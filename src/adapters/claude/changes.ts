// Claude Code agent adapter: turn a PreToolUse tool call into Change[] BEFORE it runs,
// so the cheat path never opens. A Bash call is a command Change; an Edit/Write/MultiEdit/
// NotebookEdit is reconstructed into before/after content (it hasn't touched disk yet) and run
// through `git diff --no-index` so it reuses the same tested parser the git views use —
// one normalization, four producers.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Change, DiffLine, FileChange, FileOp, Hunk } from '../../types';
import { parseDiff } from '../../diff/parse';
import { inspectResolved, textOf } from '../../disk';
import { execFailure, isRecord } from '../../narrow';

// ── Operator-owned budget for reconstructing AND judging an incoming edit (#517) ──
//
// The synthetic diff and the detectors that judge it run synchronously BEFORE the hook
// can answer, so an unbounded incoming edit stalls the agent-facing gate — a 20k-line
// high-churn write took 30+ seconds. The reconstruction itself is cheap (~90 ms); the
// cost is the detector evaluation over the full content, which grows ~linearly with
// size on the high-churn MODIFY fixture (test-content-removal — the dominant detector —
// running): ~1.3 s at 1k lines, ~2.2 s at 3k, ~2.9 s at ~3.9k lines (~291 KiB), the worst
// input the ceiling admits. A 20k-line write is ~24 s, well past any sane hook budget.
//
// So the ceiling is calibrated to a DEMONSTRATED evaluation budget, not an arbitrary
// size: an edit within RECONSTRUCT_MAX_LINES / RECONSTRUCT_MAX_BYTES per side is judged
// in FULL — every detector runs, the appended `test.skip` is seen by `test-skip` — and
// the worst such input evaluates in ~3 s. An edit PAST the ceiling FAILS CLOSED (the
// hook denies with an explicit reason) rather than stall; it is still re-derived from
// git by the Stop sweep (SPEC §5.2). All four bounds are operator-tunable by env.
//
// A git-diff timeout or overflow is NEVER read as a smaller diff (partial stdout would
// parse as a smaller change and allow on a partial view); the bounded linear fallback
// below reconstructs one conservative hunk from the full before/after instead.
const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const RECONSTRUCT_TIMEOUT_MS = (): number => num('TAMPERWARD_RECONSTRUCT_TIMEOUT_MS', 5000);
const RECONSTRUCT_MAXBUFFER = (): number => num('TAMPERWARD_RECONSTRUCT_MAXBUFFER', 32 * 1024 * 1024);
const RECONSTRUCT_MAX_BYTES = (): number => num('TAMPERWARD_RECONSTRUCT_MAX_BYTES', 384 * 1024);
const RECONSTRUCT_MAX_LINES = (): number => num('TAMPERWARD_RECONSTRUCT_MAX_LINES', 4000);

/** How large a side (before or after) is, in bytes and lines — the two dimensions the
 *  detector cost scales with (content bytes to parse, significant lines to compare). */
function sideSize(s: string | null): { bytes: number; lines: number } {
  if (s == null) return { bytes: 0, lines: 0 };
  let lines = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) lines++;
  return { bytes: Buffer.byteLength(s), lines };
}

/** Whether either side exceeds the reconstruction ceiling. Above it the incoming edit
 *  cannot be judged within the hook budget and must fail closed. */
function overReconstructCeiling(before: string | null, after: string | null): string | null {
  const maxBytes = RECONSTRUCT_MAX_BYTES();
  const maxLines = RECONSTRUCT_MAX_LINES();
  for (const [label, side] of [['before', before], ['after', after]] as const) {
    const { bytes, lines } = sideSize(side);
    if (bytes > maxBytes) return `${label} is ${bytes} bytes (over the ${maxBytes}-byte reconstruction budget)`;
    if (lines > maxLines) return `${label} is ${lines} lines (over the ${maxLines}-line reconstruction budget)`;
  }
  return null;
}

/** A conservative one-hunk reconstruction from full before/after, by line: trim the
 *  common prefix and suffix, then emit every line of the changed middle as a delete
 *  (before) followed by an add (after). Used when `git diff` cannot answer within the
 *  budget — the FileChange still carries full before/after for content detectors, and
 *  every changed line reaches the hunk-based ones. Deterministic line numbers and, via
 *  the caller, a deterministic op. Never used for a diff `git` produced, so ordinary
 *  edits keep git's exact hunks. */
export function linearFallbackHunks(before: string | null, after: string | null): Hunk[] {
  const b = before == null ? [] : before.split('\n');
  const a = after == null ? [] : after.split('\n');
  let p = 0;
  while (p < b.length && p < a.length && b[p] === a[p]) p++;
  let s = 0;
  while (s < b.length - p && s < a.length - p && b[b.length - 1 - s] === a[a.length - 1 - s]) s++;
  const delContent = b.slice(p, b.length - s);
  const addContent = a.slice(p, a.length - s);
  if (delContent.length === 0 && addContent.length === 0) return [];
  const lines: DiffLine[] = [
    ...delContent.map((content, i): DiffLine => ({ type: 'del', content, oldLine: p + 1 + i, newLine: null })),
    ...addContent.map((content, i): DiffLine => ({ type: 'add', content, oldLine: null, newLine: p + 1 + i })),
  ];
  return [{ oldStart: p + 1, oldLines: delContent.length, newStart: p + 1, newLines: addContent.length, lines }];
}

export interface ClaudeHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  stop_hook_active?: boolean;
  /** Claude Code's per-session id — anchors the Stop sweep's turn baseline. */
  session_id?: string;
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** The content the tool is about to edit. The path may honestly be a link (a
 *  dotfiles-managed settings file), so the chain is resolved — but the target is
 *  read under the same guards as any repository path (src/disk.ts): a link to a
 *  device or a FIFO is not a read that never returns. */
function readDisk(path: string): string | null {
  return textOf(inspectResolved(path));
}

/** The repo-relative path when the file is inside `cwd`; the absolute path otherwise. */
function relForDisplay(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

export function applyEdit(content: string | null, oldStr: string, newStr: string, replaceAll = false): string {
  if (content === null) return newStr;
  // FAIL-OPEN CLOSED (taskbench Phase 3, 07-fastify): when old_string is not
  // found in the disk read, a silent no-op made after === before, which made
  // ZERO changes, which ALLOWED the call — while the tool itself may still
  // apply the edit. An unreconstructable edit must never mean an unseen edit:
  // model the incoming new_string as ADDED content (the NotebookEdit stance),
  // so the additive detectors judge what is about to enter the file.
  if (oldStr !== '' && !content.includes(oldStr)) return content + '\n' + newStr;
  // Function replacer so `$&`, `$1`, `` $` `` in newStr are inserted literally, not
  // interpreted as replacement patterns.
  //
  // The Edit tool's real write semantics (#418): with `replace_all` every occurrence of
  // old_string is rewritten; without it old_string must be UNIQUE and exactly one is
  // rewritten. Modelling only the first occurrence when replace_all is set makes the
  // predicted content (and the hash sanctionPredictedWrites records) SMALLER than what the
  // tool writes to disk, so the next call re-judges via drift and threshold rules see less
  // than lands. `replaceAll` with a string pattern touches every occurrence; the single
  // path stays `replace` (first occurrence), preserving prior behaviour exactly.
  return replaceAll ? content.replaceAll(oldStr, () => newStr) : content.replace(oldStr, () => newStr);
}

/** before/after full content → a FileChange with hunks, via the same diff parser. */
export function synthFileChange(displayPath: string, before: string | null, after: string | null): FileChange[] {
  if (before === after) return [];
  let op: FileOp;
  if (before === null) op = 'add';
  else if (after === null) op = 'delete';
  else op = 'modify';

  // Hard ceiling (#517): past the operator-owned budget the incoming edit cannot be
  // reconstructed AND judged within the hook's latency, so fail CLOSED — the caller's
  // try/catch turns this throw into a deny — rather than stall the agent-facing gate for
  // tens of seconds on a high-churn write. Nothing lands unseen: the Stop sweep still
  // re-derives the turn's real net diff from git (SPEC §5.2).
  const over = overReconstructCeiling(before, after);
  if (over) {
    throw new Error(`cannot safely reconstruct the incoming edit to ${displayPath} within the hook budget: ${over}`);
  }

  const mk = (hunks: Hunk[]): FileChange[] => [
    { kind: 'file', path: displayPath, oldPath: null, op, before, after, binary: false, hunks },
  ];

  const dir = mkdtempSync(join(tmpdir(), 'hf-'));
  try {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    writeFileSync(a, before ?? '');
    writeFileSync(b, after ?? '');
    try {
      // A bounded diff: a strict timeout and a bounded output buffer (#517). Both are
      // defensive — the content is already under the ceiling above, so a well-behaved
      // `git diff` finishes well inside them; a diff that does not is not read here.
      //
      // `--text`: git's binary heuristic treats a NUL byte anywhere in either side as
      // "binary" and prints one "Binary files differ" line instead of hunks. A Write
      // whose content added `it.skip` plus a `\0` therefore reached the line-based
      // rules with no hunks at all and was allowed (see src/git/build.ts DIFF_ARGS —
      // the same override every git view uses).
      const raw = execFileSync('git', ['diff', '--no-index', '--no-color', '--text', a, b], {
        encoding: 'utf8',
        maxBuffer: RECONSTRUCT_MAXBUFFER(),
        timeout: RECONSTRUCT_TIMEOUT_MS(),
        killSignal: 'SIGKILL',
      });
      const first = parseDiff(raw)[0];
      return mk(first && first.kind === 'file' ? first.hunks : []);
    } catch (e) {
      const failure = execFailure(e);
      // git diff --no-index exits 1 when the files differ; the patch is on stdout.
      if (failure.status === 1) {
        const first = parseDiff(failure.stdout)[0];
        return mk(first && first.kind === 'file' ? first.hunks : []);
      }
      // Anything else — a timeout, the buffer overflowing, git missing, a signal — is
      // NOT a diff. Partial stdout would parse as a SMALLER change than the one about to
      // land, so it is discarded; instead reconstruct one conservative delete/add hunk
      // from the full before/after by line. The content is under the ceiling, so this is
      // bounded, and every changed line still reaches the hunk-based detectors while the
      // full before/after keeps the content detectors exact (#517).
      return mk(linearFallbackHunks(before, after));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `cwd` is the directory paths are DISPLAYED relative to — the repository root,
 *  so a Change names the same root-relative path a git view would. `base` is the
 *  directory a RELATIVE tool path resolves from: the session's own cwd, which may
 *  be a subdirectory of that root (#412). The runtime sends absolute paths; the
 *  distinction only matters for a relative one, and defaults to `cwd`. */
export function changesFromClaudeHook(input: ClaudeHookInput, cwd: string, base: string = cwd): Change[] {
  const ti = input.tool_input ?? {};
  // NORMALISED absolute path. The tool input is the model's own spelling of the
  // path, and `/repo/./.claude/settings.json` or `/repo/src/../.tamperward.yml`
  // reached the detectors as `./.claude/settings.json` / `src/../.tamperward.yml`
  // — which no protected glob matches. Every exact-path protected asset (the
  // policy, the Claude hooks, the workflows) could be edited unseen at the
  // PreToolUse layer by writing its path with one redundant segment.
  const abs = (path: string): string => resolve(base, path);

  switch (input.tool_name) {
    case 'Bash': {
      const raw = asStr(ti.command);
      return raw ? [{ kind: 'command', raw, argv: raw.split(/\s+/) }] : [];
    }
    case 'Write': {
      const fp = asStr(ti.file_path);
      if (!fp) return [];
      const before = readDisk(abs(fp));
      return synthFileChange(relForDisplay(abs(fp), cwd), before, asStr(ti.content));
    }
    case 'Edit': {
      const fp = asStr(ti.file_path);
      if (!fp) return [];
      const before = readDisk(abs(fp));
      const after = applyEdit(before, asStr(ti.old_string), asStr(ti.new_string), ti.replace_all === true);
      return synthFileChange(relForDisplay(abs(fp), cwd), before, after);
    }
    case 'MultiEdit': {
      const fp = asStr(ti.file_path);
      if (!fp) return [];
      const before = readDisk(abs(fp));
      let after: string | null = before;
      const edits = Array.isArray(ti.edits) ? ti.edits : [];
      for (const raw of edits) {
        const ed = isRecord(raw) ? raw : {};
        after = applyEdit(after, asStr(ed.old_string), asStr(ed.new_string), ed.replace_all === true);
      }
      return synthFileChange(relForDisplay(abs(fp), cwd), before, after);
    }
    case 'NotebookEdit': {
      const fp = asStr(ti.notebook_path);
      const src = asStr(ti.new_source);
      if (!fp || !src) return [];
      // Model the cell's new source as content being ADDED to the notebook. before is ''
      // rather than the notebook JSON on purpose: the additive detectors (skip / any /
      // suppression) get the text about to be written, while the AST count detectors see
      // no phantom "blocks removed" from diffing a cell against a whole notebook.
      return synthFileChange(relForDisplay(abs(fp), cwd), '', src);
    }
    default:
      // Anything we do not model produces no Change — including read-only tools, which is
      // correct. A tool that mutates files by some path we cannot reconstruct (an arbitrary
      // Bash-driven write, a future edit tool) is NOT silently trusted: it is the Stop
      // sweep's job (SPEC §5.2), which re-derives the turn's real net diff from git.
      return [];
  }
}
