// Claude Code agent adapter: turn a PreToolUse tool call into Change[] BEFORE it runs,
// so the cheat path never opens. A Bash call is a command Change; an Edit/Write/MultiEdit/
// NotebookEdit is reconstructed into before/after content (it hasn't touched disk yet) and run
// through `git diff --no-index` so it reuses the same tested parser the git views use —
// one normalization, four producers.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
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

function abs(path: string, cwd: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

function relForDisplay(path: string, cwd: string): string {
  return path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path;
}

function applyEdit(content: string | null, oldStr: string, newStr: string): string {
  if (content === null) return newStr;
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
      raw = execFileSync('git', ['diff', '--no-index', '--no-color', a, b], { encoding: 'utf8' });
    } catch (e) {
      // git diff --no-index exits 1 when the files differ; the patch is on stdout
      const err = e as { stdout?: string | Buffer };
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
