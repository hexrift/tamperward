// Codex's deny envelopes (#482 / #563, EXPERIMENTAL).
//
// The deny wire differs BY PHASE, grounded in the real Codex output schemas
// (codex-rs/hooks/schema/generated):
//
//  - pre-action (PreToolUse) → `hookSpecificOutput.permissionDecision:"deny"` plus
//    `permissionDecisionReason`; the top-level `decision:"block"` + `reason` are also set
//    (the deprecated-but-honoured blocking shape) so a build that reads either path blocks.
//    (pre-tool-use.command.output.schema.json; pre_tool_use.rs
//    `permission_decision_deny_blocks_processing` / `deprecated_block_decision_blocks_processing`.)
//  - end-of-turn (Stop) → `{decision:"block", reason}` ONLY; Stop has no hookSpecificOutput.
//    (stop.command.output.schema.json.)
//
// The reason text is built by the SHARED `formatDenial`, so the correction an agent reads is
// identical across runtimes. An allow writes an empty string.
//
// Observation-only `post-action` is intentionally not a Codex veto phase and is rejected
// before serialisation.

import { formatDenial } from '../claude/deny';
import { Finding } from '../../types';

export type CodexWirePhase = 'pre-action' | 'end-of-turn';

function assertCodexWirePhase(phase: string): asserts phase is CodexWirePhase {
  if (phase !== 'pre-action' && phase !== 'end-of-turn') {
    throw new Error(`unsupported Codex wire phase: ${phase}`);
  }
}

/** Serialise Codex's deny envelope for an already-formatted reason, by phase. */
export function codexWire(reason: string, phase: CodexWirePhase): string {
  assertCodexWirePhase(phase as string);
  const payload =
    phase === 'end-of-turn'
      ? { decision: 'block', reason }
      : {
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
          decision: 'block',
          reason,
        };
  return JSON.stringify(payload) + '\n';
}

/** The deny wire for `findings` at a supported veto phase, reusing `formatDenial`. Empty
 * findings mean an allow, which writes an empty string. Observation-only phases are rejected. */
export function codexDenyWire(findings: Finding[], phase: CodexWirePhase): string {
  assertCodexWirePhase(phase as string);
  if (findings.length === 0) return '';
  return codexWire(formatDenial(findings), phase);
}
