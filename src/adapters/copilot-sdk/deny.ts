// GitHub Copilot SDK (@github/copilot-sdk) deny envelopes (#482 / #611, EXPERIMENTAL).
//
// The hosted SDK's decision vocabulary differs from the CLI hook wire, and the two SDK surfaces
// are themselves distinct (@github/copilot-sdk Node README):
//
//  - pre-action (onPermissionRequest) → a `PermissionRequestResult`, a discriminated union on
//    `kind`. Denial is `{ kind: "reject", feedback }`; approval is `{ kind: "approve-once" }` (and
//    kin). Returning `reject` denies the tool before it executes and the `feedback` reaches the
//    agent. (This is NOT the CLI hook's flat `{permissionDecision:"deny",...}`, nor the agentStop
//    `{decision:...}` shape — this adapter never emits those here.)
//  - end-of-turn (onAgentStop) → `{ decision: "block", reason }`, which forces the agent to
//    continue for another turn. This is IDENTICAL to the canonical Stop sweep's wire
//    (src/cli/hook.ts `stopFromRaw`), so the adapter passes that sweep wire through unchanged and
//    only builds this shape itself for a fail-closed seam failure at end-of-turn.
//
// The reason text is built by the SHARED `formatDenial`, so the correction an agent reads is
// identical across runtimes. An allow writes an empty string. Observation-only `post-action` is
// not an SDK veto surface and is rejected before serialisation.

import { formatDenial } from '../claude/deny';
import { Finding } from '../../types';

export type CopilotSdkWirePhase = 'pre-action' | 'end-of-turn';

function assertPhase(phase: CopilotSdkWirePhase): void {
  const known: readonly CopilotSdkWirePhase[] = ['pre-action', 'end-of-turn'];
  if (!known.includes(phase)) throw new Error(`unsupported Copilot SDK wire phase: ${phase}`);
}

/** Serialise the SDK's decision envelope for an already-formatted reason, by phase. Pre-action is
 *  the `PermissionRequestResult` reject variant (discriminated on `kind`); end-of-turn is the
 *  agentStop block/continue shape (discriminated on `decision`). */
export function copilotSdkWire(reason: string, phase: CopilotSdkWirePhase): string {
  assertPhase(phase);
  const payload = phase === 'end-of-turn' ? { decision: 'block', reason } : { kind: 'reject', feedback: reason };
  return JSON.stringify(payload) + '\n';
}

/** The deny wire for `findings` at a supported veto phase, reusing `formatDenial`. Empty findings
 *  mean an allow, which writes an empty string. */
export function copilotSdkDenyWire(findings: Finding[], phase: CopilotSdkWirePhase): string {
  assertPhase(phase);
  if (findings.length === 0) return '';
  return copilotSdkWire(formatDenial(findings), phase);
}
