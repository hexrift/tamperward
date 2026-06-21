// The git adapter: shell out, parse, then enrich before/after with full file content
// (which the diff alone doesn't carry) so the AST detectors have something to parse.
// Enrichment is best-effort and never throws on a missing blob — a detector that needs
// content null-checks; a detector that only needs hunks ignores before/after entirely.
//
// The `after` side MUST match the view, or full-content/AST detectors go blind:
//   range  → the head revision
//   staged → the index (`:path`)
//   worktree (Stop sweep) → the file ON DISK, because an agent's edits are unstaged.
// Reading the index for the worktree view was the bug that made the Stop sweep miss
// interpreter-based tampers (the change is on disk, the index is stale).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDiff } from '../diff/parse';
import { Change } from '../types';

export interface GitOpts {
  cwd?: string;
}

type Reader = (path: string) => string | null;

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Content of `path` at a revision (or `:path` for the index). null if absent. */
function blobAt(rev: string, path: string, cwd?: string): string | null {
  try {
    return git(['show', `${rev}:${path}`], cwd);
  } catch {
    return null;
  }
}

function fromDisk(path: string, cwd?: string): string | null {
  try {
    return readFileSync(join(cwd ?? process.cwd(), path), 'utf8');
  } catch {
    return null;
  }
}

function enrich(c: Change, beforeReader: Reader, afterReader: Reader): Change {
  if (c.kind !== 'file' || c.binary) return c;
  const before = c.op !== 'add' ? beforeReader(c.oldPath ?? c.path) : null;
  const after = c.op !== 'delete' ? afterReader(c.path) : null;
  return { ...c, before, after };
}

/** Changes on `head` since its merge-base with `base` — the CI authority view. */
export function diffRange(base: string, head: string, opts: GitOpts = {}): Change[] {
  const raw = git(['diff', '--no-color', '-M', `${base}...${head}`], opts.cwd);
  // `base...head` diffs from the merge-base, so `before` must come from the merge-base
  // too (not base's tip), or it misaligns whenever base advanced past the branch point.
  let mergeBase = base;
  try {
    mergeBase = git(['merge-base', base, head], opts.cwd).trim() || base;
  } catch {
    /* fall back to base */
  }
  return parseDiff(raw).map((c) =>
    enrich(c, (p) => blobAt(mergeBase, p, opts.cwd), (p) => blobAt(head, p, opts.cwd)),
  );
}

/** Staged changes — the pre-commit view. `after` is the index. */
export function diffStaged(opts: GitOpts = {}): Change[] {
  const raw = git(['diff', '--no-color', '-M', '--cached'], opts.cwd);
  return parseDiff(raw).map((c) =>
    enrich(c, (p) => blobAt('HEAD', p, opts.cwd), (p) => blobAt('', p, opts.cwd)),
  );
}

/** Unstaged + staged working-tree changes vs HEAD — the Stop-sweep view.
 *  `after` is read from DISK: an agent's edits are unstaged, so the index is stale. */
export function diffWorktree(opts: GitOpts = {}): Change[] {
  const raw = git(['diff', '--no-color', '-M', 'HEAD'], opts.cwd);
  return parseDiff(raw).map((c) =>
    enrich(c, (p) => blobAt('HEAD', p, opts.cwd), (p) => fromDisk(p, opts.cwd)),
  );
}
