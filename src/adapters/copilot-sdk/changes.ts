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

  const newFileContents = typeof args.newFileContents === 'string' ? args.newFileContents : undefined;
  const rawDiff = asStr(args.diff);

  // Reconstruct the proposed `after` from the unified `diff`, bound to the permission request's
  // `fileName`. The diff is parsed by the SHARED producer (`parseDiff`, which needs a `diff --git`
  // envelope) and CRUCIALLY bound to the target — the diff's own header paths are NOT trusted (a
  // payload could name a benign file while authorizing a protected write). Returns the reconstructed
  // `after`, `null` for a shape not reconstructed here (diff-only create → measured-unsupported), or
  // throws (multi-file / mismatched path / malformed zero-hunk / unverifiable hunk) → fail closed.
  let afterFromDiff; // string | undefined; undefined = no diff reconstruction available
  if (rawDiff.trim()) {
    const parsed = parseDiff(toGitDiff(rawDiff, display));
    if (!parsed.length) throw new Error(`write diff for ${path} could not be reconstructed into a change`);
    if (parsed.length > 1) throw new Error(`write diff spans ${parsed.length} files; a single permission target (${display}) was expected`);
    const c = parsed[0];
    if (c.kind !== 'file') throw new Error('write diff did not reconstruct into a file change');
    if (c.path !== display || (c.oldPath != null && c.oldPath !== display)) {
      throw new Error(`write diff path (${c.path}${c.oldPath ? ` from ${c.oldPath}` : ''}) does not match the permission request target (${display}) — refusing to judge a different file`);
    }
    // A true file CREATE is one whose target was ABSENT on disk (`before === null`) — NOT a hunk
    // whose `oldLines === 0`, which is also the shape of a pure INSERTION into an existing file
    // (`@@ -1,0 +2,1 @@`). A diff-only create is a valid shape this milestone does not reconstruct,
    // so it is UNSUPPORTED (measured-incomplete; the end-of-turn sweep is authority) and can never be
    // counted as content-aware proof — unless the full newFileContents is also supplied. An existing
    // file (including an insertion into it) is always reconstructed + validated normally below.
    const isCreate = before === null;
    if (isCreate) {
      if (newFileContents === undefined) return null; // diff-only create → unsupported this milestone
      // create + full content: judge the authoritative newFileContents (no diff cross-check for a create).
    } else {
      // A non-empty modify/insert diff MUST carry at least one successfully parsed hunk — parseDiff
      // skips a malformed `@@` header, which would otherwise collapse to a no-op "nothing changed" allow.
      if (c.hunks.length === 0) throw new Error(`write diff for ${path} carries no valid hunk (malformed) — refusing a no-op reconstruction`);
      // parseDiff carries hunks but not before/after; apply them (conservatively — see
      // applyUnifiedHunks) to recover the full proposed `after`.
      afterFromDiff = applyUnifiedHunks(before, c.hunks);
    }
  }

  if (newFileContents !== undefined) {
    // If both representations are supplied they must AGREE — an inconsistent event (e.g. benign full
    // content beside a weakening diff) is ambiguous and fails closed rather than judging only one.
    if (afterFromDiff !== undefined && afterFromDiff !== newFileContents) {
      throw new Error(`write supplies both newFileContents and a diff that DISAGREE for ${path}; ambiguous request — refusing to judge only one representation`);
    }
    return synthFileChange(display, before, newFileContents);
  }
  if (afterFromDiff !== undefined) return synthFileChange(display, before, afterFromDiff);

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
