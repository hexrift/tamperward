// GitHub Copilot SDK (@github/copilot-sdk) permission request → the neutral SteeringEvent
// (#482 / #611, EXPERIMENTAL — spike infrastructure).
//
// The hosted-SDK counterpart to src/adapters/copilot/schema.ts. Where the CLI adapter parses
// raw hook bytes off stdin, the hosted SDK hands the host an in-process `PermissionRequest`
// object before each tool executes (`onPermissionRequest`). The host JSON-serialises that
// object and passes it here, so this module normalises the SDK's fields into the runtime-neutral
// event the engine already understands — reading no disk and reaching no engine.
//
// The SDK `PermissionRequest` surface (from the @github/copilot-sdk Node README):
//   kind: 'shell' | 'write' | 'read' | 'mcp' | 'custom-tool' | 'url' | 'memory' | 'hook'
//   toolCallId, toolName, fileName (write), fullCommandText (shell), managedApprovalRequired
// plus the host-supplied session identity (sessionId) and the claimed working directory (cwd).
//
// IMPORTANT LIMITATION carried through the whole adapter: a `write` request surfaces the target
// `fileName` but NOT the proposed content. So a shell request reconstructs to a real command
// Change (content-sensitive), while a write reconstructs to a path-only operation the pre-action
// path deliberately does NOT judge — see adapter.ts and docs/guide/runtime-adapters.md §Copilot
// SDK. `end-of-turn` (the SDK `onAgentStop` hook) is a synthetic stop op, exactly as the CLI and
// Codex adapters model it.

import { OperationKind, ProposedOperation, SteeringEvent, SteeringPhase, UntrustedIdentity } from '../contract';
import { isRecord } from '../../narrow';

/** SDK permission `kind` → neutral operation kind. `custom-tool` / `url` / `memory` / `hook`
 *  carry no repository mutation this adapter reconstructs, so they map to `other` (no Change,
 *  hence a pre-action allow), exactly as the CLI adapter models read-only / unknown tools. */
export function copilotSdkOperationKind(kind: string | undefined): OperationKind {
  switch ((kind ?? '').toLowerCase()) {
    case 'shell':
      return 'shell';
    case 'write':
      return 'file-edit';
    case 'read':
      return 'file-read';
    case 'mcp':
      return 'mcp';
    default:
      return 'other';
  }
}

interface SdkRequest {
  kind?: string;
  toolName?: string;
  fileName?: string;
  fullCommandText?: string;
  cwd?: string;
  sessionId?: string;
  stopHookActive?: boolean;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Field-by-field, wrong types dropped rather than believed. Never throws — the caller
 *  distinguishes an empty absence from a malformed shape first. */
function requestFrom(parsed: Record<string, unknown>): SdkRequest {
  return {
    ...(str(parsed.kind) !== undefined ? { kind: str(parsed.kind) } : {}),
    ...(str(parsed.toolName) !== undefined ? { toolName: str(parsed.toolName) } : {}),
    ...(str(parsed.fileName) !== undefined ? { fileName: str(parsed.fileName) } : {}),
    ...(str(parsed.fullCommandText) !== undefined ? { fullCommandText: str(parsed.fullCommandText) } : {}),
    ...(str(parsed.cwd) !== undefined ? { cwd: str(parsed.cwd) } : {}),
    ...(str(parsed.sessionId) !== undefined ? { sessionId: str(parsed.sessionId) } : {}),
    ...(typeof parsed.stopHookActive === 'boolean' ? { stopHookActive: parsed.stopHookActive } : {}),
  };
}

/** The reconstruction args for a pre-action operation. A shell op carries its `fullCommandText`
 *  as `command` (judged content-sensitively by the command detectors); a write carries only its
 *  `fileName` as `path` (NO content — the pre-action path does not judge it). */
function argsFor(req: SdkRequest): Record<string, unknown> {
  const kind = copilotSdkOperationKind(req.kind);
  if (kind === 'shell') return req.fullCommandText !== undefined ? { command: req.fullCommandText } : {};
  if (kind === 'file-edit') return req.fileName !== undefined ? { path: req.fileName } : {};
  return {};
}

function eventFrom(req: SdkRequest, phase: SteeringPhase): SteeringEvent {
  const operation: ProposedOperation =
    phase === 'end-of-turn'
      ? { kind: 'other', name: 'stop', args: {} }
      : { kind: copilotSdkOperationKind(req.kind), name: req.toolName ?? '', args: argsFor(req) };
  const identity: UntrustedIdentity = { claimedCwd: req.cwd, sessionId: req.sessionId };
  return { phase, operation, identity };
}

type ParseResult = { kind: 'absent' } | { kind: 'ok'; record: Record<string, unknown> } | { kind: 'fail'; detail: string };

function parseRaw(raw: string): ParseResult {
  if (!raw.trim()) return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { kind: 'fail', detail: `the Copilot SDK permission request is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isRecord(parsed)) {
    return { kind: 'fail', detail: `the Copilot SDK permission request is not a JSON object (got ${Array.isArray(parsed) ? 'an array' : typeof parsed})` };
  }
  return { kind: 'ok', record: parsed };
}

/**
 * Normalise a JSON-serialised SDK PermissionRequest for `phase` into a neutral event, or a parse
 * failure. Empty/whitespace input is a well-formed ABSENCE (an allow); invalid JSON or a non-object
 * is a `parse-failure` the adapter fails CLOSED on.
 */
export function normalizeCopilotSdkEvent(raw: string, phase: SteeringPhase): SteeringEvent | { failure: 'parse-failure'; detail: string } {
  const parsed = parseRaw(raw);
  if (parsed.kind === 'absent') return eventFrom({}, phase);
  if (parsed.kind === 'fail') return { failure: 'parse-failure', detail: parsed.detail };
  return eventFrom(requestFrom(parsed.record), phase);
}

/**
 * Build the Claude-format Stop payload the canonical git sweep (`stopFromRaw`) consumes, from a
 * serialised SDK `onAgentStop` request. Normalises `sessionId` → `session_id` so the sweep anchors
 * the same per-session turn baseline the pre-action path pinned. Returns a parse-failure for a
 * malformed payload (the adapter validates before calling, but this stays honest).
 */
export function copilotSdkStopInput(raw: string): string | { failure: 'parse-failure'; detail: string } {
  const parsed = parseRaw(raw);
  if (parsed.kind === 'absent') return '{}';
  if (parsed.kind === 'fail') return { failure: 'parse-failure', detail: parsed.detail };
  const req = requestFrom(parsed.record);
  return JSON.stringify({
    ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
    ...(req.sessionId !== undefined ? { session_id: req.sessionId } : {}),
    ...(req.stopHookActive !== undefined ? { stop_hook_active: req.stopHookActive } : {}),
  });
}
