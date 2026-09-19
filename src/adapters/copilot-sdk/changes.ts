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

  // Otherwise a unified diff, parsed by the SHARED producer (`parseDiff`, which requires a
  // `diff --git` envelope). CRUCIAL (#611 proposal binding): the parsed change is bound to the
  // permission request's `fileName` target — the diff's own header paths are NOT trusted, because a
  // payload could name a benign file in the diff while authorizing a write to a protected one. Any
  // change whose path (or rename oldPath) is not exactly the target, or a multi-file diff, FAILS
  // CLOSED. `newFileContents` above is the exact path; this is the diff fallback.
  const diff = asStr(args.diff);
  if (diff.trim()) {
    const parsed = parseDiff(toGitDiff(diff, display));
    if (!parsed.length) throw new Error(`write diff for ${path} could not be reconstructed into a change`);
    if (parsed.length > 1) throw new Error(`write diff spans ${parsed.length} files; a single permission target (${display}) was expected`);
    const c = parsed[0];
    if (c.kind !== 'file') throw new Error('write diff did not reconstruct into a file change');
    if (c.path !== display || (c.oldPath != null && c.oldPath !== display)) {
      throw new Error(`write diff path (${c.path}${c.oldPath ? ` from ${c.oldPath}` : ''}) does not match the permission request target (${display}) — refusing to judge a different file`);
    }
    // parseDiff carries hunks but not before/after content, so apply the hunks to the on-disk
    // `before` to get the full proposed `after`, then hand the shared `synthFileChange` real
    // before/after so the content detectors judge it (the same shape the newFileContents path uses).
    const after = applyUnifiedHunks(before, c.hunks);
    return synthFileChange(display, before, after);
  }

  return null; // no usable content surfaced → the caller reports unsupported
}

/**
 * Apply parsed unified-diff hunks to `before`, yielding the proposed `after` — CONSERVATIVELY. The
 * reconstructed `after` is what the engine is asked to approve, so a hunk that cannot be located and
 * verified EXACTLY is never guessed (the same principle as src/adapters/apply-patch.ts): every
 * context and deleted line must match the corresponding on-disk `before` line, each hunk's declared
 * old/new line counts must match its body, and hunks must be in-bounds and strictly forward (no
 * overlap/backtracking). Any mismatch THROWS, and the caller turns that into a fail-closed deny.
 */
function applyUnifiedHunks(
  before: string | null,
  hunks: { oldStart: number; oldLines: number; newLines: number; lines: { type: string; content: string }[] }[],
): string {
  const beforeLines = before === null ? [] : before.split('\n');
  const out: string[] = [];
  let cursor = 0; // 0-based index into beforeLines; strictly non-decreasing across hunks
  for (const h of hunks) {
    const start = h.oldStart - 1;
    if (start < cursor) throw new Error('unified diff has overlapping or out-of-order hunks; refusing to reconstruct');
    if (start > beforeLines.length) throw new Error('unified diff hunk starts beyond the end of the file; refusing to reconstruct');
    while (cursor < start) out.push(beforeLines[cursor++]);
    let oldCount = 0;
    let newCount = 0;
    for (const ln of h.lines) {
      if (ln.type === 'context') {
        if (beforeLines[cursor] !== ln.content) throw new Error('unified diff context line does not match the file on disk; refusing to reconstruct');
        out.push(ln.content);
        cursor++;
        oldCount++;
        newCount++;
      } else if (ln.type === 'del') {
        if (beforeLines[cursor] !== ln.content) throw new Error('unified diff deletion line does not match the file on disk; refusing to reconstruct');
        cursor++;
        oldCount++;
      } else if (ln.type === 'add') {
        out.push(ln.content);
        newCount++;
      }
    }
    if (oldCount !== h.oldLines) throw new Error(`unified diff hunk old-line count (${oldCount}) disagrees with its header (${h.oldLines})`);
    if (newCount !== h.newLines) throw new Error(`unified diff hunk new-line count (${newCount}) disagrees with its header (${h.newLines})`);
  }
  while (cursor < beforeLines.length) out.push(beforeLines[cursor++]);
  return out.join('\n');
}

/**
 * Turn a unified diff into a `diff --git`-enveloped diff `parseDiff` accepts, ALWAYS anchored to
 * `target`. When the raw diff already carries a `diff --git` envelope it is used verbatim (its paths
 * are then verified against `target` by the caller, so a mismatching header fails closed rather than
 * being silently rebound). A bare hunk body is wrapped with a header derived from `target`.
 */
function toGitDiff(raw: string, target: string): string {
  if (raw.includes('diff --git ')) return raw;
  const at = raw.indexOf('\n@@');
  const firstAt = raw.startsWith('@@') ? 0 : at >= 0 ? at + 1 : -1;
  if (firstAt < 0) throw new Error('unified diff has no hunk to reconstruct');
  const body = raw.slice(firstAt);
  return `diff --git a/${target} b/${target}\n--- a/${target}\n+++ b/${target}\n${body}`;
}
