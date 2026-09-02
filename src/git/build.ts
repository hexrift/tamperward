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

/**
 * `execFileSync` inherits the parent's stderr by default, so every probe that git answers
 * with "path does not exist in <rev>" printed a `fatal:` line to the user's terminal even
 * though the caller went on to handle the absence perfectly well. Piping stderr keeps the
 * probes quiet; folding it into the thrown Error keeps a real failure just as diagnosable
 * as it was, since that text is now on the exception instead of on the terminal.
 */
function git(args: string[], cwd?: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      // 256 MiB, matching the hook adapter. Every diff below runs with `--text`, so a
      // changed binary asset now costs its full size in patch output instead of one
      // "Binary files differ" line; a legitimate golden-image update must fit. Past
      // the cap git() throws and the view fails CLOSED (a truncated patch would parse
      // as a smaller change than the one landing), which is the documented stance.
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = e as { stderr?: string | Buffer; message?: string };
    const detail = String(err.stderr ?? '').trim();
    throw new Error(detail ? `git ${args[0]}: ${detail}` : (err.message ?? `git ${args[0]} failed`));
  }
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

/**
 * Every diff this module produces runs with `--text` (see DIFF_ARGS), so `binary` is
 * no longer a reason to skip enrichment: it used to be, and that was a total bypass.
 * git decides "binary" from a `-diff`/`binary` gitattribute or from a NUL byte in the
 * blob — both under the change author's control — and a binary change carried no
 * hunks and, here, no before/after either, so a spec gutted to one `it()` with `// \0`
 * appended (or with `x.spec.ts -diff` in a committed .gitattributes) reached every
 * content detector as an empty modify. The flag is still set by the parser when git
 * says so and is kept for reporting; content is loaded regardless.
 */
function enrich(c: Change, beforeReader: Reader, afterReader: Reader): Change {
  if (c.kind !== 'file') return c;
  const before = c.op !== 'add' ? beforeReader(c.oldPath ?? c.path) : null;
  const after = c.op !== 'delete' ? afterReader(c.path) : null;
  return { ...c, before, after };
}

/** Reject a revision that git would read as an option. Every shipped wiring
 *  passes operator-controlled revs, so this is a guard rather than a fix for a
 *  demonstrated escape — but `git diff --output=...` from a rev argument is
 *  free to prevent. (P2-16, external review.) */
export function assertRev(rev: string): string {
  if (rev.startsWith('-')) throw new Error(`refusing a revision that git would read as an option: ${rev}`);
  return rev;
}

/** The merge-base of `base` and `head`, or `base` when git can't compute one.
 *  This is the TRUSTED revision for a range: it is what the head branched from, so
 *  nothing on the head can have altered it. */
export function mergeBaseOf(base: string, head: string, opts: GitOpts = {}): string {
  try {
    return git(['merge-base', assertRev(base), assertRev(head)], opts.cwd).trim() || base;
  } catch {
    return base;
  }
}

/** Content of `path` at a revision, or null when it doesn't exist there. */
export function fileAt(rev: string, path: string, opts: GitOpts = {}): string | null {
  return blobAt(rev, path, opts.cwd);
}

/** Whether `cwd` is inside a git work tree. Lets a caller tell "nothing to compare"
 *  apart from "the comparison failed" — the two must not share a fail-open path. */
export function isGitRepo(cwd?: string): boolean {
  try {
    git(['rev-parse', '--git-dir'], cwd);
    return true;
  } catch {
    return false;
  }
}

/** The absolute .git directory, or null outside a repo. */
export function gitDir(cwd?: string): string | null {
  try {
    return git(['rev-parse', '--absolute-git-dir'], cwd).trim() || null;
  } catch {
    return null;
  }
}

/** The current HEAD sha, or null (unborn branch / not a repo). */
export function headSha(cwd?: string): string | null {
  try {
    return git(['rev-parse', 'HEAD'], cwd).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Flags shared by every `git diff` Tamperward runs.
 *
 * `--text` is load-bearing: without it git's binary heuristic decides what the gate
 * gets to see. A `-diff` or `binary` attribute in a committed .gitattributes, or a
 * single NUL byte anywhere in the file, made git print "Binary files a/x and b/x
 * differ" instead of hunks — and every line-based detector (test-skip, test-content-
 * removal, ci-tampering, coverage-lowering, hook-tampering's content branch) went
 * silent on that file, in the range, staged and worktree views alike. `--text`
 * overrides both the attribute and the NUL heuristic, so the parser always receives
 * hunks. The hook adapter's `git diff --no-index` passes it too.
 */
const DIFF_ARGS = ['diff', '--no-color', '--text', '-M'];

/** Everything that changed since `rev`, COMMITTED OR NOT — the honest Stop-sweep view.
 *  `git diff <rev>` compares that commit to the working tree, so a mid-turn commit can no
 *  longer launder a tamper out of sight the way `git diff HEAD` allowed. */
export function diffSince(rev: string, opts: GitOpts = {}): Change[] {
  const raw = git([...DIFF_ARGS, rev], opts.cwd);
  return parseDiff(raw).map((c) =>
    enrich(c, (p) => blobAt(rev, p, opts.cwd), (p) => fromDisk(p, opts.cwd)),
  );
}

/** Changes on `head` since its merge-base with `base` — the CI authority view. */
export function diffRange(base: string, head: string, opts: GitOpts = {}): Change[] {
  assertRev(base);
  assertRev(head);
  const raw = git([...DIFF_ARGS, `${base}...${head}`], opts.cwd);
  // `base...head` diffs from the merge-base, so `before` must come from the merge-base
  // too (not base's tip), or it misaligns whenever base advanced past the branch point.
  const mergeBase = mergeBaseOf(base, head, opts);
  return parseDiff(raw).map((c) =>
    enrich(c, (p) => blobAt(mergeBase, p, opts.cwd), (p) => blobAt(head, p, opts.cwd)),
  );
}

/** Staged changes — the pre-commit view. `after` is the index. */
export function diffStaged(opts: GitOpts = {}): Change[] {
  const raw = git([...DIFF_ARGS, '--cached'], opts.cwd);
  return parseDiff(raw).map((c) =>
    enrich(c, (p) => blobAt('HEAD', p, opts.cwd), (p) => blobAt('', p, opts.cwd)),
  );
}

/** Unstaged + staged working-tree changes vs HEAD — the Stop-sweep view.
 *  `after` is read from DISK: an agent's edits are unstaged, so the index is stale. */
export function diffWorktree(opts: GitOpts = {}): Change[] {
  const raw = git([...DIFF_ARGS, 'HEAD'], opts.cwd);
  return parseDiff(raw).map((c) =>
    enrich(c, (p) => blobAt('HEAD', p, opts.cwd), (p) => fromDisk(p, opts.cwd)),
  );
}

/** Worktree view that also treats UNTRACKED (not-ignored) files as adds. The
 *  plain `git diff HEAD` view misses them entirely — an agent can drop a new
 *  .github/workflows/*.yml or a fresh test-shadowing file and it is invisible
 *  to every tracked-diff scan. The enforcement envelope adjudicates the whole
 *  tree, so it needs this. */
export function diffWorktreeWithUntracked(opts: GitOpts = {}): Change[] {
  const tracked = diffWorktree(opts);
  const others = git(['ls-files', '--others', '--exclude-standard', '-z'], opts.cwd)
    .split('\0')
    .filter(Boolean);
  const seen = new Set(tracked.filter((c) => c.kind === 'file').map((c) => (c as { path: string }).path));
  const untracked: Change[] = others
    .filter((rel) => !seen.has(rel))
    .map((rel) =>
      enrich(
        { kind: 'file', path: rel, oldPath: null, op: 'add', before: null, after: null, binary: false, hunks: [] },
        () => null,
        (p) => fromDisk(p, opts.cwd),
      ),
    );
  return [...tracked, ...untracked];
}
