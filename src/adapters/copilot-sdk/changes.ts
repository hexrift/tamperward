// GitHub Copilot SDK write PermissionRequest → Change[] (#482 / #611, EXPERIMENTAL).
//
// A hosted-SDK `write` permission request surfaces the proposed change (a unified `diff`, and
// optionally the full `newFileContents`) alongside the target `fileName`. This reconstructs that
// into the shared `Change[]` shape the engine already judges — so content-aware pre-deny reuses
// the SAME detectors as every other surface, no new verdict path. Reconstruction is CONDITIONAL on
// what the runtime actually provides:
//
//   - `newFileContents` present → exact before→after reconstruction via the shared `synthFileChange`;
//   - else a usable `diff` → parsed by the shared `parseDiff` (the same producer the CI / pre-commit
//     path judges), with a synthetic file header added from `fileName` when the raw diff omits one;
//   - neither → `null`, signalling this measured configuration surfaces no usable content, so the
//     adapter reports `unsupported` (allow-through; the end-of-turn sweep is the authority) rather
//     than blanket-denying the write.
//
// A write that carries a path but a diff that cannot be reconstructed THROWS, and the caller turns
// that into a fail-closed deny — the conservative stance for an unproven runtime (never allow an
// edit the gate could not model), matching src/adapters/copilot/changes.ts.

import { isAbsolute, relative, resolve } from 'node:path';
import { Change } from '../../types';
import { synthFileChange } from '../claude/changes';
import { parseDiff } from '../../diff/parse';
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

/**
 * Reconstruct the Change[] a Copilot SDK write would land, or `null` when the runtime surfaced no
 * usable content (measured-unsupported). `cwd` is the repository root paths display relative to;
 * `base` is where a RELATIVE tool path resolves from (the session cwd).
 */
export function sdkFileEditChanges(args: Record<string, unknown>, cwd: string, base: string = cwd): Change[] | null {
  const path = asStr(args.path) || asStr(args.fileName) || asStr(args.file_path);
  if (!path) throw new Error('write event carries no fileName/path to reconstruct');
  const abs = resolve(base, path);
  const before = readDisk(abs);
  const display = relForDisplay(abs, cwd);

  // Exact content wins: the full proposed file content reconstructs the change precisely.
  if (typeof args.newFileContents === 'string') {
    return synthFileChange(display, before, args.newFileContents);
  }

  // Otherwise a unified diff, parsed by the shared producer. Add a header from the fileName when the
  // raw diff omits one, so the change binds to the intended path.
  const diff = asStr(args.diff);
  if (diff.trim()) {
    const hasHeader = /^\+\+\+ /m.test(diff) || diff.startsWith('diff --git ');
    const withHeader = hasHeader ? diff : `--- a/${display}\n+++ b/${display}\n${diff}`;
    const changes = parseDiff(withHeader);
    if (changes.length) return changes;
    throw new Error(`write diff for ${path} could not be reconstructed into a change`);
  }

  return null; // no usable content surfaced → the caller reports unsupported
}
