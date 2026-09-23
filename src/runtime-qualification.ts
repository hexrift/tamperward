// A version-bound, operation-specific runtime capability model (#599).
//
// This module turns TamperWard's binary "runtime detected" label into an HONEST,
// per-operation capability report. It is a REPORTING surface over EXISTING facts, not a
// new qualification authority and not a promotion path:
//
//  - `PROVEN` is reserved for a capability a RETAINED REAL-RUNTIME PROBE observed holding
//    under the FULL binding being reported (src/adapters/evidence.ts). A static
//    `RuntimeCapabilities` declaration (`preDeny` / `postObserve` / `endOfTurn`,
//    src/adapters/contract.ts, #482) describes what the adapter is BUILT to do at the
//    contract boundary — it can never, on its own, prove a live runtime invokes and honors
//    the hook, so a declaration alone grades at most `PARTIAL` (declared, unproven live),
//    and an absent capability grades `UNPROVEN`/`UNSUPPORTED`. There is never a fabricated
//    `PROVEN` from a contract/mock/adapter declaration (the #599 architecture constraint).
//  - This module runs no live runtime; it GRADES against retained probe observations. A unit
//    test can validate the adapter contract but cannot move a live capability to `PROVEN`;
//    only a committed real-runtime evidence record matching the binding can.
//  - A fail-open declaration (an adapter naming, in `unsupported`, a failure mode that lets a
//    tool proceed) — or a fail-open OBSERVED by a probe — is surfaced as `FAIL-OPEN` with the
//    exact evidence, and the in-loop aggregate can then never be rendered as FULL support.
//
// Pure and dependency-light: it hashes and compares, reads no disk and no git, and imports
// only types. The CLI (src/cli/runtime.ts) resolves the live binding, matches it to retained
// evidence, and passes the matching record in; the derivation here is deterministic given its
// inputs, so tests pin it exactly.

import { createHash } from 'node:crypto';
import { RuntimeCapabilities, OperationKind } from './adapters/contract';
import type { RetainedRuntimeEvidence, RetainedObservation } from './adapters/evidence';

// ————————————————————————————————————————————————————————————————————————
// Vocabularies (the single source the emitter and the published schema share).
// ————————————————————————————————————————————————————————————————————————

/**
 * The six capability states. Deliberately NOT a percentage: a score would let a caller
 * average a fail-open away. `FAIL-OPEN` and `INCONCLUSIVE` are first-class so a dangerous
 * or unresolved result is never collapsed into "supported".
 *
 *  - `PROVEN`       — a retained real-runtime probe observed this capability holding under the
 *                     binding being reported (src/adapters/evidence.ts). A static declaration
 *                     NEVER earns `PROVEN` on its own — only observed live evidence does.
 *  - `PARTIAL`      — declared/guaranteed at the adapter/contract boundary, but no retained
 *                     real-runtime probe proves it holds live for this runtime/version/config.
 *  - `UNPROVEN`     — no evidence either way; the adapter does not declare it and no record
 *                     proves it (the conservative default — NEVER read as "unsupported-safe").
 *  - `UNSUPPORTED`  — the adapter declares it does NOT provide this capability.
 *  - `FAIL-OPEN`    — a declared failure mode lets the operation proceed. A negative result,
 *                     preserved verbatim; it can never count toward FULL support.
 *  - `INCONCLUSIVE` — evidence exists but does not resolve the state (reserved for committed
 *                     records that conflict; no current adapter produces it).
 */
export const CAPABILITY_STATES = [
  'PROVEN',
  'PARTIAL',
  'UNPROVEN',
  'UNSUPPORTED',
  'FAIL-OPEN',
  'INCONCLUSIVE',
] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

/**
 * The operation-specific capabilities (#599). Order is the display order. Each id names a
 * concrete in-loop control or failure mode, at a finer granularity than the adapter's
 * OperationKind declaration — the derivation below records WHICH declared kind backs each.
 */
export const RUNTIME_CAPABILITY_IDS = [
  'pre-deny:shell',
  'pre-deny:native-edit',
  'pre-deny:delete',
  'pre-deny:rename',
  'pre-deny:git-mutation',
  'pre-deny:mcp',
  'post-observe',
  'end-of-turn',
  'denial-reason-delivery',
  'continue-after-denial',
  'transport:missing-executable',
  'transport:non-zero',
  'transport:timeout',
  'transport:malformed',
  'transport:empty',
  'hook-not-invoked',
  'detached/quiescence',
] as const;
export type RuntimeCapabilityId = (typeof RUNTIME_CAPABILITY_IDS)[number];

/** Where a capability's state came from — so the derivation is auditable, and a declaration
 *  is never silently presented as a live probe result. */
export const EVIDENCE_SOURCES = [
  'adapter-declaration', // structural preDeny / postObserve / endOfTurn membership
  'adapter-unsupported', // named verbatim in the adapter's `unsupported[]` prose
  'contract', // the neutral steering contract guarantees this at the adapter boundary
  'committed-evidence', // a committed real-runtime evidence record proved it
  'not-declared', // absent from every declaration — no proof either way
] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export interface CapabilityEvidence {
  source: EvidenceSource;
  /** The exact citation: a declaration summary, the verbatim `unsupported` string, the
   *  contract guarantee, or a committed evidence id. Negative/fail-open detail is preserved. */
  detail: string;
}

export interface CapabilityAssessment {
  id: RuntimeCapabilityId;
  state: CapabilityState;
  evidence: CapabilityEvidence;
}

/** The in-loop steering aggregate. `FULL` is reachable ONLY when every required capability
 *  is `PROVEN` and none is `FAIL-OPEN`/`INCONCLUSIVE` — the honesty invariant the issue names. */
export const IN_LOOP_AGGREGATES = ['FULL', 'PARTIAL', 'NONE'] as const;
export type InLoopAggregate = (typeof IN_LOOP_AGGREGATES)[number];

/** Final authority (CI / pristine verification) is independent of the runtime hook, so this
 *  is a constant: a weak in-loop hook never makes adjudication weak (the steering/authority
 *  split). It is `AVAILABLE` because TamperWard ships pre-commit + CI + the run envelope +
 *  `verify`, none of which depend on the runtime's in-loop capabilities. */
export const FINAL_AUTHORITY = 'AVAILABLE' as const;
export type FinalAuthority = typeof FINAL_AUTHORITY;

// ————————————————————————————————————————————————————————————————————————
// Derivation. Pure functions over a RuntimeCapabilities declaration.
// ————————————————————————————————————————————————————————————————————————

function includesKind(set: readonly OperationKind[], kind: OperationKind): boolean {
  return set.includes(kind);
}

/** A declared failure that lets the operation proceed ("fails OPEN"). */
const FAIL_OPEN_RE = /fails?\s+open/i;
/** A generic pre-action-deny-unproven note that covers every pre-deny kind at once. */
const PRE_DENY_UNPROVEN_RE = /pre-action deny|pre-deny|shell pre-deny/i;
/** A note that the fail-closed transport itself is not (yet) proven. */
const TRANSPORT_UNPROVEN_RE = /(?:fail-?closed|transport)[^.]*\b(?:not (?:yet )?proven|unproven|unmeasured)/i;
/** A note that the end-of-turn/stop is only a lifecycle control, not a filesystem veto. */
const LIFECYCLE_ONLY_RE = /lifecycle continuation|not a filesystem veto|only block turn completion|block turn completion and force continuation/i;
/** A note that post-action/post-observe is not consumed as a supported path. */
const POST_ACTION_RE = /post-action|post-observe|posttooluse|stop sweep is the post-turn/i;

const TRANSPORT_KEYWORDS: Record<string, RegExp> = {
  'transport:missing-executable': /missing exec|executable|enoent|not found/i,
  'transport:non-zero': /non-?zero|exit code|exit 2|non-?2xx/i,
  'transport:timeout': /time-?out|timed[- ]out/i,
  'transport:malformed': /malformed|parse/i,
  'transport:empty': /\bempty\b/i,
};

function find(unsupported: readonly string[], re: RegExp): string | undefined {
  return unsupported.find((u) => re.test(u));
}

/** A quick lookup of a matched evidence record's per-capability observations by id. */
type EvidenceIndex = Map<RuntimeCapabilityId, RetainedObservation>;

function indexEvidence(evidence: RetainedRuntimeEvidence | null | undefined): EvidenceIndex {
  const m: EvidenceIndex = new Map();
  if (!evidence) return m;
  for (const o of evidence.observations) m.set(o.id, o);
  return m;
}

/** Grade a capability directly from a retained real-runtime observation, when one exists for
 *  it in the matched record. This is the ONLY path to `PROVEN`. A `fail-open` observation is a
 *  first-class negative (`FAIL-OPEN`); an `inconclusive` one is `INCONCLUSIVE`. Returns null
 *  when the matched record says nothing about this capability, so the static derivation (capped
 *  at `PARTIAL`) applies. */
function assessFromEvidence(
  id: RuntimeCapabilityId,
  index: EvidenceIndex,
  evidence: RetainedRuntimeEvidence | null | undefined,
): CapabilityAssessment | null {
  const obs = index.get(id);
  if (!obs || !evidence) return null;
  const state: CapabilityState = obs.result === 'proven' ? 'PROVEN' : obs.result === 'fail-open' ? 'FAIL-OPEN' : 'INCONCLUSIVE';
  return {
    id,
    state,
    evidence: {
      source: 'committed-evidence',
      detail: `${obs.detail} [retained evidence ${evidence.ref} · ${evidence.source} · sha256 ${evidence.source_artifact_sha256.slice(0, 12)}]`,
    },
  };
}

/** Pre-deny for an operation kind. `PROVEN` comes ONLY from a retained real-runtime observation
 *  for this capability under the matched binding. A static `preDeny` membership is not proof of
 *  live honoring, so it grades `PARTIAL` (declared at the contract boundary, unproven live);
 *  absence grades `UNPROVEN`, citing an adapter `unsupported` note when one explains the gap. */
function assessPreDeny(
  caps: RuntimeCapabilities,
  id: RuntimeCapabilityId,
  kind: OperationKind,
  kindNote: string,
  index: EvidenceIndex,
  evidence: RetainedRuntimeEvidence | null | undefined,
): CapabilityAssessment {
  const proven = assessFromEvidence(id, index, evidence);
  if (proven) return proven;
  if (includesKind(caps.preDeny, kind)) {
    return {
      id,
      state: 'PARTIAL',
      evidence: {
        source: 'adapter-declaration',
        detail: `declared preDeny includes '${kind}' (${kindNote}); the contract denies it at the adapter boundary, but no retained real-runtime probe proves this runtime/version invokes and honors the hook live`,
      },
    };
  }
  const note = find(caps.unsupported, PRE_DENY_UNPROVEN_RE);
  if (note) return { id, state: 'UNPROVEN', evidence: { source: 'adapter-unsupported', detail: note } };
  return {
    id,
    state: 'UNPROVEN',
    evidence: {
      source: 'not-declared',
      detail: `operation kind '${kind}' (${kindNote}) is absent from the declared preDeny set and unnamed in unsupported`,
    },
  };
}

/** Transport failure mode: FAIL-OPEN when a declared failure of this kind proceeds; UNPROVEN
 *  when the adapter says the fail-closed transport is itself unproven; otherwise PARTIAL,
 *  because the neutral contract maps parse/transport/not-invoked to a fail-closed DENY at the
 *  adapter boundary (`failsClosed`), while full live honoring across modes stays unproven. */
function assessTransport(
  caps: RuntimeCapabilities,
  id: RuntimeCapabilityId,
  index: EvidenceIndex,
  evidence: RetainedRuntimeEvidence | null | undefined,
): CapabilityAssessment {
  const observed = assessFromEvidence(id, index, evidence);
  if (observed) return observed;
  const kw = TRANSPORT_KEYWORDS[id];
  const failOpen = caps.unsupported.find((u) => FAIL_OPEN_RE.test(u) && kw.test(u));
  if (failOpen) return { id, state: 'FAIL-OPEN', evidence: { source: 'adapter-unsupported', detail: failOpen } };
  const unproven = find(caps.unsupported, TRANSPORT_UNPROVEN_RE);
  if (unproven) return { id, state: 'UNPROVEN', evidence: { source: 'adapter-unsupported', detail: unproven } };
  return {
    id,
    state: 'PARTIAL',
    evidence: {
      source: 'contract',
      detail:
        'the neutral steering contract maps this transport failure to a fail-closed deny at the adapter boundary (failsClosed); full live-runtime honoring across execution modes is not separately proven by static qualification',
    },
  };
}

/**
 * Derive the full capability assessment for one runtime, from its declared capabilities
 * alone. Deterministic: the same declaration always yields the same states and evidence.
 */
export function assessCapabilities(
  caps: RuntimeCapabilities,
  evidence?: RetainedRuntimeEvidence | null,
): CapabilityAssessment[] {
  const out: CapabilityAssessment[] = [];
  const ev = indexEvidence(evidence);
  const fromEvidence = (id: RuntimeCapabilityId) => assessFromEvidence(id, ev, evidence);

  out.push(assessPreDeny(caps, 'pre-deny:shell', 'shell', 'a shell/exec tool call', ev, evidence));
  out.push(assessPreDeny(caps, 'pre-deny:native-edit', 'file-edit', 'a native file-edit tool', ev, evidence));
  out.push(assessPreDeny(caps, 'pre-deny:delete', 'file-edit', 'a delete proposed as a file-edit/native tool', ev, evidence));
  out.push(assessPreDeny(caps, 'pre-deny:rename', 'file-edit', 'a rename proposed as a file-edit/native tool', ev, evidence));
  out.push(assessPreDeny(caps, 'pre-deny:git-mutation', 'shell', 'a git mutation proposed as a shell command', ev, evidence));
  out.push(assessPreDeny(caps, 'pre-deny:mcp', 'mcp', 'an MCP tool call', ev, evidence));

  // post-observe: PROVEN only from a retained probe; a declared postObserve grades PARTIAL
  // (declared, live honoring unproven); UNSUPPORTED when the adapter says it consumes none;
  // UNPROVEN otherwise.
  const postObserveEvidence = fromEvidence('post-observe');
  if (postObserveEvidence) {
    out.push(postObserveEvidence);
  } else if (caps.postObserve.length > 0) {
    out.push({
      id: 'post-observe',
      state: 'PARTIAL',
      evidence: { source: 'adapter-declaration', detail: `declared postObserve: [${[...caps.postObserve].sort().join(', ')}]; no retained real-runtime probe proves live post-action observation on this runtime/version` },
    });
  } else {
    const note = find(caps.unsupported, POST_ACTION_RE);
    out.push(
      note
        ? { id: 'post-observe', state: 'UNSUPPORTED', evidence: { source: 'adapter-unsupported', detail: note } }
        : {
            id: 'post-observe',
            state: 'UNPROVEN',
            evidence: { source: 'not-declared', detail: 'no post-action observation kind is declared and none is named unsupported' },
          },
    );
  }

  // end-of-turn: PROVEN only from a retained probe; a declared endOfTurn grades PARTIAL
  // (declared stop event, live honoring unproven); PARTIAL with the adapter's own caveat when
  // it is a lifecycle continuation control only (cannot veto the tree); UNSUPPORTED when absent.
  const endOfTurnEvidence = fromEvidence('end-of-turn');
  if (endOfTurnEvidence) {
    out.push(endOfTurnEvidence);
  } else if (!caps.endOfTurn) {
    out.push({ id: 'end-of-turn', state: 'UNSUPPORTED', evidence: { source: 'adapter-declaration', detail: 'endOfTurn is declared false' } });
  } else {
    const caveat = find(caps.unsupported, LIFECYCLE_ONLY_RE);
    out.push(
      caveat
        ? { id: 'end-of-turn', state: 'PARTIAL', evidence: { source: 'adapter-unsupported', detail: caveat } }
        : { id: 'end-of-turn', state: 'PARTIAL', evidence: { source: 'adapter-declaration', detail: 'endOfTurn is declared true (a stop event can run the mandatory sweep); no retained real-runtime probe proves this runtime/version delivers and honors the stop sweep live' } },
    );
  }

  // denial-reason-delivery: the deny wire carries a reason via the contract; live delivery to
  // the agent is not separately proven → PARTIAL where a deny path exists, UNPROVEN otherwise.
  const hasDenyPath = caps.endOfTurn || caps.preDeny.length > 0;
  out.push(
    hasDenyPath
      ? {
          id: 'denial-reason-delivery',
          state: 'PARTIAL',
          evidence: {
            source: 'contract',
            detail:
              'a deny carries a human/agent-facing reason on the wire (SteeringDecision.reason); that the runtime delivers it to the agent is not separately proven by static qualification',
          },
        }
      : {
          id: 'denial-reason-delivery',
          state: 'UNPROVEN',
          evidence: { source: 'not-declared', detail: 'the adapter declares no pre-deny or end-of-turn deny path, so no reason is delivered' },
        },
  );

  // continue-after-denial: not encoded in the neutral declaration → UNPROVEN pending live evidence.
  out.push({
    id: 'continue-after-denial',
    state: 'UNPROVEN',
    evidence: { source: 'not-declared', detail: 'whether the agent can continue after a denial is not encoded in the neutral capability declaration and requires live evidence' },
  });

  for (const id of ['transport:missing-executable', 'transport:non-zero', 'transport:timeout', 'transport:malformed', 'transport:empty'] as const) {
    out.push(assessTransport(caps, id, ev, evidence));
  }

  // hook-not-invoked: PROVEN only from a retained probe that observed a broken/absent hook path
  // failing CLOSED; otherwise the contract fails a required not-invoked hook CLOSED at the
  // boundary, but that the runtime actually invokes/honors a configured hook is unproven → PARTIAL.
  out.push(
    fromEvidence('hook-not-invoked') ?? {
      id: 'hook-not-invoked',
      state: 'PARTIAL',
      evidence: {
        source: 'contract',
        detail:
          'the neutral contract fails a required not-invoked hook CLOSED (failsClosed); that a configured hook is actually invoked/honored on this runtime/version is not proven by static qualification',
      },
    },
  );

  // detached/quiescence: the end-of-turn sweep reconciles the net tree at turn end (catching a
  // detached/deferred effect), but continuous in-turn quiescence is not an in-loop guarantee.
  out.push(
    caps.endOfTurn
      ? {
          id: 'detached/quiescence',
          state: 'PARTIAL',
          evidence: {
            source: 'contract',
            detail:
              'the end-of-turn sweep reconciles the net tree at turn end, catching a detached/deferred effect the in-loop phase could only observe; continuous in-turn quiescence is not an in-loop guarantee',
          },
        }
      : {
          id: 'detached/quiescence',
          state: 'UNPROVEN',
          evidence: { source: 'not-declared', detail: 'no end-of-turn sweep is declared, so a detached/deferred effect is not reconciled in-loop' },
        },
  );

  return out;
}

const PRE_DENY_IDS: readonly RuntimeCapabilityId[] = [
  'pre-deny:shell',
  'pre-deny:native-edit',
  'pre-deny:delete',
  'pre-deny:rename',
  'pre-deny:git-mutation',
  'pre-deny:mcp',
];

/** The capabilities that decide the in-loop aggregate: the pre-deny surface, the end-of-turn
 *  sweep, and the transport/invocation failure modes. */
const REQUIRED_IN_LOOP_IDS: readonly RuntimeCapabilityId[] = [
  ...PRE_DENY_IDS,
  'end-of-turn',
  'transport:missing-executable',
  'transport:non-zero',
  'transport:timeout',
  'transport:malformed',
  'transport:empty',
  'hook-not-invoked',
];

/**
 * Aggregate the in-loop steering posture. The honesty invariant: `FULL` requires every required
 * capability `PROVEN` (which, per the derivation, means every one backed by a matching retained
 * real-runtime probe) and NONE `FAIL-OPEN`/`INCONCLUSIVE` — so a static declaration alone can
 * never render `FULL`. `NONE` is reserved for a runtime that neither PROVES nor even DECLARES a
 * pre-deny or end-of-turn steering surface (protected by the neutral layers only). A declared
 * surface that no probe has proven live is the honest middle: `PARTIAL`.
 */
export function aggregateInLoop(assessments: readonly CapabilityAssessment[]): InLoopAggregate {
  const byId = new Map(assessments.map((a) => [a.id, a] as const));
  const required = REQUIRED_IN_LOOP_IDS.map((id) => byId.get(id)).filter((a): a is CapabilityAssessment => a !== undefined);
  const anyDangerous = required.some((a) => a.state === 'FAIL-OPEN' || a.state === 'INCONCLUSIVE');
  // A "present" steering surface is one that is either PROVEN live or at least DECLARED at the
  // contract boundary (PARTIAL). A capability that is UNPROVEN/UNSUPPORTED is not present.
  const present = (id: RuntimeCapabilityId) => {
    const s = byId.get(id)?.state;
    return s === 'PROVEN' || s === 'PARTIAL';
  };
  const anyPreDenyPresent = PRE_DENY_IDS.some(present);
  const endOfTurnPresent = present('end-of-turn');

  if (!anyPreDenyPresent && !endOfTurnPresent) return 'NONE';
  if (!anyDangerous && required.every((a) => a.state === 'PROVEN')) return 'FULL';
  return 'PARTIAL';
}

// ————————————————————————————————————————————————————————————————————————
// Binding + staleness. Bind a qualification to the inputs that make it interpretable.
// ————————————————————————————————————————————————————————————————————————

export function sha16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** A stable hash of a capability declaration, so an adapter change invalidates a stored
 *  qualification (the load-bearing "adapter version/hash" the issue names). */
export function capabilityHash(caps: RuntimeCapabilities): string {
  const stable = JSON.stringify({
    preDeny: [...caps.preDeny].sort(),
    postObserve: [...caps.postObserve].sort(),
    endOfTurn: caps.endOfTurn,
    unsupported: [...caps.unsupported].sort(),
  });
  return sha16(stable);
}

export type ExecutionMode = 'headless' | 'interactive';

/** The interpretability binding for a qualification (#599 "Version/config binding"). Every
 *  field but `timestamp`/`evidence_id` is load-bearing: a change to any of them makes a stored
 *  qualification STALE. */
export interface QualificationBinding {
  runtime: { id: string; label: string; version: string | null };
  tamperward: { version: string; commit: string | null };
  adapter: { name: string; capability_hash: string };
  hook_config_hash: string | null;
  execution_mode: ExecutionMode;
  platform: string;
  model: string | null;
  tested_capabilities: string[];
  timestamp: string;
  evidence_id: string;
}

/** The subset of a binding that is load-bearing for staleness — every field but the
 *  provenance-only `timestamp`/`evidence_id`. */
export type BindingInputs = Omit<QualificationBinding, 'timestamp' | 'evidence_id'>;

/** The load-bearing projection of a binding — the fields staleness compares. `commit`,
 *  `timestamp` and `evidence_id` are recorded for provenance but do NOT trigger staleness
 *  (`capability_hash` already captures adapter behaviour changes within a version). */
export function loadBearing(b: BindingInputs): Record<string, string> {
  return {
    'runtime.id': b.runtime.id,
    'runtime.version': b.runtime.version ?? '∅',
    'tamperward.version': b.tamperward.version,
    'adapter.capability_hash': b.adapter.capability_hash,
    'hook_config_hash': b.hook_config_hash ?? '∅',
    'execution_mode': b.execution_mode,
    'platform': b.platform,
    'model': b.model ?? '∅',
    'tested_capabilities': [...b.tested_capabilities].sort().join(','),
  };
}

export interface StalenessResult {
  stale: boolean;
  /** Human-readable "field: old → new" lines for every changed load-bearing input. */
  changed: string[];
}

/** Compare a stored binding to the current one and report which load-bearing inputs changed. */
export function qualificationStaleness(stored: QualificationBinding, current: QualificationBinding): StalenessResult {
  const a = loadBearing(stored);
  const b = loadBearing(current);
  const changed: string[] = [];
  for (const key of Object.keys(b)) {
    if (a[key] !== b[key]) changed.push(`${key}: ${a[key]} → ${b[key]}`);
  }
  return { stale: changed.length > 0, changed };
}

/** A deterministic evidence id over the load-bearing binding plus the assessed states — the
 *  identity a caller cites for THIS qualification. */
export function evidenceId(binding: BindingInputs, assessments: readonly CapabilityAssessment[]): string {
  const projection = {
    load_bearing: loadBearing(binding),
    states: assessments.map((a) => [a.id, a.state] as const),
  };
  return sha16(JSON.stringify(projection));
}
