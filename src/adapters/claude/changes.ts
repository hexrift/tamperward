// Claude Code agent adapter: turn a PreToolUse tool call into Change[] BEFORE it runs,
// so the cheat path never opens. A Bash call is a command Change; an Edit/Write/MultiEdit
// is reconstructed into before/after content (the change hasn't touched disk yet) and run
// through `git diff --no-index` so it reuses the same tested parser the git views use —
// one normalization, four producers.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { Change, FileChange, FileOp } from '../../types';
import { parseDiff } from '../../diff/parse';

export interface ClaudeHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  stop_hook_active?: boolean;
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
  return content.replace(oldStr, newStr); // first occurrence, matching Edit semantics
}

/** before/after full content → a FileChange with hunks, via the same diff parser. */
export function synthFileChange(displayPath: string, before: string | null, after: string | null): FileChange[] {
  if (before === after) return [];
  let op: FileOp;
  if (before === null) op = 'add';
  else if (after === null) op = 'delete';
  else op = 'modify';

  const dir = mkdtempSync(join(tmpdir(), 'hf-'));
  const a = join(dir, 'a');
  const b = join(dir, 'b');
  writeFileSync(a, before ?? '');
  writeFileSync(b, after ?? '');

  let raw = '';
  try {
    raw = execFileSync('git', ['diff', '--no-index', '--no-color', a, b], { encoding: 'utf8' });
  } catch (e) {
    // git diff --no-index exits 1 when the files differ; the patch is on stdout
    const err = e as { stdout?: string | Buffer };
    raw = err.stdout ? String(err.stdout) : '';
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
    default:
      return [];
  }
}
