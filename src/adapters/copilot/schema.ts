// GitHub Copilot CLI hook payload → the neutral SteeringEvent (#482 / #598, EXPERIMENTAL).
//
// The Copilot counterpart to src/cli/hook.ts `parseInput` and the Codex adapter's
// `normalizeCodexEvent`: it turns raw Copilot CLI hook bytes into the runtime-neutral event
// the engine already understands, or a parse failure that the adapter fails CLOSED on. It
// reads no disk and reaches no engine — only shape normalization and the tool-name →
// OperationKind map live here.
//
// TWO DOCUMENTED WIRE FORMATS (GitHub Copilot hooks reference). The adapter accepts both, so
// it works whichever mode a Copilot build emits:
//
//   1. NATIVE camelCase — `preToolUse`:  { sessionId, timestamp, cwd, toolName, toolArgs }
//      where `toolArgs` arrives as a JSON *string* that must be parsed; `agentStop`:
//      { sessionId, transcriptPath, stopReason }.
//   2. PascalCase (VS Code / Claude-compatible) — `PreToolUse`: { hook_event_name, session_id,
//      timestamp, cwd, tool_name, tool_input } where `tool_name` is the CLAUDE tool name
//      (`Bash`, `Write`, `Edit`, `Read`); `Stop`: { session_id, transcript_path, stop_reason }.
//
// Normalization is field-by-field with the PascalCase/snake_case spelling taking precedence and
// the native camelCase spelling as a fallback, so either mode — or a build that mixes them —
// normalizes sensibly. `tool_use_id` is NOT a documented Copilot hook field and is not read.
//
// Empty/absent stdin is a well-formed ABSENCE (an allow), exactly as the Claude and Codex
// parsers treat it; a present-but-malformed payload (invalid JSON, or a non-object shape) is a
// parse-failure that must fail closed. Field values of the wrong type are dropped, not believed.

import { OperationKind, ProposedOperation, SteeringEvent, SteeringPhase, UntrustedIdentity } from '../contract';
import { isRecord } from '../../narrow';

export interface CopilotHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  session_id?: string;
  stop_hook_active?: boolean;
}

// Canonical Copilot CLI hook-facing tool names span BOTH documented vocabularies (GitHub
// Copilot hooks reference), matched case-insensitively so the same map handles the native
// lowercase names and the PascalCase Claude-compatible names:
//  - shell: `bash` / `powershell` (native), `Bash` (PascalCase). The Copilot CLI command
//    reference also lists shell-SESSION tools — `write_bash` / `write_powershell` SEND INPUT
//    to an existing shell session, so they are mutation-capable and classified as `shell`
//    too (never `other`, which would produce a silent allow); the read/list/stop session
//    tools do not send input and are left non-mutating;
//  - file write: `create` / `edit` / `apply_patch` / `str_replace_editor` (native),
//    `Write` / `Edit` (PascalCase). NOTE: in PascalCase mode, a native `apply_patch` / `edit`
//    / `str_replace_editor` is reported to the hook as `Edit`. `MultiEdit` is accepted
//    DEFENSIVELY (a Claude-compatible name), not because a Copilot source documents it;
//  - file read: `view`, `grep`/`rg`, `glob` (native), `Read`, `Grep`, `Glob` (PascalCase); all are
 *    non-mutating and produce no Change;
 *  - other non-mutating built-ins: `read_*` / `stop_*` / `list_*` shell-session helpers,
 *    `web_fetch`/`web_search`, `ask_user`, `report_intent`, `task`/`agent`, `skill`, and
 *    `update_todo`/`todowrite`/`todo`, including their documented PascalCase aliases;
//  - MCP: `mcp__<server>__<tool>`.
const SHELL_TOOLS = new Set(['bash', 'powershell', 'write_bash', 'write_powershell']);
const FILE_EDIT_TOOLS = new Set(['create', 'edit', 'write', 'multiedit', 'apply_patch', 'str_replace_editor']);
const FILE_READ_TOOLS = new Set(['view', 'read', 'grep', 'rg', 'glob']);
const NON_MUTATING_TOOLS = new Set([
  'read_bash', 'read_powershell', 'stop_bash', 'stop_powershell', 'list_bash', 'list_powershell',
  'web_fetch', 'webfetch', 'web_search', 'websearch', 'ask_user', 'askuserquestion', 'report_intent',
  'task', 'agent', 'skill', 'update_todo', 'todowrite', 'todo', 'list_agents', 'read_agent', 'write_agent',
]);
const MCP_PREFIX = 'mcp__';

/** Copilot hook-facing tool name → neutral operation kind, over both documented vocabularies.
 *  Read-only kinds produce no Change downstream; explicitly non-mutating built-ins are mapped to
 *  `other`; unknown names remain explicit so the adapter can fail closed. */
export function copilotOperationKind(toolName: string | undefined): OperationKind {
  if (!toolName) return 'other';
  const name = toolName.toLowerCase();
  if (SHELL_TOOLS.has(name)) return 'shell';
  if (FILE_EDIT_TOOLS.has(name)) return 'file-edit';
  if (name.startsWith(MCP_PREFIX)) return 'mcp';
  if (FILE_READ_TOOLS.has(name)) return 'file-read';
  if (NON_MUTATING_TOOLS.has(name)) return 'other';
  return 'unknown';
}

/** The tool arguments, from PascalCase `tool_input` (an object) or native `toolArgs` (a JSON
 *  string that must be parsed, per GitHub's tutorial). A `toolArgs` that is not valid JSON is
 *  dropped, not believed — the reconstruction then carries no args and fails closed to a deny. */
function argsFrom(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(parsed.tool_input)) return parsed.tool_input;
  const ta = parsed.toolArgs;
  if (isRecord(ta)) return ta;
  if (typeof ta === 'string' && ta.trim()) {
    try {
      const decoded = JSON.parse(ta);
      return isRecord(decoded) ? decoded : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Field-by-field, PascalCase/snake_case winning over native camelCase, wrong types dropped
 *  rather than believed. Never throws — the caller distinguishes an empty absence from a
 *  malformed shape before calling this. */
function inputFrom(parsed: Record<string, unknown>): CopilotHookInput {
  const toolName =
    typeof parsed.tool_name === 'string' ? parsed.tool_name : typeof parsed.toolName === 'string' ? parsed.toolName : undefined;
  const sessionId =
    typeof parsed.session_id === 'string' ? parsed.session_id : typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined;
  const args = argsFrom(parsed);
  return {
    ...(toolName !== undefined ? { tool_name: toolName } : {}),
    ...(args !== undefined ? { tool_input: args } : {}),
    ...(typeof parsed.cwd === 'string' ? { cwd: parsed.cwd } : {}),
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
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

type ParseResult =
  | { kind: 'absent' }
  | { kind: 'ok'; record: Record<string, unknown> }
  | { kind: 'fail'; detail: string };

function parseRaw(raw: string): ParseResult {
  if (!raw.trim()) return { kind: 'absent' }; // well-formed absence
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { kind: 'fail', detail: `the Copilot hook payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isRecord(parsed)) {
    return { kind: 'fail', detail: `the Copilot hook payload is not a JSON object (got ${Array.isArray(parsed) ? 'an array' : typeof parsed})` };
  }
  return { kind: 'ok', record: parsed };
}

/**
 * Normalize raw Copilot CLI hook bytes for `phase` into a neutral event, or a parse failure.
 *
 *  - empty/whitespace-only stdin → a well-formed ABSENCE: an event with an empty-named
 *    operation (which reconstructs to no Change, hence an allow);
 *  - invalid JSON, or a JSON value that is not an object → `parse-failure` (fail-closed deny).
 */
export function normalizeCopilotEvent(
  raw: string,
  phase: SteeringPhase,
): SteeringEvent | { failure: 'parse-failure'; detail: string } {
  const parsed = parseRaw(raw);
  if (parsed.kind === 'absent') return eventFrom({}, phase);
  if (parsed.kind === 'fail') return { failure: 'parse-failure', detail: parsed.detail };
  return eventFrom(inputFrom(parsed.record), phase);
}

/**
 * Build the Claude-format Stop payload the canonical git sweep (`stopFromRaw`) consumes, from
 * either documented Copilot `agentStop` / `Stop` format. This normalizes native `sessionId`
 * → `session_id` so the sweep anchors the same per-session turn baseline the pre-action path
 * pinned, regardless of which wire format the runtime uses. Returns a parse-failure for a
 * malformed payload (the adapter already validates this before calling, but it stays honest).
 */
export function copilotStopInput(raw: string): string | { failure: 'parse-failure'; detail: string } {
  const parsed = parseRaw(raw);
  if (parsed.kind === 'absent') return '{}';
  if (parsed.kind === 'fail') return { failure: 'parse-failure', detail: parsed.detail };
  const input = inputFrom(parsed.record);
  return JSON.stringify({
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
    ...(input.stop_hook_active !== undefined ? { stop_hook_active: input.stop_hook_active } : {}),
  });
}
