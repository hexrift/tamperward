// Local verification receipts, and their CI reconciliation (#601).
//
// A receipt is a BOUNDED, TRANSPORTABLE projection of the first-class
// verification record (#600): after a local `tamperward verify` reaches
// VERIFIED it emits a receipt that binds to the EXACT same load-bearing
// identities #600 already computes — candidate tree fingerprint, entry/base
// commit, HEAD, policy digest, verifier-contract digest, protected surface,
// runtime-intervention wiring and dependency environment. Nothing here invents a
// second notion of "what was verified"; the receipt carries #600's `binding`
// verbatim, plus an `evidence_digest` over its own bounded fields.
//
// The receipt is EVIDENCE, never authority (the #495 separation). CI reruns the
// canonical TamperWard verification independently and computes its OWN verdict
// and identity from trusted inputs; the receipt only makes the AGREEMENT or
// DIVERGENCE between the local claim and CI's adjudication explicit. A stale,
// mismatched, malformed, tampered, unknown-schema or missing receipt can never
// promote or strengthen a CI result — reconciliation's `result` is CI's verdict,
// full stop (see `reconcile`).
//
// The format is deliberately bounded and non-sensitive: only fixed-width digests
// and commit object ids, closed-enum stage results, a verdict and a timestamp. No
// prompt text, source snippets, command bodies, secrets/environment, absolute
// local paths or unbounded logs — the same trust model the verifier/audit
// schemas ship under.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoContext } from './repo-context';
import {
  BINDING_INPUTS,
  firstBindingMismatch,
  type BindingInput,
  type VerificationBinding,
  type VerificationRecord,
} from './verification-state';
import { VERIFY_VERDICTS, type VerifyVerdict } from './machine-output';

/** On-disk/transport format version for the receipt. Independent of the
 *  machine-output `schema_version` and of #600's record version: a receipt whose
 *  version this binary does not understand FAILS SAFE — it is treated as
 *  non-applicable and can never strengthen a CI result. */
export const RECEIPT_SCHEMA_VERSION = 1 as const;

/** The per-stage results a VERIFIED local adjudication implies. Closed
 *  vocabularies, single-sourced to the emitter and the published schema. */
export const RECEIPT_STAGE_RESULTS = ['PASS', 'FAIL'] as const;
export type ReceiptStageResult = (typeof RECEIPT_STAGE_RESULTS)[number];
export const RECEIPT_INTEGRITY_RESULTS = ['CLEAN', 'CHANGED'] as const;
export type ReceiptIntegrityResult = (typeof RECEIPT_INTEGRITY_RESULTS)[number];

/** Bounded per-stage evidence. For a VERIFIED receipt the visible (candidate)
 *  and pristine suites both PASS and the pristine integrity check is CLEAN — the
 *  three facts the CI job summary distinguishes. */
export interface ReceiptStages {
  candidate: ReceiptStageResult;
  pristine: ReceiptStageResult;
  integrity: ReceiptIntegrityResult;
}

/**
 * A local verification receipt. Only a genuine VERIFIED adjudication produces
 * one; a masked failure, red suite or budget exhaustion never does.
 */
export interface VerificationReceipt {
  schema_version: typeof RECEIPT_SCHEMA_VERSION;
  verdict: 'VERIFIED';
  tw_version: string;
  verified_at: string;
  /** #600's load-bearing identity, carried verbatim. */
  binding: VerificationBinding;
  stages: ReceiptStages;
  /** sha256 over the canonical {schema_version, verdict, binding, stages}. Lets a
   *  consumer detect an internally-inconsistent (tampered) receipt without any
   *  other input; it is NOT a substitute for CI's independent identity check. */
  evidence_digest: string;
}

/** How a claimed receipt was interpreted during reconciliation. */
export const RECEIPT_DISPOSITIONS = ['PRESENT', 'ABSENT', 'MALFORMED', 'UNKNOWN_SCHEMA'] as const;
export type ReceiptDisposition = (typeof RECEIPT_DISPOSITIONS)[number];

/** Reconciliation agreement classes between the local claim and CI's verdict. */
export const RECONCILE_AGREEMENTS = ['AGREE', 'DIVERGENCE', 'NON_APPLICABLE', 'NO_CLAIM'] as const;
export type ReconcileAgreement = (typeof RECONCILE_AGREEMENTS)[number];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deterministic JSON with recursively sorted keys — the one canonical form the
 *  evidence digest is taken over, so it depends on content not key order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** The evidence digest for a receipt's identity-bearing fields. */
export function receiptEvidenceDigest(fields: {
  schema_version: typeof RECEIPT_SCHEMA_VERSION;
  verdict: 'VERIFIED';
  binding: VerificationBinding;
  stages: ReceiptStages;
}): string {
  const canonical = {
    schema_version: fields.schema_version,
    verdict: fields.verdict,
    binding: BINDING_INPUTS.reduce<Record<string, string>>((acc, k) => {
      acc[k] = fields.binding[k];
      return acc;
    }, {}),
    stages: fields.stages,
  };
  return 'sha256:' + createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}

/** Build a transportable receipt from a persisted #600 verification record. The
 *  receipt binds to the record's identity verbatim — no re-derivation. */
export function receiptFromRecord(record: VerificationRecord): VerificationReceipt {
  const stages: ReceiptStages = { candidate: 'PASS', pristine: 'PASS', integrity: 'CLEAN' };
  const core = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    verdict: 'VERIFIED' as const,
    binding: record.binding,
    stages,
  };
  return {
    ...core,
    tw_version: record.tw_version,
    verified_at: record.verified_at,
    evidence_digest: receiptEvidenceDigest(core),
  };
}

/** `.git/tamperward/verification-receipt.json` — the raw local evidence, stored
 *  OUTSIDE the candidate-controlled tracked tree, under the non-candidate git
 *  authority, exactly like the #600 record. An explicit export command copies it
 *  to a caller-chosen path for transport. */
export function receiptPath(cwd: string): string | null {
  const ctx = repoContext(cwd);
  return ctx ? join(ctx.gitDir, 'tamperward', 'verification-receipt.json') : null;
}

/** Persist the receipt beside the #600 record. Best-effort evidence: a write
 *  failure must never change a verify verdict. Returns whether it was written. */
export function storeReceipt(cwd: string, receipt: VerificationReceipt): boolean {
  const path = receiptPath(cwd);
  if (!path) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(receipt) + '\n');
    return true;
  } catch {
    return false;
  }
}

/** The stored local receipt, or null when absent/unreadable (fail safe). */
export function readStoredReceipt(cwd: string): unknown {
  const path = receiptPath(cwd);
  if (!path) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** A claimed receipt, classified. `PRESENT` carries the validated receipt; every
 *  other disposition fails safe and can never strengthen a CI result. */
export type ClaimedReceipt =
  | { disposition: 'PRESENT'; receipt: VerificationReceipt }
  | { disposition: 'ABSENT' | 'MALFORMED' | 'UNKNOWN_SCHEMA'; detail: string };

/** Membership in a closed string vocabulary, as a type guard so callers narrow
 *  instead of asserting. The single localized assertion is `Array.includes`'s
 *  argument type (a closed tuple's `includes` rejects a plain string). */
export function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

function isStages(v: unknown): v is ReceiptStages {
  return (
    isRecord(v) &&
    isOneOf(RECEIPT_STAGE_RESULTS, v.candidate) &&
    isOneOf(RECEIPT_STAGE_RESULTS, v.pristine) &&
    isOneOf(RECEIPT_INTEGRITY_RESULTS, v.integrity)
  );
}

function isBinding(v: unknown): v is VerificationBinding {
  if (!isRecord(v)) return false;
  return BINDING_INPUTS.every((k) => {
    const val = v[k];
    return typeof val === 'string' && val.length > 0;
  });
}

/**
 * Interpret an arbitrary parsed value as a claimed receipt, fail-safe at every
 * step:
 *   - null / undefined            → ABSENT (absence is not an enforcement failure)
 *   - not an object, or no/other
 *     schema_version than 1       → UNKNOWN_SCHEMA (unknown version cannot strengthen)
 *   - structurally invalid, OR
 *     evidence_digest mismatch    → MALFORMED (a tampered receipt is non-applicable)
 *   - otherwise                   → PRESENT
 */
export function classifyReceipt(value: unknown): ClaimedReceipt {
  if (value === null || value === undefined) {
    return { disposition: 'ABSENT', detail: 'no local verification receipt was provided' };
  }
  if (!isRecord(value)) {
    return { disposition: 'UNKNOWN_SCHEMA', detail: 'receipt is not a JSON object' };
  }
  if (value.schema_version !== RECEIPT_SCHEMA_VERSION) {
    return {
      disposition: 'UNKNOWN_SCHEMA',
      detail: `unrecognised receipt schema_version ${JSON.stringify(value.schema_version)} (this build understands ${RECEIPT_SCHEMA_VERSION})`,
    };
  }
  if (value.verdict !== 'VERIFIED') {
    return { disposition: 'MALFORMED', detail: 'receipt verdict is not VERIFIED' };
  }
  if (typeof value.tw_version !== 'string' || typeof value.verified_at !== 'string') {
    return { disposition: 'MALFORMED', detail: 'receipt is missing tw_version or verified_at' };
  }
  if (!isBinding(value.binding)) {
    return { disposition: 'MALFORMED', detail: 'receipt binding is incomplete or malformed' };
  }
  if (!isStages(value.stages)) {
    return { disposition: 'MALFORMED', detail: 'receipt stages are incomplete or malformed' };
  }
  if (typeof value.evidence_digest !== 'string') {
    return { disposition: 'MALFORMED', detail: 'receipt evidence_digest is missing' };
  }
  // `isBinding`/`isStages` narrowed these; rebuild explicitly so the receipt
  // carries ONLY the bounded fields (any extra keys are dropped, not trusted).
  const b = value.binding;
  const binding: VerificationBinding = {
    tree: b.tree, head: b.head, base: b.base, policy: b.policy,
    verifier: b.verifier, surface: b.surface, intervention: b.intervention, dependencies: b.dependencies,
  };
  const stages: ReceiptStages = {
    candidate: value.stages.candidate,
    pristine: value.stages.pristine,
    integrity: value.stages.integrity,
  };
  const expected = receiptEvidenceDigest({
    schema_version: RECEIPT_SCHEMA_VERSION,
    verdict: 'VERIFIED',
    binding,
    stages,
  });
  if (expected !== value.evidence_digest) {
    // Internally inconsistent: some identity-bearing field was edited without
    // re-deriving the digest. Non-applicable, never "close enough".
    return { disposition: 'MALFORMED', detail: 'receipt evidence_digest does not match its own contents (tampered)' };
  }
  return {
    disposition: 'PRESENT',
    receipt: {
      schema_version: RECEIPT_SCHEMA_VERSION,
      verdict: 'VERIFIED',
      tw_version: value.tw_version,
      verified_at: value.verified_at,
      binding,
      stages,
      evidence_digest: value.evidence_digest,
    },
  };
}

/** CI's independent side of the reconciliation. `verdict` is CI's own verify
 *  adjudication; `binding` is the identity CI computed from trusted inputs (or
 *  null when CI could not compute it — e.g. broken authority wiring). */
export interface CiAdjudication {
  verdict: VerifyVerdict;
  binding: VerificationBinding | null;
  /** When CI's binding could not be computed, why. */
  binding_error?: string;
}

/** The reconciliation outcome. `result` is ALWAYS CI's verdict: no receipt state
 *  ever changes it. `agreement` and `applicable` classify the local claim
 *  against CI's independent adjudication for reporting only. */
export interface Reconciliation {
  result: VerifyVerdict;
  agreement: ReconcileAgreement;
  /** Whether the claimed receipt binds to the EXACT state CI adjudicated. */
  applicable: boolean;
  local: {
    disposition: ReceiptDisposition;
    verdict?: 'VERIFIED';
    verified_at?: string;
    detail?: string;
  };
  ci: { verdict: VerifyVerdict };
  /** For a NON_APPLICABLE claim whose binding differs, the first load-bearing
   *  input that diverged from CI's identity. */
  mismatched_input?: BindingInput;
  /** Human-readable divergence notes (never authoritative). */
  divergence: string[];
}

/**
 * Reconcile a claimed local receipt against CI's independent adjudication.
 *
 * The one invariant that matters for a security tool: `result === ci.verdict`
 * for EVERY claimed receipt — present, absent, malformed, tampered, stale,
 * mismatched or divergent. The receipt is evidence; CI recomputes the verdict
 * from trusted inputs. A local-green / CI-red case reports DIVERGENCE and stays
 * failed; it is never promoted.
 */
export function reconcile(ci: CiAdjudication, claimed: ClaimedReceipt): Reconciliation {
  const base: Reconciliation = {
    result: ci.verdict, // CI is the sole authority for the verdict — always.
    agreement: 'NO_CLAIM',
    applicable: false,
    local: { disposition: claimed.disposition },
    ci: { verdict: ci.verdict },
    divergence: [],
  };

  if (claimed.disposition !== 'PRESENT') {
    base.local.detail = claimed.detail;
    if (claimed.disposition === 'ABSENT') {
      // Receipt absence is not itself an enforcement failure (#601): no claim to
      // reconcile, CI's verdict stands on its own.
      base.agreement = 'NO_CLAIM';
    } else {
      // Fail safe: a receipt this build cannot trust is non-applicable and cannot
      // strengthen CI. It does not, by itself, fail the build either.
      base.agreement = 'NON_APPLICABLE';
      base.divergence.push(`local receipt ${claimed.disposition === 'UNKNOWN_SCHEMA' ? 'has an unknown schema/version' : 'is malformed or tampered'} — ignored as evidence`);
    }
    return base;
  }

  // PRESENT: a structurally valid, internally consistent VERIFIED claim.
  const receipt = claimed.receipt;
  base.local.verdict = receipt.verdict;
  base.local.verified_at = receipt.verified_at;

  if (!ci.binding) {
    base.agreement = 'NON_APPLICABLE';
    base.divergence.push(`CI could not independently compute the candidate identity${ci.binding_error ? ` (${ci.binding_error})` : ''}; the receipt cannot be applied`);
    return base;
  }

  const mismatch = firstBindingMismatch(receipt.binding, ci.binding);
  if (mismatch) {
    // The receipt describes a DIFFERENT candidate state than CI adjudicated.
    // Non-applicable, not "close enough": stale tree, policy/verifier drift, a
    // different base/HEAD all land here and cannot vouch for CI's state.
    base.agreement = 'NON_APPLICABLE';
    base.mismatched_input = mismatch;
    base.divergence.push(`receipt binds a different \`${mismatch}\` than CI computed — the receipt describes another state`);
    return base;
  }

  // The receipt binds the exact state CI adjudicated.
  base.applicable = true;
  if (ci.verdict === 'VERIFIED') {
    base.agreement = 'AGREE';
    return base;
  }
  // Local claimed VERIFIED, CI did not: first-class DIVERGENCE, still failed.
  base.agreement = 'DIVERGENCE';
  base.divergence.push(`local claim VERIFIED, CI ${ci.verdict}`);
  if (receipt.stages.pristine === 'PASS' && ci.verdict === 'MASKED_FAILURE') {
    base.divergence.push('local pristine: PASS / CI pristine: FAIL');
  }
  return base;
}

// Re-export for the schema invariant test's single-source assertions.
export { VERIFY_VERDICTS };
