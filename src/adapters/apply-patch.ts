// The OpenAI `apply_patch` envelope → Change[] (#598).
//
// `apply_patch` is the patch format several models drive both Codex and GitHub Copilot CLI
// with (`*** Begin Patch` … `*** End Patch`, with `Add File:` / `Update File:` /
// `Delete File:` sections and an optional `*** Move to:` rename). Both adapters reconstruct
// it into the shared `Change[]` via the same tested diff producer (`synthFileChange`), so the
// engine judges an `apply_patch` mutation identically no matter which runtime issued it.
//
// This module is the single implementation of that reconstruction (previously private to the
// Codex adapter). A hunk that cannot be located against the file on disk THROWS, and every
// caller turns that into a fail-closed deny — the conservative stance: never allow an edit the
// gate could not model.

import { isAbsolute, relative } from 'node:path';
import { Change, FileChange } from '../types';
import { synthFileChange } from './claude/changes';
import { inspectResolved, textOf } from '../disk';

function readDisk(path: string): string | null {
  return textOf(inspectResolved(path));
}

function relForDisplay(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
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

/**
 * Reconstruct the Change[] an `apply_patch` envelope would land. `abs` resolves a
 * section path to an absolute path (from the session cwd); `cwd` is the repository root
 * paths are displayed relative to. An update hunk that cannot be located on disk THROWS.
 */
export function applyPatchChanges(patch: string, abs: (p: string) => string, cwd: string): Change[] {
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
        throw new Error(
          `cannot reconstruct the apply_patch update to ${section.path}: its hunks did not locate against the file on disk`,
        );
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
