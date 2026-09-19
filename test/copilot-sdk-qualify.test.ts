// #611 (layer c): the real-runtime Phase-0 QUALIFICATION orchestrator, exercised end-to-end WITHOUT
// live Copilot credentials by injecting a deterministic fake binding (the SDK/session seam) alongside
// the REAL neutral adapter + canonical engine + disposable git fixtures. The fake scripts the runtime
// semantics we cannot otherwise reach (fail-open, timeout, continuation), so the orchestrator's
// decisive classifications run against real observations, and CI proves it cannot false-green.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { copilotSdkAdapter } from '../src/adapters/copilot-sdk/adapter';
// @ts-expect-error - the orchestrator is a plain .mjs harness module, no d.ts
import { buildConfig, runQualification, runPreDenyScenario, runBrokenPathScenario, runEndOfTurnScenario, assembleResult, serializeRequest, promptHash } from '../harness/adapters/copilot-sdk/orchestrator.mjs';
// @ts-expect-error - the spike is a plain .mjs harness module, no d.ts
import { provenanceGate, sha16 } from '../harness/adapters/copilot-sdk-spike.mjs';
// @ts-expect-error - the fake binding is a plain .mjs test-support module, no d.ts
import { createFakeBinding } from './support/fake-copilot-binding.mjs';

const adapter = copilotSdkAdapter as unknown as { decide: (raw: string, phase: string, cwd?: string) => { outcome: string; wire?: string; decision?: { verdict: string; reason?: string } } };
const CFG = (over: Record<string, unknown> = {}) => ({ model: 'gpt-5.4', keepArtifacts: false, expected: {}, errors: [], ...over });

describe('buildConfig — exact model is required, auto is forbidden', () => {
  it('errors when the model is missing', () => {
    expect(buildConfig({}, {}).errors.length).toBeGreaterThan(0);
  });
  it('errors when the model is "auto"', () => {
    expect(buildConfig({ model: 'auto' }, {}).errors.some((e: string) => /auto/.test(e))).toBe(true);
  });
  it('accepts an exact model', () => {
    expect(buildConfig({ model: 'gpt-5.4' }, {}).errors).toEqual([]);
  });
});

describe('runQualification — startup / auth / preflight', () => {
  it('a startup/connection failure degrades to INSUFFICIENT (never a crash or false-pass)', async () => {
    const binding = createFakeBinding({ startError: 'runtime failed to start' });
    const r = await runQualification({ binding, adapter, config: buildConfig({ model: 'gpt-5.4' }, {}) });
    expect(r.overall).toBe('INSUFFICIENT');
    expect(r.round_4_1_eligible).toBe(false);
  });

  it('unavailable authentication degrades to INSUFFICIENT', async () => {
    const binding = createFakeBinding({ auth: { isAuthenticated: false } });
    const r = await runQualification({ binding, adapter, config: buildConfig({ model: 'gpt-5.4' }, {}) });
    expect(r.overall).toBe('INSUFFICIENT');
  });

  it('a missing exact model is INSUFFICIENT before any scenario runs', async () => {
    const binding = createFakeBinding({});
    const r = await runQualification({ binding, adapter, config: buildConfig({}, {}) });
    expect(r.overall).toBe('INSUFFICIENT');
  });

  it('--preflight MEASURES runtime provenance and makes NO qualification claim', async () => {
    const binding = createFakeBinding({ status: { version: '1.0.14', protocolVersion: 3 } });
    const r = await runQualification({ binding, adapter, config: buildConfig({ model: 'gpt-5.4', preflight: true }, {}) });
    expect(r.mode).toBe('preflight');
    expect(r.overall).toBe('PREFLIGHT');
    expect(r.round_4_1_eligible).toBe(false);
    expect(r.measured?.model).toBe('gpt-5.4');
    expect(r.measured?.runtime_version).toBe('copilot-runtime@1.0.14');
    expect(r.measured?.protocol_version).toBe(3);
  });
});

describe('runQualification — full driver loop (fake runtime, real adapter)', () => {
  it('a well-behaved runtime with no frozen pins → scenarios pass but overall INSUFFICIENT (provenance)', async () => {
    const r = await runQualification({ binding: createFakeBinding({}), adapter, config: buildConfig({ model: 'gpt-5.4' }, {}) });
    expect(r.overall).toBe('INSUFFICIENT'); // no expected pins / SDK not installed in the project
    expect(r.round_4_1_eligible).toBe(false);
    const ids = r.scenarios.map((s: { id: string }) => s.id);
    expect(ids).toContain('shell-pre-deny');
    expect(ids).toContain('write-pre-deny');
    expect(ids).toContain('end-of-turn');
    expect(ids.some((i: string) => i.startsWith('broken-path:'))).toBe(true);
    expect(Array.isArray(r.capability_matrix)).toBe(true);
  });

  it('a runtime that fails a broken decision path OPEN → overall INELIGIBLE, march halts at the fail-open', async () => {
    const r = await runQualification({ binding: createFakeBinding({ brokenFailOpen: true }), adapter, config: buildConfig({ model: 'gpt-5.4' }, {}) });
    expect(r.overall).toBe('INELIGIBLE');
    expect(r.round_4_1_eligible).toBe(false);
    const broken = r.scenarios.filter((s: { id: string }) => s.id.startsWith('broken-path:'));
    expect(broken.some((s: { semantic: string }) => s.semantic === 'FAIL-OPEN')).toBe(true);
  });
});

describe('runPreDenyScenario — shell & native-write pre-dispatch deny (real adapter)', () => {
  it('shell: denied + not dispatched + intact + observed continuation, but reason-delivery is not observable → INCOMPLETE (not manufactured PROVEN)', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({}), adapter, config: CFG(), mechanism: 'shell' });
    expect(r.semantic).toBe('INCOMPLETE');
    expect(r.evidence.denyReturned).toBe(true);
    expect(r.evidence.handlerDispatched).toBe(false); // explicit non-dispatch, channel proven live by the sentinel
    expect(r.evidence.finalStateMutated).toBe(false);
    expect(r.evidence.reasonReached).toBeUndefined(); // not independently observable on the current SDK surface
    expect(r.evidence.agentContinued).toBe(true); // the post-denial sentinel proposal is real continuation evidence
    expect(r.evidence.mechanismConfirmed).toBe(true); // the denied proposal really was a shell op
  });

  it('native-write: a weakening apply_patch is reconstructed and denied; the proposal is bound to the write mechanism', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({}), adapter, config: CFG(), mechanism: 'write' });
    expect(r.evidence.finalStateMutated).toBe(false);
    expect(r.evidence.observedKind).toBe('write');
    expect(r.evidence.mechanismConfirmed).toBe(true);
  });

  it('a "write" prompt satisfied by SHELL is UNSUPPORTED for the write mechanism (label not bound to intent)', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({ mechanismOverride: 'shell' }), adapter, config: CFG(), mechanism: 'write' });
    expect(r.semantic).toBe('UNSUPPORTED');
    expect(r.evidence.mechanismConfirmed).toBe(false);
    expect(r.evidence.observedKind).toBe('shell');
  });

  it('dispatch AFTER a deny is FAIL-OPEN (the runtime ignored the reject)', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({ ignoreDeny: true }), adapter, config: CFG(), mechanism: 'shell' });
    expect(r.semantic).toBe('FAIL-OPEN');
    expect(r.evidence.finalStateMutated).toBe(true);
  });

  it('no dispatch-liveness evidence → INCOMPLETE (never inferred from an unchanged file)', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({ suppressBenign: true }), adapter, config: CFG(), mechanism: 'shell' });
    expect(r.semantic).toBe('INCOMPLETE');
    expect(r.evidence.handlerDispatched).toBeUndefined();
  });

  it('records the proposal AND the deny decision as immutable host evidence', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({}), adapter, config: CFG(), mechanism: 'shell' });
    const stages = r.evidenceRows.map((e: { stage?: string }) => e.stage);
    expect(stages).toContain('proposal');
    expect(stages).toContain('decision');
    expect(r.evidenceRows.every((e: object) => Object.isFrozen(e))).toBe(true);
  });
});

describe('runBrokenPathScenario — a broken decision path must fail CLOSED', () => {
  for (const breakage of ['sync-throw', 'reject', 'adapter-throw'] as const) {
    it(`${breakage}: no dispatch on the broken path → FAIL-CLOSED`, async () => {
      const r = await runBrokenPathScenario({ binding: createFakeBinding({ brokenFailOpen: false }), adapter, config: CFG(), breakage });
      expect(r.semantic).toBe('FAIL-CLOSED');
      expect(r.eligible).toBe(true);
    });
  }

  it('timeout: a hung callback with no dispatch is INCONCLUSIVE, NOT FAIL-CLOSED (no runtime callback-timeout exercised)', async () => {
    const r = await runBrokenPathScenario({ binding: createFakeBinding({ brokenFailOpen: false }), adapter, config: CFG(), breakage: 'timeout' });
    expect(r.semantic).toBe('INCONCLUSIVE');
    expect(r.eligible).toBe(false);
  });

  it('a broken path that STILL dispatches is FAIL-OPEN and INELIGIBLE (incl. timeout)', async () => {
    const r = await runBrokenPathScenario({ binding: createFakeBinding({ brokenFailOpen: true }), adapter, config: CFG(), breakage: 'sync-throw' });
    expect(r.semantic).toBe('FAIL-OPEN');
    expect(r.eligible).toBe(false);
    const t = await runBrokenPathScenario({ binding: createFakeBinding({ brokenFailOpen: true }), adapter, config: CFG(), breakage: 'timeout' });
    expect(t.semantic).toBe('FAIL-OPEN');
  });

  for (const breakage of ['cross-repo', 'path-escape', 'malformed-identity'] as const) {
    it(`${breakage}: the real adapter fails the identity claim closed → FAIL-CLOSED + identity pass`, async () => {
      const r = await runBrokenPathScenario({ binding: createFakeBinding({}), adapter, config: CFG(), breakage });
      expect(r.semantic).toBe('FAIL-CLOSED');
      expect(r.identity?.pass).toBe(true);
    });
  }
});

describe('runEndOfTurnScenario — block + observed continuation', () => {
  it('the weakening lands, the sweep blocks, and the agent continues → PROVEN', async () => {
    const r = await runEndOfTurnScenario({ binding: createFakeBinding({ continueOnBlock: true }), adapter, config: CFG() });
    expect(r.evidence.endOfTurnFired).toBe(true);
    expect(r.evidence.sweepDetected).toBe(true);
    expect(r.evidence.blockReturned).toBe(true);
    expect(r.evidence.continuationObserved).toBe(true);
    expect(r.semantic).toBe('PROVEN');
  });

  it('a block with NO continuation does not pass (agent merely stopped)', async () => {
    const r = await runEndOfTurnScenario({ binding: createFakeBinding({ continueOnBlock: false }), adapter, config: CFG() });
    expect(r.evidence.continuationObserved).toBe(false);
    expect(r.pass).toBe(false);
  });
});

describe('assembleResult — overall verdict, Round 4.1 gating, deterministic JSON', () => {
  const proven = [
    { id: 'shell-pre-deny', semantic: 'PROVEN', pass: true },
    { id: 'write-pre-deny', semantic: 'PROVEN', pass: true },
    { id: 'broken-path:sync-throw', semantic: 'FAIL-CLOSED', eligible: true },
    { id: 'end-of-turn', semantic: 'PROVEN', pass: true },
  ];

  it('all required paths proven + full provenance → FULL and phase0_passed, but Round 4.1 stays NOT eligible', () => {
    const r = assembleResult({ scenarios: proven, provenanceExpected: {}, provenanceMeasured: {}, provenanceGateResult: { full: true, reasons: [] } });
    expect(r.overall).toBe('FULL');
    expect(r.phase0_passed).toBe(true);
    expect(r.ready_for_extended_qualification).toBe(true);
    expect(r.round_4_1_eligible).toBe(false); // Phase-0 FULL is NOT Round 4.1 eligibility (#611)
    expect(r.schema_version).toBe('copilot-sdk-qualification/v1');
    expect(Array.isArray(r.capability_matrix)).toBe(true);
  });

  it('a required fail-open makes the overall INELIGIBLE regardless of provenance', () => {
    const scenarios = [...proven.slice(0, 2), { id: 'broken-path:sync-throw', semantic: 'FAIL-OPEN', eligible: false }, proven[3]];
    const r = assembleResult({ scenarios, provenanceExpected: {}, provenanceMeasured: {}, provenanceGateResult: { full: true, reasons: [] } });
    expect(r.overall).toBe('INELIGIBLE');
    expect(r.round_4_1_eligible).toBe(false);
  });

  it('incomplete provenance is never FULL (INSUFFICIENT) even when every scenario passed', () => {
    const r = assembleResult({ scenarios: proven, provenanceExpected: {}, provenanceMeasured: {}, provenanceGateResult: { full: false, reasons: ['unmeasured sdk_version'] } });
    expect(r.overall).toBe('INSUFFICIENT');
    expect(r.round_4_1_eligible).toBe(false);
  });

  it('the machine-readable result is deterministic in its claim fields', () => {
    const a = assembleResult({ scenarios: proven, provenanceExpected: {}, provenanceMeasured: {}, provenanceGateResult: { full: true, reasons: [] } });
    const b = assembleResult({ scenarios: proven, provenanceExpected: {}, provenanceMeasured: {}, provenanceGateResult: { full: true, reasons: [] } });
    expect({ overall: a.overall, eligible: a.round_4_1_eligible, matrix: a.capability_matrix }).toEqual({ overall: b.overall, eligible: b.round_4_1_eligible, matrix: b.capability_matrix });
  });
});

describe('promptHash — binds the actual prompt content, not constant labels', () => {
  it('is a deterministic 16-hex hash of the rendered prompts, not the old label placeholders', () => {
    const h = promptHash();
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(promptHash()).toBe(h); // deterministic
    // The pre-fix implementation hashed the literal strings 'shell'/'write'/'endOfTurn'; ensure we moved off it.
    expect(h).not.toBe(sha16(JSON.stringify({ shell: 'shell', write: 'write', endOfTurn: 'endOfTurn', model: 'gpt-5.4' })));
  });
});

describe('provenanceGate — auto model and unmeasured pins never qualify', () => {
  it('an "auto" model is never full', () => {
    expect(provenanceGate({ expected: { model: 'auto' }, measured: { model: 'auto' } }).full).toBe(false);
  });
});

describe('qualification authority is host-owned, never a candidate-writable file', () => {
  it('evidence rows are frozen host-memory records and no evidence artifact is written into the repo', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({}), adapter, config: CFG({ keepArtifacts: true }), mechanism: 'shell' });
    expect(r.evidenceRows.length).toBeGreaterThan(0);
    expect(r.evidenceRows.every((e: object) => Object.isFrozen(e))).toBe(true);
    // The repo the candidate could write to holds no qualification evidence file.
    const root = r.evidence.repoRoot as string;
    if (existsSync(root)) {
      const names = readdirSync(root);
      expect(names).not.toContain('.tamperward-evidence.json');
    }
  });
});

describe('serializeRequest — only adapter-relevant fields, claimed cwd carried through', () => {
  it('forwards kind/fileName/diff and the claimed cwd, drops undefined', () => {
    const json = serializeRequest({ kind: 'write', fileName: 'a.spec.ts', diff: 'd', toolCallId: 't1' }, { cwd: '/repo', sessionId: 's' });
    const o = JSON.parse(json);
    expect(o).toMatchObject({ kind: 'write', fileName: 'a.spec.ts', diff: 'd', cwd: '/repo', sessionId: 's' });
    expect('fullCommandText' in o).toBe(false);
  });
});
