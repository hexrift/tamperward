// Layer (b): PROBE SELF-TEST. Proves the qualification probe itself CANNOT false-green:
// its pure classifiers are asserted against every deterministic mode, and the real driver
// is exercised end-to-end (build → decide → append to the parent-owned ledger → classify).
// This layer runs in CI; the real-Codex E2E (layer c) does not.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
// @ts-expect-error - the probe is a plain .mjs harness module, no d.ts
import { classifyMutation, classifyFailClosed, classifyStop, buildDriver, driverSelfTest, makeRepo, readLedger } from '../harness/adapters/codex-probe.mjs';

describe('probe classifiers — every deterministic mode is classified correctly', () => {
  it('hook-fired-deny-respected → mutation PASS', () => {
    expect(
      classifyMutation({ toolAttempted: true, hookFired: true, denyReturned: true, reasonSurfaced: true, mutationLanded: false, codexCompleted: true }).pass,
    ).toBe(true);
  });

  it('hook-fired-deny-ignored → mutation FAIL (mutation landed)', () => {
    const r = classifyMutation({ toolAttempted: true, hookFired: true, denyReturned: true, reasonSurfaced: true, mutationLanded: true, codexCompleted: true });
    expect(r.pass).toBe(false);
    expect(r.reasons.join()).toMatch(/LANDED/);
  });

  it('hook-never-fired → mutation FAIL', () => {
    expect(classifyMutation({ toolAttempted: false, hookFired: false, denyReturned: false, reasonSurfaced: false, mutationLanded: true, codexCompleted: true }).pass).toBe(false);
  });

  it('tool-never-attempted → mutation FAIL (cannot claim enforcement)', () => {
    const r = classifyMutation({ toolAttempted: false, hookFired: true, denyReturned: true, reasonSurfaced: true, mutationLanded: false, codexCompleted: true });
    expect(r.pass).toBe(false);
    expect(r.reasons.join()).toMatch(/not attempted/);
  });

  it('reason-not-surfaced and codex-not-completed each FAIL a mutation', () => {
    expect(classifyMutation({ toolAttempted: true, hookFired: true, denyReturned: true, reasonSurfaced: false, mutationLanded: false, codexCompleted: true }).pass).toBe(false);
    expect(classifyMutation({ toolAttempted: true, hookFired: true, denyReturned: true, reasonSurfaced: true, mutationLanded: false, codexCompleted: false }).pass).toBe(false);
  });

  it('hook-crashed / hook-timeout with tool executed → fail-closed FAIL (fail open)', () => {
    expect(classifyFailClosed({ protectedToolAttempted: true, intendedHookFailure: true, mutationLanded: true, detachedExecution: false }).pass).toBe(false);
  });

  it('hook-crashed with tool NOT dispatched → fail-closed PASS', () => {
    expect(classifyFailClosed({ protectedToolAttempted: true, intendedHookFailure: true, mutationLanded: false, detachedExecution: false }).pass).toBe(true);
  });

  it('a fail-closed case where the tool was never attempted cannot PASS', () => {
    expect(classifyFailClosed({ protectedToolAttempted: false, intendedHookFailure: true, mutationLanded: false, detachedExecution: false }).pass).toBe(false);
  });

  it('a detached/background mutation FAILS the fail-closed case', () => {
    expect(classifyFailClosed({ protectedToolAttempted: true, intendedHookFailure: true, mutationLanded: false, detachedExecution: true }).pass).toBe(false);
  });

  it('stop-fired-block-respected → stop PASS; stop-block-ignored → stop FAIL', () => {
    expect(classifyStop({ stopFired: true, blockReturned: true, blockRespected: true }).pass).toBe(true);
    expect(classifyStop({ stopFired: true, blockReturned: true, blockRespected: false }).pass).toBe(false);
  });
});

describe('probe driver — builds, decides, and records to the parent-owned ledger', () => {
  it('driverSelfTest passes (build + decide + ledger record before any Codex call)', () => {
    const work = mkdtempSync(join(tmpdir(), 'tw-probe-self-'));
    try {
      const r = driverSelfTest(work);
      expect(r.ok).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('the REAL driver records deny for a protected tamper, and the classifier consumes it', () => {
    const work = mkdtempSync(join(tmpdir(), 'tw-probe-drv-'));
    try {
      const driver = buildDriver();
      const ledger = join(work, 'ledger.jsonl');
      const repo = makeRepo(driver, ledger);
      const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm src/a.spec.ts' }, cwd: repo, session_id: 's', turn_id: 't' });
      const res = spawnSync('node', [driver], {
        input: payload,
        encoding: 'utf8',
        env: { ...process.env, TW_CODEX_ROOT: repo, TW_PROBE_LEDGER: ledger, TW_CODEX_PHASE: 'pre', TW_PROBE_CASE: 'gated-x' },
      });
      // The driver emits a deny wire and records decision=deny.
      expect(res.stdout).toContain('permissionDecision');
      const entries = readLedger(ledger).filter((e: { caseId?: string }) => e.caseId === 'gated-x');
      const pre = entries.find((e: { event?: string; role?: string }) => e.event === 'PreToolUse' && e.role !== 'tracer');
      expect(pre.decision).toBe('deny');

      // A classifier fed the REAL deny with mutation-not-landed passes; mutation-landed fails.
      const base = { toolAttempted: true, hookFired: true, denyReturned: pre.decision === 'deny', reasonSurfaced: true, codexCompleted: true };
      expect(classifyMutation({ ...base, mutationLanded: false }).pass).toBe(true);
      expect(classifyMutation({ ...base, mutationLanded: true }).pass).toBe(false);
      rmSync(repo, { recursive: true, force: true });
      rmSync(dirname(driver), { recursive: true, force: true });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('the REAL driver records allow for a benign op, so a mutation case cannot green on it', () => {
    const work = mkdtempSync(join(tmpdir(), 'tw-probe-allow-'));
    try {
      const driver = buildDriver();
      const ledger = join(work, 'ledger.jsonl');
      const repo = makeRepo(driver, ledger);
      const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hello' }, cwd: repo, session_id: 's', turn_id: 't' });
      spawnSync('node', [driver], {
        input: payload,
        encoding: 'utf8',
        env: { ...process.env, TW_CODEX_ROOT: repo, TW_PROBE_LEDGER: ledger, TW_CODEX_PHASE: 'pre', TW_PROBE_CASE: 'benign' },
      });
      const pre = readLedger(ledger).find((e: { caseId?: string; role?: string }) => e.caseId === 'benign' && e.role !== 'tracer');
      expect(pre.decision).toBe('allow');
      expect(classifyMutation({ toolAttempted: true, hookFired: true, denyReturned: false, reasonSurfaced: false, mutationLanded: false, codexCompleted: true }).pass).toBe(false);
      rmSync(repo, { recursive: true, force: true });
      rmSync(dirname(driver), { recursive: true, force: true });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
