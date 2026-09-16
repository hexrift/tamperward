// Codex hook payload → the neutral SteeringEvent (#482 / #563, EXPERIMENTAL).
//
// This is the Codex counterpart to src/cli/hook.ts `parseInput` + the Claude adapter's
// `eventFrom`: it turns raw Codex hook bytes into the runtime-neutral event the engine
// already understands, or a parse failure that the adapter fails CLOSED on. It reads no
// disk and reaches no engine — only shape normalization and the tool-name → OperationKind
// map live here.
//
// Empty/absent stdin is a well-formed ABSENCE (an allow), exactly as the Claude parser
// treats it; a present-but-malformed payload (invalid JSON, or a non-object shape) is a
// parse-failure that must fail closed. Field values of the wrong type are dropped, not
// believed — never fatal — mirroring `parseInput`.

import { OperationKind, ProposedOperation, SteeringEvent, SteeringPhase, UntrustedIdentity } from '../contract';
import { isRecord } from '../../narrow';

export interface CodexHookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  session_id?: string;
  stop_hook_active?: boolean;
}

const SHELL_TOOLS = new Set(['shell_command', 'exec_command', 'unified_exec', 'exec', 'shell', 'local_shell']);
const FILE_EDIT_TOOLS = new Set([
  'apply_patch',
  'write_file',
  'create_file',
  'edit_file',
  'str_replace',
  'str_replace_editor',
  'str_replace_based_edit_tool',
  'write',
  'edit',
  'patch',
]);
const FILE_READ_TOOLS = new Set(['read_file', 'read', 'view', 'grep', 'search', 'list_files', 'list_dir', 'glob', 'cat', 'ripgrep']);

/** Codex tool name → neutral operation kind. Shell/exec variants gate synchronously;
 *  apply_patch and the edit/write tools are file edits; read/search tools are reads;
 *  an MCP call is named by an `mcp` prefix; everything else is `other`. Read-only and
 *  unknown kinds produce no Change downstream (src/adapters/codex/changes.ts). */
export function codexOperationKind(toolName: string | undefined): OperationKind {
  if (!toolName) return 'other';
  if (SHELL_TOOLS.has(toolName)) return 'shell';
  if (FILE_EDIT_TOOLS.has(toolName)) return 'file-edit';
  if (FILE_READ_TOOLS.has(toolName)) return 'file-read';
  if (toolName.startsWith('mcp')) return 'mcp';
  return 'other';
}

/** Field-by-field, wrong types dropped rather than believed. Never throws — the caller
 *  distinguishes an empty absence from a malformed shape before calling this. */
function inputFrom(parsed: Record<string, unknown>): CodexHookInput {
  return {
    ...(typeof parsed.hook_event_name === 'string' ? { hook_event_name: parsed.hook_event_name } : {}),
    ...(typeof parsed.tool_name === 'string' ? { tool_name: parsed.tool_name } : {}),
    ...(isRecord(parsed.tool_input) ? { tool_input: parsed.tool_input } : {}),
    ...(typeof parsed.cwd === 'string' ? { cwd: parsed.cwd } : {}),
    ...(typeof parsed.session_id === 'string' ? { session_id: parsed.session_id } : {}),
    ...(typeof parsed.stop_hook_active === 'boolean' ? { stop_hook_active: parsed.stop_hook_active } : {}),
  };
}

function eventFrom(input: CodexHookInput, phase: SteeringPhase): SteeringEvent {
  const operation: ProposedOperation =
    phase === 'end-of-turn'
      ? { kind: 'other', name: 'stop', args: {} }
      : { kind: codexOperationKind(input.tool_name), name: input.tool_name ?? '', args: input.tool_input ?? {} };
  const identity: UntrustedIdentity = { claimedCwd: input.cwd, sessionId: input.session_id };
  return { phase, operation, identity };
}

/**
 * Normalize raw Codex hook bytes for `phase` into a neutral event, or a parse failure.
 *
 *  - empty/whitespace-only stdin → a well-formed ABSENCE: an event with an empty-named
 *    operation (which reconstructs to no Change, hence an allow), matching the Claude
 *    parser's treatment of `< /dev/null`;
 *  - invalid JSON, or a JSON value that is not an object (an array, a primitive) →
 *    `parse-failure`, which the adapter maps to a fail-closed deny.
 */
export function normalizeCodexEvent(
  raw: string,
  phase: SteeringPhase,
): SteeringEvent | { failure: 'parse-failure'; detail: string } {
  if (!raw.trim()) return eventFrom({}, phase);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { failure: 'parse-failure', detail: `the Codex hook payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isRecord(parsed)) {
    return {
      failure: 'parse-failure',
      detail: `the Codex hook payload is not a JSON object (got ${Array.isArray(parsed) ? 'an array' : typeof parsed})`,
    };
  }
  return eventFrom(inputFrom(parsed), phase);
}
