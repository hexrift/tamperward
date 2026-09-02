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
import { inspectRel, textOf } from '../disk';
import { parseDiff } from '../diff/parse';
import { addHunks } from '../diff/synth';
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

/** What git would record for the path on disk: a regular file's bytes, a symbolic
 *  link's target text. null when it is absent — or when it is something the gate
 *  does not read (a link is never followed; a FIFO, socket or device is never
 *  opened for content; a file past the cap is not read), which the callers that
 *  judge the working tree report by name (src/disk.ts unjudgeableProtected). */
function fromDisk(path: string, cwd?: string): string | null {
  return textOf(inspectRel(cwd ?? process.cwd(), path));
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

/** Content of `path` on disk as git would record it, or null when it is absent or
 *  not something the gate reads (see fromDisk). */
export function fileOnDisk(path: string, opts: GitOpts = {}): string | null {
  return fromDisk(path, opts.cwd);
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

/** A file on disk as the ADD it is — `after` from disk, hunks synthesised from
 *  that content so the hunk-based rules read it as the edit it is. */
function addOf(rel: string, cwd?: string): Change {
  const after = fromDisk(rel, cwd);
  return {
    kind: 'file' as const,
    path: rel,
    oldPath: null,
    op: 'add' as const,
    before: null,
    after,
    binary: false,
    hunks: after == null ? [] : addHunks(after),
  };
}

/** Every UNTRACKED, not-ignored file as an add. `keep` narrows the set (the Stop
 *  sweep wants protected paths only; the envelope wants the whole tree). `exclude`
 *  drops paths another view already reports. */
export function untrackedAdds(opts: GitOpts = {}, keep?: (rel: string) => boolean, exclude?: Set<string>): Change[] {
  const others = git(['ls-files', '--others', '--exclude-standard', '-z'], opts.cwd)
    .split('\0')
    .filter(Boolean);
  return others.filter((rel) => !exclude?.has(rel) && (!keep || keep(rel))).map((rel) => addOf(rel, opts.cwd));
}

/** Directories no protected file lives under and no view needs to enumerate: the
 *  package tree and the VCS directories. Mirrors src/effect.ts SKIP_DIRS. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn']);
const IGNORED_LS = ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'];

function underSkippedDir(rel: string): boolean {
  return rel.split('/').some((seg) => SKIP_DIRS.has(seg));
}

/**
 * The IGNORED files under `keep` — the files `ls-files --others --exclude-standard`
 * drops on purpose and no other git view lists. A protected file CREATED where git
 * will not list it (a `.gitignore` edit, the agent-writable `.git/info/exclude`,
 * the global excludes that carry `**\/.claude/settings.local.json`) was judged by
 * nobody: not the tracked diff, not the untracked view, not the hidden-tracked
 * probe. `keep` is mandatory and is meant to be the protected globs: an ignored
 * file outside them stays out, exactly as an untracked one does.
 *
 * Two passes, so a repository with a large package tree pays nothing for it.
 * `--directory` collapses a wholly-ignored directory to one entry (`node_modules/`,
 * `dist/`), which costs a handful of stats instead of a walk of every file under
 * it (measured: 3 ms against 70 ms for the flat listing on a 100k-file
 * node_modules). The collapsed entries outside SKIP_DIRS are then expanded with a
 * positive `:(literal)` pathspec, which prunes git's traversal to those trees
 * alone and takes the name as-is (a `[` or a leading `-` in a directory name is
 * not a glob or an option). An ignored directory that also holds tracked files is
 * not collapsed; its ignored files arrive in the first pass.
 */
export function ignoredPaths(opts: GitOpts = {}, keep: (rel: string) => boolean): string[] {
  return ignoredTree(opts, keep).files;
}

/**
 * The two halves of the ignored listing: `dirs` are the WHOLLY-ignored
 * directories git collapsed (trailing slash, git's own spelling — a directory
 * that also holds a tracked file is never among them), `files` the ignored
 * files under `keep`, from the flat pass and the expansion of those directories.
 * The effect layer (src/effect.ts) prunes its walk with `dirs`: a 50k-file
 * `dist/` no protected file lives in was stat'ed file by file on every hook
 * call, and the collapse git already does answers it in one entry.
 */
export function ignoredTree(opts: GitOpts = {}, keep: (rel: string) => boolean): { dirs: string[]; files: string[] } {
  const files: string[] = [];
  const dirs: string[] = [];
  for (const entry of git([...IGNORED_LS, '--directory'], opts.cwd).split('\0').filter(Boolean)) {
    if (underSkippedDir(entry)) continue;
    if (entry.endsWith('/')) dirs.push(entry);
    else files.push(entry);
  }
  if (dirs.length > 0) {
    const expanded = git([...IGNORED_LS, '--', ...dirs.map((d) => `:(literal)${d}`)], opts.cwd).split('\0').filter(Boolean);
    for (const rel of expanded) if (!underSkippedDir(rel)) files.push(rel);
  }
  return { dirs, files: files.filter(keep) };
}

/** Every IGNORED file under `keep` as an add (see ignoredPaths). `exclude` drops
 *  paths another view already reports. */
export function ignoredAdds(opts: GitOpts = {}, keep: (rel: string) => boolean, exclude?: Set<string>): Change[] {
  return ignoredPaths(opts, keep)
    .filter((rel) => !exclude?.has(rel))
    .map((rel) => addOf(rel, opts.cwd));
}

/** Worktree view that also treats UNTRACKED (not-ignored) files as adds. The
 *  plain `git diff HEAD` view misses them entirely — an agent can drop a new
 *  .github/workflows/*.yml or a fresh test-shadowing file and it is invisible
 *  to every tracked-diff scan. The enforcement envelope adjudicates the whole
 *  tree, so it needs this. With `keepIgnored` (the protected globs), IGNORED
 *  files under those globs are adds too: a conftest.py the agent excluded via
 *  `.git/info/exclude` is as much a part of the tree the runner executes as an
 *  untracked one, and used to be the one file no view enumerated. */
export function diffWorktreeWithUntracked(opts: GitOpts = {}, keepIgnored?: (rel: string) => boolean): Change[] {
  const tracked = diffWorktree(opts);
  const seen = new Set(tracked.filter((c) => c.kind === 'file').map((c) => (c as { path: string }).path));
  const untracked = untrackedAdds(opts, undefined, seen);
  for (const c of untracked) if (c.kind === 'file') seen.add(c.path);
  const ignored = keepIgnored ? ignoredAdds(opts, keepIgnored, seen) : [];
  return [...tracked, ...untracked, ...ignored];
}

/**
 * Tracked paths git has been told NOT to compare against the working tree:
 * `update-index --skip-worktree` (tag `S`) and `--assume-unchanged` (a lowercase
 * tag). Neither shows in `git diff <rev>`, `git status`, nor `ls-files --others`
 * — an edit to such a file is invisible to every git view, while the file is
 * exactly what the runner executes. A caller that judges the working tree must
 * diff these by hand (the trusted blob vs the disk).
 */
export function hiddenTrackedPaths(opts: GitOpts = {}): string[] {
  const out: string[] = [];
  for (const entry of git(['ls-files', '-v', '-z'], opts.cwd).split('\0')) {
    if (entry.length < 3 || entry[1] !== ' ') continue;
    const tag = entry[0];
    if (tag === 'S' || tag !== tag.toUpperCase()) out.push(entry.slice(2));
  }
  return out;
}
