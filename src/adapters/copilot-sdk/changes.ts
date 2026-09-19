// GitHub Copilot SDK write PermissionRequest → Change[] (#482 / #611, EXPERIMENTAL).
//
// A hosted-SDK `write` permission request surfaces the proposed change (a unified `diff`, and
// optionally the full `newFileContents`) alongside the target `fileName`. This reconstructs that
// into the shared `Change[]` shape the engine already judges — so content-aware pre-deny reuses
// the SAME detectors as every other surface, no new verdict path.
//
// TamperWard does NOT re-implement unified-diff semantics. Reconstruction is delegated to canonical
// Git: for a write carrying a `diff` we seed an isolated, host-owned temp tree with the EXACT current
// target bytes, bind the patch to a fixed in-tree name (the diff's own header paths are validated
// against the permission request's `fileName` but never trusted for application), and run
// `git apply --check` then `git apply`. The reconstructed file is read back and passed as the exact
// `after`. Any parse/apply failure — stale context, an overlapping hunk, a malformed header, a patch
// naming a different file — makes Git refuse, and we FAIL CLOSED (the caller turns the throw into a
// deny), the conservative stance for an unproven runtime.
//
// Reconstruction is CONDITIONAL on what the runtime actually provides:
//   - a usable `diff` → reconstructed by Git as above;
//   - `newFileContents` present → the authoritative `after`; if a `diff` is ALSO present the two
//     must byte-match (an inconsistent event is ambiguous and fails closed);
//   - neither → `null`, signalling this measured configuration surfaces no usable content, so the
//     adapter reports `unsupported` (allow-through; the end-of-turn sweep is the authority) rather
//     than blanket-denying the write.
//
// `DiskEntry.kind` is preserved: only an ABSENT target is a create; an existing target that cannot
// be read (directory, symlink-to-nonfile, oversize, irregular, read error) fails closed rather than
// being treated as a create.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, join, dirname } from 'node:path';
import { Change } from '../../types';
import { synthFileChange } from '../claude/changes';
import { inspectResolved, textOf } from '../../disk';

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
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
  const display = relForDisplay(abs, cwd);

  // Preserve DiskEntry.kind: only an ABSENT target is a create. An existing target the gate cannot
  // read (directory/symlink-to-nonfile/oversize/irregular/read error → content null) fails closed
  // rather than being reconstructed against a phantom empty "before".
  const entry = inspectResolved(abs);
  const isCreate = entry.kind === 'absent';
  const before = textOf(entry);
  if (!isCreate && before === null) {
    throw new Error(`write target ${display} exists but cannot be read to judge it (${entry.kind})`);
  }

  const newFileContents = typeof args.newFileContents === 'string' ? args.newFileContents : undefined;
  const rawDiff = asStr(args.diff);

  // Reconstruct the proposed `after` from the unified `diff` via canonical Git, bound to the
  // permission request's target. Returns the reconstructed `after`, or throws (multi-file /
  // mismatched path / malformed / stale context / overlap) → the caller fails closed.
  const afterFromDiff = rawDiff.trim() ? reconstructAfterViaGit(rawDiff, display, before, isCreate) : undefined;

  if (newFileContents !== undefined) {
    // If both representations are supplied they must AGREE — an inconsistent event (e.g. benign full
    // content beside a weakening diff) is ambiguous and fails closed rather than judging only one.
    if (afterFromDiff !== undefined && afterFromDiff !== newFileContents) {
      throw new Error(`write supplies both newFileContents and a diff that DISAGREE for ${display}; ambiguous request — refusing to judge only one representation`);
    }
    return synthFileChange(display, before, newFileContents);
  }
  if (afterFromDiff !== undefined) return synthFileChange(display, before, afterFromDiff);

  return null; // no usable content surfaced → the caller reports unsupported
}

const TARGET = 'target'; // fixed, escape-free in-tree name the patch is bound to for application

/** Strip a leading `a/` or `b/` path prefix; leave `/dev/null` untouched. */
function stripPrefix(p: string): string {
  return /^[ab]\//.test(p) ? p.slice(2) : p;
}

/**
 * Reconstruct the proposed `after` bytes by applying `rawDiff` with canonical Git, in an isolated
 * host-owned temp tree. The diff's own header paths are VALIDATED against `display` (a diff naming a
 * different file, or spanning multiple files, is refused) but never used to place the write — the
 * patch is rebound to a fixed in-tree name, so a path-escaping or mismatched header cannot steer the
 * reconstruction at a real path. `git apply --check` then `git apply` own every unified-diff rule
 * (context match, hunk order, counts); any refusal throws and the caller fails closed.
 */
function reconstructAfterViaGit(rawDiff: string, display: string, before: string | null, isCreate: boolean): string {
  const patch = canonicalPatch(rawDiff, display, isCreate);
  const dir = mkdtempSync(join(tmpdir(), 'hf-sdk-apply-'));
  try {
    const targetPath = join(dir, TARGET);
    if (!isCreate) writeFileSync(targetPath, before ?? '');
    const patchPath = join(dir, 'change.patch');
    mkdirSync(dirname(patchPath), { recursive: true });
    writeFileSync(patchPath, patch);
    // --check first so a non-applying patch (stale context, overlap, bad counts) is refused before
    // any write; then apply. Both run with cwd = the temp tree, so `-p1` (git's default) maps the
    // bound `a/target` / `b/target` headers onto TARGET and nowhere else.
    execFileSync('git', ['apply', '--check', patchPath], { cwd: dir });
    execFileSync('git', ['apply', patchPath], { cwd: dir });
    return readFileSync(targetPath, 'utf8');
  } catch (e) {
    throw new Error(`could not reconstruct the write to ${display} from its diff via git apply: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Turn a raw unified diff into a single-file patch bound to a fixed in-tree name, ready for
 * `git apply`. Validates the trust boundary FIRST: every file path the diff declares (via
 * `diff --git`, `---`, `+++`) must, after stripping the `a/`/`b/` prefix, equal `display`, and the
 * diff must name exactly one file. A create is anchored to `/dev/null`; a modify to `a/target`. The
 * hunk body is taken verbatim from the first `@@` so Git — not this code — interprets it. Any
 * multi-file, mismatched-path, or hunkless input throws → the caller fails closed.
 */
function canonicalPatch(raw: string, display: string, isCreate: boolean): string {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');

  let fileHeaders = 0;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const parts = line.slice('diff --git '.length).trim().split(/\s+/);
      for (const p of parts) assertBound(stripPrefix(p), display);
    } else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      if (line.startsWith('+++ ')) fileHeaders++;
      const p = line.slice(4).split('\t')[0].trim();
      if (p !== '/dev/null') assertBound(stripPrefix(p), display);
    }
  }
  if (fileHeaders > 1) {
    throw new Error(`write diff spans ${fileHeaders} files; a single permission target (${display}) was expected`);
  }

  const at = lines.findIndex((l) => l.startsWith('@@ '));
  if (at < 0) throw new Error(`write diff for ${display} has no hunk to reconstruct`);
  const body = lines.slice(at);
  // A second file's headers appearing inside the hunk body is multi-file input we did not bind above.
  for (const l of body) {
    if (l.startsWith('diff --git ') || l.startsWith('--- ') || l.startsWith('+++ ')) {
      throw new Error(`write diff for ${display} carries interleaved file headers; only a single-file patch is reconstructed`);
    }
  }

  const source = isCreate ? '/dev/null' : `a/${TARGET}`;
  const header = `--- ${source}\n+++ b/${TARGET}\n`;
  const joined = body.join('\n');
  return header + (joined.endsWith('\n') ? joined : joined + '\n');
}

function assertBound(declared: string, display: string): void {
  if (declared !== display) {
    throw new Error(`write diff path (${declared}) does not match the permission request target (${display}) — refusing to judge a different file`);
  }
}
