// GitHub Copilot CLI hook payload → the neutral SteeringEvent (#482 / #598, EXPERIMENTAL).
//
// The Copilot counterpart to src/cli/hook.ts `parseInput` and the Codex adapter's
// `normalizeCodexEvent`: it turns raw Copilot CLI hook bytes into the runtime-neutral
// event the engine already understands, or a parse failure that the adapter fails CLOSED
// on. It reads no disk and reaches no engine — only shape normalization and the
// tool-name → OperationKind map live here.
//
// Empty/absent stdin is a well-formed ABSENCE (an allow), exactly as the Claude and Codex
// parsers treat it; a present-but-malformed payload (invalid JSON, or a non-object shape)
// is a parse-failure that must fail closed. Field values of the wrong type are dropped,
// not believed — never fatal — mirroring `parseInput`.
//
// Wire grounding: every Copilot CLI hook payload carries the common fields `cwd`,
// `session_id` and `timestamp`; a `preToolUse` payload additionally carries `tool_name`,
// a `tool_input` object, and a `tool_use_id` (GitHub Copilot hooks reference). The tool
// names are lowercase — `bash` / `powershell` for the shell, `create` / `edit` (with
// `str_replace` / `write` as edit-family aliases) for file writes; MCP tools arrive as
// `mcp__<server>__<tool>`. Deletes and renames are issued through the shell (`rm` / `mv`),
// so they reconstruct via the shell path, not a dedicated tool.

import { OperationKind, ProposedOperation, SteeringEvent, SteeringPhase, UntrustedIdentity } from '../contract';
import { isRecord } from '../../narrow';

export interface CopilotHookInput {
  /** Copilot names its events in camelCase (`preToolUse`, `postToolUse`, `agentStop`, …);
   *  the phase is supplied by the driver, so this is retained for diagnostics only. */
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Copilot's per-call id; retained for evidence correlation, not used in reconstruction. */
  tool_use_id?: string;
  cwd?: string;
  session_id?: string;
  stop_hook_active?: boolean;
}

// Canonical Copilot CLI hook-facing tool names (GitHub Copilot hooks reference):
//  - the shell family is `bash` (POSIX) and `powershell` (Windows);
//  - native file writes are `create` (new file) and `edit`, with `str_replace` / `write`
//    accepted as edit-family aliases the reconstruction understands;
//  - MCP calls are `mcp__<server>__<tool>`;
//  - a native read tool produces no Change downstream. Shell-mediated reads arrive as
//    `bash` and MCP reads as `mcp__…`.
const SHELL_TOOLS = new Set(['bash', 'powershell']);
const FILE_EDIT_TOOLS = new Set(['create', 'edit', 'str_replace', 'write']);
const FILE_READ_TOOLS = new Set(['view', 'read']);
const MCP_PREFIX = 'mcp__';

/** Copilot hook-facing tool name → neutral operation kind. Read-only and unknown kinds
 *  produce no Change downstream (src/adapters/copilot/changes.ts). Matched
 *  case-insensitively so a `Bash` / `BASH` spelling maps the same as `bash`. */
export function copilotOperationKind(toolName: string | undefined): OperationKind {
  if (!toolName) return 'other';
  const name = toolName.toLowerCase();
  if (SHELL_TOOLS.has(name)) return 'shell';
  if (FILE_EDIT_TOOLS.has(name)) return 'file-edit';
  if (name.startsWith(MCP_PREFIX)) return 'mcp';
  if (FILE_READ_TOOLS.has(name)) return 'file-read';
  return 'other';
}

/** Field-by-field, wrong types dropped rather than believed. Never throws — the caller
 *  distinguishes an empty absence from a malformed shape before calling this. */
function inputFrom(parsed: Record<string, unknown>): CopilotHookInput {
  return {
    ...(typeof parsed.hook_event_name === 'string' ? { hook_event_name: parsed.hook_event_name } : {}),
    ...(typeof parsed.tool_name === 'string' ? { tool_name: parsed.tool_name } : {}),
    ...(isRecord(parsed.tool_input) ? { tool_input: parsed.tool_input } : {}),
    ...(typeof parsed.tool_use_id === 'string' ? { tool_use_id: parsed.tool_use_id } : {}),
    ...(typeof parsed.cwd === 'string' ? { cwd: parsed.cwd } : {}),
    ...(typeof parsed.session_id === 'string' ? { session_id: parsed.session_id } : {}),
    ...(typeof parsed.stop_hook_active === 'boolean' ? { stop_hook_active: parsed.stop_hook_active } : {}),
  };
}

function eventFrom(input: CopilotHookInput, phase: SteeringPhase): SteeringEvent {
  const operation: ProposedOperation =
    phase === 'end-of-turn'
      ? { kind: 'other', name: 'stop', args: {} }
      : { kind: copilotOperationKind(input.tool_name), name: input.tool_name ?? '', args: input.tool_input ?? {} };
  const identity: UntrustedIdentity = { claimedCwd: input.cwd, sessionId: input.session_id };
  return { phase, operation, identity };
}

/**
 * Normalize raw Copilot CLI hook bytes for `phase` into a neutral event, or a parse failure.
 *
 *  - empty/whitespace-only stdin → a well-formed ABSENCE: an event with an empty-named
 *    operation (which reconstructs to no Change, hence an allow), matching the Claude and
 *    Codex parsers' treatment of `< /dev/null`;
 *  - invalid JSON, or a JSON value that is not an object (an array, a primitive) →
 *    `parse-failure`, which the adapter maps to a fail-closed deny.
 */
export function normalizeCopilotEvent(
  raw: string,
  phase: SteeringPhase,
): SteeringEvent | { failure: 'parse-failure'; detail: string } {
  if (!raw.trim()) return eventFrom({}, phase);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      failure: 'parse-failure',
      detail: `the Copilot hook payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!isRecord(parsed)) {
    return {
      failure: 'parse-failure',
      detail: `the Copilot hook payload is not a JSON object (got ${Array.isArray(parsed) ? 'an array' : typeof parsed})`,
    };
  }
  return eventFrom(inputFrom(parsed), phase);
}
