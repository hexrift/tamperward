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
//   suppressBenign    do NOT dispatch the benign sentinel op (removes the dispatch-liveness probe → INCOMPLETE)
//   suppressIdle      do NOT emit an idle event (no observed continuation)
//   continueOnBlock   after an agent-stop block, run another turn (observed continuation) — default true
//   callbackBudgetMs  how long the fake waits for the host decision before treating it as a timeout
//   status/auth/models/startError  provenance + startup shaping

import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

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

  async function propose(req, phase = 'protected') {
    let decision;
    let broke = false;
    try {
      decision = await raceTimeout(cfg.onPermissionRequest(req, { sessionId }), opts.callbackBudgetMs ?? 50);
    } catch {
      broke = true;
    }
    if (decision === TIMEOUT) {
      broke = true;
      decision = undefined;
    }
    const rejected = !broke && decision && decision.kind === 'reject';
    const approved = !broke && decision && decision.kind !== 'reject';
    let dispatch;
    if (broke) dispatch = !!opts.brokenFailOpen;
    else if (rejected) dispatch = !!opts.ignoreDeny;
    else dispatch = approved;
    if (dispatch) {
      // The execution event carries its OWN toolCallId, which the real SDK generates even when the
      // permission request omitted one (`PermissionRequest.toolCallId` is optional upstream). Modeling
      // that is what lets the missing-id regression exercise "a protected execution-start the host
      // cannot correlate back to the denied proposal."
      const execId = req.toolCallId ?? nextTc();
      // `suppressExecEvents` models a runtime whose repository EFFECT lands but whose host-owned
      // execution-event channel is broken/absent — the effect is applied, but no tool.execution_start
      // is emitted, so the host cannot observe dispatch. Liveness must then stay unproven.
      if (!opts.suppressExecEvents) emit('tool.execution_start', { toolCallId: execId, toolName: req.toolName, turnId: 't1' });
      applyEffect(cfg.workspace, req);
      if (!opts.suppressExecEvents) emit('tool.execution_complete', { toolCallId: execId });
    }
    return { dispatched: dispatch, rejected, approved, broke };
  }

  return {
    sessionId,
    async sendAndWait(prompt) {
      const spec = parsePrompt(prompt);
      emit('assistant.turn_start', { turnId: 't1' });
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
        await propose(protectedReq);
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
        emit('tool.execution_complete', { toolCallId: execId });
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
