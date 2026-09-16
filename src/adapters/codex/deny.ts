// Codex's deny envelope (#482 / #563, EXPERIMENTAL).
//
// Codex documents a single `hookSpecificOutput` deny shape for both its PreToolUse and
// Stop hooks (unlike Claude, whose Stop uses `{decision:"block",reason}`). The reason text
// is built by the SHARED `formatDenial`, so the correction message an agent reads is
// identical across runtimes. An allow writes an empty string.

import { formatDenial } from '../claude/deny';
import { Finding } from '../../types';
import { SteeringPhase } from '../contract';

function hookEventName(phase: SteeringPhase): 'PreToolUse' | 'Stop' {
  return phase === 'end-of-turn' ? 'Stop' : 'PreToolUse';
}

/** Serialise Codex's deny envelope for an already-formatted reason. */
export function codexWire(reason: string, phase: SteeringPhase): string {
  return (
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: hookEventName(phase),
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }) + '\n'
  );
}

/** The deny wire for `findings` at `phase`, reusing `formatDenial`. Empty findings mean an
 *  allow, which writes an empty string. */
export function codexDenyWire(findings: Finding[], phase: SteeringPhase): string {
  if (findings.length === 0) return '';
  return codexWire(formatDenial(findings), phase);
}
