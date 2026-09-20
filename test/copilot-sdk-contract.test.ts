// SDK CONTRACT / CONFORMANCE layer (#618). These tests are grounded ONLY in facts directly supported
// by the pinned @github/copilot-sdk v1.0.14 documentation and source — NOT in TamperWard policy, and
// NOT in experimental error-message hashes learned from one live run. They are the boundary that keeps
// TamperWard's integration aligned with the documented/pinned contract.
//
// SDK basis (tag v1.0.14):
//   - docs/features/streaming-events.md — permission.requested {requestId, permissionRequest{kind, toolCallId?}};
//       permission.completed {requestId, result.kind ∈ approved | denied-by-rules | denied-interactively-by-user
//       | denied-no-approval-rule-and-could-not-request-from-user | denied-by-content-exclusion-policy};
//       tool.execution_complete {toolCallId, success, result?, error?}.
//   - nodejs/src/session.ts — _executePermissionAndRespond awaits the handler with NO timeout; on a
//       thrown/rejected handler it responds {kind:"user-not-available"}.
//   - nodejs/src/types.ts — PermissionRequestResult kinds incl. approve-once / reject{feedback?} /
//       user-not-available / no-result; the default handler returns {kind:"approve-once"}.

import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain .mjs harness module, no d.ts
import { classifyProtectedDispatch, toPermissionResult } from '../harness/adapters/copilot-sdk/orchestrator.mjs';
// @ts-expect-error - plain .mjs harness module, no d.ts
import { PERMISSION_COMPLETED_KIND, PERMISSION_COMPLETED_KINDS, isDeniedPermissionKind, isApprovedPermissionKind } from '../harness/adapters/copilot-sdk/fixtures.mjs';
// @ts-expect-error - plain .mjs test-support module, no d.ts
import { createFakeBinding } from './support/fake-copilot-binding.mjs';

describe('permission.completed.result.kind — the documented resolution enum (streaming-events.md)', () => {
  it('carries exactly the five documented v1.0.14 values', () => {
    expect(PERMISSION_COMPLETED_KINDS).toEqual([
      'approved',
      'denied-by-rules',
      'denied-interactively-by-user',
      'denied-no-approval-rule-and-could-not-request-from-user',
      'denied-by-content-exclusion-policy',
    ]);
  });

  it('the only non-denied documented kind is `approved`; every `denied-*` is a deny', () => {
    expect(isApprovedPermissionKind(PERMISSION_COMPLETED_KIND.APPROVED)).toBe(true);
    for (const k of PERMISSION_COMPLETED_KINDS) {
      if (k === 'approved') expect(isDeniedPermissionKind(k)).toBe(false);
      else expect(isDeniedPermissionKind(k)).toBe(true);
    }
    // A bare, undocumented, or absent kind is neither approved nor a proven deny.
    expect(isDeniedPermissionKind('denied')).toBe(true); // prefix, documented family
    expect(isDeniedPermissionKind(undefined)).toBe(false);
    expect(isApprovedPermissionKind('nope')).toBe(false);
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

describe('classifyProtectedDispatch — dispatch decided from DOCUMENTED signals only (no error-message hashes)', () => {
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

  it('a documented denied-* resolution with intact state is NON-DISPATCH (the gate withheld the tool)', () => {
    expect(classifyProtectedDispatch({ resolvedKind: 'denied-by-rules', mutated: false }))
      .toMatchObject({ handlerDispatched: false, basis: 'permission-denied-resolution' });
    expect(classifyProtectedDispatch({ resolvedKind: 'denied-no-approval-rule-and-could-not-request-from-user', mutated: false }))
      .toMatchObject({ handlerDispatched: false, basis: 'permission-denied-resolution' });
  });

  it('contradictory post-decision completions (success AND error) are INCONCLUSIVE, never last-write', () => {
    expect(classifyProtectedDispatch({ resolvedKind: 'denied-by-rules', mutated: false, completion: { completions: [error(6), success(7)] }, boundarySeq }))
      .toMatchObject({ handlerDispatched: undefined, basis: 'contradictory-post-decision-completions', evidenceConflict: true });
  });

  it('no documented resolution (e.g. a hung/timeout handler emits none) is undefined — never inferred from absence', () => {
    expect(classifyProtectedDispatch({ resolvedKind: undefined, mutated: false })).toMatchObject({ handlerDispatched: undefined, basis: 'no-permission-resolution' });
  });

  it('an approved resolution with no protected mutation is undefined for the protected-mutation question (used for benign allows)', () => {
    expect(classifyProtectedDispatch({ resolvedKind: 'approved', mutated: false })).toMatchObject({ handlerDispatched: undefined, basis: 'permission-approved-no-mutation' });
  });
});

describe('fake binding conformance — the documented lifecycle events, driven by the real host handler', () => {
  async function driveOnce({ handler, prompt, opts = {} }: { handler: (req: unknown) => unknown; prompt: string; opts?: Record<string, unknown> }) {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const binding = createFakeBinding(opts);
    const session = await binding.createSession({
      workspace: '/tmp',
      onPermissionRequest: handler,
      onAgentStop: async () => undefined,
      onEvent: (e: { type: string; data: Record<string, unknown> }) => events.push(e),
    });
    await session.sendAndWait(prompt);
    return events;
  }
  const shellPrompt = 'delete the file src/keep.spec.ts using a shell command';
  const completed = (events: Array<{ type: string; data: Record<string, unknown> }>) =>
    events.filter((e) => e.type === 'permission.completed').map((e) => (e.data.result as { kind?: string }).kind);

  it('emits permission.requested then permission.completed, correlated by requestId', async () => {
    const events = await driveOnce({ handler: async () => ({ kind: 'approve-once' }), prompt: shellPrompt });
    const req = events.find((e) => e.type === 'permission.requested');
    const comp = events.find((e) => e.type === 'permission.completed');
    expect(req?.data.requestId).toBeTruthy();
    expect(comp?.data.requestId).toBe(req?.data.requestId);
    // permissionRequest carries the tool-call linkage.
    expect((req?.data.permissionRequest as { toolCallId?: string }).toolCallId).toBeTruthy();
  });

  it('an ALLOW (approve-once) resolves as documented `approved`', async () => {
    const events = await driveOnce({ handler: async () => ({ kind: 'approve-once' }), prompt: shellPrompt });
    expect(completed(events)).toContain('approved');
  });

  it('a host REJECT resolves as a documented `denied-*`', async () => {
    const events = await driveOnce({ handler: async () => ({ kind: 'reject', feedback: 'no' }), prompt: shellPrompt });
    expect(completed(events).some(isDeniedPermissionKind)).toBe(true);
  });

  it('a THROWN host handler resolves via the SDK user-not-available fallback (session.ts) → a documented `denied-*`', async () => {
    const events = await driveOnce({ handler: () => { throw new Error('boom'); }, prompt: shellPrompt });
    // Pinned v1.0.14 implementation behaviour: the SDK catches the exception and responds
    // {kind:"user-not-available"}, which resolves as the "could not request from user" denial.
    expect(completed(events)).toContain('denied-no-approval-rule-and-could-not-request-from-user');
  });

  it('a never-resolving (timeout) host handler emits NO permission.completed (FACT 6 — no permission-handler timeout)', async () => {
    const events = await driveOnce({ handler: () => new Promise(() => {}), prompt: shellPrompt, opts: { callbackBudgetMs: 20 } });
    expect(events.some((e) => e.type === 'permission.requested')).toBe(true);
    expect(events.some((e) => e.type === 'permission.completed')).toBe(false);
  });
});
