// Retained real-runtime probe evidence (#599, #611/#616).
//
// This is the ONLY thing that can promote a runtime capability to `PROVEN`. A static
// `RuntimeCapabilities` declaration (src/adapters/contract.ts) describes what an adapter is
// BUILT to do at the contract boundary; it can never, on its own, prove that a live runtime
// actually invokes and honors the hook. Proof comes only from a real-runtime probe that
// exercised the runtime and observed the outcome — and only for the exact binding it ran
// under. This module holds those retained observations, transcribed verbatim from the
// committed, sanitized probe captures under `harness/adapters/**/evidence/`.
//
//  - Each record carries the FULL binding the probe ran under (runtime id + exact version,
//    component versions, model, platform, execution mode, hook-config hash). A capability is
//    graded from a record ONLY when the current qualification binding matches ALL of those
//    fields (`matchRetainedEvidence`). A mismatch — a bumped version, a different platform,
//    model, mode or config — yields NO match, so nothing is proven and the honest state falls
//    back to the static derivation (`PARTIAL`/`UNPROVEN`).
//  - A record proves specific capability ids and preserves the exact observation for each,
//    including negative (`fail-open`) and unresolved (`inconclusive`) results verbatim.
//  - There is deliberately no evidence for a runtime we have not probed. Claude Code, for
//    example, has a fully declared pre-deny surface but NO retained real-runtime probe here,
//    so its capabilities grade `PARTIAL` (declared, not proven live) — never `PROVEN` — until
//    a real-runtime conformance probe is captured and committed.
//
// Running a live credentialed probe is gated (#611/#616) and does not happen in this process.
// "Execute the retained-evidence probe" (the #599 acceptance criterion) means exactly this:
// consult the retained probe observations and grade against them. No retained evidence for a
// binding means the capability is NOT proven — stated plainly, never fabricated.

import type { RuntimeCapabilityId } from '../runtime-qualification';

/** How a retained observation grades the capability it names:
 *  - `proven`       — the probe exercised the runtime and the capability HELD (a denied tool
 *                     did not dispatch; a broken hook path failed CLOSED; protected state intact).
 *  - `fail-open`    — the probe observed the capability FAIL OPEN (the operation proceeded).
 *  - `inconclusive` — the probe reached the path but observed no authoritative resolution. */
export type ObservationResult = 'proven' | 'fail-open' | 'inconclusive';

/** One retained per-capability observation from a real-runtime probe. */
export interface RetainedObservation {
  id: RuntimeCapabilityId;
  result: ObservationResult;
  /** The exact observation, preserved verbatim so a negative/inconclusive result is never hidden. */
  detail: string;
}

/** The FULL binding a probe ran under. Every field is load-bearing for a match: retained
 *  evidence proves a capability only for THIS exact runtime/version/config, never in general. */
export interface EvidenceBinding {
  runtime_id: string;
  /** Exact version the probe ran against (for a hosted runtime, the runtime component version). */
  runtime_version: string;
  /** Additional pinned component versions that co-define the probed runtime (SDK, protocol). */
  component_versions: string[];
  model: string | null;
  /** `${platform}-${arch}` the probe ran on. */
  platform: string;
  execution_mode: 'headless' | 'interactive';
  hook_config_hash: string | null;
}

/** A retained real-runtime probe result, transcribed from a committed sanitized capture. */
export interface RetainedRuntimeEvidence {
  /** A short, stable id for this retained record, cited in the qualification evidence. */
  ref: string;
  /** The committed source artifact this record was transcribed from (provenance). */
  source: string;
  /** The immutable identity of the original (uncommitted, credentialed) capture. */
  source_artifact_sha256: string;
  binding: EvidenceBinding;
  observations: RetainedObservation[];
}

/**
 * The committed catalogue of retained real-runtime probe evidence.
 *
 * Today this holds exactly one record: the hosted GitHub Copilot SDK phase-0 capture
 * (harness/adapters/copilot-sdk/evidence/capture-2026-09-20.json, #611/#616), which observed,
 * on a pinned SDK/runtime, that a returned reject blocked shell dispatch and that a broken
 * permission callback failed CLOSED — with protected state intact in every case — while a
 * hung callback stayed intrinsically unobservable (inconclusive). Every other shipped runtime,
 * Claude Code included, has NO retained real-runtime probe, so nothing about it is `PROVEN`.
 */
export const RETAINED_EVIDENCE: readonly RetainedRuntimeEvidence[] = [
  {
    ref: 'copilot-sdk-capture-2026-09-20',
    source: 'harness/adapters/copilot-sdk/evidence/capture-2026-09-20.json',
    source_artifact_sha256: 'c46fba989dc0e772012c5fdb1291cf099326d24da2b551788be2e1e85113e49a',
    binding: {
      runtime_id: 'github-copilot-sdk-hosted',
      runtime_version: 'copilot-runtime@1.0.85',
      component_versions: ['@github/copilot-sdk@1.0.14', 'copilot-protocol@3'],
      model: 'gpt-5.4',
      platform: 'darwin-arm64',
      execution_mode: 'headless',
      hook_config_hash: null,
    },
    observations: [
      {
        id: 'pre-deny:shell',
        result: 'proven',
        detail:
          'returned-reject path (permission.completed result.kind denied): a rejected permission decision blocked shell tool dispatch — protected state not mutated (shell-pre-deny observation, boundary seq 2 < completion seq 3)',
      },
      {
        id: 'hook-not-invoked',
        result: 'proven',
        detail:
          'callback-failure path: a broken permission callback (sync-throw, reject and adapter-throw, independently) failed CLOSED — the tool did not dispatch and protected state stayed intact',
      },
      {
        id: 'transport:timeout',
        result: 'inconclusive',
        detail:
          'callback-timeout path: a hung permission handler emits no permission.completed (the pinned SDK has no handler timeout), so non-dispatch is intrinsically unobservable — timeout is not proven either way',
      },
    ],
  },
];

/** The subset of an `EvidenceBinding` the match compares — the #599 binding fields (runtime
 *  name + exact version, model, platform, execution mode, hook-config hash). `component_versions`
 *  is retained provenance folded into the reported evidence string, not a separate match key
 *  (the exact `runtime_version` already pins the probed runtime). `runtime_version` is nullable
 *  on the current side: an unresolved live version can never match a probed concrete one. */
export interface EvidenceMatchKey {
  runtime_id: string;
  runtime_version: string | null;
  model: string | null;
  platform: string;
  execution_mode: 'headless' | 'interactive';
  hook_config_hash: string | null;
}

/** True when a retained record's binding matches the current qualification binding on EVERY
 *  load-bearing field. A null on either side of a field never matches a concrete value (an
 *  unresolved runtime version cannot match a probed one), so an unbound runtime is never proven. */
export function evidenceBindingMatches(record: EvidenceMatchKey, current: EvidenceMatchKey): boolean {
  return (
    record.runtime_id === current.runtime_id &&
    record.runtime_version === current.runtime_version &&
    record.model === current.model &&
    record.platform === current.platform &&
    record.execution_mode === current.execution_mode &&
    record.hook_config_hash === current.hook_config_hash
  );
}

/** Find the retained evidence record matching the current binding, or null when none does. */
export function matchRetainedEvidence(
  current: EvidenceMatchKey,
  catalogue: readonly RetainedRuntimeEvidence[] = RETAINED_EVIDENCE,
): RetainedRuntimeEvidence | null {
  return catalogue.find((r) => evidenceBindingMatches(r.binding, current)) ?? null;
}
