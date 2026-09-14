// The one way a CLI command writes a file it does not own outright.
//
// `init` and `onboard` write into repository content: the policy, the Claude
// settings, a pre-commit hook, CODEOWNERS, the workflow. Every one of those paths
// is a NAME the repository chose, and what stands at it on disk is the
// repository's too. A `.claude/settings.json` that is a symlink to the
// operator's `~/.claude/settings.json`, or a tracked `.husky/pre-commit` aimed at
// any file a reviewer can write, turned `writeFileSync(path, …)` into a write
// wherever the link pointed, with content the tool chose and a destination the
// repository chose (#414). `onboard` refused that since the #402 review; `init`
// followed the link.
//
// Two primitives, shared so no command grows its own weaker copy:
//
// - `refuseNonRegular` lstats the destination and names why it must not be
//   written — a symlink, a directory, a FIFO, a device — or null when it is
//   absent or a regular file. The caller turns the reason into a plan row.
// - `atomicReplaceFile` never opens the destination for writing. The bytes go
//   to a fresh `wx` sibling in the same directory and rename replaces the
//   directory entry, so a final-component symlink (or a hard link to operator
//   state) is never followed, a hard link is broken rather than mutated in
//   place, and a crash mid-write leaves the old file whole instead of a
//   truncated one.
//
// The check and the write are separate calls, so a link swapped in between
// them is still not followed: rename over a symlink replaces the link itself,
// never its target. The check exists so the tool can say what it saw and
// refuse; the write is safe on its own.

import { randomBytes } from 'node:crypto';
import { lstatSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { errnoCode } from './narrow';

/** What stands at `path`, without following it. */
export type WriteTargetKind = 'absent' | 'file' | 'symlink' | 'irregular';

export function writeTargetKind(path: string): WriteTargetKind {
  let st;
  try {
    st = lstatSync(path, { throwIfNoEntry: false });
  } catch (e) {
    // A parent that is not a directory: nothing stands at the path itself. The
    // write then fails in apply and is reported as its own error row.
    if (errnoCode(e) === 'ENOTDIR') return 'absent';
    throw e;
  }
  if (!st) return 'absent';
  if (st.isSymbolicLink()) return 'symlink';
  return st.isFile() ? 'file' : 'irregular';
}

/** Why `path` must not be written, or null when it is absent or a regular
 *  file. The text is a plan-table detail: it starts with `refusing:` so the row
 *  reads as the refusal it is. */
export function refuseNonRegular(path: string): string | null {
  switch (writeTargetKind(path)) {
    case 'symlink':
      return 'refusing: symlink — the target would be written instead of this path; replace the link with a regular file, then re-run';
    case 'irregular':
      return 'refusing: not a regular file — a directory or special file stands where a file is expected; remove it, then re-run';
    default:
      return null;
  }
}

/** The mode an existing regular file has, or `fallback` when the path is absent. */
export function existingMode(path: string, fallback: number): number {
  if (writeTargetKind(path) !== 'file') return fallback;
  return lstatSync(path).mode & 0o777;
}

/** Replace a file without ever opening the destination for writing. The bytes go
 * to a fresh sibling and rename replaces the directory entry atomically. That
 * means a final-component symlink (or a hard link to operator state) is never
 * followed; a hard link is broken rather than mutated in place. */
export function atomicReplaceFile(path: string, content: string, mode: number): void {
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx', mode });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}
