// Codex ProposedOperation → Change[] (#482 / #563, EXPERIMENTAL).
//
// The reconstruction seam only: a Codex shell op becomes a command Change (the same shape
// the Claude Bash path builds), and a Codex file edit is reconstructed into before/after
// content and handed to the SHARED `synthFileChange` — the one tested diff producer every
// runtime reuses. No new detector logic lives here; the reconstructed Change[] feeds the
// existing engine. A read/search/MCP/unknown op produces no Change, exactly as the Claude
// adapter models read-only tools, so the engine finds nothing to block on it.
//
// An edit the adapter cannot faithfully reconstruct THROWS, and the caller (decide) turns
// that into a fail-closed deny — the conservative stance for an unproven runtime: never
// allow an edit the gate could not model.

import { isAbsolute, relative, resolve } from 'node:path';
import { Change } from '../../types';
import { ProposedOperation } from '../contract';
import { applyEdit, synthFileChange } from '../claude/changes';
import { applyPatchChanges } from '../apply-patch';
import { inspectResolved, textOf } from '../../disk';

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

/** A shell command from `command`, accepting either a raw string or an argv array (Codex
 *  exec variants pass argv). The command Change is identical to the Claude Bash shape so
 *  the command detectors judge it the same way. */
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
 * Reconstruct the Change[] a Codex operation would land, for the pre-action engine pass.
 * `cwd` is the repository root paths are displayed relative to; `base` is where a RELATIVE
 * tool path resolves from (the session cwd). An operation kind that mutates nothing
 * reconstructs to no Change.
 */
export function changesFromCodex(operation: ProposedOperation, cwd: string, base: string = cwd): Change[] {
  const args = operation.args ?? {};
  const abs = (path: string): string => resolve(base, path);

  if (operation.kind === 'shell') return shellChanges(args);
  if (operation.kind !== 'file-edit') return [];

  if (operation.name === 'apply_patch' || operation.name === 'patch') {
    // The real apply_patch hook payload is `tool_input: { command: "*** Begin Patch ..." }`
    // (codex-rs apply_patch.rs `pre_tool_use_payload`); patch/input are lenient fallbacks.
    const patch = asStr(args.command) || asStr(args.patch) || asStr(args.input);
    if (!patch) throw new Error('apply_patch event carries no command/patch/input to reconstruct');
    return applyPatchChanges(patch, abs, cwd);
  }

  const fp = asStr(args.path) || asStr(args.file_path);
  if (!fp) throw new Error(`${operation.name || 'file-edit'} event carries no path to reconstruct`);
  const before = readDisk(abs(fp));

  const old = args.old_string ?? args.old_str ?? args.old;
  const next = args.new_string ?? args.new_str ?? args.new;
  if (typeof old === 'string' || typeof next === 'string') {
    const after = applyEdit(before, asStr(old), asStr(next), args.replace_all === true);
    return synthFileChange(relForDisplay(abs(fp), cwd), before, after);
  }

  const content = args.content ?? args.text;
  if (typeof content === 'string') {
    return synthFileChange(relForDisplay(abs(fp), cwd), before, content);
  }
  throw new Error(`${operation.name || 'file-edit'} event for ${fp} carries no old_string/new_string/content to reconstruct`);
}
