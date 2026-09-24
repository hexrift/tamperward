// The vendor-neutral in-loop steering contract (#482, Phase 1).
//
// TamperWard's detectors and engine are already runtime-neutral: they consume a
// `Change[]` and know nothing of the agent that produced it. The coupling to Claude
// Code lives in a thin seam — the hook I/O (src/cli/hook.ts) and the Claude adapter
// (src/adapters/claude/*). This module names that seam as a TYPE so a second runtime
// can implement it without a rewrite, and so the semantics a runtime does and does
// NOT provide are recorded per operation rather than assumed.
//
// This file is TYPES + small pure helpers ONLY. It changes no verdict, reads no disk,
// and imports nothing from the engine or the live hook path. The Claude implementation
// (src/adapters/claude/adapter.ts) delegates to the unchanged canonical functions in
// src/cli/hook.ts; this module never becomes a second, divergent verdict path.
//
// Design follows the owner's review on #482 (decision/observation split, per-operation
// capabilities, explicit failure states, and "runtime-supplied identity is a claim to
// validate, not a trusted fact").

import { Finding } from '../types';

/**
 * The three points a runtime can hand TamperWard control, kept explicitly distinct so
 * a post-edit observation is never mistaken for a pre-execution veto:
 *
 *  - `pre-action`   — BEFORE the operation runs. Carries a SYNCHRONOUS decision: a deny
 *                     here blocks the operation (Claude PreToolUse, even under
 *                     `--dangerously-skip-permissions`).
 *  - `post-action`  — AFTER the operation ran. OBSERVATION ONLY: the outcome is reported
 *                     so it can be recorded and swept, but this phase NEVER carries a veto
 *                     (a mutation that already landed cannot be un-run here).
 *  - `end-of-turn`  — the turn is ending. Lifecycle status plus a MANDATORY final sweep of
 *                     the turn's net effect on the tree (Claude Stop). This is what still
 *                     catches a mutation a runtime could only observe, not pre-deny.
 */
export type SteeringPhase = 'pre-action' | 'post-action' | 'end-of-turn';

/**
 * The kind of operation a runtime proposes, at the granularity the review requires:
 * capabilities are declared PER OPERATION, not per layer, because a runtime can gate
 * one kind synchronously (shell) while only observing another (a native file edit).
 */
export type OperationKind = 'shell' | 'file-edit' | 'file-read' | 'mcp' | 'other' | 'unknown';

export type Verdict = 'allow' | 'deny';

/** The operation a runtime proposes, as the runtime describes it — an UNTRUSTED input. */
export interface ProposedOperation {
  kind: OperationKind;
  /** The tool/operation name as the runtime named it (e.g. 'Bash', 'Edit', 'stop'). */
  name: string;
  /** The operation arguments verbatim from the runtime. Validated downstream, never trusted. */
  args: Record<string, unknown>;
}

/**
 * The working-directory / repository / session identity AS THE RUNTIME CLAIMS IT.
 *
 * REVIEW POINT 5: this is a claim to validate, not authority. The runner derives the
 * real repository root INDEPENDENTLY (git rev-parse), and a supplied cwd that escapes
 * the trusted root, resolves through a symlink out of it, is malformed, or names a
 * different repository than the one under enforcement must be rejected — never believed.
 * See `RuntimeAdapter.validateIdentity` and docs/guide/runtime-adapters.md §"Identity".
 */
export interface UntrustedIdentity {
  /** The cwd the runtime says the operation runs in. A CLAIM — validate, do not trust. */
  claimedCwd?: string;
  /** The runtime's session id, anchoring the end-of-turn baseline. Also untrusted. */
  sessionId?: string;
}

/** The neutral event a `RuntimeAdapter.parseEvent` produces from raw runtime bytes. */
export interface SteeringEvent {
  phase: SteeringPhase;
  /** For `end-of-turn`, a synthetic operation of kind 'other' named 'stop'. */
  operation: ProposedOperation;
  identity: UntrustedIdentity;
}

/** A synchronous decision. `deny` is enforced at `pre-action`; at `end-of-turn` a deny
 *  blocks the stop. `post-action` never yields a `deny` (observation only). */
export interface SteeringDecision {
  verdict: Verdict;
  /** The blocking findings behind a deny (empty for an allow). */
  findings: Finding[];
  /** The human/agent-facing correction message carried on the wire. */
  reason?: string;
}

export type OperationSet = readonly OperationKind[];

/**
 * What a runtime can actually do, declared per operation. A runtime that supplies only
 * a SUBSET (e.g. shell/MCP pre-deny but not native file-edit pre-deny) is a scoped
 * PARTIAL adapter and does NOT meet Claude-equivalent semantics — the gap is recorded
 * in `unsupported`, never silently degraded (review points 1, 2).
 */
export interface RuntimeCapabilities {
  /** Operation kinds this runtime can SYNCHRONOUSLY DENY before execution (pre-action). */
  preDeny: OperationSet;
  /** Operation kinds this runtime reports AFTER execution (post-action, observation only). */
  postObserve: OperationSet;
  /** True iff the runtime delivers an end-of-turn/stop event that can run the mandatory sweep. */
  endOfTurn: boolean;
  /**
   * Semantics this runtime explicitly does NOT provide, as prose tags
   * (e.g. 'file-edit pre-deny', 'network-egress control', 'identity/authN'). A
   * cross-runtime study reads this to avoid presenting a partial adapter as equivalent.
   */
  unsupported: readonly string[];
}

/**
 * The explicit outcome of a steering attempt. The failure states are first-class so a
 * runtime that could not participate is never confused with one that ALLOWED:
 *
 *  - `ok`                — the runtime participated; `decision` carries allow or deny.
 *  - `unsupported`       — this phase/operation is outside the runtime's declared
 *                          capabilities. No decision; the caller's OTHER boundary (the
 *                          run envelope / CI) is the authority for the uncovered operation.
 *  - `not-invoked`       — a required hook did not fire (config removed before start, a
 *                          platform regression). Fails CLOSED for a required phase.
 *  - `parse-failure`     — the event bytes could not be understood. Fails CLOSED (deny).
 *  - `transport-failure` — the event could not be delivered/retrieved. Fails CLOSED (deny).
 *
 * `parse-failure` and `transport-failure` MUST map to DENY, mirroring today's
 * `HookInputError` → `failClosed` behaviour in src/cli/hook.ts.
 */
export type SteeringOutcome = 'ok' | 'unsupported' | 'not-invoked' | 'parse-failure' | 'transport-failure';

/** The result of a steering attempt: an outcome, the decision it produced (when any),
 *  and the exact wire bytes to hand the runtime. */
export interface SteeringResult {
  outcome: SteeringOutcome;
  /** The synchronous decision. Present for `ok`, and a fail-closed DENY for the failure
   *  outcomes that map to one (`parse-failure`, `transport-failure`, required `not-invoked`).
   *  Absent for `unsupported`. */
  decision?: SteeringDecision;
  /** The exact wire bytes for the runtime (empty string = allow). Absent for `unsupported`. */
  wire?: string;
  /** Diagnostic detail for a failure outcome (never echoes the inspected command/env). */
  detail?: string;
  /** A SANITIZED, bounded category for WHY a fail-closed `tamperward-unavailable` decision occurred, so
   *  a diagnosing caller can tell a parse / identity / policy-load / repo-context / reconstruction /
   *  evaluate failure apart WITHOUT the raw `detail` (which may echo paths or error text). Set only on
   *  fail-closed results; absent on allow/deny-by-policy/unsupported (#616 item C). */
  unavailableReason?: UnavailableReason;
}

/** The bounded, sanitized cause categories for a fail-closed `tamperward-unavailable` decision (#616). */
export type UnavailableReason =
  | 'parse-failure'
  | 'identity-rejected'
  | 'repo-context'
  | 'policy-load'
  | 'baseline'
  | 'reconstruction'
  | 'evaluate'
  | 'other';

/** The result of validating a runtime's identity claim against the runner's trusted root. */
export interface IdentityValidation {
  ok: boolean;
  /** The repository root the runner derived INDEPENDENTLY of the runtime claim. */
  trustedRoot?: string;
  /** Why the claim was rejected (path escape, symlink escape, malformed, missing/changed). */
  rejected?: string;
}

/**
 * The seam a runtime implements to receive TamperWard's in-loop steering.
 *
 * A conforming adapter NEVER opens a second verdict path: it either delegates to the
 * canonical engine/hook functions (as the Claude adapter does) or reuses `synthFileChange`
 * / `formatDenial` so the diff reconstruction, fail-closed behaviour and denial wording
 * are shared. The interface exists to make the covered/uncovered surface explicit, not to
 * re-implement enforcement per runtime.
 */
export interface RuntimeAdapter {
  /** Stable adapter id (e.g. 'claude-code'). */
  name: string;
  /** What this runtime can do, per operation. */
  capabilities: RuntimeCapabilities;
  /** Parse raw runtime bytes for `phase` into the neutral event, or a parse failure. */
  parseEvent(raw: string, phase: SteeringPhase): SteeringEvent | { failure: 'parse-failure'; detail: string };
  /**
   * Validate the runtime-supplied identity against the runner's trusted repository root,
   * deriving the git root INDEPENDENTLY of the claim (review point 5). Reject path/symlink
   * escapes, malformed paths, and a missing/changed repository identity. This is the
   * explicit boundary; it must never weaken a check the live path already performs.
   */
  validateIdentity(claim: UntrustedIdentity, defaultCwd?: string): IdentityValidation;
  /** The wire bytes for a DENY at `phase` — byte-identical to the runtime's native deny
   *  envelope. Empty operations are not this method's concern (an allow writes nothing). */
  denyPayload(findings: Finding[], phase: SteeringPhase): string;
  /**
   * The authoritative synchronous path: parse → validate → decide → wire. Every failure
   * state that maps to a decision fails CLOSED (deny). For a runtime whose canonical
   * implementation lives elsewhere (Claude's src/cli/hook.ts), this DELEGATES to it so
   * the observable output is byte-identical.
   */
  decide(raw: string, phase: SteeringPhase, defaultCwd?: string): SteeringResult;
}

// ————————————————————————————————————————————————————————————————————————
// Small pure helpers. No disk, no git, no engine — safe for any adapter to reuse.
// ————————————————————————————————————————————————————————————————————————

/** The three phases, for iteration in tests/docs. */
export const STEERING_PHASES: readonly SteeringPhase[] = ['pre-action', 'post-action', 'end-of-turn'];

/**
 * The coarse research-ledger layer names (`src/research/adapter.ts` `ADAPTER_LAYERS`).
 * Declared here as a literal union so this neutral module stays free of a research import;
 * the conformance test asserts it stays equal to `ADAPTER_LAYERS` so the two cannot drift.
 */
export type ResearchLayer = 'envelope' | 'pre-tool-use' | 'stop-sweep';

/** One row of the neutral-contract → research-`layers` mapping. `source` is the neutral
 *  phase, or the post-exit run envelope that wraps the whole agent process. */
export interface ContractLayerMapping {
  source: SteeringPhase | 'post-exit-envelope';
  layer: ResearchLayer;
  note: string;
}

/**
 * How the neutral steering contract maps onto the research runner's coarse `layers`
 * (#482 completeness). The per-OPERATION capabilities (`RuntimeCapabilities`) REFINE this
 * coarse mapping: a runtime records `layer: pre-tool-use` only for the operation kinds it
 * can actually pre-deny, so a cross-runtime ledger never presents a partial adapter's
 * shell/MCP interception as the same treatment as Claude's all-operation PreToolUse. This
 * is a doc/type mapping only — it changes no research-runtime behaviour.
 */
export const CONTRACT_TO_RESEARCH_LAYER: readonly ContractLayerMapping[] = [
  { source: 'pre-action', layer: 'pre-tool-use', note: 'synchronous pre-execution deny (Claude PreToolUse)' },
  { source: 'end-of-turn', layer: 'stop-sweep', note: 'mandatory end-of-turn reconciliation (Claude Stop)' },
  {
    source: 'post-exit-envelope',
    layer: 'envelope',
    note: "the run envelope around the whole agent process; post-action outcome observation lives here, not in a per-tool veto",
  },
];

/**
 * A fail-closed finding for a non-empty Copilot tool name outside the adapter's explicit
 * vocabulary. This is a classification gap, not a transport failure: the operator should
 * confirm the tool's semantics and add it deliberately, rather than repair hook delivery.
 */
export function unknownToolFinding(toolName: string): Finding {
  const name = toolName.length > 80 ? toolName.slice(0, 77) + '...' : toolName;
  const detail = 'Copilot tool "' + name + '" is not in TamperWard\'s explicit operation vocabulary';
  return {
    rule: 'unknown-tool',
    severity: 'block',
    message: 'TamperWard cannot safely classify ' + detail + '; it is denied rather than treated as a no-op.',
    evidence: detail,
    remediation:
      'Confirm the tool is non-mutating and add it to the Copilot adapter allowlist, or obtain an explicit sign-off before retrying.',
    signoff: { required: true, command: 'tamperward allow --reason "..."' },
  };
}

/**
 * The declarable operation kinds, for iteration and for declaring "all kinds" capabilities.
 *
 * `unknown` is intentionally absent: it is a Copilot adapter classification outcome for
 * an unmapped non-empty tool name, never a capability a runtime may claim to cover.
 */
export const OPERATION_KINDS: readonly OperationKind[] = ['shell', 'file-edit', 'file-read', 'mcp', 'other'];

/** True when `outcome` is one that MUST fail closed (deny) rather than allow. */
export function failsClosed(outcome: SteeringOutcome): boolean {
  return outcome === 'parse-failure' || outcome === 'transport-failure' || outcome === 'not-invoked';
}

/**
 * The neutral fail-closed finding for a steering failure a runtime surfaces at the seam
 * (a transport failure, a required hook that did not fire). It mirrors the shape and
 * intent of `failClosed` in src/cli/hook.ts so a partial adapter denies with the same
 * "could not evaluate, so denied" contract. Claude's live path builds its OWN finding
 * inside src/cli/hook.ts and does not use this helper, so the two never drift for Claude.
 */
export function steeringUnavailableFinding(detail: string): Finding {
  return {
    rule: 'tamperward-unavailable',
    severity: 'block',
    message: `TamperWard could not evaluate this operation (${detail}), so it is denied rather than allowed.`,
    evidence: detail,
    remediation:
      'Repair the runtime steering path (hook config, transport, or event delivery), then retry. Do not work around the gate while it is down.',
    signoff: { required: true, command: 'tamperward allow --reason "..."' },
  };
}

/**
 * Build a fail-closed DENY result for a failure outcome, using the adapter's own
 * `denyPayload` so the wire bytes are the runtime's native deny envelope. Used by an
 * adapter to map a transport/not-invoked failure onto a deny (`parse-failure` for Claude
 * is produced by the live path, which already fails closed — see the Claude adapter).
 */
export function failClosedResult(
  outcome: 'parse-failure' | 'transport-failure' | 'not-invoked',
  detail: string,
  phase: SteeringPhase,
  denyPayload: (findings: Finding[], phase: SteeringPhase) => string,
): SteeringResult {
  const findings = [steeringUnavailableFinding(detail)];
  const wire = denyPayload(findings, phase);
  return { outcome, detail, wire, decision: { verdict: 'deny', findings, reason: wire } };
}
