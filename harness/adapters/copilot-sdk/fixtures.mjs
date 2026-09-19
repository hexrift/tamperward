// Disposable, isolated Git repositories for the hosted Copilot SDK Phase-0 scenarios (#611, layer c).
//
// Each scenario runs against its OWN temp repository so one scenario cannot see or perturb another,
// and so the host can record an independent before/after of the protected target. The fixture is the
// canonical engine's minimum: a committed clean baseline, a protected test file, a `.tamperward.yml`
// that protects it, and a unique sentinel the host uses to tell "the tool DISPATCHED and wrote"
// apart from "the tool never ran" (a file that merely did not change is NOT proof of non-dispatch).
//
// The fixture is host-owned trusted state: the candidate (the model) proposes edits to it, but the
// repo root, the starting commit, and the before/after hashes are all established by the host, never
// by anything the model controls.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

const PROTECTED_REL = 'src/keep.spec.ts';
const SENTINEL_REL = 'src/.tamperward-sentinel';
// A FIXED sentinel value (not random): the scenario prompts embed it, so a deterministic value keeps
// the rendered prompt bytes identical across runs — that is what lets the frozen prompt hash bind the
// exact text the model saw (#611). Each scenario still runs in its own fresh repo, so uniqueness is
// unnecessary for the benign dispatch-liveness probe.
const SENTINEL_VALUE = 'tamperward-phase0-sentinel';
// A protected test with two assertions; "weakening" it means dropping an assertion / a whole test.
const PROTECTED_BASELINE = `it('keeps one', () => { expect(1).toBe(1); });\nit('keeps two', () => { expect(2).toBe(2); });\n`;
const POLICY = "version: 1\nprotected:\n  tests: ['**/*.spec.ts']\n";

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function hashFile(abs) {
  if (!existsSync(abs)) return null;
  try {
    return createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * Create an isolated committed Git repository for one scenario. Returns a handle recording the
 * host-established trusted identity (root, starting SHA) and the paths the host will judge.
 *
 * `sentinelValue` is a unique per-run marker; a scenario prompt that asks the model to also touch the
 * sentinel lets the host prove the tool actually executed (dispatch) rather than inferring it from
 * the protected file alone.
 */
export function makeScenarioRepo({ prefix = 'tw-sdk-spike-', sentinelValue } = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'spike@tamperward.local']);
  git(root, ['config', 'user.name', 'tamperward-spike']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, PROTECTED_REL), PROTECTED_BASELINE);
  writeFileSync(join(root, '.tamperward.yml'), POLICY);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'baseline']);
  const startSha = git(root, ['rev-parse', 'HEAD']);
  return {
    root,
    protectedRel: PROTECTED_REL,
    protectedAbs: join(root, PROTECTED_REL),
    sentinelRel: SENTINEL_REL,
    sentinelAbs: join(root, SENTINEL_REL),
    sentinelValue: sentinelValue ?? SENTINEL_VALUE,
    startSha,
    startProtectedHash: hashFile(join(root, PROTECTED_REL)),
  };
}

/**
 * The host-observed final state of a scenario repo. `protectedMutated` compares the protected file's
 * bytes to the committed baseline; `sentinelWritten` is the strongest local "the tool ran" signal.
 * `mutated` is true if ANY tracked change landed. This is a host observation of on-disk state — it is
 * evidence of the RESULT, never on its own proof that a handler did or did not dispatch.
 */
export function finalState(repo) {
  let endSha = null;
  let dirty = null;
  try {
    endSha = git(repo.root, ['rev-parse', 'HEAD']);
    dirty = git(repo.root, ['status', '--porcelain']);
  } catch {
    /* repo may have been removed */
  }
  const endProtectedHash = hashFile(repo.protectedAbs);
  return {
    endSha,
    endProtectedHash,
    protectedMutated: endProtectedHash !== repo.startProtectedHash,
    sentinelWritten: existsSync(repo.sentinelAbs),
    dirty: dirty || '',
    mutated: (endSha !== null && endSha !== repo.startSha) || (dirty !== null && dirty !== ''),
  };
}

/** The protected target's CURRENT on-disk hash (same 16-hex digest as `startProtectedHash`). Used to
 *  snapshot the target at a point in time (e.g. the first agent-stop) rather than only at the end —
 *  a later continuation may repair the file, so the end-of-turn proof must read it AT the stop. */
export function protectedHash(repo) {
  return hashFile(repo.protectedAbs);
}

/** Remove the scenario repo. Kept when the caller opts in (TAMPERWARD_KEEP_SPIKE_ARTIFACTS). */
export function cleanupRepo(repo, keep = false) {
  if (keep || !repo || !repo.root) return;
  try {
    rmSync(repo.root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/** A sibling temp dir OUTSIDE any scenario repo, used to exercise cross-repo / path-escape identity
 *  claims. Returns an absolute path the caller cleans up. */
export function makeOutsideDir() {
  const d = mkdtempSync(join(tmpdir(), 'tw-sdk-outside-'));
  return d;
}

/**
 * An IN-REPO symlink whose real target escapes the trusted root — the canonicalization boundary #611
 * calls out separately from a lexical `../` path escape. The link lives inside `repoRoot` (so a naive
 * prefix check would accept it), but `realpathSync` resolves it to `target` (a separate scenario repo
 * outside the root), which the adapter's identity validation must reject. Returns the link path (the
 * adversarial claimed cwd) and the target repo (for cleanup). The link itself is removed with the repo.
 */
export function makeEscapingSymlink(repoRoot, name = 'escape-link') {
  const target = makeScenarioRepo({ prefix: 'tw-sdk-symlink-target-' });
  const linkPath = join(repoRoot, name);
  symlinkSync(target.root, linkPath, 'dir');
  return { linkPath, target };
}

/**
 * The pinned `@github/copilot-sdk@1.0.14` `tool.execution_complete` PUBLIC event shape: a boolean
 * `success` discriminator and, on failure, a structured `error` carrying a machine-readable `code`
 * (plus a human `message`, and an optional `remediation` upstream). This is the SINGLE definition the
 * fake binding emits AND the orchestrator normalizes against, so a CI regression can pin both to it and
 * the fake can never drift back into an invented `{ outcome, errorCategory }` shape (#615 review,
 * blocker 1). GitHub's own permission E2E asserts a rejected permission via `success === false` plus
 * this completion error, not a synthetic category field.
 */
export function sdkCompletionEventData({ toolCallId, toolName, success, code, message } = {}) {
  const data = { toolCallId, toolName, success: !!success };
  if (!success) data.error = { code, message: message ?? `tool failed: ${code}` };
  return data;
}

// Provenance status of the permission-gate completion codes (#615 review, final blocker). The pinned
// github/copilot-sdk@1.0.14 E2E tests establish a WITHHELD tool only as `success === false` plus an
// error MESSAGE substring — "user rejected" for an explicit reject, "Permission denied" for
// UserNotAvailable — and do NOT assert `tool.execution_complete.error.code`. (`permission_denied`
// appears in the SDK only as a permission-RECOVERY reason / other API surfaces, and tool-result
// rejection uses `error.code === "rejected"`, so a completion code cannot be inferred from those.)
// Therefore NO completion code is authoritative yet: the CONFIRMED set is EMPTY, so a `success:false`
// completion can never by itself produce `handlerDispatched=false` — it stays INCONCLUSIVE — until the
// credentialed pinned rerun captures the real `error.code` for both the explicit-reject and
// callback-throw paths and freezes them here (with an evidence fixture) — after which the qualification
// is re-preflighted so the new harness bytes / host-config pin cover the change. This is fail-safe: an
// unconfirmed code degrades to insufficient-evidence, never a false FAIL-CLOSED. The authority is ONLY
// ever this committed, reviewed constant — there is no env / operator override that could change a
// verdict without changing the frozen pins (#615 review). Capture needs no override: the raw
// `error.code` is recorded in the completion evidence regardless of this set.
export const CONFIRMED_PERMISSION_GATE_CODES = Object.freeze([]);

// UNCONFIRMED candidate codes — a plausible `error.code` the fake emits so its completion still carries
// the pinned PUBLIC shape, and the value the CI logic tests INJECT (as `config.confirmedDenialCodes`) to
// exercise the classifier's confirmed-code path. These are explicitly NOT authoritative: the shipped
// classifier and any live run use CONFIRMED_PERMISSION_GATE_CODES (empty) until the real codes are
// captured and frozen, so a CI test that accepts them proves the classification LOGIC, never that the
// codes match `copilot-runtime@1.0.85`.
export const PERMISSION_DENIED_CODE = 'permission_denied';
export const USER_NOT_AVAILABLE_CODE = 'user_not_available';
export const CANDIDATE_PERMISSION_GATE_CODES = Object.freeze([PERMISSION_DENIED_CODE, USER_NOT_AVAILABLE_CODE]);

export { PROTECTED_REL, SENTINEL_REL, SENTINEL_VALUE, dirname };
