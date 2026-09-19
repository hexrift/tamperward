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
  const sessionId = `fake-session-${Math.random().toString(36).slice(2, 8)}`;
  const emit = (type, data) => { if (cfg.onEvent) cfg.onEvent({ type, data }); };
  let counter = 0;
  const nextTc = () => `tc_${++counter}`;

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
      emit('tool.execution_start', { toolCallId: req.toolCallId, toolName: req.toolName, turnId: 't1' });
      applyEffect(cfg.workspace, req);
      emit('tool.execution_complete', { toolCallId: req.toolCallId });
    }
    return { dispatched: dispatch, rejected, approved, broke };
  }

  return {
    sessionId,
    async sendAndWait(prompt) {
      const spec = parsePrompt(prompt);
      emit('assistant.turn_start', { turnId: 't1' });
      // The protected proposal the prompt asks for.
      const protectedReq = spec.isShell
        ? { kind: 'shell', toolName: 'shell', toolCallId: nextTc(), fullCommandText: `rm ${spec.protectedRel}` }
        : {
            kind: 'write',
            toolName: 'apply_patch',
            toolCallId: nextTc(),
            fileName: spec.protectedRel,
            diff: [`--- a/${spec.protectedRel}`, `+++ b/${spec.protectedRel}`, '@@ -1,2 +1,1 @@', ` it('keeps one', () => { expect(1).toBe(1); });`, `-it('keeps two', () => { expect(2).toBe(2); });`].join('\n'),
          };
      await propose(protectedReq);
      // The benign sentinel op — a dispatch-liveness probe that is NOT protected, so the host approves
      // it; observing it dispatch proves the event channel works this turn.
      if (spec.sentinelRel && !opts.suppressBenign) {
        await propose({ kind: 'write', toolName: 'write', toolCallId: nextTc(), fileName: spec.sentinelRel, newFileContents: spec.sentinelValue ?? '' });
      }
      if (!opts.suppressIdle) emit('agent_idle', { turnId: 't1' });

      // End-of-turn: run the agent-stop hook; on a block, optionally run a continuation turn.
      if (cfg.onAgentStop) {
        const out = await cfg.onAgentStop({ stopReason: 'end_turn', stopHookActive: false }, { sessionId });
        if (out && out.decision === 'block' && opts.continueOnBlock !== false) {
          emit('assistant.turn_start', { turnId: 't2' });
          if (!opts.suppressIdle) emit('agent_idle', { turnId: 't2' });
        }
      }
      return { type: 'assistant.message', data: { content: 'done' } };
    },
    async disconnect() {},
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
