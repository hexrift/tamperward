// The git adapter: shell out, parse, then enrich before/after with full file content
// (which the diff alone doesn't carry) so the AST detectors have something to parse.
// Enrichment is best-effort and never throws on a missing blob — a detector that needs
// content null-checks; a detector that only needs hunks ignores before/after entirely.

import { execFileSync } from 'node:child_process';
import { parseDiff } from '../diff/parse';
import { Change } from '../types';

export interface GitOpts {
  cwd?: string;
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Content of `path` at a revision (or `:path` for the index). null if absent. */
function blobAt(rev: string, path: string, cwd?: string): string | null {
  try {
    return git(['show', `${rev}:${path}`], cwd);
  } catch {
    return null;
  }
}

function enrich(c: Change, base: string, head: string | null, cwd?: string): Change {
  if (c.kind !== 'file' || c.binary) return c;

  let before: string | null = null;
  let after: string | null = null;

  if (c.op !== 'add') {
    before = blobAt(base, c.oldPath ?? c.path, cwd);
  }
  if (c.op !== 'delete') {
    // head === null means "compare against the index" (staged), i.e. `:path`.
    after = head !== null ? blobAt(head, c.path, cwd) : blobAt('', c.path, cwd);
  }

  return { ...c, before, after };
}

/** Changes on `head` since its merge-base with `base` — the CI authority view. */
export function diffRange(base: string, head: string, opts: GitOpts = {}): Change[] {
  const raw = git(['diff', '--no-color', '-M', `${base}...${head}`], opts.cwd);
  return parseDiff(raw).map((c) => enrich(c, base, head, opts.cwd));
}

/** Staged changes — the pre-commit view. */
export function diffStaged(opts: GitOpts = {}): Change[] {
  const raw = git(['diff', '--no-color', '-M', '--cached'], opts.cwd);
  return parseDiff(raw).map((c) => enrich(c, 'HEAD', null, opts.cwd));
}

/** Unstaged + staged working-tree changes vs HEAD — the Stop-sweep view. */
export function diffWorktree(opts: GitOpts = {}): Change[] {
  const raw = git(['diff', '--no-color', '-M', 'HEAD'], opts.cwd);
  return parseDiff(raw).map((c) => enrich(c, 'HEAD', null, opts.cwd));
}
