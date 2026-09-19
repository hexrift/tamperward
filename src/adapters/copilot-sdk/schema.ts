// GitHub Copilot SDK (@github/copilot-sdk) permission request → the neutral SteeringEvent
// (#482 / #611, EXPERIMENTAL — spike infrastructure).
//
// The hosted-SDK counterpart to src/adapters/copilot/schema.ts. Where the CLI adapter parses
// raw hook bytes off stdin, the hosted SDK hands the host an in-process `PermissionRequest`
// object before each tool executes (`onPermissionRequest`). The host JSON-serialises that
// object and passes it here, so this module normalises the SDK's fields into the runtime-neutral
// event the engine already understands — reading no disk and reaching no engine.
//
// The SDK `PermissionRequest` surface (@github/copilot-sdk Node README + streaming-events ref):
//   kind: 'shell' | 'write' | 'read' | 'mcp' | 'custom-tool' | 'url' | 'memory' | 'hook'
//   toolCallId, toolName, managedApprovalRequired
//   shell: fullCommandText
//   write: fileName, diff (unified diff), intention, newFileContents? (full proposed content)
//   read:  fileName
//   mcp:   toolName
// plus the host-supplied session identity (sessionId) and the claimed working directory (cwd).
//
// A `write` request DOES surface the proposed change — the unified `diff`, and optionally the full
// `newFileContents` — so content-aware pre-deny is possible: the adapter reconstructs a Change[]
// from that content and runs the shared engine. It is CONDITIONAL on what the pinned runtime
// actually provides: a write that surfaces neither a usable diff nor newFileContents is UNSUPPORTED
// for that measured configuration (allow-through; the end-of-turn sweep is the authority) — see
// adapter.ts and docs/guide/runtime-adapters.md §Copilot SDK. `end-of-turn` (the SDK `onAgentStop`
// hook) is a synthetic stop op, exactly as the CLI and Codex adapters model it.

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
  resolvedPath?: string;
  fullCommandText?: string;
  diff?: string;
  newFileContents?: string;
  intention?: string;
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
  const s = (k: string): string | undefined => str(parsed[k]);
  return {
    ...(s('kind') !== undefined ? { kind: s('kind') } : {}),
    ...(s('toolName') !== undefined ? { toolName: s('toolName') } : {}),
    ...(s('fileName') !== undefined ? { fileName: s('fileName') } : {}),
    ...(s('resolvedPath') !== undefined ? { resolvedPath: s('resolvedPath') } : {}),
    ...(s('fullCommandText') !== undefined ? { fullCommandText: s('fullCommandText') } : {}),
    ...(s('diff') !== undefined ? { diff: s('diff') } : {}),
    ...(s('newFileContents') !== undefined ? { newFileContents: s('newFileContents') } : {}),
    ...(s('intention') !== undefined ? { intention: s('intention') } : {}),
    ...(s('cwd') !== undefined ? { cwd: s('cwd') } : {}),
    ...(s('sessionId') !== undefined ? { sessionId: s('sessionId') } : {}),
    ...(typeof parsed.stopHookActive === 'boolean' ? { stopHookActive: parsed.stopHookActive } : {}),
  };
}

/** The reconstruction args for a pre-action operation. A shell op carries its `fullCommandText`
 *  as `command` (judged content-sensitively by the command detectors); a write carries its
 *  `fileName` as `path` PLUS the proposed content (`diff` / `newFileContents`) and `intention`,
 *  so the adapter can reconstruct and content-judge the change when the runtime surfaces it. */
function argsFor(req: SdkRequest): Record<string, unknown> {
  const kind = copilotSdkOperationKind(req.kind);
  if (kind === 'shell') return req.fullCommandText !== undefined ? { command: req.fullCommandText } : {};
  if (kind === 'file-edit') {
    return {
      ...(req.fileName !== undefined ? { path: req.fileName } : {}),
      // The SDK's experimental runtime-resolved canonical path. Retained as an UNTRUSTED claim: the
      // host derives its own canonical target and denies on mismatch — resolvedPath is never authority.
      ...(req.resolvedPath !== undefined ? { resolvedPath: req.resolvedPath } : {}),
      ...(req.diff !== undefined ? { diff: req.diff } : {}),
      ...(req.newFileContents !== undefined ? { newFileContents: req.newFileContents } : {}),
      ...(req.intention !== undefined ? { intention: req.intention } : {}),
    };
  }
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
