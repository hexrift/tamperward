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
import { existsSync } from 'node:fs';
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

/** Forget every resolved context (tests that re-initialise a fixture in place). */
export function resetRepoContextCache(): void {
  cache.clear();
}
