// The one place a cwd becomes a repository.
//
// Every git view reports paths RELATIVE TO THE REPOSITORY ROOT, whatever directory
// the command ran from. Every worktree-reading path used to join those paths onto
// cwd instead: from a subdirectory the after-content of every changed file resolved
// to a path that does not exist, the content/AST detectors went blind, `.tamperward.yml`
// was looked for beside the subdirectory and the root policy silently gave way to the
// baseline. `check --worktree` and the Stop sweep failed OPEN for a session started
// in `packages/x`; PreToolUse enforced the wrong policy; `init` wired the wrong
// directory. (#412.)
//
// Callers resolve the context once at their entry and thread `root` through as the
// cwd every helper reads against. A cwd outside any repository resolves to null and
// the caller keeps its existing behaviour for it (the non-repository message, a
// policy file read beside the cwd) — the bug was never about those.

import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export interface RepoContext {
  /** The working-tree root, as `git rev-parse --show-toplevel` reports it (symlinks resolved). */
  root: string;
  /** The absolute git directory: `.git` of the checkout, or the linked worktree's
   *  `.git/worktrees/<name>` — where session state lives. */
  gitDir: string;
}

function rev(cwd: string, flag: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', flag], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return out ? (isAbsolute(out) ? out : resolve(cwd, out)) : null;
  } catch {
    return null;
  }
}

/** Resolved contexts by the cwd they were asked for. A hook call reads the policy,
 *  the disk and the snapshot state from the same cwd; the persistent service serves
 *  many calls from one client cwd. Two `git rev-parse` per distinct cwd, not per
 *  read. A cached entry whose git directory has since vanished (the fixture was
 *  torn down, the repository re-initialised) is resolved afresh; a failure is never
 *  cached, so a directory that BECOMES a repository is seen as one on the next call. */
const cache = new Map<string, RepoContext>();
const CACHE_MAX = 256;

/**
 * The repository `cwd` lies in, or null when it lies in none (or in a bare
 * repository, which has no working tree to read). `root` is what every relative
 * path in a git view is relative to; `gitDir` is where per-session state lives.
 */
export function repoContext(cwd: string): RepoContext | null {
  const key = resolve(cwd);
  const hit = cache.get(key);
  if (hit && existsSync(hit.gitDir) && existsSync(hit.root)) return hit;
  cache.delete(key);
  const root = rev(key, '--show-toplevel');
  const gitDir = root ? rev(key, '--absolute-git-dir') : null;
  if (!root || !gitDir) return null;
  const ctx: RepoContext = { root, gitDir };
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, ctx);
  return ctx;
}

/** The root of the repository `cwd` lies in, or `cwd` itself outside a repository —
 *  the base every worktree read is joined onto. */
export function repoRoot(cwd: string): string {
  return repoContext(cwd)?.root ?? cwd;
}

/** The outcome of validating a runtime-supplied cwd CLAIM against a trusted repo root. */
export type ClaimValidation = { ok: true; trustedRoot: string } | { ok: false; rejected: string };

/**
 * Validate a runtime-supplied `claimedCwd` against `trustedRoot` — the repository root the
 * RUNNER derived INDEPENDENTLY of the claim (#482 review point 5). The payload's cwd is an
 * input to check, not a fact to trust:
 *
 *  - no claim (undefined) → the runner's own trusted root stands (`ok`);
 *  - a non-string / empty claim → rejected (malformed);
 *  - a claim that resolves to NO repository → rejected;
 *  - a claim that resolves to a DIFFERENT repository than `trustedRoot` → rejected.
 *
 * `repoContext` resolves through git (`--show-toplevel`, symlinks included), so a claim that
 * is a symlink escaping into another repository resolves to THAT repo's root and is rejected
 * here — a subdirectory or linked path genuinely inside `trustedRoot` resolves back to it and
 * is accepted. `trustedRoot` must itself be a canonical `repoContext(...).root`, so the
 * comparison is root-to-root. `base` is the runner directory a RELATIVE claim resolves from
 * (never the claim itself).
 */
export function validateClaimAgainstRoot(claimedCwd: string | undefined, trustedRoot: string, base: string): ClaimValidation {
  if (claimedCwd === undefined) return { ok: true, trustedRoot };
  if (typeof claimedCwd !== 'string' || claimedCwd.trim() === '') return { ok: false, rejected: 'malformed cwd claim' };
  const abs = isAbsolute(claimedCwd) ? claimedCwd : resolve(base, claimedCwd);
  const ctx = repoContext(abs);
  if (!ctx) return { ok: false, rejected: `cwd claim resolves to no repository (${abs})` };
  if (ctx.root !== trustedRoot) return { ok: false, rejected: `cwd claim resolves to a different repository (${ctx.root} != trusted ${trustedRoot})` };
  return { ok: true, trustedRoot };
}

/**
 * Why `cwd` resolved to no repository, or null when it is a real, readable directory
 * that git itself reports as lying outside every repository — the ONE case in which
 * "nothing to compare" is the truth. A directory that does not exist, one the hook
 * cannot read, a bare repository, or any other git failure (dubious ownership, a
 * broken `.git` file) is a verdict the gate could not compute, and the caller denies
 * it with this diagnostic rather than passing it as empty (#417).
 */
export function outsideRepository(cwd: string): string | null {
  const key = resolve(cwd);
  let isDir: boolean;
  try {
    isDir = statSync(key).isDirectory();
  } catch (e) {
    return `cwd ${key} cannot be read: ${errCode(e)}`;
  }
  if (!isDir) return `cwd ${key} is not a directory`;
  try {
    accessSync(key, constants.R_OK | constants.X_OK);
  } catch (e) {
    return `cwd ${key} cannot be read: ${errCode(e)}`;
  }
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: key,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const detail = errDetail(e);
    if (/not a git repository/i.test(detail)) return null;
    return `git could not resolve cwd ${key}: ${detail || 'unknown failure'}`;
  }
  // rev-parse succeeded but no working-tree root resolved: a bare repository, or a
  // git directory the hook can see with no tree it can judge.
  return `cwd ${key} lies in a repository with no working tree the gate can judge`;
}

function errCode(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const code = Reflect.get(e, 'code');
    if (typeof code === 'string') return code;
  }
  return e instanceof Error ? e.message : String(e);
}

/** The stderr git wrote, else the error's code or message, on one line. */
function errDetail(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const stderr = Reflect.get(e, 'stderr');
    if (typeof stderr === 'string' && stderr.trim()) return stderr.replace(/\s+/g, ' ').trim();
  }
  return errCode(e);
}

/** Forget every resolved context (tests that re-initialise a fixture in place). */
export function resetRepoContextCache(): void {
  cache.clear();
}
