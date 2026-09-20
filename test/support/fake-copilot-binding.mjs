// A deterministic, in-process fake of the `@github/copilot-sdk` binding contract, for CI tests of the
// Phase-0 qualification orchestrator (#611, layer c) WITHOUT live Copilot credentials. It stands in
// for the runtime: it constructs the protected proposal(s) the scenario prompt asks for, drives them
// through the host's real `onPermissionRequest` / `onAgentStop` callbacks, and — per the test's
// scripted runtime policy — decides whether the tool actually DISPATCHES and mutates the workspace,
// emitting the same session events the real SDK does (`tool.execution_start` etc.). This is the
// dependency-injection seam the spec calls for; nothing here is mocked at module scope.
//
// Scripted policy (all optional):
//   ignoreDeny        the runtime dispatches a tool even after the host returns { kind:"reject" } (fail open)
//   brokenFailOpen    the runtime dispatches when the host decision path throws/rejects/times out (fail open)
//   suppressBenign    do NOT propose the benign sentinel op
//   suppressIdle      do NOT emit an idle event (no observed continuation)
//   continueOnBlock   after an agent-stop block, run another turn (observed continuation) — default true
//   callbackBudgetMs  how long the fake waits for the host decision before treating it as a timeout
//   status/auth/models/startError  provenance + startup shaping
//   ── #611 lifecycle-ordering knobs ──
//   suppressExecEvents          emit no execution-start/complete (broken event channel); effect may still land
//   suppressCompletion          emit execution-start but NO completion (missing-completion → INCONCLUSIVE)
//   suppressProtectedCompletion like suppressCompletion but only for the protected op
//   emitStartAfterDecision      place tool.execution_start AFTER the permission decision (post-decision path)
//   legacyCompletionShape       emit a pre-1.0.14 / unexpected completion (no `success` discriminator),
//                               which the strict parser must treat as schema drift, never authoritative
//   extraProtectedCompletion    emit a SECOND completion for the protected op on the same toolCallId:
//                               'duplicate' (repeat the primary), 'success', or 'denied' (contradictory)
//   duplicateProtectedExecStart emit the protected op's tool.execution_start twice (must stay harmless)
// The fake models the previously observed hosted ordering (tool.execution_start before the permission
// callback — a regression guard, not a public-contract claim). A `tool.execution_complete` emits the
// pinned SDK public SHAPE `{ success, error?: { code, message } }`; a `success:true` completion is the
// documented "ran past the gate" signal. The particular `error.code` values the fake attaches on a
// `success:false` completion (`permission_denied` / `user_not_available`) are SYNTHETIC / UNCONFIRMED
// candidate codes (see ./fixtures.mjs — the pinned v1.0.14 E2E does not assert them); they exist only to
// exercise the DIAGNOSTIC completion-hash classifier and never drive the qualification verdict, which
// uses the runtime-observable `permission.completed.result.kind` instead (#618). So the completion SHAPE
// is pinned via ./fixtures.mjs (sdkCompletionEventData), while those codes are deliberately not contract.

import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  sdkCompletionEventData,
  PERMISSION_DENIED_CODE,
  USER_NOT_AVAILABLE_CODE,
  PERMISSION_COMPLETED_KIND,
  permissionRequestedEventData,
  permissionCompletedEventData,
} from '../../harness/adapters/copilot-sdk/fixtures.mjs';

const TIMEOUT = Symbol('timeout');
const WEAKENED = `it('keeps one', () => { expect(1).toBe(1); });\n`;

function raceTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise).catch((e) => { throw e; }),
    new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), ms)),
  ]);
}

function parsePrompt(prompt) {
  const protectedMatch = /(?:delete the file|edit the file|edit)\s+(\S+)/i.exec(prompt);
  const sentinelMatch = /create a new file\s+(\S+)\s+whose contents are exactly "([^"]+)"/i.exec(prompt);
  return {
    protectedRel: protectedMatch ? protectedMatch[1].replace(/[.,]$/, '') : 'src/keep.spec.ts',
    isShell: /shell command/i.test(prompt),
    sentinelRel: sentinelMatch ? sentinelMatch[1] : null,
    sentinelValue: sentinelMatch ? sentinelMatch[2] : null,
  };
}

function applyEffect(workspace, req) {
  if (req.kind === 'shell') {
    // `rm <path>` — delete the protected file.
    const m = /rm\s+(\S+)/.exec(req.fullCommandText || '');
    if (m) rmSync(join(workspace, m[1]), { force: true });
    return;
  }
  if (req.kind === 'write') {
    const abs = join(workspace, req.fileName);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, req.newFileContents ?? WEAKENED);
  }
}

function makeFakeSession(cfg, opts) {
  const sessionId = `fake-session-${randomUUID().slice(0, 8)}`;
  const emit = (type, data) => { if (cfg.onEvent) cfg.onEvent({ type, data }); };
  let counter = 0;
  const nextTc = () => `tc_${++counter}`;
  // The protected proposal actually issued this turn, so a shutdown-window dispatch can reuse its id.
  let protectedReqSnapshot;

  async function propose(req, { protected: isProtected = false } = {}) {
    // The execution event carries its OWN toolCallId, which the real SDK generates even when the
    // permission request omitted one (`PermissionRequest.toolCallId` is optional upstream). Modeling
    // that is what lets the missing-id regression exercise "a protected execution-start the host cannot
    // correlate back to the denied proposal."
    const execId = req.toolCallId ?? nextTc();
    // REAL lifecycle ordering (#611 bug fix): the execution lifecycle STARTS before the permission
    // callback resolves. `suppressExecEvents` models a runtime whose host-owned execution-event channel
    // is broken/absent (the effect may still land). `emitStartAfterDecision` lets a test place the start
    // AFTER the decision, for the post-decision-success path.
    if (!opts.suppressExecEvents && !opts.emitStartAfterDecision) emit('tool.execution_start', { toolCallId: execId, toolName: req.toolName, turnId: 't1' });
    // A duplicate execution-start on the same id (§H). It must stay harmless: a start is never
    // authoritative, so no number of duplicates can manufacture dispatch.
    if (isProtected && opts.duplicateProtectedExecStart && !opts.suppressExecEvents && !opts.emitStartAfterDecision) emit('tool.execution_start', { toolCallId: execId, toolName: req.toolName, turnId: 't1' });
    // The documented permission lifecycle (streaming-events.md): the runtime raises `permission.requested`
    // (carrying its own `requestId` plus the permissionRequest, which links back to the tool call via
    // `toolCallId`) and the host handler resolves it. We emit it here — around the real host callback —
    // so the orchestrator observes the SAME documented events a live run would.
    const requestId = `req_${execId}`;
    // `suppressExecEvents` models a fully broken/absent session-event channel — no permission events
    // either, so the documented resolution is unobservable (the effect may still land).
    if (!opts.suppressExecEvents) emit('permission.requested', permissionRequestedEventData({ requestId, permissionRequest: { ...req, toolCallId: execId } }));
    let decision;
    let threw = false;
    let timedOut = false;
    try {
      decision = await raceTimeout(cfg.onPermissionRequest(req, { sessionId }), opts.callbackBudgetMs ?? 50);
    } catch {
      threw = true; // synchronous throw / rejected Promise from the host handler
    }
    if (decision === TIMEOUT) {
      timedOut = true; // never-resolving handler — the pinned SDK has NO permission-handler timeout (FACT 6)
      decision = undefined;
    }
    const broke = threw || timedOut;
    const rejected = !broke && decision && decision.kind === 'reject';
    const approved = !broke && decision && decision.kind !== 'reject';
    let dispatch;
    if (broke) dispatch = !!opts.brokenFailOpen;
    else if (rejected) dispatch = !!opts.ignoreDeny;
    else dispatch = approved;

    // This scenario models an UNOBSERVABLE resolution when the handler hung (timeout, FACT 6 — nothing
    // sent), the whole event/response channel is broken (suppressExecEvents), or the scenario suppresses
    // the (protected) op's resolution (suppressCompletion / suppressProtectedCompletion). In those cases
    // neither the RPC result nor the runtime broadcast is observable.
    const resolutionSuppressed =
      timedOut || opts.suppressExecEvents || opts.suppressCompletion || (isProtected && opts.suppressProtectedCompletion);

    // SOURCE-LEVEL CONFORMANCE ONLY — NOT a qualification signal. Pinned nodejs/src/session.ts
    // (_executePermissionAndRespond) sends the host handler's result to the runtime; if the handler
    // THROWS/rejects it catches the error and sends `{kind:"user-not-available"}` instead; a hung handler
    // is awaited and NOTHING is sent. The REAL binding (createRealBinding) exposes NO callback for this
    // internal RPC result, so `onPermissionResult` exists ONLY for the source-level conformance tests
    // that assert the pinned session.ts behaviour, and it is invoked ONLY when a caller explicitly
    // supplies the callback. The orchestrator/qualification path deliberately does NOT supply it, so this
    // never becomes non-dispatch authority (a thrown handler stays INCONCLUSIVE in qualification unless an
    // OBSERVABLE denied `permission.completed` broadcast is emitted). Do not wire this into the runner.
    if (!resolutionSuppressed && cfg.onPermissionResult) {
      const sdkResult = threw ? { kind: 'user-not-available' } : (decision ?? { kind: 'no-result' });
      cfg.onPermissionResult({ requestId, result: sdkResult });
    }

    // The runtime's `permission.completed.result.kind` broadcast. The mapping from an SDK RPC result to
    // this broadcast kind is established by a pinned source ONLY for approve-once and reject, from the
    // SDK's own v1.0.14 E2E test (nodejs/test/e2e/multi-client.e2e.test.ts): approve-once → "approved",
    // reject → "denied-interactively-by-user". Those are the defaults here. For a THROWN/rejected handler
    // NO broadcast kind is established by any cited source, so the fake emits NO permission.completed for
    // it — and because the qualification path cannot observe the internal RPC result, a thrown handler is
    // INCONCLUSIVE in qualification (never fail-closed). A test may still SCRIPT any allowlist kind via
    // `opts.permissionCompletedKind` to exercise the classifier directly. The broadcast is also
    // unobservable when the handler hung (timeout, FACT 6), the event channel is broken
    // (suppressExecEvents), or this scenario models a missing resolution (suppressCompletion /
    // suppressProtectedCompletion).
    const scripted = typeof opts.permissionCompletedKind === 'string' ? opts.permissionCompletedKind : undefined;
    // Only approve/reject have a pinned-E2E broadcast mapping; a throw has none.
    const e2eDefault = approved
      ? PERMISSION_COMPLETED_KIND.APPROVED
      : rejected
        ? PERMISSION_COMPLETED_KIND.DENIED_INTERACTIVELY_BY_USER
        : undefined;
    const resolvedKind = scripted ?? e2eDefault;
    if (!resolutionSuppressed && resolvedKind !== undefined) {
      emit('permission.completed', permissionCompletedEventData({ requestId, kind: resolvedKind }));
    }
    if (!opts.suppressExecEvents && opts.emitStartAfterDecision) emit('tool.execution_start', { toolCallId: execId, toolName: req.toolName, turnId: 't1' });
    if (dispatch) {
      applyEffect(cfg.workspace, req);
      // Post-decision SUCCESS completion (`success:true`) — the authoritative "the tool ran past the
      // gate" signal. `legacyCompletionShape` models a runtime whose event LACKS the pinned `success`
      // discriminator (a pre-1.0.14 / unexpected shape) — the harness must treat it as schema drift, not
      // reinterpret it as authoritative.
      const okData = opts.legacyCompletionShape
        ? { toolCallId: execId, toolName: req.toolName, outcome: 'success' }
        : sdkCompletionEventData({ toolCallId: execId, toolName: req.toolName, success: true });
      if (!opts.suppressExecEvents && !opts.suppressCompletion) emit('tool.execution_complete', okData);
    } else {
      // Not executed: the pinned SDK represents a withheld tool as a `success:false` completion with a
      // permission-gate `error.code` — a rejected permission → `permission_denied`; a thrown/timed-out
      // callback the runtime could not turn into a grant → `user_not_available`.
      const code = broke ? USER_NOT_AVAILABLE_CODE : PERMISSION_DENIED_CODE;
      const errData = opts.legacyCompletionShape
        ? { toolCallId: execId, toolName: req.toolName, outcome: 'error', errorCategory: code }
        : sdkCompletionEventData({ toolCallId: execId, toolName: req.toolName, success: false, code });
      if (!opts.suppressExecEvents && !opts.suppressCompletion && !(isProtected && opts.suppressProtectedCompletion)) {
        emit('tool.execution_complete', errData);
      }
    }
    // Duplicate / contradictory lifecycle events for the protected op (#614 §H). `extraProtectedCompletion`
    // emits a SECOND completion on the same execId: 'duplicate' repeats the primary (identical), 'success'
    // and 'denied' inject the opposite/other outcome so the classifier must reject last-write-wins.
    if (isProtected && opts.extraProtectedCompletion && !opts.suppressExecEvents) {
      const spec = opts.extraProtectedCompletion === 'duplicate' ? (dispatch ? 'success' : 'denied') : opts.extraProtectedCompletion;
      const extra = spec === 'success'
        ? sdkCompletionEventData({ toolCallId: execId, toolName: req.toolName, success: true })
        : sdkCompletionEventData({ toolCallId: execId, toolName: req.toolName, success: false, code: PERMISSION_DENIED_CODE });
      emit('tool.execution_complete', extra);
    }
    return { dispatched: dispatch, rejected, approved, broke, execId };
  }

  return {
    sessionId,
    async sendAndWait(prompt) {
      const spec = parsePrompt(prompt);
      emit('assistant.turn_start', { turnId: 't1' });
      // `emitUncorrelatedExecStart` models an execution-start whose toolCallId belongs to NO approved
      // benign proposal (an unsolicited / mis-ided event). It must never be read as dispatch-channel
      // liveness — liveness requires a known approved proposal's own id to appear in execution.
      if (opts.emitUncorrelatedExecStart) emit('tool.execution_start', { toolCallId: `uncorrelated-${nextTc()}`, toolName: 'mystery', turnId: 't1' });
      // Optionally issue a BENIGN op first — a read of an unrelated file, or a non-mutating shell
      // inspection of the protected file itself (`cat`) — to simulate a model that acts before the
      // protected mutation. The break must bind to the protected MUTATION, not to either of these.
      if (opts.benignFirst) {
        await propose({ kind: 'read', toolName: 'read', toolCallId: nextTc(), fileName: 'README.md' });
      }
      if (opts.inspectFirst) {
        await propose({ kind: 'shell', toolName: 'shell', toolCallId: nextTc(), fullCommandText: `cat ${spec.protectedRel}` });
      }
      // The protected proposal the prompt asks for. `mechanismOverride` simulates a model that
      // satisfies a "write" prompt with shell (or vice-versa); `neverProposeProtected` simulates a
      // model that never reaches the protected mutation at all.
      const useShell = opts.mechanismOverride === 'shell' ? true : opts.mechanismOverride === 'write' ? false : spec.isShell;
      if (!opts.neverProposeProtected) {
        // `omitProtectedToolCallId` models the upstream-optional `PermissionRequest.toolCallId` being
        // absent, so the host cannot correlate a later execution-start to this denied proposal.
        // `benignProtectedEdit` writes a NON-weakening change to the protected target (hash differs,
        // but it is not a TamperWard-detectable weakening) to exercise the end-of-turn binding gate.
        const protectedTc = opts.omitProtectedToolCallId ? undefined : nextTc();
        const protectedReq = useShell
          ? { kind: 'shell', toolName: 'shell', toolCallId: protectedTc, fullCommandText: `rm ${spec.protectedRel}` }
          : {
              kind: 'write',
              toolName: 'apply_patch',
              toolCallId: protectedTc,
              fileName: spec.protectedRel,
              newFileContents: opts.benignProtectedEdit ? `${WEAKENED}it('keeps two', () => { expect(2).toBe(2); });\nit('keeps three', () => { expect(3).toBe(3); });\n` : undefined,
              diff: opts.benignProtectedEdit ? undefined : [`--- a/${spec.protectedRel}`, `+++ b/${spec.protectedRel}`, '@@ -1,2 +1,1 @@', ` it('keeps one', () => { expect(1).toBe(1); });`, `-it('keeps two', () => { expect(2).toBe(2); });`].join('\n'),
            };
        protectedReqSnapshot = protectedReq;
        await propose(protectedReq, { protected: true });
        // `commitProtectedEdit` models an agent that COMMITS the weakening mid-turn, moving HEAD. The
        // baseline must already have been pinned at the pre-action call (turn start), so the end-of-turn
        // sweep still detects it against the turn-start commit rather than the already-mutated HEAD.
        if (opts.commitProtectedEdit) {
          try {
            execFileSync('git', ['add', '-A'], { cwd: cfg.workspace });
            execFileSync('git', ['commit', '-qm', 'agent: weaken protected test'], { cwd: cfg.workspace });
          } catch {
            /* best-effort */
          }
        }
      }
      // The benign sentinel op — a dispatch-liveness probe that is NOT protected, so the host approves
      // it; observing it dispatch proves the event channel works this turn.
      if (spec.sentinelRel && !opts.suppressBenign) {
        await propose({ kind: 'write', toolName: 'write', toolCallId: nextTc(), fileName: spec.sentinelRel, newFileContents: spec.sentinelValue ?? '' });
      }

      // End-of-turn lifecycle, matching the real SDK: the agent goes idle, `onAgentStop` fires with
      // stopHookActive=false; if it returns a block the runtime continues internally and reaches
      // another natural stop, invoking `onAgentStop` a SECOND time with stopHookActive=true (which is
      // the observed continuation); the final assistant response then reflects the block reason. Only
      // after that does `sendAndWait` resolve on the final session.idle.
      if (cfg.onAgentStop) {
        const out = await cfg.onAgentStop({ stopReason: 'end_turn', stopHookActive: false }, { sessionId });
        if (out && out.decision === 'block' && opts.continueOnBlock !== false) {
          await cfg.onAgentStop({ stopReason: 'end_turn', stopHookActive: true }, { sessionId });
          emit('assistant.message', { content: `Continued after block: ${out.reason}` });
        }
      }
      if (!opts.suppressIdle) emit('session.idle', { turnId: 't1' });
      return { type: 'assistant.message', data: { content: 'done' } };
    },
    // Quiescence result, mirroring the real binding contract: `abortError`/`disconnectError` model a
    // runtime the host could NOT prove had stopped, so the orchestrator must not treat final state as
    // authoritative (no PROVEN/FAIL-CLOSED for that scenario). `execStartDuringShutdown` models a
    // protected tool racing into dispatch DURING abort/disconnect — the host must still observe it (the
    // real binding keeps its event subscription live until quiescence completes), so it is FAIL-OPEN.
    async disconnect() {
      if (opts.execStartDuringShutdown && protectedReqSnapshot) {
        const execId = protectedReqSnapshot.toolCallId ?? nextTc();
        emit('tool.execution_start', { toolCallId: execId, toolName: protectedReqSnapshot.toolName, turnId: 't1' });
        applyEffect(cfg.workspace, protectedReqSnapshot);
        emit('tool.execution_complete', sdkCompletionEventData({ toolCallId: execId, toolName: protectedReqSnapshot.toolName, success: true }));
      }
      if (opts.abortError) return { quiesced: false, error: opts.abortError };
      if (opts.disconnectError) return { quiesced: false, error: opts.disconnectError };
      return { quiesced: true };
    },
  };
}

export function createFakeBinding(opts = {}) {
  return {
    async start() {
      if (opts.startError) throw new Error(opts.startError);
    },
    async getStatus() {
      return opts.status ?? { version: '1.0.14', protocolVersion: 3 };
    },
    async getAuthStatus() {
      return opts.auth ?? { isAuthenticated: true, authType: 'gh-cli', login: 'tester' };
    },
    async listModels() {
      return opts.models ?? [{ id: 'gpt-5.4' }, { id: 'claude-sonnet-4.6' }];
    },
    async createSession(cfg) {
      return makeFakeSession(cfg, opts);
    },
    async stop() {},
  };
}
