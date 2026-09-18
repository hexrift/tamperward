// GitHub Copilot CLI's deny envelopes (#482 / #598, EXPERIMENTAL).
//
// The deny wire differs BY PHASE, grounded in the real Copilot CLI hook contract
// (GitHub Copilot hooks reference):
//
//  - pre-action (preToolUse) → a FLAT `{ permissionDecision: "deny", permissionDecisionReason }`
//    on stdout. `preToolUse` is the ONLY control point Copilot exposes: returning
//    `permissionDecision:"deny"` blocks the tool call and the reason reaches the agent.
//    (Copilot's flat shape, unlike Claude's `hookSpecificOutput` wrapper.)
//  - end-of-turn (agentStop) → a FLAT `{ decision: "block", reason }`. `decision:"block"`
//    forces the agent to continue for another turn; agentStop cannot veto a tool, but the
//    `{decision,reason}` shape is IDENTICAL to the canonical Stop sweep's wire
//    (src/cli/hook.ts `stopFromRaw`), so the adapter passes that wire through unchanged.
//
// The reason text is built by the SHARED `formatDenial`, so the correction an agent reads is
// identical across runtimes. An allow writes an empty string.
//
// Observation-only `post-action` (postToolUse) is intentionally not a Copilot veto phase and
// is rejected before serialisation.

import { formatDenial } from '../claude/deny';
import { Finding } from '../../types';

export type CopilotWirePhase = 'pre-action' | 'end-of-turn';

function assertCopilotWirePhase(phase: CopilotWirePhase): void {
  // Defends against a caller that bypasses the type with `as never` (the observation-only
  // post-action phase has no veto envelope and must never be serialised into one).
  const known: readonly CopilotWirePhase[] = ['pre-action', 'end-of-turn'];
  if (!known.includes(phase)) {
    throw new Error(`unsupported Copilot wire phase: ${phase}`);
  }
}

/** Serialise Copilot's deny envelope for an already-formatted reason, by phase. */
export function copilotWire(reason: string, phase: CopilotWirePhase): string {
  assertCopilotWirePhase(phase);
  const payload =
    phase === 'end-of-turn'
      ? { decision: 'block', reason }
      : { permissionDecision: 'deny', permissionDecisionReason: reason };
  return JSON.stringify(payload) + '\n';
}

/** The deny wire for `findings` at a supported veto phase, reusing `formatDenial`. Empty
 * findings mean an allow, which writes an empty string. Observation-only phases are rejected. */
export function copilotDenyWire(findings: Finding[], phase: CopilotWirePhase): string {
  assertCopilotWirePhase(phase);
  if (findings.length === 0) return '';
  return copilotWire(formatDenial(findings), phase);
}
