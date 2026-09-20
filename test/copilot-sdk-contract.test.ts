// SDK CONTRACT / CONFORMANCE layer (#618). These tests are grounded ONLY in facts directly supported
// by the pinned @github/copilot-sdk v1.0.14 documentation and GENERATED source — NOT in TamperWard
// policy, and NOT in experimental error-message hashes or invented host-result→event mappings learned
// from one live run. They are the boundary that keeps TamperWard's integration aligned with the
// documented/pinned contract.
//
// SDK basis (tag v1.0.14):
//   - nodejs/src/generated/session-events.ts `PermissionResult` (matching go/rpc/zsession_events.go
//       `PermissionResultKind`): the FULL permission.completed result.kind union — three approved
//       variants, `cancelled`, and five `denied-*`. docs/features/streaming-events.md lists only five of
//       these; the generated schema is the authority for what the runtime can emit (discrepancy pinned
//       in the first describe below).
//   - nodejs/src/session.ts _executePermissionAndRespond: awaits the handler with NO timeout; on a
//       thrown/rejected handler it sends `{kind:"user-not-available"}` to the runtime.
//   - nodejs/src/types.ts: PermissionRequestResult kinds incl. approve-once / reject{feedback?} /
//       user-not-available / no-result; the default handler returns `{kind:"approve-once"}`.

import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain .mjs harness module, no d.ts
import { classifyProtectedDispatch, toPermissionResult } from '../harness/adapters/copilot-sdk/orchestrator.mjs';
// @ts-expect-error - plain .mjs harness module, no d.ts
import { PERMISSION_COMPLETED_KINDS, PERMISSION_COMPLETED_KINDS_DOCUMENTED, PERMISSION_APPROVED_KINDS, PERMISSION_DENIED_KINDS, PERMISSION_OTHER_KINDS, isDeniedPermissionKind, isApprovedPermissionKind, isKnownPermissionKind, isDenySdkResultKind } from '../harness/adapters/copilot-sdk/fixtures.mjs';
// @ts-expect-error - plain .mjs test-support module, no d.ts
import { createFakeBinding } from './support/fake-copilot-binding.mjs';

describe('permission.completed.result.kind — the EXACT pinned v1.0.14 generated enum (session-events.ts)', () => {
  it('the allowlist is the nine generated values (3 approved + cancelled + 5 denied)', () => {
    expect([...PERMISSION_COMPLETED_KINDS].sort()).toEqual(
      [
        'approved',
        'approved-for-location',
        'approved-for-session',
        'cancelled',
        'denied-by-content-exclusion-policy',
        'denied-by-permission-request-hook',
        'denied-by-rules',
        'denied-interactively-by-user',
        'denied-no-approval-rule-and-could-not-request-from-user',
      ].sort(),
    );
  });

  it('pins the docs-vs-generated discrepancy: the docs list only five, the generated schema adds four', () => {
    // The docs enumerate a strict subset; the generated schema is authoritative.
    for (const k of PERMISSION_COMPLETED_KINDS_DOCUMENTED) expect(PERMISSION_COMPLETED_KINDS).toContain(k);
    const generatedOnly = PERMISSION_COMPLETED_KINDS.filter((k: string) => !PERMISSION_COMPLETED_KINDS_DOCUMENTED.includes(k));
    expect([...generatedOnly].sort()).toEqual(
      ['approved-for-location', 'approved-for-session', 'cancelled', 'denied-by-permission-request-hook'].sort(),
    );
    // In particular the generated-only denial the docs omit is a real value the parser must know.
    expect(PERMISSION_DENIED_KINDS).toContain('denied-by-permission-request-hook');
  });

  it('classifies EXACTLY by allowlist membership — deny, approve, and non-enforcing are disjoint', () => {
    for (const k of PERMISSION_DENIED_KINDS) {
      expect(isDeniedPermissionKind(k)).toBe(true);
      expect(isApprovedPermissionKind(k)).toBe(false);
    }
    for (const k of PERMISSION_APPROVED_KINDS) {
      expect(isApprovedPermissionKind(k)).toBe(true);
      expect(isDeniedPermissionKind(k)).toBe(false);
    }
    // `cancelled` is a KNOWN kind but neither a deny nor an approve (the request was dismissed).
    for (const k of PERMISSION_OTHER_KINDS) {
      expect(isKnownPermissionKind(k)).toBe(true);
      expect(isDeniedPermissionKind(k)).toBe(false);
      expect(isApprovedPermissionKind(k)).toBe(false);
    }
  });

  it('an unknown / schema-drift / bare value is UNRECOGNIZED — never promoted to a proven deny or approve', () => {
    for (const k of ['denied', 'denied-whatever', 'approved-tomorrow', 'nope', '', undefined, null]) {
      expect(isDeniedPermissionKind(k)).toBe(false); // the reviewer's blocker: `startsWith('denied')` is gone
      expect(isApprovedPermissionKind(k)).toBe(false);
      expect(isKnownPermissionKind(k)).toBe(false);
    }
  });
});

describe('toPermissionResult — TamperWard decision → documented PermissionRequestResult (types.ts)', () => {
  it('an ALLOW maps to the documented {kind:"approve-once"} (the SDK default approval kind)', () => {
    const r = toPermissionResult({ outcome: 'ok', decision: { verdict: 'allow' } });
    expect(r.result).toEqual({ kind: 'approve-once' });
    expect(r.deny).toBe(false);
  });

  it('a measured-unsupported allow-through also maps to {kind:"approve-once"} (never a blanket reject)', () => {
    const r = toPermissionResult({ outcome: 'unsupported', detail: 'no content surfaced' });
    expect(r.result.kind).toBe('approve-once');
    expect(r.deny).toBe(false);
  });

  it('a DENY maps to the documented {kind:"reject", feedback} (reject = deny; feedback is the optional string)', () => {
    const r = toPermissionResult({ outcome: 'ok', wire: 'blocked: weakens a protected test', decision: { verdict: 'deny', reason: 'blocked: weakens a protected test' } });
    expect(r.result.kind).toBe('reject');
    expect(typeof r.result.feedback).toBe('string');
    expect(r.deny).toBe(true);
  });
});

describe('classifyProtectedDispatch — dispatch decided from DOCUMENTED signals only, over the exact enum', () => {
  const boundarySeq = 5;
  const success = (seq: number) => ({ completeSeq: seq, outcome: 'success' });
  const error = (seq: number) => ({ completeSeq: seq, outcome: 'error' });

  it('a landed protected mutation is authoritative FAIL-OPEN whatever the resolution says', () => {
    expect(classifyProtectedDispatch({ resolvedKind: 'denied-by-rules', mutated: true })).toMatchObject({ handlerDispatched: true, basis: 'protected-mutation' });
  });

  it('a documented post-decision success completion (success:true) is FAIL-OPEN', () => {
    expect(classifyProtectedDispatch({ resolvedKind: 'denied-by-rules', mutated: false, completion: { completions: [success(6)] }, boundarySeq }))
      .toMatchObject({ handlerDispatched: true, basis: 'post-decision-success-completion' });
  });

  it('EVERY pinned denied-* kind with intact state is NON-DISPATCH', () => {
    for (const k of PERMISSION_DENIED_KINDS) {
      expect(classifyProtectedDispatch({ resolvedKind: k, mutated: false })).toMatchObject({ handlerDispatched: false, basis: 'permission-denied-resolution' });
    }
  });

  it('EVERY pinned approved kind with no mutation is undefined for the protected-mutation question', () => {
    for (const k of PERMISSION_APPROVED_KINDS) {
      expect(classifyProtectedDispatch({ resolvedKind: k, mutated: false })).toMatchObject({ handlerDispatched: undefined, basis: 'permission-approved-no-mutation' });
    }
  });

  it('`cancelled` (known but non-enforcing) is INCONCLUSIVE, never non-dispatch', () => {
    expect(classifyProtectedDispatch({ resolvedKind: 'cancelled', mutated: false })).toMatchObject({ handlerDispatched: undefined, basis: 'permission-non-enforcing-resolution' });
  });

  it('an UNKNOWN / schema-drift kind is INCONCLUSIVE (unrecognized), never non-dispatch', () => {
    expect(classifyProtectedDispatch({ resolvedKind: 'denied-whatever', mutated: false })).toMatchObject({ handlerDispatched: undefined, basis: 'unrecognized-permission-resolution' });
    expect(classifyProtectedDispatch({ resolvedKind: 'denied', mutated: false })).toMatchObject({ handlerDispatched: undefined, basis: 'unrecognized-permission-resolution' });
  });

  it('contradictory post-decision completions (success AND error) are INCONCLUSIVE, never last-write', () => {
    expect(classifyProtectedDispatch({ resolvedKind: 'denied-by-rules', mutated: false, completion: { completions: [error(6), success(7)] }, boundarySeq }))
      .toMatchObject({ handlerDispatched: undefined, basis: 'contradictory-post-decision-completions', evidenceConflict: true });
  });

  it('no resolution at all (e.g. a hung/timeout handler emits none) is undefined — never inferred from absence', () => {
    expect(classifyProtectedDispatch({ resolvedKind: undefined, mutated: false })).toMatchObject({ handlerDispatched: undefined, basis: 'no-permission-resolution' });
  });

  it('the SDK RPC result decision (user-not-available / reject) is NOT accepted as a live non-dispatch signal — it is not runtime-observable', () => {
    // The classifier only takes what the real hosted binding can OBSERVE (the permission.completed
    // broadcast). It has no `sdkResultKind` input: a fake could not feed the internal RPC result as if it
    // were host evidence. A broken handler with no observed broadcast therefore stays INCONCLUSIVE, even
    // though the SDK sends user-not-available on its internal path — that fact lives in the source-level
    // conformance test below, not in the live verdict.
    expect(classifyProtectedDispatch({ resolvedKind: undefined, mutated: false })).toMatchObject({ handlerDispatched: undefined, basis: 'no-permission-resolution' });
  });
});

describe('source-level conformance (not live evidence) — the pinned SDK deny decisions (README + session.ts)', () => {
  it('reject and user-not-available are documented DENY decisions; nothing else is', () => {
    // nodejs/README.md: reject = "Deny the request"; user-not-available = "Deny the request because no
    // user is available to confirm it". session.ts sends user-not-available on a thrown handler. This is
    // a SOURCE fact used only for conformance — it is NOT wired into the live qualification verdict.
    expect(isDenySdkResultKind('reject')).toBe(true);
    expect(isDenySdkResultKind('user-not-available')).toBe(true);
    for (const k of ['approve-once', 'approve-for-session', 'no-result', 'approved', undefined]) {
      expect(isDenySdkResultKind(k)).toBe(false);
    }
  });
});

describe('fake binding conformance — only HARD FACTS, not invented host-result→broadcast mappings', () => {
  async function drive({ handler, prompt, opts = {} }: { handler: (req: unknown) => unknown; prompt: string; opts?: Record<string, unknown> }) {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const results: Array<{ requestId: string; result: { kind: string } }> = [];
    const binding = createFakeBinding(opts);
    const session = await binding.createSession({
      workspace: '/tmp',
      onPermissionRequest: handler,
      onPermissionResult: (r: { requestId: string; result: { kind: string } }) => results.push(r),
      onAgentStop: async () => undefined,
      onEvent: (e: { type: string; data: Record<string, unknown> }) => events.push(e),
    });
    await session.sendAndWait(prompt);
    return { events, results };
  }
  const shellPrompt = 'delete the file src/keep.spec.ts using a shell command';
  const completedKinds = (events: Array<{ type: string; data: Record<string, unknown> }>) =>
    events.filter((e) => e.type === 'permission.completed').map((e) => (e.data.result as { kind?: string }).kind);

  it('emits permission.requested then permission.completed, correlated by requestId (documented lifecycle)', async () => {
    const { events } = await drive({ handler: async () => ({ kind: 'approve-once' }), prompt: shellPrompt });
    const req = events.find((e) => e.type === 'permission.requested');
    const comp = events.find((e) => e.type === 'permission.completed');
    expect(req?.data.requestId).toBeTruthy();
    expect(comp?.data.requestId).toBe(req?.data.requestId);
    expect((req?.data.permissionRequest as { toolCallId?: string }).toolCallId).toBeTruthy();
  });

  it('the default broadcast mappings are exactly the pinned v1.0.14 E2E test mappings (multi-client.e2e.test.ts)', async () => {
    // approve-once → "approved", reject → "denied-interactively-by-user" are asserted by the SDK's own
    // E2E test, so they are the ONLY host-result→broadcast defaults the fake bakes in.
    const { events: approved } = await drive({ handler: async () => ({ kind: 'approve-once' }), prompt: shellPrompt });
    expect(completedKinds(approved)).toContain('approved');
    const { events: rejected } = await drive({ handler: async () => ({ kind: 'reject', feedback: 'no' }), prompt: shellPrompt });
    expect(completedKinds(rejected)).toContain('denied-interactively-by-user');
    expect(completedKinds(rejected)).not.toContain('denied-by-rules'); // the previous unproven default is gone
    for (const k of [...completedKinds(approved), ...completedKinds(rejected)]) expect(isKnownPermissionKind(k)).toBe(true);
  });

  it('a THROWN handler emits NO permission.completed broadcast by default (no cited source establishes its broadcast kind)', async () => {
    const { events, results } = await drive({ handler: () => { throw new Error('boom'); }, prompt: shellPrompt });
    expect(events.some((e) => e.type === 'permission.completed')).toBe(false); // no fabricated broadcast
    expect(results.some((r) => r.result.kind === 'user-not-available')).toBe(true); // only the pinned RPC-result fact
  });

  it('HARD FACT: a THROWN host handler is caught and the SDK sends {kind:"user-not-available"} (session.ts), not a claimed broadcast kind', async () => {
    const { results } = await drive({ handler: () => { throw new Error('boom'); }, prompt: shellPrompt });
    // The RPC-level result the SDK sends is the pinned-source fact we assert — NOT a permission.completed kind.
    expect(results.some((r) => r.result.kind === 'user-not-available')).toBe(true);
  });

  it('HARD FACT: an approve/reject host result is sent to the runtime verbatim (session.ts)', async () => {
    const { results: approved } = await drive({ handler: async () => ({ kind: 'approve-once' }), prompt: shellPrompt });
    expect(approved.some((r) => r.result.kind === 'approve-once')).toBe(true);
    const { results: rejected } = await drive({ handler: async () => ({ kind: 'reject', feedback: 'no' }), prompt: shellPrompt });
    expect(rejected.some((r) => r.result.kind === 'reject')).toBe(true);
  });

  it('the broadcast permission.completed kind is a SCRIPTED input, not a fixed host-result mapping', async () => {
    // The runtime→broadcast mapping is unestablished, so it is scriptable; the classifier is what we
    // actually test against the enum (above). Here we prove the fake honours the scripted kind.
    const { events } = await drive({ handler: async () => ({ kind: 'reject', feedback: 'no' }), prompt: shellPrompt, opts: { permissionCompletedKind: 'denied-by-permission-request-hook' } });
    expect(completedKinds(events)).toContain('denied-by-permission-request-hook');
  });

  it('HARD FACT: a never-resolving (timeout) handler emits NO permission.completed and sends no result (session.ts: no handler timeout)', async () => {
    const { events, results } = await drive({ handler: () => new Promise(() => {}), prompt: shellPrompt, opts: { callbackBudgetMs: 20 } });
    expect(events.some((e) => e.type === 'permission.requested')).toBe(true);
    expect(events.some((e) => e.type === 'permission.completed')).toBe(false);
    expect(results.length).toBe(0);
  });
});
