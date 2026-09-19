// GitHub Copilot SDK write PermissionRequest → Change[] (#482 / #611, EXPERIMENTAL).
//
// A hosted-SDK `write` permission request surfaces the proposed change (a unified `diff`, and
// optionally the full `newFileContents`) alongside the target `fileName`. This reconstructs that
// into the shared `Change[]` shape the engine already judges — so content-aware pre-deny reuses
// the SAME detectors as every other surface, no new verdict path.
//
// TamperWard does NOT re-implement unified-diff semantics. Reconstruction is delegated to canonical
// Git: for a write carrying a `diff` we seed an isolated, host-owned temp tree with the EXACT current
// target bytes, bind the patch to a fixed in-tree name, and run `git apply --numstat` (single-file
// binding), `git apply --check`, then `git apply`. The reconstructed file is read back and passed as
// the exact `after`. Any parse/apply failure — stale context, an overlapping hunk, a malformed
// header, a patch naming a different or multiple files — makes Git refuse, and we FAIL CLOSED (the
// caller turns the throw into a deny), the conservative stance for an unproven runtime.
//
// The EXACT proposed operation is preserved, never normalized: the raw diff's `/dev/null` endpoints
// decide create vs delete vs modify, that operation is validated against the observed disk state
// (a create whose target already exists, or a modify/delete whose target is absent, fails closed),
// and it is that operation — not one re-inferred locally — that Git reconstructs. Rename / copy /
// binary / mode-only shapes are rejected explicitly.
//
// The reconstruction work is BOUNDED before Git is ever spawned: a candidate-controlled diff past the
// operator-owned byte/line budget fails closed, and both Git invocations run under a strict timeout
// and output cap — TamperWard must not manufacture the very decision-path delay #611 is measuring.
//
// Reconstruction is CONDITIONAL on what the runtime provides:
//   - a usable `diff` → reconstructed by Git as above;
//   - `newFileContents` present → the authoritative `after`; if a `diff` is ALSO present the
//     Git-reconstructed result must byte-match it (an inconsistent event is ambiguous → fail closed);
//   - neither → `null`, so the adapter reports `unsupported` (allow-through; the end-of-turn sweep is
//     the authority) rather than blanket-denying the write.
//
// `DiskEntry.kind` is preserved: only an ABSENT target is a create; an existing target that cannot be
// read (directory, symlink-to-nonfile, oversize, irregular, read error) fails closed.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, join } from 'node:path';
import { Change } from '../../types';
import { synthFileChange } from '../claude/changes';
import { inspectResolved, textOf } from '../../disk';

// ── Operator-owned budget for reconstructing an incoming SDK write (same principle as
// src/adapters/claude/changes.ts) ──
//
// `git apply` runs synchronously INSIDE the permission callback, before the host can answer, so an
// unbounded or pathological candidate-proposed diff could stall the pre-action decision — and #611's
// decisive unknown is exactly what the runtime does when that decision is delayed. So the raw diff is
// bounded BEFORE Git is spawned (a `synthFileChange` ceiling afterwards is too late — the expensive
// work has already happened), and both Git invocations run under a strict timeout and output cap.
// Anything past the budget, or a Git call that times out / overflows, FAILS CLOSED. All operator-
// tunable by the same env knobs the Claude path uses.
const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const APPLY_TIMEOUT_MS = (): number => num('TAMPERWARD_RECONSTRUCT_TIMEOUT_MS', 5000);
const APPLY_MAXBUFFER = (): number => num('TAMPERWARD_RECONSTRUCT_MAXBUFFER', 32 * 1024 * 1024);
const DIFF_MAX_BYTES = (): number => num('TAMPERWARD_RECONSTRUCT_MAX_BYTES', 384 * 1024);
const DIFF_MAX_LINES = (): number => num('TAMPERWARD_RECONSTRUCT_MAX_LINES', 4000);

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function relForDisplay(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

/** The canonical location of a write target: its absolute symlink-resolved path and the root-relative
 *  spelling policy and `Change.path` must use (never the alias the request named). */
interface ContainedTarget {
  /** Absolute, symlink-resolved path of the target (or, for a create, its resolved parent + tail). */
  real: string;
  /** `real` relative to the trusted root — the spelling disk inspection and policy judge. */
  rel: string;
}

/**
 * The canonical, symlink-resolved location of `abs`, proven to lie under the trusted repository
 * `root`, or a throw (fail closed). The deepest EXISTING ancestor is resolved with `realpathSync`
 * (following any symlink to where it points now) and the not-yet-existing tail re-attached, so an
 * existing target, and the parent that would hold a create, are both checked against the root's real
 * path. A target at, above, or outside the root — lexically (`../`, absolute) or via a symlink whose
 * real target escapes — is refused. The returned root-relative `rel` is the spelling to inspect and
 * judge: an in-repo `alias.yml → .tamperward.yml` resolves to `.tamperward.yml`, so a protected
 * target cannot be reached under a benign alias.
 */
function canonicalContainedTarget(abs: string, root: string): ContainedTarget {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (e) {
    throw new Error(`trusted repository root ${root} cannot be resolved: ${e instanceof Error ? e.message : String(e)}`);
  }
  let dir = abs;
  const tail: string[] = [];
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root reached with nothing existing
    tail.unshift(basename(dir));
    dir = parent;
  }
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch (e) {
    throw new Error(`write target ${abs} cannot be resolved: ${e instanceof Error ? e.message : String(e)}`);
  }
  const real = tail.length ? join(realDir, ...tail) : realDir;
  const rel = relative(realRoot, real);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`write target ${abs} resolves outside the trusted repository root ${realRoot} — refusing to judge a write beyond the repository`);
  }
  return { real, rel };
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

  // Bind the target to the trusted repository root BEFORE any disk read (#611 identity matrix): a
  // `../` escape, an absolute path outside the root, or an in-repo symlink whose real target leaves
  // the root fails CLOSED — `relForDisplay` only changes presentation, it does not contain. The SDK's
  // `resolvedPath`, when present, is an UNTRUSTED claim compared against the host-derived canonical
  // target (mismatch → deny), never used as the authority.
  const canonical = canonicalContainedTarget(abs, cwd);
  const claimedResolved = asStr(args.resolvedPath);
  if (claimedResolved && canonicalContainedTarget(resolve(base, claimedResolved), cwd).real !== canonical.real) {
    throw new Error(`the runtime-claimed resolvedPath (${claimedResolved}) does not match the host-derived target for ${path} — refusing to judge a different path`);
  }
  // Disk inspection, `Change.path` and policy use the CANONICAL root-relative spelling (so an in-repo
  // alias to a protected file is judged as that protected file); the request's own spelling is kept
  // ONLY to bind the raw diff's headers, which name the file as the request did.
  const display = canonical.rel;
  const requestRel = relForDisplay(abs, cwd);

  // Preserve DiskEntry.kind: only an ABSENT target is a create. An existing target the gate cannot
  // read (directory/symlink-to-nonfile/oversize/irregular/read error → content null) fails closed
  // rather than being reconstructed against a phantom empty "before".
  const entry = inspectResolved(canonical.real);
  const isCreate = entry.kind === 'absent';
  const before = textOf(entry);
  if (!isCreate && before === null) {
    throw new Error(`write target ${display} exists but cannot be read to judge it (${entry.kind})`);
  }

  const newFileContents = typeof args.newFileContents === 'string' ? args.newFileContents : undefined;
  const rawDiff = asStr(args.diff);

  // Reconstruct the proposed `after` from the unified `diff` via canonical Git, bound to the
  // permission request's target (its own path spelling) and its exact operation. `undefined` = no
  // diff supplied; a `string` is the reconstructed content; `null` is a real deletion; a throw → the
  // caller fails closed.
  const afterFromDiff: string | null | undefined = rawDiff.trim() ? reconstructAfterViaGit(rawDiff, requestRel, before, isCreate) : undefined;

  if (newFileContents !== undefined) {
    // If both representations are supplied they must AGREE — an inconsistent event (e.g. benign full
    // content beside a weakening diff, or a delete diff beside full content) is ambiguous and fails
    // closed rather than judging only one.
    if (afterFromDiff !== undefined && afterFromDiff !== newFileContents) {
      throw new Error(`write supplies both newFileContents and a diff that DISAGREE for ${display}; ambiguous request — refusing to judge only one representation`);
    }
    return synthFileChange(display, before, newFileContents);
  }
  if (afterFromDiff !== undefined) return synthFileChange(display, before, afterFromDiff);

  return null; // no usable content surfaced → the caller reports unsupported
}

const TARGET = 'target'; // fixed, escape-free in-tree name the patch is bound to for application

type DiffOp = 'create' | 'delete' | 'modify';

/** Strip a leading `a/` or `b/` path prefix; leave `/dev/null` untouched. */
function stripPrefix(p: string): string {
  return /^[ab]\//.test(p) ? p.slice(2) : p;
}

/**
 * Reconstruct the proposed `after` (a `string`, or `''` for a full delete which the caller reads as
 * a deletion) by applying `rawDiff` with canonical Git, in an isolated host-owned temp tree. The
 * diff is bound to a fixed in-tree name and its exact operation; `git apply --numstat` proves it
 * touches exactly that one file, and `--check` then `apply` own every unified-diff rule. Any refusal
 * — or a Git call that exceeds the time/output budget — throws and the caller fails closed.
 *
 * For a delete, Git removes the file; the returned `after` is `null`, so the shared engine judges a
 * real deletion of the target rather than an empty-file modify.
 */
function reconstructAfterViaGit(rawDiff: string, display: string, before: string | null, isCreate: boolean): string | null {
  const bytes = Buffer.byteLength(rawDiff);
  if (bytes > DIFF_MAX_BYTES()) throw new Error(`write diff for ${display} is ${bytes} bytes (over the ${DIFF_MAX_BYTES()}-byte reconstruction budget)`);
  const { op, patch } = canonicalPatch(rawDiff, display, isCreate);

  const dir = mkdtempSync(join(tmpdir(), 'hf-sdk-apply-'));
  try {
    const targetPath = join(dir, TARGET);
    if (op !== 'create') writeFileSync(targetPath, before ?? '');
    const patchPath = join(dir, 'change.patch');
    writeFileSync(patchPath, patch);
    const git = (extra: string[]): string =>
      execFileSync('git', ['apply', ...extra, patchPath], {
        cwd: dir,
        encoding: 'utf8',
        timeout: APPLY_TIMEOUT_MS(),
        maxBuffer: APPLY_MAXBUFFER(),
        killSignal: 'SIGKILL',
      });
    // --numstat proves single-file binding before any write: an interleaved second file (git can tell
    // a real header from a hunk-body line that merely starts with `---`, this code cannot) is refused.
    const stat = git(['--numstat']).trim();
    const rows = stat ? stat.split('\n') : [];
    if (rows.length !== 1) throw new Error(`write diff spans ${rows.length} files; a single permission target (${display}) was expected`);
    const statPath = rows[0].split('\t')[2];
    if (statPath !== TARGET) throw new Error(`write diff reconstructs a different file (${statPath}) than the bound target`);
    // --check validates the patch actually applies (context, hunk order/counts, bounds); then apply.
    git(['--check']);
    git([]);
    // A delete removes the file → `after` is null (a real deletion the engine judges), never an
    // empty-file modify. A create/modify reads back the reconstructed bytes (a missing file here
    // would be an anomaly → readFileSync throws → the caller fails closed).
    return op === 'delete' ? null : readFileSync(targetPath, 'utf8');
  } catch (e) {
    throw new Error(`could not reconstruct the write to ${display} from its diff via git apply: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Turn a raw unified diff into a single-file patch bound to a fixed in-tree name AND its exact
 * operation, ready for `git apply`. Only the header block BEFORE the first hunk is parsed for file
 * identity (a hunk-body line can legitimately begin `---`/`+++`, so scanning the whole diff would
 * false-deny valid patches — Git owns the hunk body). Validates the trust boundary: every declared
 * path must equal `display`; the `/dev/null` endpoints decide create/delete/modify; that operation
 * must match the observed disk state; rename/copy/binary/mode-only shapes are rejected. Any
 * multi-file, mismatched-path, contradictory, or hunkless input throws → the caller fails closed.
 */
function canonicalPatch(raw: string, display: string, isCreate: boolean): { op: DiffOp; patch: string } {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > DIFF_MAX_LINES()) {
    throw new Error(`write diff for ${display} is ${lines.length} lines (over the ${DIFF_MAX_LINES()}-line reconstruction budget)`);
  }

  const at = lines.findIndex((l) => l.startsWith('@@ '));
  if (at < 0) throw new Error(`write diff for ${display} has no hunk to reconstruct`);
  const header = lines.slice(0, at);
  const body = lines.slice(at);

  // The pre-hunk grammar is TOTAL: every non-blank line before the first hunk must be one this code
  // explicitly understands, and each carries its meaning through — nothing is recognized-then-
  // discarded. An unknown line, a duplicate, or metadata that contradicts the derived operation fails
  // CLOSED, so a malformed / internally contradictory event is never repaired into a valid proposal.
  let src: string | undefined; // stripped `--- ` endpoint
  let dst: string | undefined; // stripped `+++ ` endpoint
  let hasGitLine = false; // a `diff --git` header — at most one for a single file
  let sawCreateMode = false; // `new file mode` — only valid with a create endpoint pair
  let sawDeleteMode = false; // `deleted file mode` — only valid with a delete endpoint pair
  let sawSemanticHeader = false; // any operation-bearing metadata → a full endpoint pair is required
  for (const line of header) {
    if (line.trim() === '') continue; // tolerate blank lines
    if (line.startsWith('diff --git ')) {
      if (hasGitLine) throw new Error(`write diff for ${display} carries more than one diff --git header (contradictory / multi-file) — refusing to reconstruct`);
      hasGitLine = true;
      sawSemanticHeader = true;
      for (const p of line.slice('diff --git '.length).trim().split(/\s+/)) assertBound(stripPrefix(p), display);
    } else if (line.startsWith('--- ')) {
      if (src !== undefined) throw new Error(`write diff for ${display} carries more than one --- endpoint (contradictory header) — refusing to reconstruct`);
      src = line.slice(4).split('\t')[0].trim();
    } else if (line.startsWith('+++ ')) {
      if (dst !== undefined) throw new Error(`write diff for ${display} carries more than one +++ endpoint (contradictory header) — refusing to reconstruct`);
      dst = line.slice(4).split('\t')[0].trim();
    } else if (line.startsWith('index ')) {
      sawSemanticHeader = true; // accompanies any op; validated only by the endpoints below
    } else if (/^new file mode\b/.test(line)) {
      if (sawCreateMode) throw new Error(`write diff for ${display} carries duplicate new file mode metadata — refusing to reconstruct`);
      sawCreateMode = true;
      sawSemanticHeader = true;
    } else if (/^deleted file mode\b/.test(line)) {
      if (sawDeleteMode) throw new Error(`write diff for ${display} carries duplicate deleted file mode metadata — refusing to reconstruct`);
      sawDeleteMode = true;
      sawSemanticHeader = true;
    } else {
      // rename/copy/mode-change/binary/similarity metadata, or anything else this code does not
      // model, is not reconstructed — fail closed rather than silently strip it.
      throw new Error(`write diff for ${display} carries an unsupported or unrecognized pre-hunk header line ("${line.trim().slice(0, 60)}") — refusing to reconstruct`);
    }
  }

  // Derive the EXACT proposed operation from the `/dev/null` endpoints, never re-inferred from local
  // state or repaired from a malformed event. The contract is explicit:
  //   - BOTH endpoints absent → bare-hunk mode: infer create/modify from the observed target state
  //     (never a delete, which requires a `+++ /dev/null` header). Any operation-bearing metadata,
  //     however, promises a full endpoint pair, so its presence without one is malformed.
  //   - BOTH present → validate exact create/delete/modify semantics.
  //   - EXACTLY ONE present → malformed one-sided pair → fail closed (not normalized into a valid op).
  let op: DiffOp;
  if (src === undefined && dst === undefined) {
    if (sawSemanticHeader) throw new Error(`write diff for ${display} carries Git file metadata but no --- / +++ endpoints (malformed)`);
    op = isCreate ? 'create' : 'modify';
  } else if (src !== undefined && dst !== undefined) {
    const srcNull = src === '/dev/null';
    const dstNull = dst === '/dev/null';
    if (srcNull && dstNull) throw new Error(`write diff for ${display} has /dev/null on both sides`);
    if (!srcNull) assertBound(stripPrefix(src), display);
    if (!dstNull) assertBound(stripPrefix(dst), display);
    op = srcNull ? 'create' : dstNull ? 'delete' : 'modify';
  } else {
    throw new Error(`write diff for ${display} has a one-sided --- / +++ endpoint pair (malformed) — refusing to repair it into a valid operation`);
  }

  // Operation-bearing metadata must AGREE with the derived operation — `new file mode` only on a
  // create, `deleted file mode` only on a delete — or the event is internally contradictory.
  if (sawCreateMode && op !== 'create') throw new Error(`write diff for ${display} carries new file mode metadata but its endpoints describe a ${op} — contradictory, refusing to reconstruct`);
  if (sawDeleteMode && op !== 'delete') throw new Error(`write diff for ${display} carries deleted file mode metadata but its endpoints describe a ${op} — contradictory, refusing to reconstruct`);

  // The proposed operation must agree with the observed disk state, or the event is inconsistent and
  // fails closed rather than being normalized into whatever the local state would suggest.
  if (op === 'create' && !isCreate) throw new Error(`write diff for ${display} proposes a create but the target already exists`);
  if (op !== 'create' && isCreate) throw new Error(`write diff for ${display} proposes a ${op} but the target is absent`);

  const source = op === 'create' ? '/dev/null' : `a/${TARGET}`;
  const dest = op === 'delete' ? '/dev/null' : `b/${TARGET}`;
  const joined = body.join('\n');
  const patch = `--- ${source}\n+++ ${dest}\n` + (joined.endsWith('\n') ? joined : joined + '\n');
  return { op, patch };
}

function assertBound(declared: string, display: string): void {
  if (declared !== display) {
    throw new Error(`write diff path (${declared}) does not match the permission request target (${display}) — refusing to judge a different file`);
  }
}
