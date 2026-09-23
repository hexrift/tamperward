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
//  - Each record carries the FULL binding the probe ran under, and the applicability match
//    (`matchRetainedEvidence`) compares EVERY evidence-defining field: runtime id + exact
//    version, the pinned component versions (SDK/protocol), the TamperWard version+commit the
//    probe ran under, the adapter capability hash, the tested capability set, model, platform,
//    execution mode and hook-config hash. A capability is graded from a record ONLY when the
//    current qualification binding matches ALL of them. A mismatch — a bumped runtime OR
//    TamperWard version, a changed SDK/protocol component, a different adapter capability hash,
//    a different tested set, or a different platform/model/mode/config — yields NO match, so
//    nothing is proven and the honest state falls back to the static derivation
//    (`PARTIAL`/`UNPROVEN`). Stale evidence can never promote across a load-bearing change.
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
  /** Additional pinned component versions that co-define the probed runtime (SDK, protocol),
   *  e.g. `@github/copilot-sdk@1.0.14`, `copilot-protocol@3`. Compared order-insensitively. */
  component_versions: string[];
  /** The exact TamperWard build the probe ran under, as `version+shortcommit`
   *  (e.g. `2.31.0+3671a5e6`). A different TamperWard version or commit is a different build and
   *  must not reuse this evidence — a change here breaks the match. */
  tamperward_version: string;
  /** The adapter capability hash the probe ran under, or `null` when it is NOT authentically
   *  recoverable from the committed capture. A `null` here fails the match CLOSED: the match
   *  REQUIRES a concrete hash on both sides, so a record with an unrecoverable hash can never
   *  equal a concrete current hash and can never promote. We never fabricate a historical hash. */
  adapter_capability_hash: string | null;
  /** The capability ids the probe actually tested/observed. Compared order-insensitively against
   *  the current qualification's tested set: evidence that tested a different capability surface
   *  than the one being reported does not apply. */
  tested_capabilities: RuntimeCapabilityId[];
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
      // The capture's own provenance: tamperward@2.31.0+3671a5e6 (capture-2026-09-20.json).
      tamperward_version: '2.31.0+3671a5e6',
      // NOT authentically recoverable from the committed capture: the sanitized artifact records
      // no adapter capability-declaration hash. We do NOT invent a historical hash. `null` makes
      // the applicability match fail CLOSED (a null recorded hash can never equal a concrete
      // current hash), so this record can never promote — the honest, safe outcome.
      adapter_capability_hash: null,
      // The capability ids the capture actually observed (the `observations` below).
      tested_capabilities: ['pre-deny:shell', 'hook-not-invoked', 'transport:timeout'],
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

/** Every evidence-defining field the applicability match compares (#599). Retained evidence
 *  proves a capability ONLY for the exact binding it ran under, so ALL of these are load-bearing:
 *  a change to any one is a different binding and stale evidence must not carry over.
 *   - `runtime_id` / `runtime_version` — the probed runtime and its exact version.
 *   - `component_versions` — pinned SDK/protocol versions (order-insensitive set).
 *   - `tamperward_version` — the TamperWard build (`version+shortcommit`) the probe ran under.
 *   - `adapter_capability_hash` — the adapter capability declaration hash (see below).
 *   - `tested_capabilities` — the capability surface the probe tested (order-insensitive set).
 *   - `model` / `platform` / `execution_mode` / `hook_config_hash` — the rest of the environment.
 *  `runtime_version`, `tamperward_version` and `adapter_capability_hash` are nullable on the
 *  current side: an unresolved value can never match a concrete probed one, so an unbound
 *  runtime is never proven. */
export interface EvidenceMatchKey {
  runtime_id: string;
  runtime_version: string | null;
  component_versions: string[];
  tamperward_version: string | null;
  adapter_capability_hash: string | null;
  tested_capabilities: string[];
  model: string | null;
  platform: string;
  execution_mode: 'headless' | 'interactive';
  hook_config_hash: string | null;
}

/** Order-insensitive set equality over string ids (dedups first, so element order and
 *  duplicates never affect the result). */
function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const ua = [...new Set(a)].sort();
  const ub = [...new Set(b)].sort();
  return ua.length === ub.length && ua.every((x, i) => x === ub[i]);
}

/** True when a retained record's binding matches the current qualification binding on EVERY
 *  evidence-defining field. A null on either side of a scalar field never matches a concrete
 *  value (an unresolved runtime/TamperWard version cannot match a probed one), so an unbound
 *  runtime is never proven. `adapter_capability_hash` fails CLOSED: it must be concrete on BOTH
 *  sides and equal — a record whose hash was not authentically recoverable (stored `null`) can
 *  never promote, and we never fabricate one to force a match. */
export function evidenceBindingMatches(record: EvidenceMatchKey, current: EvidenceMatchKey): boolean {
  return (
    record.runtime_id === current.runtime_id &&
    record.runtime_version === current.runtime_version &&
    record.model === current.model &&
    record.platform === current.platform &&
    record.execution_mode === current.execution_mode &&
    record.hook_config_hash === current.hook_config_hash &&
    // Pinned SDK/protocol component versions — order-insensitive set comparison.
    sameIdSet(record.component_versions, current.component_versions) &&
    // The TamperWard build (version+commit): a different TamperWard build is a different binding.
    record.tamperward_version === current.tamperward_version &&
    // Adapter capability hash — REQUIRED (fail-closed) on both sides. A `null` recorded hash
    // (unrecoverable, never fabricated) can never equal a concrete current hash.
    record.adapter_capability_hash !== null &&
    current.adapter_capability_hash !== null &&
    record.adapter_capability_hash === current.adapter_capability_hash &&
    // The capability surface the probe tested — order-insensitive set comparison.
    sameIdSet(record.tested_capabilities, current.tested_capabilities)
  );
}

/** Find the retained evidence record matching the current binding, or null when none does. */
export function matchRetainedEvidence(
  current: EvidenceMatchKey,
  catalogue: readonly RetainedRuntimeEvidence[] = RETAINED_EVIDENCE,
): RetainedRuntimeEvidence | null {
  return catalogue.find((r) => evidenceBindingMatches(r.binding, current)) ?? null;
}
