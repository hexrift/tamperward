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

/** Forget the memoised listing (tests that mutate a repo between evaluations). */
export function resetTrackedFiles(): void {
  cache.clear();
}

const dirOf = (t: string) => t.replace(/^\.\//, '').replace(/\/+$/, '');

/**
 * Whether a directory token names a directory that CONTAINS a protected file of
 * `category`. With a file listing the answer is exact; without one the token is
 * resolved against the globs as `dir/**` — a probe path under it must match a
 * directory-shaped glob (`**\/__tests__/**`, `**\/src/test/**`) or the directory must
 * carry a conventional test-directory name.
 */
export function containsProtected(token: string, policy: Policy, category: string, ctx?: DetectorContext): boolean {
  const dir = dirOf(token);
  if (!dir || dir === '.' || dir === '/' || dir.startsWith('-')) return false;
  const files = trackedFiles(ctx);
  if (files) {
    const prefix = dir + '/';
    return files.some((f) => f.startsWith(prefix) && isProtected(f, policy, category));
  }
  if (isProtected(dir + '/probe', policy, category)) return true;
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
