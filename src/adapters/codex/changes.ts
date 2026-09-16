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
import { Change, FileChange } from '../../types';
import { ProposedOperation } from '../contract';
import { applyEdit, synthFileChange } from '../claude/changes';
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
    return argv.length ? [{ kind: 'command', raw: argv.join(' '), argv }] : [];
  }
  const raw = asStr(cmd);
  return raw ? [{ kind: 'command', raw, argv: raw.split(/\s+/) }] : [];
}

/** A single `*** ... File:` section of an apply_patch envelope. */
interface PatchSection {
  op: 'add' | 'update' | 'delete';
  path: string;
  moveTo?: string;
  body: string[];
}

function parsePatchSections(patch: string): PatchSection[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && !/^\*\*\* Begin Patch/.test(lines[i])) i++;
  if (i >= lines.length) throw new Error('apply_patch payload has no "*** Begin Patch" header');
  i++;
  const sections: PatchSection[] = [];
  let current: PatchSection | null = null;
  const flush = () => {
    if (current) sections.push(current);
    current = null;
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (/^\*\*\* End Patch/.test(line)) {
      flush();
      return sections;
    }
    const add = /^\*\*\* Add File: (.*)$/.exec(line);
    const upd = /^\*\*\* Update File: (.*)$/.exec(line);
    const del = /^\*\*\* Delete File: (.*)$/.exec(line);
    const move = /^\*\*\* Move to: (.*)$/.exec(line);
    if (add) {
      flush();
      current = { op: 'add', path: add[1].trim(), body: [] };
    } else if (upd) {
      flush();
      current = { op: 'update', path: upd[1].trim(), body: [] };
    } else if (del) {
      flush();
      current = { op: 'delete', path: del[1].trim(), body: [] };
    } else if (move && current) {
      current.moveTo = move[1].trim();
    } else if (current) {
      current.body.push(line);
    }
  }
  throw new Error('apply_patch payload is missing its "*** End Patch" trailer');
}

/** The content of a new file: the `+`-prefixed body lines, additions only. */
function addedContent(body: string[]): string {
  return body.filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n');
}

/** Apply an Update section's hunks to the disk content, locating each hunk by its
 *  context/deletion block and splicing the context/addition block in its place. A hunk
 *  that cannot be located returns null → the caller fails closed. */
function applyUpdate(before: string, body: string[]): string | null {
  const lines = before.split('\n');
  const hunks: string[][] = [];
  let hunk: string[] = [];
  for (const l of body) {
    if (l.startsWith('@@')) {
      if (hunk.length) hunks.push(hunk);
      hunk = [];
      continue;
    }
    hunk.push(l);
  }
  if (hunk.length) hunks.push(hunk);

  let cursor = 0;
  for (const h of hunks) {
    const oldBlock: string[] = [];
    const newBlock: string[] = [];
    for (const l of h) {
      if (l === '') {
        oldBlock.push('');
        newBlock.push('');
      } else if (l.startsWith(' ')) {
        oldBlock.push(l.slice(1));
        newBlock.push(l.slice(1));
      } else if (l.startsWith('-')) {
        oldBlock.push(l.slice(1));
      } else if (l.startsWith('+')) {
        newBlock.push(l.slice(1));
      } else {
        return null; // an unrecognised body line — do not guess
      }
    }
    if (oldBlock.length === 0) return null; // a hunk with no anchor cannot be safely located
    let at = -1;
    for (let s = cursor; s <= lines.length - oldBlock.length; s++) {
      let ok = true;
      for (let k = 0; k < oldBlock.length; k++) {
        if (lines[s + k] !== oldBlock[k]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        at = s;
        break;
      }
    }
    if (at < 0) return null;
    lines.splice(at, oldBlock.length, ...newBlock);
    cursor = at + newBlock.length;
  }
  return lines.join('\n');
}

function applyPatchChanges(patch: string, abs: (p: string) => string, cwd: string): Change[] {
  const out: Change[] = [];
  for (const section of parsePatchSections(patch)) {
    const targetRel = relForDisplay(abs(section.moveTo ?? section.path), cwd);
    if (section.op === 'add') {
      out.push(...synthFileChange(targetRel, null, addedContent(section.body)));
    } else if (section.op === 'delete') {
      out.push(...synthFileChange(targetRel, readDisk(abs(section.path)), null));
    } else {
      const before = readDisk(abs(section.path));
      const after = applyUpdate(before ?? '', section.body);
      if (after === null) {
        throw new Error(`cannot reconstruct the apply_patch update to ${section.path}: its hunks did not locate against the file on disk`);
      }
      const synth = synthFileChange(targetRel, before, after);
      if (section.moveTo && section.moveTo !== section.path) {
        // A rename: name the origin so the rename-aware detectors see it, keeping the
        // reconstructed before/after content.
        out.push(...synth.map((c): FileChange => ({ ...c, op: 'rename', oldPath: relForDisplay(abs(section.path), cwd) })));
      } else {
        out.push(...synth);
      }
    }
  }
  return out;
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
