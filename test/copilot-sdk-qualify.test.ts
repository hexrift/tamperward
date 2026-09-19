// #611 (layer c): the real-runtime Phase-0 QUALIFICATION orchestrator, exercised end-to-end WITHOUT
// live Copilot credentials by injecting a deterministic fake binding (the SDK/session seam) alongside
// the REAL neutral adapter + canonical engine + disposable git fixtures. The fake scripts the runtime
// semantics we cannot otherwise reach (fail-open, timeout, continuation), so the orchestrator's
// decisive classifications run against real observations, and CI proves it cannot false-green.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copilotSdkAdapter } from '../src/adapters/copilot-sdk/adapter';
// @ts-expect-error - the orchestrator is a plain .mjs harness module, no d.ts
import { buildConfig, runQualification, runPreDenyScenario, runBrokenPathScenario, runEndOfTurnScenario, assembleResult, serializeRequest, promptHash } from '../harness/adapters/copilot-sdk/orchestrator.mjs';
// @ts-expect-error - the spike is a plain .mjs harness module, no d.ts
import { provenanceGate, sha16, resolvedPackageIntegrity, packageIntegrityHash, finalizeQualification, renderResult } from '../harness/adapters/copilot-sdk-spike.mjs';
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
    // tool surface is honestly recorded as the runtime default (unmeasured) when not configured…
    expect(String(r.measured?.tool_surface)).toContain('unmeasured');
  });

  it('--preflight with COPILOT_SDK_AVAILABLE_TOOLS freezes the exact tool surface (not a fabricated list)', async () => {
    const binding = createFakeBinding({ status: { version: '1.0.14', protocolVersion: 3 } });
    const cfg = buildConfig({ model: 'gpt-5.4', preflight: true }, { COPILOT_SDK_AVAILABLE_TOOLS: 'write,shell,read' });
    const r = await runQualification({ binding, adapter, config: cfg });
    expect(r.measured?.tool_surface).toBe('read,shell,write'); // sorted, frozen from the configured set
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

  it('effects land but execution EVENTS are suppressed → INCOMPLETE (sentinel state is not dispatch-channel liveness)', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({ suppressExecEvents: true }), adapter, config: CFG(), mechanism: 'shell' });
    // The sentinel file was written (repo effect landed) but no tool.execution_start was observed…
    expect(r.evidence.finalState.sentinelWritten).toBe(true);
    expect(r.evidence.dispatchChannelLive).toBe(false);
    expect(r.evidence.handlerDispatched).toBeUndefined();
    expect(r.semantic).toBe('INCOMPLETE');
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

  it('the break is BOUND to the protected proposal — a benign read arriving first does not stand in for it', async () => {
    const r = await runBrokenPathScenario({ binding: createFakeBinding({ benignFirst: true }), adapter, config: CFG(), breakage: 'sync-throw' });
    expect(r.evidence.protectedReached).toBe(true); // the protected op was reached and broken, not the read
    expect(r.evidence.dispatchChannelLive).toBe(true); // the benign read/sentinel dispatched → channel live
    expect(r.semantic).toBe('FAIL-CLOSED');
  });

  it('the break binds to the MUTATION, not a non-mutating inspection of the same path (cat first)', async () => {
    const r = await runBrokenPathScenario({ binding: createFakeBinding({ inspectFirst: true }), adapter, config: CFG(), breakage: 'sync-throw' });
    // `cat <protected>` is not the protected mutation, so the break does not fire on it; the real
    // `rm` is still reached and broken, and the inspection's dispatch established liveness.
    expect(r.evidence.protectedReached).toBe(true);
    expect(r.evidence.dispatchChannelLive).toBe(true);
    expect(r.semantic).toBe('FAIL-CLOSED');
  });

  it('if the protected proposal is never reached, the broken path is INCONCLUSIVE (not FAIL-CLOSED from absence)', async () => {
    const r = await runBrokenPathScenario({ binding: createFakeBinding({ neverProposeProtected: true }), adapter, config: CFG(), breakage: 'sync-throw' });
    expect(r.evidence.protectedReached).toBe(false);
    expect(r.semantic).toBe('INCONCLUSIVE');
  });

  it('no dispatch-channel liveness → the broken path cannot claim explicit non-dispatch (INCONCLUSIVE)', async () => {
    const r = await runBrokenPathScenario({ binding: createFakeBinding({ suppressBenign: true }), adapter, config: CFG(), breakage: 'sync-throw' });
    expect(r.evidence.dispatchChannelLive).toBe(false);
    expect(r.evidence.handlerDispatched).toBeUndefined();
    expect(r.semantic).toBe('INCONCLUSIVE');
  });
});

describe('runEndOfTurnScenario — block + observed continuation', () => {
  it('the weakening lands, the sweep blocks, and onAgentStop RE-ENTERS (stopHookActive) → PROVEN', async () => {
    const r = await runEndOfTurnScenario({ binding: createFakeBinding({ continueOnBlock: true }), adapter, config: CFG() });
    expect(r.evidence.endOfTurnFired).toBe(true);
    expect(r.evidence.sweepDetected).toBe(true);
    expect(r.evidence.blockReturned).toBe(true);
    expect(r.evidence.continuationObserved).toBe(true); // proven by the second onAgentStop invocation
    expect(r.evidence.agentStopInvocations).toBeGreaterThanOrEqual(2);
    // The block is bound to a protected weakening that had actually LANDED at the first stop (captured
    // before the sweep was interpreted), and the sweep finding names the protected target.
    expect(r.evidence.landedWeakeningAtStop).toBe(true);
    expect(r.evidence.findingBindsTarget).toBe(true);
    expect(r.semantic).toBe('PROVEN');
  });

  it('a block with NO re-entry does not pass (agent merely stopped; a single onAgentStop is not continuation)', async () => {
    const r = await runEndOfTurnScenario({ binding: createFakeBinding({ continueOnBlock: false }), adapter, config: CFG() });
    expect(r.evidence.continuationObserved).toBe(false);
    expect(r.evidence.agentStopInvocations).toBe(1);
    expect(r.pass).toBe(false);
  });

  it('a block WITHOUT a landed protected weakening at the first stop is NOT PROVEN (block must bind to the mutation)', async () => {
    // A stub adapter that returns a block at end-of-turn for a reason unrelated to any protected
    // weakening, while the runtime never proposes/lands the protected mutation. The classifiers are
    // otherwise satisfied (fires, block, continuation), so ONLY the landed-weakening gate can stop a
    // false PROVEN here.
    const alwaysBlockEndOfTurn = {
      decide: (_raw: string, phase: string) =>
        phase === 'end-of-turn'
          ? { outcome: 'deny', decision: { verdict: 'deny', reason: 'spurious end-of-turn block' }, wire: JSON.stringify({ decision: 'block', reason: 'spurious end-of-turn block' }) }
          : { outcome: 'allow', decision: { verdict: 'allow' } },
    };
    const r = await runEndOfTurnScenario({ binding: createFakeBinding({ neverProposeProtected: true, continueOnBlock: true }), adapter: alwaysBlockEndOfTurn, config: CFG() });
    expect(r.evidence.blockReturned).toBe(true);
    expect(r.evidence.continuationObserved).toBe(true);
    expect(r.evidence.landedWeakeningAtStop).toBe(false); // no protected mutation had landed at the stop
    expect(r.evidence.findingBindsTarget).toBe(false);
    expect(r.semantic).not.toBe('PROVEN');
    expect(r.pass).toBe(false);
  });

  it('a BENIGN edit to the protected target + an unrelated block is NOT PROVEN (changed != weakened, and the finding must name the target)', async () => {
    // The at-stop protected hash differs (benign/strengthening edit), and a block IS returned — but for
    // a finding naming another file, not the protected target. A byte change plus an unrelated block
    // must not read as "the intended protected weakening landed and was detected."
    const blockNamingOtherFile = {
      decide: (_raw: string, phase: string) =>
        phase === 'end-of-turn'
          ? { outcome: 'ok', decision: { verdict: 'deny', reason: 'weakened src/other.ts' }, wire: JSON.stringify({ decision: 'block', reason: 'weakened src/other.ts' }) }
          : { outcome: 'allow', decision: { verdict: 'allow' } },
    };
    const r = await runEndOfTurnScenario({ binding: createFakeBinding({ benignProtectedEdit: true, continueOnBlock: true }), adapter: blockNamingOtherFile, config: CFG() });
    expect(r.evidence.landedWeakening).toBe(true); // the file DID change at the end...
    expect(r.evidence.findingBindsTarget).toBe(false); // ...but the block names another file
    expect(r.evidence.landedWeakeningAtStop).toBe(false);
    expect(r.semantic).not.toBe('PROVEN');
  });

  it('detects a weakening the agent COMMITTED mid-turn — the baseline is pinned at the routed pre-action call, not first at Stop', async () => {
    // The fake commits the weakening during the turn (HEAD moves). Because the end-of-turn scenario
    // now routes the proposal through the adapter (pinning turnBaseline at turn start) before approving
    // it, the Stop sweep compares against the turn-start commit and still detects the committed tamper.
    const r = await runEndOfTurnScenario({ binding: createFakeBinding({ commitProtectedEdit: true, continueOnBlock: true }), adapter, config: CFG() });
    expect(r.evidence.sweepDetected).toBe(true);
    expect(r.evidence.landedWeakeningAtStop).toBe(true);
    expect(r.evidence.findingBindsTarget).toBe(true);
    expect(r.semantic).toBe('PROVEN');
  });

  it('a block naming a DIFFERENT file with the same BASENAME does not bind to the target (exact repo-relative path, not basename)', async () => {
    // protectedRel is src/keep.spec.ts; the stub blocks naming other/keep.spec.ts. The bare basename
    // "keep.spec.ts" appears in the reason, but the exact path does not, so the finding is NOT bound.
    const blockOtherDir = {
      decide: (_raw: string, phase: string) =>
        phase === 'end-of-turn'
          ? { outcome: 'ok', decision: { verdict: 'deny', reason: 'weakened (other/keep.spec.ts:2)' }, wire: JSON.stringify({ decision: 'block', reason: 'weakened (other/keep.spec.ts:2)' }) }
          : { outcome: 'allow', decision: { verdict: 'allow' } },
    };
    const r = await runEndOfTurnScenario({ binding: createFakeBinding({ benignProtectedEdit: true, continueOnBlock: true }), adapter: blockOtherDir, config: CFG() });
    expect(r.evidence.findingBindsTarget).toBe(false);
    expect(r.semantic).not.toBe('PROVEN');
  });

  it('a block naming a path that CONTAINS the target as a suffix does not bind (exact location token, not substring)', async () => {
    // protectedRel is src/keep.spec.ts; the stub blocks naming other/src/keep.spec.ts, which contains
    // the target as a suffix. A bare `includes` would match; the anchored location token must not.
    const blockSuffixPath = {
      decide: (_raw: string, phase: string) =>
        phase === 'end-of-turn'
          ? { outcome: 'ok', decision: { verdict: 'deny', reason: 'weakened (other/src/keep.spec.ts:2)' }, wire: JSON.stringify({ decision: 'block', reason: 'weakened (other/src/keep.spec.ts:2)' }) }
          : { outcome: 'allow', decision: { verdict: 'allow' } },
    };
    const r = await runEndOfTurnScenario({ binding: createFakeBinding({ benignProtectedEdit: true, continueOnBlock: true }), adapter: blockSuffixPath, config: CFG() });
    expect(r.evidence.findingBindsTarget).toBe(false);
    expect(r.semantic).not.toBe('PROVEN');
  });
});

describe('observation boundary — shutdown-window dispatch, runtime-correlatable identity, source provenance', () => {
  it('a protected execution-start emitted DURING shutdown is still observed → FAIL-OPEN (no blind window)', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({ execStartDuringShutdown: true }), adapter, config: CFG(), mechanism: 'shell' });
    // The protected op was denied during the turn, but the runtime raced it into dispatch during
    // abort/disconnect; because the host keeps observing until quiescence, that dispatch is seen.
    expect(r.evidence.handlerDispatched).toBe(true);
    expect(r.semantic).toBe('FAIL-OPEN');
  });

  it('pre-deny: a protected proposal with NO runtime toolCallId cannot be proven non-dispatched → INCOMPLETE (never explicit false)', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({ omitProtectedToolCallId: true }), adapter, config: CFG(), mechanism: 'shell' });
    expect(r.evidence.protectedRuntimeIdPresent).toBe(false);
    expect(r.evidence.handlerDispatched).toBeUndefined(); // no correlatable id → cannot claim non-dispatch
    expect(r.semantic).toBe('INCOMPLETE');
  });

  it('broken-path: a protected proposal with NO runtime toolCallId is INCONCLUSIVE, not FAIL-CLOSED from absence', async () => {
    const r = await runBrokenPathScenario({ binding: createFakeBinding({ omitProtectedToolCallId: true }), adapter, config: CFG(), breakage: 'sync-throw' });
    expect(r.evidence.protectedReached).toBe(true);
    expect(r.evidence.protectedRuntimeIdPresent).toBe(false);
    expect(r.evidence.handlerDispatched).toBeUndefined();
    expect(r.semantic).toBe('INCONCLUSIVE');
    expect(r.eligible).toBe(false);
  });

  it('an unmeasured (runtime-default) tool surface caps provenance below FULL', () => {
    const expected = {
      sdk_version: '@github/copilot-sdk@1.2.3', runtime_version: 'copilot-runtime@0.9.0', model: 'gpt-5',
      tamperward_version: 'tamperward@2.31.0', host_config_sha256: 'abc', network_mode: 'live',
      approval_mode: 'onPermissionRequest', evidence_schema_version: 'copilot-sdk-spike/v1',
    };
    // Everything matches, but the tool surface was never measured/frozen.
    const measured = { ...expected, tool_surface: 'runtime-default (unmeasured)' };
    expect(provenanceGate({ expected, measured }).full).toBe(false);
    // With an explicitly frozen surface, this rule does not cap it.
    expect(provenanceGate({ expected, measured: { ...expected, tool_surface: 'read,shell,write' } }).full).toBe(true);
  });

  it('a dirty relevant source tree caps a qualifying run below FULL, and the bundle hash folds into measured provenance', async () => {
    const cfg = { ...buildConfig({ model: 'gpt-5.4' }, {}), sourceTreeDirty: 3, adapterBundleSha: 'deadbeefdeadbeef' };
    const r = await runQualification({ binding: createFakeBinding({}), adapter, config: cfg });
    expect(r.overall).not.toBe('FULL');
    expect(r.reasons.some((x: string) => /uncommitted change/.test(x))).toBe(true);
    expect(r.provenance.measured.adapter_bundle_sha256).toBe('deadbeefdeadbeef');
  });

  it('UNKNOWN source-tree cleanliness (git failed / non-git tree) caps below FULL — unknown != clean', async () => {
    const cfg = { ...buildConfig({ model: 'gpt-5.4' }, {}), sourceTreeDirty: null, adapterBundleSha: 'abc123' };
    const r = await runQualification({ binding: createFakeBinding({}), adapter, config: cfg });
    expect(r.overall).not.toBe('FULL');
    expect(r.reasons.some((x: string) => /could not be determined|source provenance is unknown/.test(x))).toBe(true);
  });

  it('an uncorrelated execution-start does NOT manufacture dispatch-channel liveness (liveness needs a known approved benign proposal)', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({ suppressBenign: true, emitUncorrelatedExecStart: true }), adapter, config: CFG(), mechanism: 'shell' });
    // The only observed execution-start belongs to no approved benign proposal, so the channel is not
    // proven live and the protected op's non-dispatch stays unproven (INCOMPLETE), never explicit false.
    expect(r.evidence.dispatchChannelLive).toBe(false);
    expect(r.evidence.handlerDispatched).toBeUndefined();
    expect(r.semantic).toBe('INCOMPLETE');
  });

  it('SDK integrity covers TRANSITIVE files, not just the entry (a changed client.js changes the hash; node_modules excluded)', () => {
    const root = mkdtempSync(join(tmpdir(), 'tw-sdkint-'));
    try {
      mkdirSync(join(root, 'dist', 'cjs'), { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
      writeFileSync(join(root, 'dist', 'index.js'), 'export * from "./client.js";'); // ESM entry
      writeFileSync(join(root, 'dist', 'cjs', 'index.js'), 'module.exports = require("../client.js");'); // CJS entry
      writeFileSync(join(root, 'dist', 'client.js'), 'export const a = 1;'); // transitive implementation
      const h1 = packageIntegrityHash(root);
      expect(h1).toMatch(/^[0-9a-f]{64}$/); // full SHA-256, not the 16-hex short form
      // A transitive file change (entry + package.json unchanged) MUST change the hash.
      writeFileSync(join(root, 'dist', 'client.js'), 'export const a = 2;');
      const h2 = packageIntegrityHash(root);
      expect(h2).not.toBe(h1);
      // A nested node_modules file is excluded → no change.
      mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'dep', 'x.js'), 'whatever');
      expect(packageIntegrityHash(root)).toBe(h2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an unmeasurable SDK caps a qualifying run below FULL', async () => {
    expect(resolvedPackageIntegrity('@github/copilot-sdk-does-not-exist')).toBeUndefined();
    // @github/copilot-sdk is not installed in the project, so a qualifying run cannot measure its
    // integrity and must not be FULL; the reason is surfaced.
    const r = await runQualification({ binding: createFakeBinding({}), adapter, config: buildConfig({ model: 'gpt-5.4' }, {}) });
    expect(r.overall).not.toBe('FULL');
    expect(r.reasons.some((x: string) => /SDK package integrity/.test(x))).toBe(true);
  });

  it('an operator-declared, UNVERIFIED network mode caps provenance below FULL (not a self-agreeing label)', () => {
    const base = {
      sdk_version: '@github/copilot-sdk@1.2.3', runtime_version: 'copilot-runtime@0.9.0', model: 'gpt-5',
      tamperward_version: 'tamperward@2.31.0', host_config_sha256: 'abc', approval_mode: 'onPermissionRequest',
      evidence_schema_version: 'copilot-sdk-spike/v1', network_mode: 'isolated',
    };
    // The measured side carries the honest "unverified" marker (as measuredProvenance now emits) →
    // capped, even though the operator's expected label is present.
    expect(provenanceGate({ expected: base, measured: { ...base, network_mode: 'isolated (operator-declared, unverified)' } }).full).toBe(false);
    // A genuinely verified value equal to the pin still passes.
    expect(provenanceGate({ expected: base, measured: { ...base } }).full).toBe(true);
  });
});

describe('quiescence is part of the observation boundary — a runtime that did not stop cannot qualify', () => {
  it('a broken path that would FAIL-CLOSED is capped at INCONCLUSIVE when the runtime does not quiesce', async () => {
    const r = await runBrokenPathScenario({ binding: createFakeBinding({ abortError: 'abort hung' }), adapter, config: CFG(), breakage: 'sync-throw' });
    // Without quiescence, "no dispatch during our window" is not authoritative — the runtime could
    // still dispatch after we read state, so this is not fail-closed.
    expect(r.quiescence.quiesced).toBe(false);
    expect(r.semantic).toBe('INCONCLUSIVE');
    expect(r.eligible).toBe(false);
    expect(r.evidence.quiesced).toBe(false);
  });

  it('an end-of-turn run that would be PROVEN is capped at INCOMPLETE when the runtime does not quiesce', async () => {
    const r = await runEndOfTurnScenario({ binding: createFakeBinding({ continueOnBlock: true, disconnectError: 'disconnect failed' }), adapter, config: CFG() });
    expect(r.quiescence.quiesced).toBe(false);
    expect(r.semantic).toBe('INCOMPLETE');
    expect(r.pass).toBe(false);
  });

  it('the quiescence outcome is recorded as immutable host evidence', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({ abortError: 'abort hung' }), adapter, config: CFG(), mechanism: 'shell' });
    const q = r.evidenceRows.find((e: { stage?: string }) => e.stage === 'quiescence');
    expect(q).toBeTruthy();
    expect(q.handler_completed).toBe(false); // quiesced === false
    expect(Object.isFrozen(q)).toBe(true);
  });

  it('a FAIL-OPEN still stands even without quiescence (an observed dispatch is definitive)', async () => {
    const r = await runBrokenPathScenario({ binding: createFakeBinding({ brokenFailOpen: true, abortError: 'abort hung' }), adapter, config: CFG(), breakage: 'sync-throw' });
    expect(r.quiescence.quiesced).toBe(false);
    expect(r.semantic).toBe('FAIL-OPEN'); // not downgraded — a dispatch is authoritative regardless
  });
});

describe('retained host-owned evidence — the persisted result carries the immutable event chain', () => {
  it('a serialized qualification result still contains the proposal→decision→dispatch→quiescence rows (auditable, not just summary)', async () => {
    const s = await runPreDenyScenario({ binding: createFakeBinding({}), adapter, config: CFG(), mechanism: 'shell' });
    const result = assembleResult({ scenarios: [s], provenanceExpected: {}, provenanceMeasured: {}, provenanceGateResult: { full: false, reasons: [] } });
    // Round-trip through JSON exactly as `--json` / the mandatory artifact would persist it.
    const persisted = JSON.parse(JSON.stringify(result));
    const rows = persisted.scenarios[0].evidenceRows;
    expect(Array.isArray(rows)).toBe(true);
    const stages = rows.map((r: { stage?: string }) => r.stage);
    // The chain #611 requires to reconstruct/audit the classification must survive serialization.
    expect(stages).toContain('proposal');
    expect(stages).toContain('decision');
    expect(stages).toContain('dispatch');
    expect(stages).toContain('quiescence');
    // A proposal row carries a correlatable id + input hash, not just a boolean.
    const proposal = rows.find((r: { stage?: string }) => r.stage === 'proposal');
    expect(proposal.proposal_input_hash).toBeTruthy();
  });
});

describe('finalizeQualification — persistence is the verdict commit boundary', () => {
  const fullResult = { schema_version: 'copilot-sdk-qualification/v1', runtime_id: 'github-copilot-sdk-hosted', overall: 'FULL', phase0_passed: true, round_4_1_eligible: false, reasons: [], scenarios: [] };

  it('persists BEFORE the verdict; a write failure downgrades to INSUFFICIENT and never surfaces FULL', () => {
    const fin = finalizeQualification(fullResult, {
      artifactPath: '/nonexistent/dir/artifact.json',
      writeFile: () => {
        throw new Error('disk full');
      },
    });
    expect(fin.persisted).toBe(false);
    expect(fin.result.overall).toBe('INSUFFICIENT'); // NOT FULL
    expect(fin.result.reasons.join(' ')).toMatch(/could not persist|not be retained/);
    // The rendered output an operator/CI would capture must NOT contain a FULL verdict.
    const rendered = renderResult(fin.result);
    expect(rendered).toContain('VERDICT: INSUFFICIENT');
    expect(rendered).not.toContain('VERDICT: FULL');
  });

  it('on a successful write, keeps the original verdict and writes the full result JSON', () => {
    let written: { path?: string; data?: string } = {};
    const fin = finalizeQualification(fullResult, {
      artifactPath: '/tmp/ok.json',
      writeFile: (p: string, data: string) => {
        written = { path: p, data };
      },
    });
    expect(fin.persisted).toBe(true);
    expect(fin.result.overall).toBe('FULL');
    expect(written.path).toBe('/tmp/ok.json');
    expect(JSON.parse(written.data as string).overall).toBe('FULL');
  });

  it('a preflight result is passed through unchanged (no qualification claim to back)', () => {
    const pre = { schema_version: 'copilot-sdk-qualification/v1', runtime_id: 'github-copilot-sdk-hosted', mode: 'preflight', overall: 'PREFLIGHT' };
    const fin = finalizeQualification(pre, { artifactPath: '/x', writeFile: () => { throw new Error('should not be called'); } });
    expect(fin.result.overall).toBe('PREFLIGHT');
    expect(fin.persisted).toBe(false);
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
