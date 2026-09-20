// #611 (layer c): the real-runtime Phase-0 QUALIFICATION orchestrator, exercised end-to-end WITHOUT
// live Copilot credentials by injecting a deterministic fake binding (the SDK/session seam) alongside
// the REAL neutral adapter + canonical engine + disposable git fixtures. The fake scripts the runtime
// semantics we cannot otherwise reach (fail-open, timeout, continuation), so the orchestrator's
// decisive classifications run against real observations, and CI proves it cannot false-green.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copilotSdkAdapter } from '../src/adapters/copilot-sdk/adapter';
// @ts-expect-error - the orchestrator is a plain .mjs harness module, no d.ts
import { buildConfig, runQualification, runPreDenyScenario, runBrokenPathScenario, runEndOfTurnScenario, assembleResult, serializeRequest, promptHash, classifyHandlerDispatch, decisionCategory, normalizeCompletionEvent } from '../harness/adapters/copilot-sdk/orchestrator.mjs';
// @ts-expect-error - the fixtures are a plain .mjs harness module, no d.ts
import { makeScenarioRepo, cleanupRepo, sdkCompletionEventData, PERMISSION_DENIED_CODE, USER_NOT_AVAILABLE_CODE, CANDIDATE_PERMISSION_GATE_CODES, CONFIRMED_PERMISSION_GATE_CODES } from '../harness/adapters/copilot-sdk/fixtures.mjs';
// @ts-expect-error - capture signatures are a plain .mjs harness module, no d.ts
import { CONFIRMED_PERMISSION_GATE_SIGNATURES } from '../harness/adapters/copilot-sdk/capture-signatures.mjs';
// @ts-expect-error - the spike is a plain .mjs harness module, no d.ts
import { provenanceGate, sha16, resolvedPackageIntegrity, packageIntegrityHash, finalizeQualification, renderResult, canonicalSdkVersionPin } from '../harness/adapters/copilot-sdk-spike.mjs';
// @ts-expect-error - the fake binding is a plain .mjs test-support module, no d.ts
import { createFakeBinding } from './support/fake-copilot-binding.mjs';

const adapter = copilotSdkAdapter as unknown as { decide: (raw: string, phase: string, cwd?: string) => { outcome: string; wire?: string; decision?: { verdict: string; reason?: string } } };
// The scenario-level CI tests INJECT the unconfirmed candidate permission-gate codes via
// `confirmedDenialCodes` so they can exercise the fail-closed / non-dispatch classification LOGIC. This
// is explicit: the shipped default (CONFIRMED_PERMISSION_GATE_CODES) is empty, so these tests prove the
// logic, not that the codes match the live runtime — that is the credentialed rerun's job (#615 review).
const TEST_PERMISSION_SIGNATURES = [
  { path: 'returned-reject', code: PERMISSION_DENIED_CODE, messageHash: sha16(`tool failed: ${PERMISSION_DENIED_CODE}`) },
  { path: 'callback-failure', code: USER_NOT_AVAILABLE_CODE, messageHash: sha16(`tool failed: ${USER_NOT_AVAILABLE_CODE}`) },
  // Identity-break rejections classify under the distinct host-known path 'identity-rejected' (#618
  // Work D). The fake emits the same permission_denied completion as a weakening reject, so this TEST
  // signature exercises the identity-path classification LOGIC — the SHIPPED authority
  // (CONFIRMED_PERMISSION_GATE_SIGNATURES) has NO identity-rejected entry, so a live run stays
  // INCONCLUSIVE for identity-break non-dispatch until a credentialed capture freezes one.
  { path: 'identity-rejected', code: PERMISSION_DENIED_CODE, messageHash: sha16(`tool failed: ${PERMISSION_DENIED_CODE}`) },
];
const CFG = (over: Record<string, unknown> = {}) => ({
  model: 'gpt-5.4',
  keepArtifacts: false,
  expected: {},
  errors: [],
  confirmedDenialCodes: [...CANDIDATE_PERMISSION_GATE_CODES],
  confirmedPermissionSignatures: TEST_PERMISSION_SIGNATURES,
  ...over,
});

describe('#616 — live permission signatures and canonical SDK provenance', () => {
  it('freezes the two credentialed live signatures, never a bare denied code', () => {
    expect(CONFIRMED_PERMISSION_GATE_SIGNATURES).toEqual([
      { path: 'returned-reject', code: 'denied', messageHash: '96ed60fc6898cdfa' },
      { path: 'callback-failure', code: 'denied', messageHash: 'ebf2100b9c49ae12' },
    ]);
  });

  it('the frozen classification authority is mechanically bound to the committed capture fixture (#616 lineage)', () => {
    // The classification constants must not be able to drift from the sanitized evidence record they
    // claim to come from: derive the authority from the fixture and require an EXACT match. A future
    // edit to CONFIRMED_PERMISSION_GATE_SIGNATURES must therefore change the committed evidence too.
    const fixturePath = join(__dirname, '..', 'harness', 'adapters', 'copilot-sdk', 'evidence', 'capture-2026-09-20.json');
    const capture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      signatures: Array<{ path: string; completion: { error_code: string; message_hash: string } }>;
    };
    const fromFixture = capture.signatures.map((s) => ({ path: s.path, code: s.completion.error_code, messageHash: s.completion.message_hash }));
    expect(CONFIRMED_PERMISSION_GATE_SIGNATURES).toEqual(fromFixture);
  });

  it('every frozen signature is justified by post-boundary, same-target sanitized observations (#616 lineage)', () => {
    const fixturePath = join(__dirname, '..', 'harness', 'adapters', 'copilot-sdk', 'evidence', 'capture-2026-09-20.json');
    const capture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      source_artifact_sha256: string;
      signatures: Array<{
        path: string;
        completion: { success: boolean; error_code: string; message_hash: string };
        observations: Array<{ scenario: string; proposal_id_hash: string; boundary_host_seq: number; completion_host_seq: number; protected_state_mutated: boolean }>;
      }>;
    };
    // The lineage is anchored to the ORIGINAL credentialed artifact's SHA-256 (its immutable identity);
    // it must be a real 64-hex digest, never null/pending or a fabricated value.
    expect(capture.source_artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
    // Each frozen signature is backed by ≥1 sanitized observation whose completion matches the signature,
    // recorded strictly AFTER the decision/callback boundary, on an opaque (sha16) proposal id, with the
    // protected state intact. This is the evidence-rows → signatures link of the lineage.
    for (const sig of CONFIRMED_PERMISSION_GATE_SIGNATURES as ReadonlyArray<{ path: string; code: string; messageHash: string }>) {
      const row = capture.signatures.find((s) => s.path === sig.path);
      expect(row, sig.path).toBeTruthy();
      if (!row) continue;
      expect(row.completion.success).toBe(false);
      expect(row.completion.error_code).toBe(sig.code);
      expect(row.completion.message_hash).toBe(sig.messageHash);
      expect(row.observations.length).toBeGreaterThanOrEqual(1);
      for (const o of row.observations) {
        expect(o.proposal_id_hash, o.scenario).toMatch(/^[0-9a-f]{16}$/); // sha16(proposal_id) convention
        expect(o.completion_host_seq, o.scenario).toBeGreaterThan(o.boundary_host_seq); // post-boundary
        expect(o.protected_state_mutated, o.scenario).toBe(false); // protected state intact
        expect(typeof o.scenario).toBe('string');
      }
    }
  });

  it('requires path + code + message hash for live non-dispatch authority', () => {
    const completion = {
      completions: [{ completeSeq: 3, outcome: 'error', errorCategory: 'denied', errorHash: '96ed60fc6898cdfa' }],
    };
    expect(classifyHandlerDispatch({
      mutated: false,
      completion,
      boundarySeq: 2,
      permissionPath: 'returned-reject',
      confirmedPermissionSignatures: CONFIRMED_PERMISSION_GATE_SIGNATURES,
    })).toMatchObject({ handlerDispatched: false });

    expect(classifyHandlerDispatch({
      mutated: false,
      completion,
      boundarySeq: 2,
      permissionPath: 'callback-failure',
      confirmedPermissionSignatures: CONFIRMED_PERMISSION_GATE_SIGNATURES,
    })).toMatchObject({ handlerDispatched: undefined });

    expect(classifyHandlerDispatch({
      mutated: false,
      completion: { completions: [{ completeSeq: 3, outcome: 'error', errorCategory: 'denied', errorHash: 'wrong' }] },
      boundarySeq: 2,
      permissionPath: 'returned-reject',
      confirmedPermissionSignatures: CONFIRMED_PERMISSION_GATE_SIGNATURES,
    })).toMatchObject({ handlerDispatched: undefined });
  });

  it('canonicalizes the Copilot SDK package pin regardless of npm-spec casing', () => {
    expect(canonicalSdkVersionPin('@GitHub/copilot-sdk@1.0.14')).toBe('@github/copilot-sdk@1.0.14');
    expect(canonicalSdkVersionPin('@github/copilot-sdk@1.0.14')).toBe('@github/copilot-sdk@1.0.14');
  });

  it('provenance gate accepts equivalent canonical Copilot SDK package casing', () => {
    const expected = {
      sdk_version: '@GitHub/copilot-sdk@1.0.14',
      runtime_version: 'copilot-runtime@1.0.85',
      tamperward_version: 'tamperward@2.31.0',
      host_config_sha256: 'abc',
      network_mode: 'verified',
      approval_mode: 'onPermissionRequest',
      evidence_schema_version: 'copilot-sdk-spike/v1',
      model: 'gpt-5.4',
    };
    const measured = { ...expected, sdk_version: '@github/copilot-sdk@1.0.14', tool_surface: 'bash' };
    expect(provenanceGate({ expected, measured }).full).toBe(true);
  });

  it('records a sanitized unavailable_reason on a fail-closed decision, so a live diagnosis knows WHY (#616 item C)', async () => {
    // A cross-repo identity claim fails closed at the real adapter; the decision evidence row must carry
    // the bounded cause category (identity-rejected), not just an opaque tamperward-unavailable.
    const r = await runBrokenPathScenario({ binding: createFakeBinding({}), adapter, config: CFG(), breakage: 'cross-repo' });
    const denyRow = r.evidenceRows.find((e: { stage?: string; tamperward_decision?: string }) => e.stage === 'decision' && e.tamperward_decision === 'deny');
    expect(denyRow).toBeTruthy();
    expect(denyRow.decision_category).toBe('identity-rejected');
    expect(denyRow.unavailable_reason).toBe('identity-rejected');
    // A plain allow decision never carries a cause category.
    const allowRow = r.evidenceRows.find((e: { stage?: string; tamperward_decision?: string }) => e.stage === 'decision' && e.tamperward_decision === 'allow');
    if (allowRow) expect(allowRow.unavailable_reason).toBeUndefined();
  });
});

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
  it('shell: denied + not dispatched + intact + observed continuation → PROVEN; reason-delivery is a recorded diagnostic, never gating (#618 Work B)', async () => {
    // With this TEST config non-dispatch is independently observable (injected confirmed signatures),
    // so every ENFORCEMENT fact is present. Reason delivery — which the live SDK surface cannot observe
    // — must NOT hold the enforcement claim below PROVEN (the old impossible criterion). It is recorded
    // as reasonDeliveryProven=false / reasonReached=undefined, never manufactured true.
    const r = await runPreDenyScenario({ binding: createFakeBinding({}), adapter, config: CFG(), mechanism: 'shell' });
    expect(r.semantic).toBe('PROVEN');
    expect(r.enforcementProven).toBe(true);
    expect(r.evidence.denyReturned).toBe(true);
    expect(r.evidence.handlerDispatched).toBe(false); // non-dispatch, proven by the post-decision permission_denied completion
    expect(r.evidence.dispatchBasis).toBe('post-decision-denied-completion');
    expect(r.evidence.finalStateMutated).toBe(false);
    expect(r.evidence.reasonReached).toBeUndefined(); // not independently observable on the current SDK surface
    expect(r.evidence.reasonDeliveryObservable).toBe(false);
    expect(r.reasonDeliveryProven).toBe(false); // recorded, not manufactured
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

  it('no post-decision completion for the protected op → INCOMPLETE (never inferred from a pre-decision execution-start)', async () => {
    // The protected op emits an execution-start but NO completion. Non-dispatch cannot be asserted from
    // absence, and the pre-decision execution-start proves nothing → INCOMPLETE (not PROVEN, not FAIL-OPEN).
    const r = await runPreDenyScenario({ binding: createFakeBinding({ suppressProtectedCompletion: true }), adapter, config: CFG(), mechanism: 'shell' });
    expect(r.semantic).toBe('INCOMPLETE');
    expect(r.evidence.handlerDispatched).toBeUndefined();
    expect(r.evidence.dispatchBasis).toBe('insufficient-post-decision-evidence');
    expect(r.evidence.finalStateMutated).toBe(false);
  });

  it('execution EVENTS suppressed (broken event channel), protected denied → INCOMPLETE, never FAIL-OPEN from a start event', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({ suppressExecEvents: true }), adapter, config: CFG(), mechanism: 'shell' });
    // The sentinel effect still landed, but there is no protected completion and the protected op did
    // not mutate — so the result is INCOMPLETE, and never FAIL-OPEN from a mere (absent) start event.
    expect(r.evidence.finalState.sentinelWritten).toBe(true);
    expect(r.evidence.handlerDispatched).toBeUndefined();
    expect(r.semantic).toBe('INCOMPLETE');
  });

  it('records proposal, decision, execution-start (lifecycle) and completion as separate immutable host evidence', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({}), adapter, config: CFG(), mechanism: 'shell' });
    const stages = r.evidenceRows.map((e: { stage?: string }) => e.stage);
    expect(stages).toContain('proposal');
    expect(stages).toContain('decision');
    expect(stages).toContain('execution-start'); // lifecycle-start, NOT "dispatch"
    expect(stages).toContain('completion');
    expect(stages).not.toContain('dispatch'); // the old "execution-start == dispatch" stage is gone
    expect(r.evidenceRows.every((e: object) => Object.isFrozen(e))).toBe(true);
    // Every row carries a monotonic host sequence, strictly increasing in append order (#611 item H).
    const seqs = r.evidenceRows.map((e: { host_seq?: number }) => e.host_seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
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

  it('timeout: a hung callback with no dispatch is INCONCLUSIVE and INTRINSICALLY unobservable, NOT FAIL-CLOSED (#618 Work C)', async () => {
    const r = await runBrokenPathScenario({ binding: createFakeBinding({ brokenFailOpen: false }), adapter, config: CFG(), breakage: 'timeout' });
    expect(r.semantic).toBe('INCONCLUSIVE');
    expect(r.eligible).toBe(false);
    // The break WAS exercised on the protected op — it is recorded INCONCLUSIVE, never dropped — and
    // flagged intrinsically unobservable so the aggregate does not treat this INCONCLUSIVE as a gap.
    expect(r.evidence.protectedReached).toBe(true);
    expect(r.intrinsicallyUnobservable).toBe(true);
  });

  it('a broken path that STILL dispatches is FAIL-OPEN and INELIGIBLE (incl. timeout — a dispatch during a hang is definitive, not intrinsically unobservable)', async () => {
    const r = await runBrokenPathScenario({ binding: createFakeBinding({ brokenFailOpen: true }), adapter, config: CFG(), breakage: 'sync-throw' });
    expect(r.semantic).toBe('FAIL-OPEN');
    expect(r.eligible).toBe(false);
    const t = await runBrokenPathScenario({ binding: createFakeBinding({ brokenFailOpen: true }), adapter, config: CFG(), breakage: 'timeout' });
    expect(t.semantic).toBe('FAIL-OPEN');
    expect(t.intrinsicallyUnobservable).toBe(false); // a dispatch is definitive FAIL-OPEN, not an unobservable timeout
  });

  for (const breakage of ['cross-repo', 'path-escape', 'symlink-escape', 'malformed-identity'] as const) {
    it(`${breakage}: the real adapter fails the identity claim closed → FAIL-CLOSED + identity pass (with the identity-path test signature injected)`, async () => {
      const r = await runBrokenPathScenario({ binding: createFakeBinding({}), adapter, config: CFG(), breakage });
      expect(r.semantic).toBe('FAIL-CLOSED');
      expect(r.identity?.pass).toBe(true);
    });

    // #618 Work D — under the SHIPPED source-frozen signatures (no identity-rejected entry), the same
    // break is still correctly DENIED but INCONCLUSIVE for non-dispatch (never fabricated FAIL-CLOSED).
    it(`${breakage}: under the source-frozen signatures the claim is denied but non-dispatch is INCONCLUSIVE (#618 Work D)`, async () => {
      const cfg = CFG({ confirmedPermissionSignatures: CONFIRMED_PERMISSION_GATE_SIGNATURES, confirmedDenialCodes: [...CONFIRMED_PERMISSION_GATE_CODES] });
      const r = await runBrokenPathScenario({ binding: createFakeBinding({}), adapter, config: cfg, breakage });
      expect(r.semantic).toBe('INCONCLUSIVE');
      expect(r.evidence.handlerDispatched).toBeUndefined(); // non-dispatch not observable → not FAIL-CLOSED
      // The decision itself is still a deny (the claim was rejected before policy).
      const denyRow = r.evidenceRows.find((e: { stage?: string; tamperward_decision?: string }) => e.stage === 'decision' && e.tamperward_decision === 'deny');
      expect(denyRow?.decision_category).toBe('identity-rejected');
    });
  }

  it('#618 Work D — the frozen weakening returned-reject signature does NOT authorize an identity-rejected completion (no cross-path leak)', () => {
    // A completion whose code + message hash exactly equal the frozen returned-reject WEAKENING
    // signature is still INCONCLUSIVE on the identity path: the host-known path is part of the signature
    // key, so the two never conflate. This is the structural guarantee behind leaving identity breaks
    // INCONCLUSIVE until an identity signature is itself captured and frozen.
    const disp = classifyHandlerDispatch({
      mutated: false,
      completion: { completions: [{ completeSeq: 3, outcome: 'error', errorCategory: 'denied', errorHash: '96ed60fc6898cdfa' }] },
      boundarySeq: 2,
      permissionPath: 'identity-rejected',
      confirmedPermissionSignatures: CONFIRMED_PERMISSION_GATE_SIGNATURES,
    });
    expect(disp.handlerDispatched).toBeUndefined();
    expect(disp.basis).toBe('insufficient-post-decision-evidence');
  });

  it('the break is BOUND to the protected proposal — a benign read arriving first does not stand in for it', async () => {
    const r = await runBrokenPathScenario({ binding: createFakeBinding({ benignFirst: true }), adapter, config: CFG(), breakage: 'sync-throw' });
    expect(r.evidence.protectedReached).toBe(true); // the protected op was reached and broken, not the read
    expect(r.semantic).toBe('FAIL-CLOSED'); // the broken callback's user_not_available completion proves non-dispatch
  });

  it('the break binds to the MUTATION, not a non-mutating inspection of the same path (cat first)', async () => {
    const r = await runBrokenPathScenario({ binding: createFakeBinding({ inspectFirst: true }), adapter, config: CFG(), breakage: 'sync-throw' });
    // `cat <protected>` is not the protected mutation, so the break does not fire on it; the real
    // `rm` is still reached and broken, and its user_not_available completion proves non-dispatch.
    expect(r.evidence.protectedReached).toBe(true);
    expect(r.semantic).toBe('FAIL-CLOSED');
  });

  it('if the protected proposal is never reached, the broken path is INCONCLUSIVE (not FAIL-CLOSED from absence)', async () => {
    const r = await runBrokenPathScenario({ binding: createFakeBinding({ neverProposeProtected: true }), adapter, config: CFG(), breakage: 'sync-throw' });
    expect(r.evidence.protectedReached).toBe(false);
    expect(r.semantic).toBe('INCONCLUSIVE');
  });

  it('a broken path with NO authoritative completion is INCONCLUSIVE, never FAIL-CLOSED from absence', async () => {
    // The protected op breaks but the runtime emits no completion — absence of a denial/non-execution
    // outcome cannot be read as fail-closed.
    const r = await runBrokenPathScenario({ binding: createFakeBinding({ suppressProtectedCompletion: true }), adapter, config: CFG(), breakage: 'sync-throw' });
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
          ? { outcome: 'ok', decision: { verdict: 'deny', findings: [{ rule: 'test-deletion', severity: 'block', file: 'src/other.ts' }], reason: 'weakened src/other.ts' }, wire: JSON.stringify({ decision: 'block', reason: 'weakened src/other.ts' }) }
          : { outcome: 'allow', decision: { verdict: 'allow', findings: [] } },
    };
    const r = await runEndOfTurnScenario({ binding: createFakeBinding({ benignProtectedEdit: true, continueOnBlock: true }), adapter: blockNamingOtherFile, config: CFG() });
    expect(r.evidence.landedWeakening).toBe(true); // the file DID change at the end...
    // #611 item G: the two conditions are reported INDEPENDENTLY — the target changed, but the finding
    // did not bind to it, so this is not conflated with "the target had not weakened".
    expect(r.evidence.targetChangedAtStop).toBe(true);
    expect(r.evidence.findingBindsTarget).toBe(false); // ...but the block names another file
    expect(r.evidence.landedWeakeningAtStop).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/changed before the first agent-stop, but the blocking sweep finding did not bind/);
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
    // protectedRel is src/keep.spec.ts; the stub blocks with a STRUCTURED finding for other/keep.spec.ts.
    // The basename matches but the repo-relative path does not, so structural binding must NOT bind it.
    const blockOtherDir = {
      decide: (_raw: string, phase: string) =>
        phase === 'end-of-turn'
          ? { outcome: 'ok', decision: { verdict: 'deny', findings: [{ rule: 'test-deletion', severity: 'block', file: 'other/keep.spec.ts', line: 2 }], reason: 'weakened (other/keep.spec.ts:2)' }, wire: JSON.stringify({ decision: 'block', reason: 'weakened (other/keep.spec.ts:2)' }) }
          : { outcome: 'allow', decision: { verdict: 'allow', findings: [] } },
    };
    const r = await runEndOfTurnScenario({ binding: createFakeBinding({ benignProtectedEdit: true, continueOnBlock: true }), adapter: blockOtherDir, config: CFG() });
    expect(r.evidence.findingBindsTarget).toBe(false);
    expect(r.semantic).not.toBe('PROVEN');
  });

  it('a block naming a path that CONTAINS the target as a suffix does not bind (exact resolved path, not substring)', async () => {
    // protectedRel is src/keep.spec.ts; the stub blocks with a STRUCTURED finding for
    // other/src/keep.spec.ts, which contains the target as a suffix. A bare `includes`/suffix compare
    // would match; the resolved-path structural compare must not.
    const blockSuffixPath = {
      decide: (_raw: string, phase: string) =>
        phase === 'end-of-turn'
          ? { outcome: 'ok', decision: { verdict: 'deny', findings: [{ rule: 'test-deletion', severity: 'block', file: 'other/src/keep.spec.ts', line: 2 }], reason: 'weakened (other/src/keep.spec.ts:2)' }, wire: JSON.stringify({ decision: 'block', reason: 'weakened (other/src/keep.spec.ts:2)' }) }
          : { outcome: 'allow', decision: { verdict: 'allow', findings: [] } },
    };
    const r = await runEndOfTurnScenario({ binding: createFakeBinding({ benignProtectedEdit: true, continueOnBlock: true }), adapter: blockSuffixPath, config: CFG() });
    expect(r.evidence.findingBindsTarget).toBe(false);
    expect(r.semantic).not.toBe('PROVEN');
  });

  it('binds STRUCTURALLY to the protected target from the sweep finding, not the rendered reason text (#616 item D)', async () => {
    // The rendered reason carries NO `(path)` location token — the old regex-over-reason binding would
    // have failed here (exactly the live-capture symptom: findingBindsTarget=false despite a real block
    // on the changed target). Structural binding reads the finding's `file` and binds regardless.
    const blockStructuralTarget = {
      decide: (_raw: string, phase: string) =>
        phase === 'end-of-turn'
          ? { outcome: 'ok', decision: { verdict: 'deny', findings: [{ rule: 'test-deletion', severity: 'block', file: 'src/keep.spec.ts', line: 2 }], reason: 'a protected test was weakened' }, wire: JSON.stringify({ decision: 'block', reason: 'a protected test was weakened' }) }
          : { outcome: 'allow', decision: { verdict: 'allow', findings: [] } },
    };
    const r = await runEndOfTurnScenario({ binding: createFakeBinding({ continueOnBlock: true }), adapter: blockStructuralTarget, config: CFG() });
    expect(r.evidence.targetChangedAtStop).toBe(true);
    expect(r.evidence.findingBindsTarget).toBe(true); // bound from finding.file, no reason-text parse
    expect(r.evidence.findingFile).toBe('src/keep.spec.ts');
    expect(r.evidence.findingRule).toBe('test-deletion');
    expect(r.semantic).toBe('PROVEN');
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

  it('an uncorrelated execution-start never manufactures FAIL-OPEN or dispatch (execution-start is not dispatch)', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({ emitUncorrelatedExecStart: true }), adapter, config: CFG(), mechanism: 'shell' });
    // An unsolicited execution-start belonging to no proposal cannot be dispatch evidence. The protected
    // op was denied and did not run — so this is NEVER FAIL-OPEN from a start event. Enforcement is fully
    // observable in this config, so the honest verdict is PROVEN (reason-delivery is diagnostic, #618 B).
    expect(r.semantic).not.toBe('FAIL-OPEN');
    expect(r.semantic).toBe('PROVEN');
    expect(r.evidence.handlerDispatched).not.toBe(true);
    expect(r.evidence.finalStateMutated).toBe(false);
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
  it('a serialized qualification result retains the full audit chain (proposal→decision→execution-start→completion→quiescence) with monotonic sequence', async () => {
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
    expect(stages).toContain('execution-start');
    expect(stages).toContain('completion');
    expect(stages).toContain('quiescence');
    // A proposal row carries a correlatable id + input hash, not just a boolean.
    const proposal = rows.find((r: { stage?: string }) => r.stage === 'proposal');
    expect(proposal.proposal_input_hash).toBeTruthy();
    // A completion row carries the sanitized outcome; a decision row carries the structured category.
    const completion = rows.find((r: { stage?: string }) => r.stage === 'completion');
    expect(completion.completion_outcome).toBeTruthy();
    const decision = rows.find((r: { stage?: string }) => r.stage === 'decision');
    expect(decision.decision_category).toBeTruthy();
    // Monotonic host sequence survives serialization and is strictly increasing.
    const seqs = rows.map((r: { host_seq?: number }) => r.host_seq);
    expect(seqs).toEqual([...seqs].sort((a: number, b: number) => a - b));
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

  // #618 Work C — an intrinsically-unobservable timeout must not make FULL mathematically impossible,
  // yet must stay visible (INCONCLUSIVE, never dropped).
  const intrinsicTimeout = {
    id: 'broken-path:timeout',
    semantic: 'INCONCLUSIVE',
    eligible: false,
    intrinsicallyUnobservable: true,
    reason: 'no runtime-exposed permission-callback timeout exists',
    evidence: { protectedReached: true, intrinsicallyUnobservable: true },
  };

  it('an exercised intrinsically-unobservable timeout does NOT block FULL, but stays visible as INCONCLUSIVE', () => {
    const scenarios = [...proven, intrinsicTimeout];
    const r = assembleResult({ scenarios, provenanceExpected: {}, provenanceMeasured: {}, provenanceGateResult: { full: true, reasons: [] } });
    expect(r.overall).toBe('FULL');
    expect(r.phase0_passed).toBe(true);
    // The decision-path capability row is FAIL-CLOSED (observable breaks all closed; the timeout is exercised).
    const decisionRow = r.capability_matrix.find((row: { label: string }) => row.label === 'decision-path:fail-closed');
    expect(decisionRow?.value).toBe('FAIL-CLOSED');
    // The timeout scenario is retained in the result, and its INCONCLUSIVE is surfaced in reasons — not dropped.
    expect(r.scenarios.some((s: { id: string; semantic: string }) => s.id === 'broken-path:timeout' && s.semantic === 'INCONCLUSIVE')).toBe(true);
    expect(r.reasons.some((x: string) => /broken-path:timeout: INCONCLUSIVE/.test(x))).toBe(true);
  });

  it('a timeout that DISPATCHED (FAIL-OPEN) is still INELIGIBLE — the intrinsic-unobservable carve-out never covers a fail-open', () => {
    const scenarios = [...proven, { id: 'broken-path:timeout', semantic: 'FAIL-OPEN', eligible: false, intrinsicallyUnobservable: false }];
    const r = assembleResult({ scenarios, provenanceExpected: {}, provenanceMeasured: {}, provenanceGateResult: { full: true, reasons: [] } });
    expect(r.overall).toBe('INELIGIBLE');
  });

  it('an intrinsic break that was NEVER exercised does not silently satisfy the gate (not FULL)', () => {
    const notExercised = { ...intrinsicTimeout, evidence: { protectedReached: false, intrinsicallyUnobservable: true } };
    const scenarios = [...proven, notExercised];
    const r = assembleResult({ scenarios, provenanceExpected: {}, provenanceMeasured: {}, provenanceGateResult: { full: true, reasons: [] } });
    expect(r.overall).not.toBe('FULL');
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

describe('#614 — execution_start is lifecycle-start, not dispatch; completion drives FAIL-OPEN', () => {
  it('classifyHandlerDispatch: a pre-decision start / missing completion is never dispatch', () => {
    expect(classifyHandlerDispatch({ mutated: false, completion: undefined, boundarySeq: 5 }).handlerDispatched).toBeUndefined();
    // A completion recorded BEFORE the decision boundary (reordered / pre-decision) is not authoritative.
    expect(classifyHandlerDispatch({ mutated: false, completion: { completeSeq: 4, outcome: 'success' }, boundarySeq: 5 }).handlerDispatched).toBeUndefined();
    // A non-denial tool error after the boundary is neither fail-open nor fail-closed.
    expect(classifyHandlerDispatch({ mutated: false, completion: { completeSeq: 6, outcome: 'error', errorCategory: 'tool-error' }, boundarySeq: 5 }).handlerDispatched).toBeUndefined();
  });

  it('classifyHandlerDispatch: FAIL-OPEN only from mutation or a post-decision success completion', () => {
    expect(classifyHandlerDispatch({ mutated: true }).handlerDispatched).toBe(true);
    const s = classifyHandlerDispatch({ mutated: false, completion: { completeSeq: 6, outcome: 'success' }, boundarySeq: 5 });
    expect(s.handlerDispatched).toBe(true);
    expect(s.basis).toBe('post-decision-success-completion');
  });

  it('classifyHandlerDispatch: non-dispatch only from a post-decision completion whose code is CONFIRMED', () => {
    const confirmedDenialCodes = [...CANDIDATE_PERMISSION_GATE_CODES];
    const d = classifyHandlerDispatch({ mutated: false, completion: { completeSeq: 6, outcome: 'error', errorCategory: USER_NOT_AVAILABLE_CODE }, boundarySeq: 5, confirmedDenialCodes });
    expect(d.handlerDispatched).toBe(false);
    expect(d.basis).toBe('post-decision-denied-completion');
    // The explicit-reject code is equally authoritative when confirmed.
    expect(classifyHandlerDispatch({ mutated: false, completion: { completeSeq: 6, outcome: 'error', errorCategory: PERMISSION_DENIED_CODE }, boundarySeq: 5, confirmedDenialCodes }).handlerDispatched).toBe(false);
  });

  it('classifyHandlerDispatch: UNCONFIRMED codes never produce fail-closed by default (#615 final blocker)', () => {
    // The shipped/live default confirmed set is EMPTY (the v1.0.14 E2E establishes only message
    // substrings, not error.code), so even a candidate permission-gate code stays INCONCLUSIVE until the
    // credentialed rerun freezes the real code — a wrong guess can never manufacture a false FAIL-CLOSED.
    expect([...CONFIRMED_PERMISSION_GATE_CODES]).toEqual([]);
    for (const code of [PERMISSION_DENIED_CODE, USER_NOT_AVAILABLE_CODE]) {
      const r = classifyHandlerDispatch({ mutated: false, completion: { completeSeq: 6, outcome: 'error', errorCategory: code }, boundarySeq: 5 });
      expect(r.handlerDispatched).toBeUndefined();
      expect(r.basis).toBe('insufficient-post-decision-evidence');
    }
  });

  it('classifyHandlerDispatch: a failure code OUTSIDE the confirmed set never promotes to FAIL-CLOSED (#615 blocker 2)', () => {
    // With the confirmed set holding only the candidate permission codes, any other failure code —
    // `aborted` (may already have mutated), generic `denied`/`rejected` (tool-result semantics), a plain
    // tool error, or an absent code — is not in the set and must stay INCONCLUSIVE.
    const confirmedDenialCodes = [...CANDIDATE_PERMISSION_GATE_CODES];
    for (const code of ['aborted', 'denied', 'rejected', 'tool-error', 'timeout', undefined]) {
      const r = classifyHandlerDispatch({ mutated: false, completion: { completeSeq: 6, outcome: 'error', errorCategory: code }, boundarySeq: 5, confirmedDenialCodes });
      expect(r.handlerDispatched).toBeUndefined();
      expect(r.basis).toBe('insufficient-post-decision-evidence');
    }
    // The candidate set is exactly the two codes — nothing wider — and stays UNCONFIRMED (not shipped).
    expect([...CANDIDATE_PERMISSION_GATE_CODES].sort()).toEqual([PERMISSION_DENIED_CODE, USER_NOT_AVAILABLE_CODE].sort());
  });

  it('buildConfig: there is NO operator override for the confirmed denial codes (#615 authority hole)', () => {
    // COPILOT_SDK_CONFIRMED_DENIAL_CODES is not an input — an unpinned verdict knob is not bound into the
    // provenance/host-config hash, so it must not exist. The confirmed set comes only from committed source.
    const cfg = buildConfig({ model: 'gpt-5.4' }, { COPILOT_SDK_CONFIRMED_DENIAL_CODES: 'aborted,rejected,permission_denied' });
    expect(cfg.confirmedDenialCodes).toEqual([]);
  });

  it('normalizeCompletionEvent: authoritative ONLY from the pinned v1.0.14 { success, error.code } shape (#615)', () => {
    // Pinned shape → authoritative.
    expect(normalizeCompletionEvent({ success: true })).toMatchObject({ outcome: 'success', schemaVariant: 'v1.0.14' });
    expect(normalizeCompletionEvent({ success: false, error: { code: PERMISSION_DENIED_CODE } })).toMatchObject({ outcome: 'error', errorCode: PERMISSION_DENIED_CODE, schemaVariant: 'v1.0.14' });
    // A `success:false` with only a legacy `error.kind` (no `code`) has no machine-readable category.
    expect(normalizeCompletionEvent({ success: false, error: { kind: 'x' } })).toMatchObject({ outcome: 'error', errorCode: undefined, schemaVariant: 'v1.0.14' });
    // Legacy / unexpected shapes lack the `success` discriminator → NON-authoritative (outcome undefined),
    // retained only as a diagnostic schema variant — never reinterpreted as success/error.
    for (const legacy of [{ outcome: 'success' }, { outcome: 'error', errorCategory: PERMISSION_DENIED_CODE }, { error: { kind: 'x' } }, {}]) {
      const n = normalizeCompletionEvent(legacy);
      expect(n.outcome).toBeUndefined();
      expect(n.schemaVariant).toBe('legacy/unexpected');
    }
  });

  it('classifyHandlerDispatch: a schema-drift completion (undefined outcome) is neither FAIL-OPEN nor FAIL-CLOSED (#615)', () => {
    // `{ outcome:'success' }` normalizes to outcome undefined, so even after the boundary it cannot be
    // read as a success completion (no dispatch); and it cannot be a denial either.
    const { outcome } = normalizeCompletionEvent({ outcome: 'success' });
    expect(classifyHandlerDispatch({ mutated: false, completion: { completeSeq: 6, outcome }, boundarySeq: 5, confirmedDenialCodes: [...CANDIDATE_PERMISSION_GATE_CODES] }).handlerDispatched).toBeUndefined();
  });

  it('an unexpected completion shape degrades to INCOMPLETE and is retained diagnostically (#615)', async () => {
    // The protected op is denied and the runtime emits a pre-1.0.14 / unexpected completion (no
    // `success`). It must not become authoritative non-dispatch: the scenario stays INCOMPLETE, and the
    // completion row is retained as schema_variant 'legacy/unexpected'.
    const r = await runPreDenyScenario({ binding: createFakeBinding({ legacyCompletionShape: true }), adapter, config: CFG(), mechanism: 'shell' });
    expect(r.evidence.finalStateMutated).toBe(false);
    expect(r.evidence.handlerDispatched).toBeUndefined();
    expect(r.semantic).toBe('INCOMPLETE');
    const compRow = r.evidenceRows.find((e: { stage?: string }) => e.stage === 'completion');
    expect(compRow?.completion_schema_variant).toBe('legacy/unexpected');
    expect(compRow?.completion_outcome).toBeUndefined();
  });

  it('classifyHandlerDispatch: duplicate/contradictory completions resolve by AGREEMENT, never last-write (#614 §H)', () => {
    const confirmedDenialCodes = [...CANDIDATE_PERMISSION_GATE_CODES];
    const denied = (seq: number) => ({ completeSeq: seq, outcome: 'error', errorCategory: PERMISSION_DENIED_CODE });
    const success = (seq: number) => ({ completeSeq: seq, outcome: 'success' });
    const run = (completions: unknown[]) => classifyHandlerDispatch({ mutated: false, completion: { completions }, boundarySeq: 5, confirmedDenialCodes });

    // deny → denied → duplicate IDENTICAL denied: consistent, still usable as non-dispatch.
    expect(run([denied(6), denied(7)])).toMatchObject({ handlerDispatched: false, basis: 'post-decision-denied-completion' });
    // deny → denied → success: contradictory → INCONCLUSIVE + conflict flag, NOT last-write success.
    expect(run([denied(6), success(7)])).toMatchObject({ handlerDispatched: undefined, basis: 'contradictory-post-decision-completions', evidenceConflict: true });
    // deny → success → denied (reverse order): still contradictory, NOT last-write denial.
    expect(run([success(6), denied(7)])).toMatchObject({ handlerDispatched: undefined, evidenceConflict: true });
    // completion BEFORE the decision boundary is ignored; the single post-decision completion governs.
    expect(run([success(4), denied(6)])).toMatchObject({ handlerDispatched: false, basis: 'post-decision-denied-completion' });
    // two post-decision successes (duplicate) agree → dispatch.
    expect(run([success(6), success(7)])).toMatchObject({ handlerDispatched: true, basis: 'post-decision-success-completion' });
  });

  it('classifyHandlerDispatch: non-dispatch needs the WHOLE error set to be one confirmed denial, not just some (#615)', () => {
    const confirmedDenialCodes = [...CANDIDATE_PERMISSION_GATE_CODES]; // permission_denied + user_not_available
    const err = (seq: number, code: string) => ({ completeSeq: seq, outcome: 'error', errorCategory: code });
    const run = (completions: unknown[]) => classifyHandlerDispatch({ mutated: false, completion: { completions }, boundarySeq: 5, confirmedDenialCodes });

    // confirmed denial + generic tool-error → NOT laundered to fail-closed; ambiguous → conflict.
    expect(run([err(6, PERMISSION_DENIED_CODE), err(7, 'tool-error')])).toMatchObject({ handlerDispatched: undefined, basis: 'contradictory-post-decision-completions', evidenceConflict: true });
    // order-independent.
    expect(run([err(6, 'tool-error'), err(7, PERMISSION_DENIED_CODE)])).toMatchObject({ handlerDispatched: undefined, evidenceConflict: true });
    // two DIFFERENT confirmed denial codes for one call → not proven equivalent → conflict.
    expect(run([err(6, PERMISSION_DENIED_CODE), err(7, USER_NOT_AVAILABLE_CODE)])).toMatchObject({ handlerDispatched: undefined, evidenceConflict: true });
    // duplicate IDENTICAL confirmed denial → consistent → usable non-dispatch.
    expect(run([err(6, PERMISSION_DENIED_CODE), err(7, PERMISSION_DENIED_CODE)])).toMatchObject({ handlerDispatched: false, basis: 'post-decision-denied-completion' });
    // generic errors only (none confirmed) → insufficient, not a conflict.
    expect(run([err(6, 'tool-error'), err(7, 'aborted')])).toMatchObject({ handlerDispatched: undefined, basis: 'insufficient-post-decision-evidence' });
  });

  it('deny → denied-completion → contradictory success completion is INCONCLUSIVE end-to-end (#614 §H)', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({ extraProtectedCompletion: 'success' }), adapter, config: CFG(), mechanism: 'shell' });
    expect(r.evidence.finalStateMutated).toBe(false); // the injected success completion is NOT a real mutation
    expect(r.evidence.handlerDispatched).toBeUndefined();
    expect(r.evidence.dispatchBasis).toBe('contradictory-post-decision-completions');
    expect(r.semantic).toBe('INCOMPLETE');
  });

  it('deny → denied-completion → duplicate IDENTICAL denied stays usable non-dispatch (#614 §H)', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({ extraProtectedCompletion: 'duplicate' }), adapter, config: CFG(), mechanism: 'shell' });
    expect(r.evidence.handlerDispatched).toBe(false);
    expect(r.evidence.dispatchBasis).toBe('post-decision-denied-completion');
  });

  it('a duplicate protected execution_start cannot manufacture dispatch (#614 §H)', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({ duplicateProtectedExecStart: true }), adapter, config: CFG(), mechanism: 'shell' });
    const starts = r.evidenceRows.filter((e: { stage?: string; proposal_id?: string }) => e.stage === 'execution-start');
    // The protected op emitted two starts, both retained.
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(r.evidence.finalStateMutated).toBe(false);
    // A start is never authoritative: duplicates don't flip dispatch — non-dispatch proven by the denied completion.
    expect(r.evidence.handlerDispatched).toBe(false);
  });

  it('runQualification enforces the committed confirmed-code authority — a caller cannot inject it (#615 boundary)', async () => {
    // Bypass buildConfig and hand the exported driver its own classification authority. It must be
    // ignored: the committed CONFIRMED_PERMISSION_GATE_CODES (empty) governs, so an injected `rejected`
    // cannot turn a broken-path completion into authoritative non-dispatch, and the run cannot be FULL.
    const injected = { ...buildConfig({ model: 'gpt-5.4' }, {}), confirmedDenialCodes: ['rejected'] };
    const r = await runQualification({ binding: createFakeBinding({}), adapter, config: injected });
    expect(r.provenance.measured.confirmed_denial_codes).toEqual([]); // active authority is the committed (empty) set
    expect(r.provenance.measured.confirmed_denial_codes_source).toBe('committed:CONFIRMED_PERMISSION_GATE_CODES');
    const broken = r.scenarios.filter((s: { id: string }) => s.id.startsWith('broken-path:'));
    expect(broken.length).toBeGreaterThan(0);
    expect(broken.every((s: { semantic: string }) => s.semantic !== 'FAIL-CLOSED')).toBe(true); // injected code inert
    expect(r.provenance.gate.full).toBe(false);
    expect(r.provenance.gate.reasons.some((x: string) => /caller-supplied confirmedDenialCodes/.test(x))).toBe(true);
    expect(r.overall).not.toBe('FULL');
  });

  it('the fake emits the pinned SDK completion shape and the orchestrator normalizes error.code (#615 blocker 1)', async () => {
    // (a) the shared builder is the pinned PUBLIC shape: a boolean `success`, and on failure a
    //     structured `error` with a machine-readable `code` + human `message` — never the old invented
    //     `{ outcome, errorCategory }`.
    const ok = sdkCompletionEventData({ toolCallId: 't1', toolName: 'shell', success: true });
    expect(ok).toEqual({ toolCallId: 't1', toolName: 'shell', success: true });
    expect('error' in ok).toBe(false);
    const bad = sdkCompletionEventData({ toolCallId: 't1', toolName: 'shell', success: false, code: PERMISSION_DENIED_CODE });
    expect(bad.success).toBe(false);
    expect(bad.error.code).toBe(PERMISSION_DENIED_CODE);
    expect(typeof bad.error.message).toBe('string');
    expect('outcome' in bad || 'errorCategory' in bad).toBe(false);

    // (b) the fake actually EMITS that shape (anti-drift): a rejected permission → success:false with
    //     the permission-gate error.code, and no legacy fields.
    const repo = makeScenarioRepo({ prefix: 'tw-sdk-shape-' });
    try {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const binding = createFakeBinding({});
      const session = await binding.createSession({
        workspace: repo.root,
        onPermissionRequest: async () => ({ kind: 'reject', feedback: 'no' }),
        onAgentStop: async () => undefined,
        onEvent: (e: { type: string; data: Record<string, unknown> }) => events.push(e),
      });
      await session.sendAndWait('delete the file src/keep.spec.ts using a shell command');
      const completion = events.find((e) => e.type === 'tool.execution_complete' && e.data.success === false);
      expect(completion).toBeTruthy();
      const err = completion!.data.error as { code?: string } | undefined;
      expect(err?.code).toBe(PERMISSION_DENIED_CODE);
      expect('outcome' in completion!.data || 'errorCategory' in completion!.data).toBe(false);
    } finally {
      cleanupRepo(repo, false);
    }

    // (c) end-to-end: the orchestrator reads `error.code` off that real shape into the sanitized
    //     completion evidence category — proving normalization, not just the fake.
    const r = await runPreDenyScenario({ binding: createFakeBinding({}), adapter, config: CFG(), mechanism: 'shell' });
    const compRow = r.evidenceRows.find((e: { stage?: string }) => e.stage === 'completion');
    expect(compRow?.completion_error_category).toBe(PERMISSION_DENIED_CODE);
  });

  it('decisionCategory maps adapter results to sanitized structured categories (never reason text)', () => {
    expect(decisionCategory({ decision: { verdict: 'allow' } })).toBe('allow');
    expect(decisionCategory({ outcome: 'unsupported', decision: { verdict: 'allow' } })).toBe('unsupported');
    expect(decisionCategory({ outcome: 'parse-failure' })).toBe('parse-failure');
    expect(decisionCategory({ decision: { verdict: 'deny', findings: [{ rule: 'test-deletion' }] } })).toBe('policy-block');
    expect(decisionCategory({ decision: { verdict: 'deny', findings: [{ rule: 'tamperward-unavailable' }] } })).toBe('fail-closed-unavailable');
    // The host's OWN knowledge that it injected an adversarial identity distinguishes an identity
    // rejection from a baseline/reconstruction fail-closed that also surfaces as tamperward-unavailable.
    expect(decisionCategory({ decision: { verdict: 'deny', findings: [{ rule: 'tamperward-unavailable' }] } }, { adversarialIdentity: true })).toBe('identity-rejected');
  });

  it('the fake models real ordering: the protected execution-start precedes its decision (host_seq)', async () => {
    const s = await runPreDenyScenario({ binding: createFakeBinding({}), adapter, config: CFG(), mechanism: 'shell' });
    const firstStart = s.evidenceRows.find((e: { stage?: string }) => e.stage === 'execution-start');
    const firstDecision = s.evidenceRows.find((e: { stage?: string }) => e.stage === 'decision');
    expect(firstStart).toBeTruthy();
    expect(firstDecision).toBeTruthy();
    expect(firstStart.host_seq).toBeLessThan(firstDecision.host_seq); // start BEFORE the permission decision
  });

  it('an ordinary in-repo read is ALLOWED, not denied (item F): decision category is "allow"', () => {
    const repo = makeScenarioRepo({ prefix: 'tw-sdk-read-' });
    try {
      const json = serializeRequest({ kind: 'read', toolName: 'view', toolCallId: 'r1', fileName: 'src/keep.spec.ts' }, { cwd: repo.root, sessionId: 'sess-read' });
      const res = adapter.decide(json, 'pre-action', repo.root) as { decision?: { verdict?: string } };
      expect(res.decision?.verdict).toBe('allow');
      expect(decisionCategory(res)).toBe('allow');
    } finally {
      cleanupRepo(repo, false);
    }
  });

  it('a reject the runtime IGNORES (mutation lands) is FAIL-OPEN with a mutation basis', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({ ignoreDeny: true }), adapter, config: CFG(), mechanism: 'shell' });
    expect(r.semantic).toBe('FAIL-OPEN');
    expect(r.evidence.dispatchBasis).toBe('protected-mutation');
  });

  it('with NO confirmed authority (no codes, no signatures), a broken decision path is INCONCLUSIVE, not FAIL-CLOSED (#615/#616)', async () => {
    // Same broken-callback scenario as the FAIL-CLOSED test above, but with NO confirmed authority at
    // all — neither codes nor permission-path signatures: the withheld tool's completion signature is
    // not established, so non-dispatch cannot be proven and the path stays INCONCLUSIVE. Mutation would
    // still be authoritative FAIL-OPEN (see above).
    const r = await runBrokenPathScenario({ binding: createFakeBinding({ brokenFailOpen: false }), adapter, config: CFG({ confirmedDenialCodes: [], confirmedPermissionSignatures: [] }), breakage: 'sync-throw' });
    expect(r.evidence.finalStateMutated).toBe(false);
    expect(r.evidence.handlerDispatched).toBeUndefined();
    expect(r.semantic).toBe('INCONCLUSIVE');
  });

  it('with NO confirmed authority (no codes, no signatures), a pre-deny is INCOMPLETE with no non-dispatch proof (#615/#616)', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({}), adapter, config: CFG({ confirmedDenialCodes: [], confirmedPermissionSignatures: [] }), mechanism: 'shell' });
    expect(r.evidence.finalStateMutated).toBe(false);
    expect(r.evidence.handlerDispatched).toBeUndefined();
    expect(r.evidence.dispatchBasis).toBe('insufficient-post-decision-evidence');
    expect(r.semantic).toBe('INCOMPLETE');
  });
});
