// What the repository knows that the diff does not: which paths are actually
// there. A shell command names a DIRECTORY (`rm -rf test`) and the diff-shaped
// rules can only ask whether the token itself matches a protected glob — it never
// does, so the deletion of every spec under it walked through; and the same rule
// applied naively blocks `rm -rf dist/__tests__`, a build output nobody protects.
// The tracked (or untracked-but-not-ignored) file list answers both: a directory
// is protected when a protected file lives under it, and a path git ignores is
// not the suite. Read from `ctx.cwd` via `git ls-files`, memoised per process; a
// test passes `ctx.trackedFiles` instead. With no context at all a caller gets
// null and falls back to the glob-only answer, which is the behaviour that shipped.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DetectorContext } from '../types';
import { isProtected } from '../policy';
import { Policy } from '../types';

const cache = new Map<string, string[] | null>();

/** Tracked + untracked-not-ignored paths relative to `ctx.cwd`, or null when unknown. */
export function trackedFiles(ctx?: DetectorContext): string[] | null {
  if (!ctx) return null;
  if (ctx.trackedFiles) return ctx.trackedFiles;
  if (!ctx.cwd) return null;
  const hit = cache.get(ctx.cwd);
  if (hit !== undefined) return hit;
  let files: string[] | null = null;
  try {
    files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: ctx.cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\0')
      .filter(Boolean);
  } catch {
    files = null; // not a repo, or git unavailable: unknown, never "empty"
  }
  cache.set(ctx.cwd, files);
  return files;
}

const contentCache = new Map<string, string | null>();

/**
 * The content of a repository file the change did not touch, or null when it cannot
 * be read. Sound for exactly that case: a path absent from the range has the same
 * content at base, at head and in the worktree, so the working copy answers for all
 * three. A path the change DID touch must come from the Change, never from here.
 */
export function trackedContent(path: string, ctx?: DetectorContext): string | null {
  if (!ctx) return null;
  if (ctx.trackedContents) return ctx.trackedContents[path] ?? null;
  if (!ctx.cwd) return null;
  const key = ctx.cwd + '\0' + path;
  const hit = contentCache.get(key);
  if (hit !== undefined) return hit;
  let src: string | null = null;
  try {
    src = readFileSync(join(ctx.cwd, path), 'utf8');
  } catch {
    src = null; // missing or unreadable: unknown, never "empty"
  }
  contentCache.set(key, src);
  return src;
}

/** Forget the memoised listing (tests that mutate a repo between evaluations). */
export function resetTrackedFiles(): void {
  cache.clear();
  contentCache.clear();
  branchCache.clear();
  refsCache.clear();
}

const branchCache = new Map<string, string | null>();
const refsCache = new Map<string, Set<string> | null>();

/** The short names of every local and remote-tracking branch (`main`,
 *  `origin/main`), or null when the repository cannot be read. */
function branchRefs(ctx?: DetectorContext): Set<string> | null {
  if (!ctx?.cwd) return null;
  const hit = refsCache.get(ctx.cwd);
  if (hit !== undefined) return hit;
  let refs: Set<string> | null = null;
  try {
    const out = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], {
      cwd: ctx.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    refs = new Set(out.split('\n').map((l) => l.trim()).filter(Boolean));
  } catch {
    refs = null;
  }
  refsCache.set(ctx.cwd, refs);
  return refs;
}

/** Whether a branch named `name` exists locally or on any remote; null when the
 *  repository cannot say. `origin/HEAD` is written once at clone time and is not
 *  moved by a rename, so a workflow that now names `main` is judged against the
 *  branches the repository actually has, not only against that stale pointer. */
export function branchExists(name: string, ctx?: DetectorContext): boolean | null {
  const refs = branchRefs(ctx);
  if (!refs) return null;
  if (refs.has(name)) return true;
  for (const r of refs) if (r.endsWith('/' + name)) return true;
  return false;
}

/** Whether `rev` names the commit HEAD is on — `main` while on main, `@`, a tag of
 *  the current commit. null when there is no repository to ask or the rev does not
 *  resolve. Restoring a path from the commit you stand on discards uncommitted
 *  edits; only a rev that resolves ELSEWHERE puts an older version back. */
export function revIsHead(rev: string, ctx?: DetectorContext): boolean | null {
  if (!ctx?.cwd || rev.startsWith('-')) return null;
  const parse = (r: string): string | null => {
    try {
      return execFileSync('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${r}^{commit}`], {
        cwd: ctx.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return null;
    }
  };
  const head = parse('HEAD');
  const target = parse(rev);
  if (!head || !target) return null;
  return head === target;
}

/** The repository's default branch as the remote declares it
 *  (`refs/remotes/origin/HEAD` → `main`), or null when unknown — a caller then
 *  accepts `main` and `master` alike. */
export function defaultBranch(ctx?: DetectorContext): string | null {
  if (!ctx?.cwd) return null;
  const hit = branchCache.get(ctx.cwd);
  if (hit !== undefined) return hit;
  let name: string | null = null;
  try {
    const ref = execFileSync('git', ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: ctx.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    name = ref.replace(/^origin\//, '') || null;
  } catch {
    name = null;
  }
  branchCache.set(ctx.cwd, name);
  return name;
}

const dirOf = (t: string) => t.replace(/^\.\//, '').replace(/\/+$/, '');

/**
 * Whether a directory token names a directory that CONTAINS a protected file of
 * `category`. With a file listing the answer is exact; without one the token is
 * resolved against the globs as `dir/**` — a probe path under it must match a
 * directory-shaped glob (`**\/__tests__/**`, `**\/src/test/**`) or the directory must
 * carry a conventional test-directory name. A file that also belongs to `except`
 * does not count: jest's default layout puts `__snapshots__` INSIDE `__tests__`, and
 * the snapshot category owns those files, so `rm -rf src/__tests__/__snapshots__`
 * holds no spec.
 */
export function containsProtected(token: string, policy: Policy, category: string, ctx?: DetectorContext, except?: string): boolean {
  const dir = dirOf(token);
  if (!dir || dir === '.' || dir === '/' || dir.startsWith('-')) return false;
  const counts = (p: string) => isProtected(p, policy, category) && !(except && isProtected(p, policy, except));
  const files = trackedFiles(ctx);
  if (files) {
    const prefix = dir + '/';
    return files.some((f) => f.startsWith(prefix) && counts(f));
  }
  if (counts(dir + '/probe')) return true;
  const base = dir.split('/').pop() ?? '';
  return category === 'tests' && /^(?:test|tests|__tests__|spec|specs)$/i.test(base);
}

/** Whether `path` (repo-relative) exists in the listing; null when unknown. */
export function isTracked(path: string, ctx?: DetectorContext): boolean | null {
  const files = trackedFiles(ctx);
  if (!files) return null;
  const p = dirOf(path);
  return files.includes(p);
}
