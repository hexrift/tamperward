// GitHub Copilot CLI ProposedOperation → Change[] (#482 / #598, EXPERIMENTAL).
//
// The reconstruction seam only: a Copilot shell op becomes a command Change (the same shape
// the Claude Bash path builds), and a Copilot file write is reconstructed into before/after
// content and handed to the SHARED `synthFileChange` — the one tested diff producer every
// runtime reuses. No new detector logic lives here; the reconstructed Change[] feeds the
// existing engine. A read/search/MCP/unknown op produces no Change, exactly as the Claude and
// Codex adapters model read-only tools, so the engine finds nothing to block on it.
//
// Copilot's documented native file tools (GitHub Copilot hooks reference) are `create`,
// `edit`, `apply_patch` (the OpenAI patch envelope several models drive Copilot with, shared
// with Codex), and `str_replace_editor`; in the PascalCase / Claude-compatible mode they are
// reported as `Write` / `Edit` / `MultiEdit`. `apply_patch` is reconstructed via the shared
// `applyPatchChanges`. `str_replace_editor` is modelled for its `str_replace` and `create`
// sub-operations; any other sub-op (e.g. `insert`) FAILS CLOSED pending a real pinned-run
// payload rather than being guessed. Deletes and renames are issued through the shell
// (`rm` / `mv`), so they reconstruct via the command path.
//
// An edit the adapter cannot faithfully reconstruct THROWS, and the caller (decide) turns
// that into a fail-closed deny — the conservative stance for an unproven runtime: never allow
// an edit the gate could not model.

import { isAbsolute, relative, resolve } from 'node:path';
import { Change } from '../../types';
import { ProposedOperation } from '../contract';
import { applyEdit, synthFileChange } from '../claude/changes';
import { applyPatchChanges } from '../apply-patch';
import { inspectResolved, textOf } from '../../disk';
import { isRecord } from '../../narrow';

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function readDisk(path: string): string | null {
  return textOf(inspectResolved(path));
}

function relForDisplay(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

/** A shell command from `command`, accepting either a raw string or an argv array. The
 *  command Change is identical to the Claude Bash shape so the command detectors judge it
 *  the same way. */
function shellChanges(args: Record<string, unknown>): Change[] {
  const cmd = args.command ?? args.argv;
  if (Array.isArray(cmd)) {
    const argv = cmd.map(asStr).filter((s) => s.length > 0);
    if (!argv.length) throw new Error('shell event carries no command/argv to reconstruct');
    return [{ kind: 'command', raw: argv.join(' '), argv }];
  }
  const raw = asStr(cmd);
  if (!raw) throw new Error('shell event carries no command to reconstruct');
  return [{ kind: 'command', raw, argv: raw.split(/\s+/) }];
}

/**
 * Reconstruct the Change[] a Copilot operation would land, for the pre-action engine pass.
 * `cwd` is the repository root paths are displayed relative to; `base` is where a RELATIVE
 * tool path resolves from (the session cwd). An operation kind that mutates nothing
 * reconstructs to no Change.
 */
export function changesFromCopilot(operation: ProposedOperation, cwd: string, base: string = cwd): Change[] {
  const args = operation.args ?? {};
  const abs = (path: string): string => resolve(base, path);

  if (operation.kind === 'shell') return shellChanges(args);
  if (operation.kind !== 'file-edit') return [];

  const name = (operation.name || '').toLowerCase();

  // apply_patch: the OpenAI patch envelope, reconstructed by the shared parser. The real
  // payload carries the patch text in `input` (with `patch` / `command` as lenient fallbacks).
  if (name === 'apply_patch') {
    const patch = asStr(args.input) || asStr(args.patch) || asStr(args.command);
    if (!patch) throw new Error('apply_patch event carries no input/patch/command to reconstruct');
    return applyPatchChanges(patch, abs, cwd);
  }

  const fp = asStr(args.path) || asStr(args.file_path) || asStr(args.filename);
  if (!fp) throw new Error(`${operation.name || 'file-edit'} event carries no path to reconstruct`);
  const before = readDisk(abs(fp));
  const display = relForDisplay(abs(fp), cwd);

  // str_replace_editor: the Anthropic text-editor tool. Only its mutating sub-ops that can be
  // reconstructed exactly are modelled — `str_replace` (old_str/new_str) and `create`
  // (file_text). Any other sub-op (e.g. `insert`) fails CLOSED rather than being guessed.
  if (name === 'str_replace_editor') {
    const old = args.old_str ?? args.old_string ?? args.old;
    const next = args.new_str ?? args.new_string ?? args.new;
    if (typeof old === 'string' || typeof next === 'string') {
      return synthFileChange(display, before, applyEdit(before, asStr(old), asStr(next), args.replace_all === true));
    }
    const fileText = args.file_text ?? args.content ?? args.text;
    if (typeof fileText === 'string') return synthFileChange(display, before, fileText);
    throw new Error(
      `str_replace_editor sub-op "${asStr(args.command) || 'unknown'}" for ${fp} cannot be reconstructed exactly (only str_replace/create are modelled; others fail closed pending a real payload)`,
    );
  }

  // MultiEdit (PascalCase): a sequence of old/new substitutions applied in order.
  if (Array.isArray(args.edits)) {
    let after: string | null = before;
    for (const raw of args.edits) {
      const ed = isRecord(raw) ? raw : {};
      after = applyEdit(after, asStr(ed.old_string ?? ed.old_str), asStr(ed.new_string ?? ed.new_str), ed.replace_all === true);
    }
    return synthFileChange(display, before, after);
  }

  // edit / Edit: in-place substitution (the same before→after model the Claude Edit path uses).
  const old = args.old_string ?? args.old_str ?? args.old;
  const next = args.new_string ?? args.new_str ?? args.new;
  if (typeof old === 'string' || typeof next === 'string') {
    return synthFileChange(display, before, applyEdit(before, asStr(old), asStr(next), args.replace_all === true));
  }

  // create / Write: the content replaces the file.
  const content = args.content ?? args.text ?? args.file_text;
  if (typeof content === 'string') return synthFileChange(display, before, content);

  throw new Error(
    `${operation.name || 'file-edit'} event for ${fp} carries no old_string/new_string/content to reconstruct`,
  );
}
