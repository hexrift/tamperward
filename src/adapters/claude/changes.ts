// Claude Code agent adapter: turn a PreToolUse tool call into Change[] BEFORE it runs,
// so the cheat path never opens. A Bash call is a command Change; an Edit/Write/MultiEdit/
// NotebookEdit is reconstructed into before/after content (it hasn't touched disk yet) and run
// through `git diff --no-index` so it reuses the same tested parser the git views use —
// one normalization, four producers.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Change, FileChange, FileOp } from '../../types';
import { parseDiff } from '../../diff/parse';

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

function readDisk(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/** NORMALISED absolute path. The tool input is the model's own spelling of the
 *  path, and `/repo/./.claude/settings.json` or `/repo/src/../.tamperward.yml`
 *  reached the detectors as `./.claude/settings.json` / `src/../.tamperward.yml`
 *  — which no protected glob matches. Every exact-path protected asset (the
 *  policy, the Claude hooks, the workflows) could be edited unseen at the
 *  PreToolUse layer by writing its path with one redundant segment. */
function abs(path: string, cwd: string): string {
  return resolve(cwd, path);
}

/** The repo-relative path when the file is inside `cwd`; the absolute path otherwise. */
function relForDisplay(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

function applyEdit(content: string | null, oldStr: string, newStr: string): string {
  if (content === null) return newStr;
  // FAIL-OPEN CLOSED (taskbench Phase 3, 07-fastify): when old_string is not
  // found in the disk read, a silent no-op made after === before, which made
  // ZERO changes, which ALLOWED the call — while the tool itself may still
  // apply the edit. An unreconstructable edit must never mean an unseen edit:
  // model the incoming new_string as ADDED content (the NotebookEdit stance),
  // so the additive detectors judge what is about to enter the file.
  if (oldStr !== '' && !content.includes(oldStr)) return content + '\n' + newStr;
  // Function replacer so `$&`, `$1`, `` $` `` in newStr are inserted literally, not
  // interpreted as replacement patterns. Still replaces the first occurrence only.
  return content.replace(oldStr, () => newStr);
}

/** before/after full content → a FileChange with hunks, via the same diff parser. */
export function synthFileChange(displayPath: string, before: string | null, after: string | null): FileChange[] {
  if (before === after) return [];
  let op: FileOp;
  if (before === null) op = 'add';
  else if (after === null) op = 'delete';
  else op = 'modify';

  const dir = mkdtempSync(join(tmpdir(), 'hf-'));
  let raw = '';
  try {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    writeFileSync(a, before ?? '');
    writeFileSync(b, after ?? '');
    try {
      // maxBuffer: Node's default is 1 MiB. A Write whose diff exceeded it was
      // killed mid-output, and the catch below read the TRUNCATED patch as if it
      // were the whole edit — so `test.skip` appended to a large spec was
      // allowed, because the hunk that carried it was past the cut. (Full-content
      // detectors were unaffected; every hunk-based one was blind past 1 MiB.)
      raw = execFileSync('git', ['diff', '--no-index', '--no-color', a, b], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      });
    } catch (e) {
      // git diff --no-index exits 1 when the files differ; the patch is on stdout.
      // Anything else — the buffer overflowing, git missing, a signal — is not a
      // diff: partial stdout would parse as a SMALLER change than the one about
      // to land, and the hook would allow on that partial view. Fail closed.
      const err = e as { stdout?: string | Buffer; status?: number | null; code?: string; message?: string };
      if (err.status !== 1) {
        throw new Error(`cannot diff the incoming edit to ${displayPath}: ${err.code ?? err.message ?? String(e)}`);
      }
      raw = err.stdout ? String(err.stdout) : '';
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const first = parseDiff(raw)[0];
  const hunks = first && first.kind === 'file' ? first.hunks : [];
  return [{ kind: 'file', path: displayPath, oldPath: null, op, before, after, binary: false, hunks }];
}

export function changesFromClaudeHook(input: ClaudeHookInput, cwd: string): Change[] {
  const ti = input.tool_input ?? {};

  switch (input.tool_name) {
    case 'Bash': {
      const raw = asStr(ti.command);
      return raw ? [{ kind: 'command', raw, argv: raw.split(/\s+/) }] : [];
    }
    case 'Write': {
      const fp = asStr(ti.file_path);
      if (!fp) return [];
      const before = readDisk(abs(fp, cwd));
      return synthFileChange(relForDisplay(abs(fp, cwd), cwd), before, asStr(ti.content));
    }
    case 'Edit': {
      const fp = asStr(ti.file_path);
      if (!fp) return [];
      const before = readDisk(abs(fp, cwd));
      const after = applyEdit(before, asStr(ti.old_string), asStr(ti.new_string));
      return synthFileChange(relForDisplay(abs(fp, cwd), cwd), before, after);
    }
    case 'MultiEdit': {
      const fp = asStr(ti.file_path);
      if (!fp) return [];
      const before = readDisk(abs(fp, cwd));
      let after: string | null = before;
      const edits = Array.isArray(ti.edits) ? ti.edits : [];
      for (const raw of edits) {
        const ed = raw as { old_string?: string; new_string?: string };
        after = applyEdit(after, ed.old_string ?? '', ed.new_string ?? '');
      }
      return synthFileChange(relForDisplay(abs(fp, cwd), cwd), before, after);
    }
    case 'NotebookEdit': {
      const fp = asStr(ti.notebook_path);
      const src = asStr(ti.new_source);
      if (!fp || !src) return [];
      // Model the cell's new source as content being ADDED to the notebook. before is ''
      // rather than the notebook JSON on purpose: the additive detectors (skip / any /
      // suppression) get the text about to be written, while the AST count detectors see
      // no phantom "blocks removed" from diffing a cell against a whole notebook.
      return synthFileChange(relForDisplay(abs(fp, cwd), cwd), '', src);
    }
    default:
      // Anything we do not model produces no Change — including read-only tools, which is
      // correct. A tool that mutates files by some path we cannot reconstruct (an arbitrary
      // Bash-driven write, a future edit tool) is NOT silently trusted: it is the Stop
      // sweep's job (SPEC §5.2), which re-derives the turn's real net diff from git.
      return [];
  }
}
