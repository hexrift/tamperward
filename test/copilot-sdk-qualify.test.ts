// #611 (layer c): the real-runtime Phase-0 QUALIFICATION orchestrator, exercised end-to-end WITHOUT
// live Copilot credentials by injecting a deterministic fake binding (the SDK/session seam) alongside
// the REAL neutral adapter + canonical engine + disposable git fixtures. The fake scripts the runtime
// semantics we cannot otherwise reach (fail-open, timeout, continuation), so the orchestrator's
// decisive classifications run against real observations, and CI proves it cannot false-green.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { copilotSdkAdapter } from '../src/adapters/copilot-sdk/adapter';
// @ts-expect-error - the orchestrator is a plain .mjs harness module, no d.ts
import { buildConfig, runQualification, runPreDenyScenario, runBrokenPathScenario, runEndOfTurnScenario, assembleResult, serializeRequest, promptHash, classifyHandlerDispatch, decisionCategory, normalizeCompletionEvent, semanticEvaluation, shellRequestMutatesProtected, containedTargetExists } from '../harness/adapters/copilot-sdk/orchestrator.mjs';
// @ts-expect-error - the reconstruction diagnostics are a plain .mjs harness module, no d.ts
import { reconstructionDiagnostic } from '../harness/adapters/copilot-sdk/reconstruction-diagnostics.mjs';
// @ts-expect-error - the fixtures are a plain .mjs harness module, no d.ts
import { makeScenarioRepo, cleanupRepo, makeEscapingSymlink, sdkCompletionEventData, PERMISSION_DENIED_CODE, USER_NOT_AVAILABLE_CODE, CANDIDATE_PERMISSION_GATE_CODES, CONFIRMED_PERMISSION_GATE_CODES, isDeniedPermissionKind } from '../harness/adapters/copilot-sdk/fixtures.mjs';
// @ts-expect-error - capture signatures are a plain .mjs harness module, no d.ts
import { CONFIRMED_PERMISSION_GATE_SIGNATURES } from '../harness/adapters/copilot-sdk/capture-signatures.mjs';
// @ts-expect-error - the spike is a plain .mjs harness module, no d.ts
import { provenanceGate, sha16, resolvedPackageIntegrity, packageIntegrityHash, finalizeQualification, renderResult, canonicalSdkVersionPin } from '../harness/adapters/copilot-sdk-spike.mjs';
// @ts-expect-error - the fake binding is a plain .mjs test-support module, no d.ts
import { createFakeBinding } from './support/fake-copilot-binding.mjs';

const adapter = copilotSdkAdapter as unknown as { decide: (raw: string, phase: string, cwd?: string) => { outcome: string; wire?: string; decision?: { verdict: string; reason?: string } } };
// These TEST signatures feed the DIAGNOSTIC completion-hash classifier only (#618): the primary
// enforcement verdict now comes from the DOCUMENTED permission lifecycle (permission.completed), so
// these no longer decide any scenario's semantic. They are injected so the diagnostic classifier still
// has an authority to record against; the shipped diagnostic set (CONFIRMED_PERMISSION_GATE_SIGNATURES)
// is what a real run uses, and it is never the enforcement authority.
const TEST_PERMISSION_SIGNATURES = [
  { path: 'returned-reject', code: PERMISSION_DENIED_CODE, messageHash: sha16(`tool failed: ${PERMISSION_DENIED_CODE}`) },
  { path: 'callback-failure', code: USER_NOT_AVAILABLE_CODE, messageHash: sha16(`tool failed: ${USER_NOT_AVAILABLE_CODE}`) },
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
    expect(r.evidence.rejectReturned).toBe(true);
    expect(r.evidence.handlerDispatched).toBe(false); // non-dispatch, proven by the DOCUMENTED permission.completed (denied-*)
    expect(r.evidence.dispatchBasis).toBe('permission-denied-resolution');
    expect(isDeniedPermissionKind(r.evidence.permissionResolutionKind)).toBe(true); // a pinned denied-* kind (scripted scaffolding), not a message hash
    expect(r.evidence.finalStateMutated).toBe(false);
    // Reason/feedback delivery is a diagnostic, never a gate (#618 Work C): the SDK exposes no event
    // proving the model read the feedback, so it is recorded false, never manufactured true.
    expect(r.evidence.feedbackProvided).toBe(true);
    expect(r.evidence.feedbackDeliveryIndependentlyObservable).toBe(false);
    expect(r.evidence.reasonReached).toBeUndefined();
    expect(r.reasonDeliveryProven).toBe(false);
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

  it('no DOCUMENTED permission resolution for the protected op → INCOMPLETE (never inferred from absence)', async () => {
    // The protected op is requested but its permission.completed (and tool completion) are suppressed —
    // the documented resolution never arrives. Non-dispatch cannot be asserted from absence → INCOMPLETE.
    const r = await runPreDenyScenario({ binding: createFakeBinding({ suppressProtectedCompletion: true }), adapter, config: CFG(), mechanism: 'shell' });
    expect(r.semantic).toBe('INCOMPLETE');
    expect(r.evidence.handlerDispatched).toBeUndefined();
    expect(r.evidence.dispatchBasis).toBe('no-permission-resolution');
    expect(r.evidence.finalStateMutated).toBe(false);
  });

  it('whole event channel suppressed (no permission or tool events), protected denied → INCOMPLETE, never FAIL-OPEN from a start event', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({ suppressExecEvents: true }), adapter, config: CFG(), mechanism: 'shell' });
    // The sentinel effect still landed, but with no documented resolution and no protected mutation the
    // result is INCOMPLETE, and never FAIL-OPEN from a mere (absent) start event.
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

describe('#621 — content-aware pre-deny requires SEMANTIC enforcement, not a returned reject', () => {
  // The live #621 contradiction: a Copilot SDK write that FAILS TamperWard content reconstruction was
  // reported `pre-deny:file-edit-content = PROVEN` because the classifier read `tamperwardEvaluated`
  // from `run.proposals.length > 0` and `denyReturned` from the bare presence of a deny. A
  // fail-closed-UNAVAILABLE deny (reconstruction / policy-load / parse failure) is the SDK reject the
  // PERMISSION layer honours, but it is NOT content-aware enforcement, so it must land INCOMPLETE.

  it('(B) a write whose reconstruction fails closed is INCOMPLETE for content-aware pre-deny, never PROVEN', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({ unreconstructableWrite: true }), adapter, config: CFG(), mechanism: 'write' });
    expect(r.semantic).not.toBe('PROVEN');
    expect(r.semantic).toBe('INCOMPLETE');
    expect(r.evidence.observedKind).toBe('write');
    expect(r.evidence.mechanismConfirmed).toBe(true);
    // The exact live-run facts that used to false-green PROVEN:
    expect(r.evidence.rejectReturned).toBe(true); // TamperWard returned a {kind:"reject"} …
    expect(r.evidence.denyReturned).toBe(false); // … but NOT a content-aware/semantic deny
    expect(r.evidence.decisionCategory).toBe('fail-closed-unavailable');
    expect(r.evidence.unavailableReason).toBe('reconstruction');
    expect(r.evidence.blockingFindingRule).toBe('tamperward-unavailable');
    expect(r.evidence.semanticEvaluationCompleted).toBe(false);
    expect(r.evidence.reconstructionCompleted).toBe(false);
    expect(r.evidence.semanticContentEnforcementProven).toBe(false);
    // PERMISSION enforcement (non-dispatch) IS separately establishable — a fail-closed-unavailable
    // deny still proves the SDK honoured the reject and the tool did not run (#621 Work A).
    expect(r.evidence.handlerDispatched).toBe(false);
    expect(r.evidence.finalStateMutated).toBe(false);
    expect(r.permissionEnforcementProven).toBe(true);
  });

  it('(A) a real reconstructed weakening write (reconstruction + evaluate + real detector block) → content-aware PROVEN', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({}), adapter, config: CFG(), mechanism: 'write' });
    expect(r.semantic).toBe('PROVEN');
    expect(r.evidence.semanticEvaluationCompleted).toBe(true);
    expect(r.evidence.reconstructionCompleted).toBe(true);
    expect(r.evidence.semanticContentEnforcementProven).toBe(true);
    expect(r.evidence.denyReturned).toBe(true);
    expect(r.evidence.decisionCategory).toBe('policy-block');
    expect(r.evidence.blockingFindingRule).not.toBe('tamperward-unavailable');
    expect(typeof r.evidence.blockingFindingRule).toBe('string');
  });

  it('(C) a write surfacing no usable content (no diff, no newFileContents) → UNSUPPORTED, never PROVEN', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({ noContentWrite: true }), adapter, config: CFG(), mechanism: 'write' });
    expect(r.semantic).toBe('UNSUPPORTED');
    expect(r.evidence.decisionCategory).toBe('unsupported');
    expect(r.evidence.semanticContentEnforcementProven).toBe(false);
    expect(r.evidence.semanticEvaluationCompleted).toBe(false);
  });

  it('Work E: a reconstruction fail-closed emits a BOUNDED, sanitized structural diagnostic — no diff text or file source', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({ unreconstructableWrite: true }), adapter, config: CFG(), mechanism: 'write' });
    const diag = r.evidence.reconstructionDiagnostic;
    expect(diag).toBeTruthy();
    expect(diag.stage).toBe('reconstruction');
    expect(diag.fileTargetPresent).toBe(true);
    expect(diag.diffPresent).toBe(true);
    expect(typeof diag.diffByteCount).toBe('number');
    expect(diag.diffByteCount).toBeGreaterThan(0);
    expect(typeof diag.diffLineCount).toBe('number');
    expect(diag.newFileContentsPresent).toBe(false);
    expect(diag.newFileContentsByteCount).toBe(0);
    // The distinguishing shape category: the diff's headers name a different file than the target.
    expect(diag.diffShape.category).toBe('path-header-mismatch');
    expect(diag.diffShape.headerMatchesTarget).toBe(false);
    expect(diag.diffShape.hunkHeaderCount).toBeGreaterThan(0);
    expect(diag.failureCategory).toBe('diff:path-header-mismatch');
    // CONTENT-FREE: neither the candidate diff text nor the file source leaks into a public artifact.
    const serialized = JSON.stringify(diag);
    for (const secret of ['keeps one', 'keeps two', 'expect(', 'it(']) expect(serialized).not.toContain(secret);
    // The same holds for the immutable decision evidence row that persists into the artifact.
    const decisionRow = r.evidenceRows.find((e: { stage?: string; reconstruction_diagnostic?: unknown }) => e.stage === 'decision' && e.reconstruction_diagnostic);
    expect(decisionRow).toBeTruthy();
    for (const secret of ['keeps one', 'keeps two', 'expect(']) expect(JSON.stringify(decisionRow)).not.toContain(secret);
  });

  it('a landed protected write after a preliminary read is FAIL-OPEN — never downgraded to UNSUPPORTED (#621 review pt 6)', async () => {
    // The live hosted flow reads before it writes; `benignProtectedEdit` makes TamperWard ALLOW the
    // protected write (no deny), which then LANDS. The protected proposal must be identified by target
    // correlation (not "which denied", which would fall back to the preliminary read), and FAIL-OPEN
    // must dominate any mechanism/UNSUPPORTED reclassification.
    const r = await runPreDenyScenario({ binding: createFakeBinding({ benignFirst: true, benignProtectedEdit: true }), adapter, config: CFG(), mechanism: 'write' });
    expect(r.evidence.finalStateMutated).toBe(true);
    expect(r.semantic).toBe('FAIL-OPEN');
    expect(r.evidence.observedKind).toBe('write'); // the protected write, not the preliminary read
    expect(r.evidence.mechanismConfirmed).toBe(true);
  });

  it('permissionEnforcementProven requires TamperWard’s own reject + a denied resolution (#621 review pt 3)', async () => {
    // Case B (reconstruction fail-closed) IS a TamperWard reject honoured as non-dispatch → true.
    const b = await runPreDenyScenario({ binding: createFakeBinding({ unreconstructableWrite: true }), adapter, config: CFG(), mechanism: 'write' });
    expect(b.permissionEnforcementProven).toBe(true);
    expect(b.evidence.rejectReturned).toBe(true);
    expect(b.evidence.dispatchBasis).toBe('permission-denied-resolution');
    // A landed write (no honoured non-dispatch) is never permission-enforcement-proven.
    const open = await runPreDenyScenario({ binding: createFakeBinding({ benignProtectedEdit: true }), adapter, config: CFG(), mechanism: 'write' });
    expect(open.permissionEnforcementProven).toBe(false);
  });

  it('shell: a non-mutating inspection (cat) of the protected path before the rm is not the protected proposal (#621 re-review pt 4)', async () => {
    // With inspectFirst, both `cat src/keep.spec.ts` (read) and `rm src/keep.spec.ts` (mutation) name the
    // protected path. The protected proposal must be the MUTATING `rm` (correctly denied + not dispatched),
    // not the `cat` whose successful completion would otherwise read as dispatch / FAIL-OPEN.
    const r = await runPreDenyScenario({ binding: createFakeBinding({ inspectFirst: true }), adapter, config: CFG(), mechanism: 'shell' });
    expect(r.evidence.observedTool).toBe('shell'); // the rm, whose toolName is 'shell'
    expect(r.evidence.mechanismConfirmed).toBe(true);
    expect(r.evidence.finalStateMutated).toBe(false); // the rm was denied and not dispatched
    expect(r.evidence.handlerDispatched).toBe(false);
    expect(r.semantic).toBe('PROVEN');
  });
});

describe('runBrokenPathScenario — a broken decision path must fail CLOSED', () => {
  for (const breakage of ['sync-throw', 'reject', 'adapter-throw'] as const) {
    it(`${breakage}: the pinned SDK sends user-not-available internally, but with NO runtime-observable denied broadcast the LIVE verdict is INCONCLUSIVE (never fail-closed from a source-level fact) — safety: protected unchanged`, async () => {
      // session.ts catches the handler exception and sends {kind:"user-not-available"} on its INTERNAL
      // RPC path (a documented deny DECISION), but the real hosted binding cannot observe that RPC result
      // and no cited source establishes a subsequent permission.completed broadcast kind — so the
      // qualification verdict is INCONCLUSIVE, never manufactured FAIL-CLOSED. The safety invariant still
      // holds: the protected mutation did NOT land.
      const r = await runBrokenPathScenario({ binding: createFakeBinding({ brokenFailOpen: false }), adapter, config: CFG(), breakage });
      expect(r.semantic).toBe('INCONCLUSIVE');
      expect(r.eligible).toBe(false);
      expect(r.evidence.protectedReached).toBe(true);
      expect(r.evidence.handlerDispatched).toBeUndefined(); // no runtime-observable non-dispatch signal
      expect(r.evidence.finalState.protectedMutated).toBe(false); // safety: the weakening did not land
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
    // #618 Work F — two SEPARATE questions: (1) did TamperWard decide DENY? (its decision row / identity
    // rejection) and (2) did the DOCUMENTED SDK permission mechanism receive and resolve that deny?
    // (permission.completed.result.kind ∈ denied-*, protected state intact). Both hold here → FAIL-CLOSED,
    // and the decision is grounded in the documented lifecycle + filesystem state, NOT a bare error code
    // or message hash or a tool.execution_start.
    it(`${breakage}: TamperWard denies the identity claim AND the documented permission resolution is denied-* → FAIL-CLOSED`, async () => {
      const r = await runBrokenPathScenario({ binding: createFakeBinding({}), adapter, config: CFG(), breakage });
      // (1) TamperWard's own decision was a deny, categorised as identity-rejected.
      const denyRow = r.evidenceRows.find((e: { stage?: string; tamperward_decision?: string }) => e.stage === 'decision' && e.tamperward_decision === 'deny');
      expect(denyRow?.decision_category).toBe('identity-rejected');
      // (2) The documented SDK resolution received/resolved that deny.
      expect(r.evidence.permissionResolutionKind?.startsWith('denied')).toBe(true);
      expect(r.evidence.finalState.protectedMutated).toBe(false);
      expect(r.evidence.dispatchBasis).toBe('permission-denied-resolution');
      expect(r.semantic).toBe('FAIL-CLOSED');
      expect(r.identity?.pass).toBe(true);
    });

    // Identity DENY must never be established from absence: with the documented resolution suppressed,
    // the claim is still denied by TamperWard but non-dispatch is INCONCLUSIVE (no documented signal).
    it(`${breakage}: with the documented resolution suppressed, TamperWard still denies but non-dispatch is INCONCLUSIVE`, async () => {
      const r = await runBrokenPathScenario({ binding: createFakeBinding({ suppressProtectedCompletion: true }), adapter, config: CFG(), breakage });
      const denyRow = r.evidenceRows.find((e: { stage?: string; tamperward_decision?: string }) => e.stage === 'decision' && e.tamperward_decision === 'deny');
      expect(denyRow?.decision_category).toBe('identity-rejected'); // TamperWard decided DENY
      expect(r.evidence.handlerDispatched).toBeUndefined(); // but the SDK resolution is unobservable → INCONCLUSIVE
      expect(r.semantic).toBe('INCONCLUSIVE');
    });
  }

  it('the break is BOUND to the protected proposal — a benign read arriving first does not stand in for it', async () => {
    const r = await runBrokenPathScenario({ binding: createFakeBinding({ benignFirst: true }), adapter, config: CFG(), breakage: 'sync-throw' });
    expect(r.evidence.protectedReached).toBe(true); // the protected op was reached and broken, not the read
    expect(r.evidence.finalState.protectedMutated).toBe(false); // safety: the weakening did not land
  });

  it('the break binds to the MUTATION, not a non-mutating inspection of the same path (cat first)', async () => {
    const r = await runBrokenPathScenario({ binding: createFakeBinding({ inspectFirst: true }), adapter, config: CFG(), breakage: 'sync-throw' });
    // `cat <protected>` is not the protected mutation, so the break does not fire on it; the real
    // `rm` is still reached and broken.
    expect(r.evidence.protectedReached).toBe(true);
    expect(r.evidence.finalState.protectedMutated).toBe(false); // safety: the weakening did not land
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

  // #618 review — a fake-only callback must never become required qualification authority. This wraps
  // the fake in a binding whose createSession accepts ONLY the option surface the real binding
  // (createRealBinding) forwards to the SDK — { workspace, model, availableTools, onPermissionRequest,
  // onAgentStop, onEvent } — dropping anything else (e.g. a fake-only onPermissionResult). Driven through
  // that real-shaped surface, a thrown handler stays INCONCLUSIVE (no runtime-observable non-dispatch),
  // while an identity break is FAIL-CLOSED purely from the observable permission.completed broadcast.
  const realShaped = (opts: Record<string, unknown> = {}) => {
    const inner = createFakeBinding(opts);
    return {
      ...inner,
      async createSession(cfg: Record<string, unknown>) {
        const { workspace, model, availableTools, onPermissionRequest, onAgentStop, onEvent } = cfg;
        return inner.createSession({ workspace, model, availableTools, onPermissionRequest, onAgentStop, onEvent });
      },
    };
  };

  it('driven through the REAL binding option surface (no onPermissionResult), a thrown handler is INCONCLUSIVE', async () => {
    const r = await runBrokenPathScenario({ binding: realShaped(), adapter, config: CFG(), breakage: 'sync-throw' });
    expect(r.evidence.protectedReached).toBe(true);
    expect(r.evidence.handlerDispatched).toBeUndefined();
    expect(r.semantic).toBe('INCONCLUSIVE');
    expect(r.evidence.finalState.protectedMutated).toBe(false); // safety still holds
  });

  it('driven through the REAL binding option surface, an identity break is FAIL-CLOSED from the OBSERVABLE denied broadcast', async () => {
    const r = await runBrokenPathScenario({ binding: realShaped(), adapter, config: CFG(), breakage: 'cross-repo' });
    expect(r.evidence.dispatchBasis).toBe('permission-denied-resolution'); // observable via onEvent, a real option
    expect(r.semantic).toBe('FAIL-CLOSED');
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
    // The fail-closed row is qualified to OBSERVABLE paths and is FAIL-CLOSED (observable breaks all
    // closed; the timeout is exercised) — it does NOT carry the timeout's INCONCLUSIVE (#618 review).
    const observableRow = r.capability_matrix.find((row: { label: string }) => row.label === 'decision-path:fail-closed (observable paths)');
    expect(observableRow?.value).toBe('FAIL-CLOSED');
    // The intrinsically-unobservable timeout is its OWN separate, non-gating diagnostic row, INCONCLUSIVE.
    const timeoutRow = r.capability_matrix.find((row: { label: string }) => row.label === 'decision-path:timeout (non-gating diagnostic)');
    expect(String(timeoutRow?.value)).toMatch(/INCONCLUSIVE/);
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

  it('an unexpected TOOL completion shape is diagnostic-only; the documented permission resolution still governs (#618)', async () => {
    // The runtime emits a pre-1.0.14 / unexpected tool.execution_complete (no `success`). That is
    // DIAGNOSTIC only — it is retained as schema_variant 'legacy/unexpected' and never drives the
    // verdict. The DOCUMENTED permission.completed (denied-*) still proves non-dispatch → PROVEN.
    const r = await runPreDenyScenario({ binding: createFakeBinding({ legacyCompletionShape: true }), adapter, config: CFG(), mechanism: 'shell' });
    expect(r.evidence.finalStateMutated).toBe(false);
    expect(r.evidence.handlerDispatched).toBe(false);
    expect(r.evidence.dispatchBasis).toBe('permission-denied-resolution');
    expect(r.semantic).toBe('PROVEN');
    const compRow = r.evidenceRows.find((e: { stage?: string }) => e.stage === 'completion');
    expect(compRow?.completion_schema_variant).toBe('legacy/unexpected'); // retained diagnostically
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

  it('deny → duplicate IDENTICAL denied completion stays usable non-dispatch (documented resolution governs) (#614 §H)', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({ extraProtectedCompletion: 'duplicate' }), adapter, config: CFG(), mechanism: 'shell' });
    expect(r.evidence.handlerDispatched).toBe(false);
    expect(r.evidence.dispatchBasis).toBe('permission-denied-resolution');
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
    expect(r.provenance.measured.confirmed_denial_codes).toEqual([]); // active diagnostic authority is the committed (empty) set
    expect(r.provenance.measured.confirmed_denial_codes_source).toBe('committed:CONFIRMED_PERMISSION_GATE_CODES');
    const broken = r.scenarios.filter((s: { id: string; evidence?: { dispatchBasis?: string } }) => s.id.startsWith('broken-path:'));
    expect(broken.length).toBeGreaterThan(0);
    // The injected code is INERT to the verdict: it is a diagnostic input only. The broken callback
    // paths that fail closed do so via the DOCUMENTED permission resolution, never via any injected code.
    const closed = broken.filter((s: { semantic: string }) => s.semantic === 'FAIL-CLOSED');
    expect(closed.length).toBeGreaterThan(0);
    // The verdicts rest on the DOCUMENTED lifecycle — the runtime denied-* broadcast (identity breaks)
    // or the SDK deny decision user-not-available (callback breaks) — never a message-hash code path.
    expect(closed.every((s: { evidence?: { dispatchBasis?: string } }) => s.evidence?.dispatchBasis === 'permission-denied-resolution')).toBe(true);
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

  it('#621 semanticEvaluation distinguishes a REAL content block from a fail-closed-unavailable deny (shell and write alike)', () => {
    // A real detector block from a completed reconstruction + evaluate — content enforcement PROVEN.
    const block = semanticEvaluation({ outcome: 'ok', decision: { verdict: 'deny', findings: [{ rule: 'test-deletion' }] } });
    expect(block.reconstructionCompleted).toBe(true);
    expect(block.evaluateCompleted).toBe(true);
    expect(block.realDetectorFinding).toBe(true);
    expect(block.contentEnforcementProven).toBe(true);
    expect(block.failClosedUnavailable).toBe(false);

    // A fail-closed-UNAVAILABLE deny (reconstruction/policy-load/parse) — the engine never judged content.
    for (const stage of ['reconstruction', 'policy-load', 'baseline', 'repo-context'] as const) {
      const fc = semanticEvaluation({ outcome: 'ok', unavailableReason: stage, decision: { verdict: 'deny', findings: [{ rule: 'tamperward-unavailable' }] } });
      expect(fc.failClosedUnavailable).toBe(true);
      expect(fc.reconstructionCompleted).toBe(false);
      expect(fc.evaluateCompleted).toBe(false);
      expect(fc.contentEnforcementProven).toBe(false);
      expect(fc.category).toBe('fail-closed-unavailable');
    }

    // An EVALUATE-stage failure means reconstruction DID complete (the adapter runs reconstruction then
    // evaluate) — only the semantic evaluation is incomplete (#621 review point 4).
    const evalFail = semanticEvaluation({ outcome: 'ok', unavailableReason: 'evaluate', decision: { verdict: 'deny', findings: [{ rule: 'tamperward-unavailable' }] } });
    expect(evalFail.reconstructionCompleted).toBe(true);
    expect(evalFail.evaluateCompleted).toBe(false);
    expect(evalFail.contentEnforcementProven).toBe(false);

    // An IDENTITY rejection happens BEFORE reconstruction/evaluate run, so neither completed (#621
    // re-review point 3) — even though outcome is 'ok' with a sentinel deny.
    const idReject = semanticEvaluation({ outcome: 'ok', unavailableReason: 'identity-rejected', decision: { verdict: 'deny', findings: [{ rule: 'tamperward-unavailable' }] } });
    expect(idReject.reconstructionCompleted).toBe(false);
    expect(idReject.evaluateCompleted).toBe(false);
    expect(idReject.contentEnforcementProven).toBe(false);

    // An allow (evaluated, no finding), an unsupported (no usable content), and a parse-failure are all
    // NOT content enforcement.
    expect(semanticEvaluation({ outcome: 'ok', decision: { verdict: 'allow', findings: [] } }).contentEnforcementProven).toBe(false);
    expect(semanticEvaluation({ outcome: 'ok', decision: { verdict: 'allow', findings: [] } }).evaluateCompleted).toBe(true);
    const unsup = semanticEvaluation({ outcome: 'unsupported' });
    expect(unsup.reconstructionCompleted).toBe(false);
    expect(unsup.contentEnforcementProven).toBe(false);
    expect(unsup.category).toBe('unsupported');
    expect(semanticEvaluation({ outcome: 'parse-failure', unavailableReason: 'parse-failure', decision: { verdict: 'deny', findings: [{ rule: 'tamperward-unavailable' }] } }).contentEnforcementProven).toBe(false);
  });

  it('#621 Work E reconstructionDiagnostic models the parser grammar, is bounded, sanitized, content-free', () => {
    const secret = "it('keeps two', () => { expect(2).toBe(2); });";
    const target = 'src/keep.spec.ts';

    // A hunk-only body with no ---/+++ headers.
    const hunkOnly = reconstructionDiagnostic({ path: target, diff: `@@ -1,2 +1,1 @@\n ok\n-${secret}` }, 'reconstruction');
    expect(hunkOnly.diffShape.category).toBe('headerless-hunk-only');
    expect(hunkOnly.failureCategory).toBe('diff:headerless-hunk-only');
    expect(hunkOnly.diffUsable).toBe(true);
    expect(hunkOnly.newFileContentsPresent).toBe(false);
    expect(JSON.stringify(hunkOnly)).not.toContain('keeps two');

    // A header whose path does not match the declared target → path-header-mismatch.
    const mismatch = reconstructionDiagnostic({ path: target, diff: '--- a/other/file.ts\n+++ b/other/file.ts\n@@ -1 +1 @@\n-a\n+b' }, 'reconstruction');
    expect(mismatch.diffShape.category).toBe('path-header-mismatch');
    expect(mismatch.diffShape.headerMatchesTarget).toBe(false);

    // Two DIFFERENT endpoint paths before the (single) hunk → multiple-file-diff.
    const multi = reconstructionDiagnostic({ path: target, diff: '--- a/x\n+++ b/y\n@@ -1 +1 @@\n-a\n+b' }, 'reconstruction');
    expect(multi.diffShape.category).toBe('multiple-file-diff');

    // PARSER FIDELITY: `---`/`+++` INSIDE a hunk body must NOT be read as headers (the parser only reads
    // identity before the first `@@ ` hunk). A create diff whose added lines happen to start with `+++`
    // is still a well-formed single-file create shape, not a phantom multi-file / mismatch.
    const hunkBodyMarkers = reconstructionDiagnostic(
      { path: target, diff: `--- a/${target}\n+++ b/${target}\n@@ -1,1 +1,2 @@\n a\n+++ this is content, not a header` },
      'reconstruction',
    );
    expect(hunkBodyMarkers.diffShape.oldFileHeaderCount).toBe(1);
    expect(hunkBodyMarkers.diffShape.newFileHeaderCount).toBe(1);
    expect(hunkBodyMarkers.diffShape.category).toBe('full-unified-diff');

    // PARSER FIDELITY: `new file mode` / `deleted file mode` are SUPPORTED metadata (accepted with a
    // create/delete endpoint pair), never `unsupported-metadata`.
    const createMode = reconstructionDiagnostic(
      { path: target, diff: `diff --git a/${target} b/${target}\nnew file mode 100644\n--- /dev/null\n+++ b/${target}\n@@ -0,0 +1,1 @@\n+x` },
      'reconstruction',
    );
    expect(createMode.diffShape.createModeMetadata).toBe(true);
    expect(createMode.diffShape.unsupportedMetadata).toBe(false);
    expect(createMode.diffShape.category).not.toBe('unsupported-metadata');
    expect(createMode.diffShape.impliedOperation).toBe('create');

    // Rename metadata → unsupported-metadata.
    const rename = reconstructionDiagnostic({ path: target, diff: `diff --git a/${target} b/renamed.ts\nrename from ${target}\nrename to renamed.ts\n@@ -1 +1 @@\n-a\n+b` }, 'reconstruction');
    expect(rename.diffShape.category).toBe('unsupported-metadata');

    // Duplicate endpoints → duplicate-endpoint (the parser rejects duplicates; not full-unified-diff).
    const dup = reconstructionDiagnostic({ path: target, diff: `--- a/${target}\n--- a/${target}\n+++ b/${target}\n@@ -1 +1 @@\n-a\n+b` }, 'reconstruction');
    expect(dup.diffShape.category).toBe('duplicate-endpoint');

    // PRESENCE semantics match sdkFileEditChanges: empty newFileContents is PRESENT; whitespace-only diff
    // is UNUSABLE.
    const emptyContents = reconstructionDiagnostic({ path: target, newFileContents: '' }, 'reconstruction');
    expect(emptyContents.newFileContentsPresent).toBe(true);
    expect(emptyContents.failureCategory).toBe('new-file-contents-only');
    const wsDiff = reconstructionDiagnostic({ path: target, diff: '   \n  ' }, 'reconstruction');
    expect(wsDiff.diffUsable).toBe(false);
    expect(wsDiff.failureCategory).toBe('no-usable-content');

    // No content at all.
    const none = reconstructionDiagnostic({ path: target }, 'reconstruction');
    expect(none.failureCategory).toBe('no-usable-content');
    expect(none.diffUsable).toBe(false);

    // BOUNDED + SANITIZED: byte counts are recorded, the content never appears, and the raw target path
    // is NOT persisted — only a hash + shape flags.
    const contentsOnly = reconstructionDiagnostic({ path: '/abs/secret/path/keep.spec.ts', newFileContents: secret }, 'reconstruction');
    expect(contentsOnly.newFileContentsPresent).toBe(true);
    expect(contentsOnly.newFileContentsByteCount).toBe(Buffer.byteLength(secret, 'utf8'));
    expect(contentsOnly.failureCategory).toBe('new-file-contents-only');
    expect(contentsOnly.target.present).toBe(true);
    expect(contentsOnly.target.absolute).toBe(true);
    expect(typeof contentsOnly.target.hash).toBe('string');
    const s = JSON.stringify(contentsOnly);
    expect(s).not.toContain('keeps two');
    expect(s).not.toContain('/abs/secret/path'); // raw path never persisted

    // PARSER FIDELITY: the pre-hunk grammar is TOTAL — an unrecognized non-blank header line makes the
    // parser fail closed BEFORE git apply, so it must not read as full-unified-diff (#621 re-review pt 2).
    const unrecognized = reconstructionDiagnostic(
      { path: target, diff: `--- a/${target}\n+++ b/${target}\nunexpected header\n@@ -1 +1 @@\n-a\n+b` },
      'reconstruction',
    );
    expect(unrecognized.diffShape.unrecognizedHeader).toBe(true);
    expect(unrecognized.diffShape.category).toBe('unrecognized-header');

    // PARSER FIDELITY: DUPLICATE create/delete-mode metadata is rejected (not laundered).
    const dupMode = reconstructionDiagnostic(
      { path: target, diff: `diff --git a/${target} b/${target}\nnew file mode 100644\nnew file mode 100644\n--- /dev/null\n+++ b/${target}\n@@ -0,0 +1 @@\n+x` },
      'reconstruction',
    );
    expect(dupMode.diffShape.createModeMetadataCount).toBe(2);
    expect(dupMode.diffShape.duplicateModeMetadata).toBe(true);
    expect(dupMode.diffShape.category).toBe('duplicate-metadata');

    // TARGET NORMALIZATION: an ABSOLUTE in-repo fileName, normalized (targetRel) to the same repo-relative
    // path the headers use, must NOT read as a path-header-mismatch (#621 re-review pt 2).
    const absMatch = reconstructionDiagnostic(
      { path: `/repo/${target}`, targetRel: target, diff: `--- a/${target}\n+++ b/${target}\n@@ -1 +1 @@\n-a\n+b` },
      'reconstruction',
    );
    expect(absMatch.diffShape.headerMatchesTarget).toBe(true);
    expect(absMatch.diffShape.category).toBe('full-unified-diff');

    // BOUNDED BY CONSTRUCTION: neither a huge non-whitespace diff, a huge WHITESPACE-only diff (the
    // `trim()` worst case), nor a huge target string produces an unbounded read — counts are flagged
    // lower bounds and usability comes from a bounded scan (#621 re-review pt 1).
    const huge = reconstructionDiagnostic({ path: target, diff: 'x'.repeat(5_000_000) }, 'reconstruction');
    expect(huge.diffByteCountTruncated).toBe(true);
    expect(huge.diffByteCount).toBeLessThan(5_000_000);
    const hugeWs = reconstructionDiagnostic({ path: target, diff: ' '.repeat(5_000_000) }, 'reconstruction');
    // All-whitespace WITHIN the scanned prefix but truncated past it → usability is unknown, not a
    // definite no-usable-content (the parser trims the full string).
    expect(hugeWs.diffUsableKnown).toBe(false);
    expect(hugeWs.diffShape.category).toBe('unknown-truncated');
    const hugeTarget = reconstructionDiagnostic({ path: 'a'.repeat(5_000_000), newFileContents: 'x' }, 'reconstruction');
    expect(hugeTarget.target.hashTruncated).toBe(true);
    expect(hugeTarget.target.byteCountTruncated).toBe(true);

    // TRUNCATION HONESTY (#621 re-review pt 1): whitespace fills the scan prefix and a real diff follows
    // within the parser's byte budget → the diagnostic must NOT assert `no-usable-content`; it reports
    // an explicit unknown-truncated state.
    const wsThenDiff = reconstructionDiagnostic(
      { path: target, diff: ' '.repeat(262_144) + `\n--- a/other.ts\n+++ b/other.ts\n@@ -1 +1 @@\n-a\n+b` },
      'reconstruction',
    );
    expect(wsThenDiff.diffShape.category).toBe('unknown-truncated');
    expect(wsThenDiff.failureCategory).toBe('diff:unknown-truncated');
    expect(wsThenDiff.diffUsableKnown).toBe(false);
    // A capped scan that never reaches the first hunk is unknown-truncated, not a definite no-hunk.
    // A >5 MB diff exceeds the parser byte budget (384 KiB) — a definite pre-parse rejection.
    const hugeHeaderNoHunk = reconstructionDiagnostic({ path: target, diff: `--- a/${target}\n` + 'x'.repeat(5_000_000) }, 'reconstruction');
    expect(hugeHeaderNoHunk.diffShape.category).toBe('over-byte-budget');

    // OPERATION-CONSISTENCY (#621 re-review pt 2): `new file mode` / `deleted file mode` with endpoints
    // that imply a different op is a parser reject BEFORE git apply — not full-unified-diff.
    const createModeModify = reconstructionDiagnostic(
      { path: target, diff: `--- a/${target}\n+++ b/${target}\nnew file mode 100644\n@@ -1 +1 @@\n-a\n+b` },
      'reconstruction',
    );
    expect(createModeModify.diffShape.metadataOperationMismatch).toBe(true);
    expect(createModeModify.diffShape.category).toBe('metadata-operation-mismatch');
    const deleteModeModify = reconstructionDiagnostic(
      { path: target, diff: `--- a/${target}\n+++ b/${target}\ndeleted file mode 100644\n@@ -1 +1 @@\n-a\n+b` },
      'reconstruction',
    );
    expect(deleteModeModify.diffShape.category).toBe('metadata-operation-mismatch');
    // A create-mode WITH create endpoints is consistent → not a mismatch.
    const createModeCreate = reconstructionDiagnostic(
      { path: target, diff: `new file mode 100644\n--- /dev/null\n+++ b/${target}\n@@ -0,0 +1 @@\n+x` },
      'reconstruction',
    );
    expect(createModeCreate.diffShape.metadataOperationMismatch).toBe(false);
    expect(createModeCreate.diffShape.category).not.toBe('metadata-operation-mismatch');

    // METADATA WITHOUT ENDPOINTS (#621 re-review 4 pt 2): operation-bearing metadata + a hunk but no
    // ---/+++ pair is a parser reject BEFORE git apply, not headerless-hunk-only.
    const indexNoEndpoints = reconstructionDiagnostic({ path: target, diff: `index 1111111..2222222 100644\n@@ -1 +1 @@\n-a\n+b` }, 'reconstruction');
    expect(indexNoEndpoints.diffShape.metadataWithoutEndpoints).toBe(true);
    expect(indexNoEndpoints.diffShape.category).toBe('metadata-without-endpoints');
    const gitDiffNoEndpoints = reconstructionDiagnostic({ path: target, diff: `diff --git a/${target} b/${target}\n@@ -1 +1 @@\n-a\n+b` }, 'reconstruction');
    expect(gitDiffNoEndpoints.diffShape.category).toBe('metadata-without-endpoints');
    // A genuinely headerless hunk (no semantic metadata) stays headerless-hunk-only.
    expect(reconstructionDiagnostic({ path: target, diff: `@@ -1 +1 @@\n-a\n+b` }, 'reconstruction').diffShape.category).toBe('headerless-hunk-only');

    // OPERATION vs DISK STATE (#621 re-review 4 pt 2): a create against an EXISTING target, or a
    // modify/delete against an ABSENT target, is rejected before git apply — categorized only when the
    // host supplies the bounded targetExists fact.
    const createExisting = reconstructionDiagnostic(
      { path: target, targetExists: true, diff: `--- /dev/null\n+++ b/${target}\n@@ -0,0 +1 @@\n+x` },
      'reconstruction',
    );
    expect(createExisting.diffShape.operationStateMismatch).toBe(true);
    expect(createExisting.diffShape.category).toBe('operation-state-mismatch');
    const modifyAbsent = reconstructionDiagnostic(
      { path: target, targetExists: false, diff: `--- a/${target}\n+++ b/${target}\n@@ -1 +1 @@\n-a\n+b` },
      'reconstruction',
    );
    expect(modifyAbsent.diffShape.category).toBe('operation-state-mismatch');
    // A consistent modify against an existing target is not a state mismatch.
    const modifyExisting = reconstructionDiagnostic(
      { path: target, targetExists: true, diff: `--- a/${target}\n+++ b/${target}\n@@ -1 +1 @@\n-a\n+b` },
      'reconstruction',
    );
    expect(modifyExisting.diffShape.operationStateMismatch).toBe(false);
    // Without a targetExists fact, no operation-state claim is made.
    const modifyUnknownState = reconstructionDiagnostic({ path: target, diff: `--- a/${target}\n+++ b/${target}\n@@ -1 +1 @@\n-a\n+b` }, 'reconstruction');
    expect(modifyUnknownState.diffShape.operationStateMismatch).toBe(false);

    // /dev/null ON BOTH SIDES (#621 re-review 5 pt 3): a parser reject, not full-unified-diff.
    const devNullBoth = reconstructionDiagnostic({ path: target, diff: `--- /dev/null\n+++ /dev/null\n@@ -0,0 +0,0 @@\n+x` }, 'reconstruction');
    expect(devNullBoth.diffShape.category).toBe('dev-null-both-sides');

    // PARSER BUDGET rejections (#621 re-review 6 pt 2): a structurally-valid diff over the byte or line
    // budget is rejected BEFORE grammar/git — not `full-unified-diff`.
    const overLine = reconstructionDiagnostic(
      { path: target, targetExists: true, diff: `--- a/${target}\n+++ b/${target}\n@@ -1,4100 +1,4100 @@\n` + ' a\n'.repeat(4100) },
      'reconstruction',
    );
    expect(overLine.diffShape.overLineBudget).toBe(true);
    expect(overLine.diffShape.category).toBe('over-line-budget');
    const overByte = reconstructionDiagnostic(
      { path: target, targetExists: true, diff: `--- a/${target}\n+++ b/${target}\n@@ -1 +1 @@\n-a\n+` + 'x'.repeat(400 * 1024) },
      'reconstruction',
    );
    expect(overByte.diffShape.overByteBudget).toBe(true);
    expect(overByte.diffShape.category).toBe('over-byte-budget');
  });

  it('#621 re-review 5 pt 2 — containedTargetExists never probes outside the trusted repository root', () => {
    const repo = makeScenarioRepo({ prefix: 'tw-sdk-contain-' }) as { root: string; protectedRel: string };
    try {
      // In-root existing file → true; in-root absent → false (a create).
      expect(containedTargetExists(repo.protectedRel, repo.root, repo.root)).toBe(true);
      expect(containedTargetExists('src/does-not-exist.ts', repo.root, repo.root)).toBe(false);
      // OUT-OF-ROOT (absolute, or a `../` escape) → undefined, and no external path is stat'd.
      expect(containedTargetExists('/etc/hosts', repo.root, repo.root)).toBeUndefined();
      expect(containedTargetExists('../../../../etc/passwd', repo.root, repo.root)).toBeUndefined();
      // A directory (not a regular file) → undefined, never reported as an existing file.
      expect(containedTargetExists('src', repo.root, repo.root)).toBeUndefined();
      // No fileName → undefined.
      expect(containedTargetExists(undefined, repo.root, repo.root)).toBeUndefined();
      // An IN-REPO SYMLINK whose real target escapes the root → undefined, and never followed/probed
      // (the walk classifies the symlink with lstat and stops) (#621 re-review 6 pt 3).
      const { linkPath } = makeEscapingSymlink(repo.root) as { linkPath: string };
      const linkRel = relative(repo.root, linkPath);
      expect(containedTargetExists(linkRel, repo.root, repo.root)).toBeUndefined();
      expect(containedTargetExists(join(linkRel, 'secret.txt'), repo.root, repo.root)).toBeUndefined();
      // An OVERSIZE regular file (parser fails on read, not op-state) → undefined. Exercised with an
      // injected tiny cap so the case is deterministic without a 64 MiB file.
      writeFileSync(join(repo.root, 'big.bin'), 'x'.repeat(4096));
      expect(containedTargetExists('big.bin', repo.root, repo.root, { readCap: 10 })).toBeUndefined();
      expect(containedTargetExists('big.bin', repo.root, repo.root)).toBe(true); // within the default cap → a normal existing file
    } finally {
      cleanupRepo(repo, false);
    }
  });

  it('#621 re-review — shellRequestMutatesProtected returns an explicit strength/basis, never collapsing ambiguity', () => {
    const protectedRel = 'src/keep.spec.ts';
    const isProtected = (p: unknown) => p === protectedRel;
    const seg = (fullCommandText: string) => ({ identifier: fullCommandText.split(/\s+/)[0], fullCommandText });
    const withSegs = (fullCommandText: string, cmds: { identifier: string; readOnly: boolean }[], extra: Record<string, unknown> = {}) => ({
      kind: 'shell',
      fullCommandText,
      commands: cmds,
      commandSegments: fullCommandText.split(/\s*;\s*/).map(seg),
      possiblePaths: [...fullCommandText.matchAll(/([\w./-]+\.\w+)/g)].map((m) => m[1]),
      ...extra,
    });
    // STRUCTURED per-segment: rm of the protected path → confident mutation.
    let r = shellRequestMutatesProtected(withSegs(`rm ${protectedRel}`, [{ identifier: 'rm', readOnly: false }]), isProtected, protectedRel);
    expect(r.value).toBe(true);
    expect(r.basis).toBe('structured-segment');
    // cat of the protected path → not a mutation.
    expect(shellRequestMutatesProtected(withSegs(`cat ${protectedRel}`, [{ identifier: 'cat', readOnly: true }]), isProtected, protectedRel).value).toBe(false);
    // COMPOUND with segments: mutate another file, read protected → not a protected mutation.
    expect(
      shellRequestMutatesProtected(withSegs(`rm other.txt ; cat ${protectedRel}`, [{ identifier: 'rm', readOnly: false }, { identifier: 'cat', readOnly: true }]), isProtected, protectedRel).value,
    ).toBe(false);
    // A write-file redirection into the protected path (per-segment) → mutation.
    expect(
      shellRequestMutatesProtected(withSegs(`echo x > ${protectedRel}`, [{ identifier: 'echo', readOnly: true }], { hasWriteFileRedirection: true }), isProtected, protectedRel).value,
    ).toBe(true);

    // commandSegments ABSENT (optional in v1.0.14):
    // - COMPOUND (mutate other, read protected), no segments → INSUFFICIENT (undefined), NOT collapsed to true.
    const compoundNoSegs = { kind: 'shell', fullCommandText: `rm other.txt ; cat ${protectedRel}`, commands: [{ identifier: 'rm', readOnly: false }, { identifier: 'cat', readOnly: true }], possiblePaths: ['other.txt', protectedRel], hasWriteFileRedirection: false };
    r = shellRequestMutatesProtected(compoundNoSegs, isProtected, protectedRel);
    expect(r.value).toBeUndefined();
    expect(r.basis).toBe('insufficient');
    // - single `rm protected`, no segments, protected is the ONLY possible path → provable, unambiguous.
    const singleNoSegs = { kind: 'shell', fullCommandText: `rm ${protectedRel}`, commands: [{ identifier: 'rm', readOnly: false }], possiblePaths: [protectedRel], hasWriteFileRedirection: false };
    r = shellRequestMutatesProtected(singleNoSegs, isProtected, protectedRel);
    expect(r.value).toBe(true);
    expect(r.basis).toBe('unambiguous-single-command');

    // NO structured fields at all → heuristic fallback (WEAK basis, must not support a PROVEN shell).
    r = shellRequestMutatesProtected({ kind: 'shell', fullCommandText: `rm ${protectedRel}` }, isProtected, protectedRel);
    expect(r.value).toBe(true);
    expect(r.basis).toBe('heuristic');

    // #621 re-review 5 pt 1 — a side effect that MENTIONS/reads the protected path but mutates ANOTHER
    // file is not a proven protected mutation:
    // - cp/mv protected other → protected is the SOURCE; role not encoded → ambiguous, not strong.
    expect(shellRequestMutatesProtected(withSegs(`cp ${protectedRel} other.txt`, [{ identifier: 'cp', readOnly: false }]), isProtected, protectedRel).value).not.toBe(true);
    expect(shellRequestMutatesProtected(withSegs(`mv ${protectedRel} other.txt`, [{ identifier: 'mv', readOnly: false }]), isProtected, protectedRel).value).not.toBe(true);
    // - echo protected > other → protected is read; the redirect target is `other`.
    expect(shellRequestMutatesProtected(withSegs(`echo ${protectedRel} > other.txt`, [{ identifier: 'echo', readOnly: true }], { hasWriteFileRedirection: true }), isProtected, protectedRel).value).not.toBe(true);
    // - rm protected.bak → a DIFFERENT path; a prefix of the protected spelling must not bind.
    expect(shellRequestMutatesProtected(withSegs(`rm ${protectedRel}.bak`, [{ identifier: 'rm', readOnly: false }]), isProtected, protectedRel).value).toBe(false);
    // A redirect whose TARGET is the protected path IS a mutation of it.
    expect(shellRequestMutatesProtected(withSegs(`echo x > ${protectedRel}`, [{ identifier: 'echo', readOnly: true }], { hasWriteFileRedirection: true }), isProtected, protectedRel).value).toBe(true);

    // #621 re-review 6 pt 1 — a NON-read-only command whose ONLY possiblePath is the protected file but
    // whose side effect is elsewhere (network/process) must NOT strong-bind: `readOnly:false` +
    // `possiblePaths:[protected]` does not prove the file is the WRITE target. rm/unlink/... prove it; a
    // generic uploader does not.
    const upload = shellRequestMutatesProtected(withSegs(`curl --upload-file ${protectedRel} https://example.invalid/u`, [{ identifier: 'curl', readOnly: false }]), isProtected, protectedRel);
    expect(upload.value).not.toBe(true);
    expect(upload.basis).toBe('insufficient');
    // The known positional-target destroyer (rm) DOES bind.
    expect(shellRequestMutatesProtected(withSegs(`rm ${protectedRel}`, [{ identifier: 'rm', readOnly: false }]), isProtected, protectedRel).basis).toBe('structured-segment');
  });

  it('the fake models the PREVIOUSLY OBSERVED hosted ordering (execution-start before its decision) — a regression guard, not an SDK-contract claim', async () => {
    // This ordering came from the earlier hosted capture and is retained only to guard against the old
    // false-dispatch interpretation (treating a pre-decision execution-start as dispatch). It is NOT part
    // of the public v1.0.14 contract, so the contract/conformance layer must not elevate it to SDK semantics.
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

  it('#618 — confirmed codes/signatures are irrelevant: an OBSERVED denied-* broadcast is what FAIL-CLOSES an (identity) broken path, with no codes', async () => {
    // Under the superseded model non-dispatch required a confirmed completion CODE/signature. It no
    // longer does: with NO codes and NO signatures, an identity break is FAIL-CLOSED purely from the
    // runtime-observable permission.completed denied-* broadcast (reject → denied-interactively-by-user).
    const r = await runBrokenPathScenario({ binding: createFakeBinding({}), adapter, config: CFG({ confirmedDenialCodes: [], confirmedPermissionSignatures: [] }), breakage: 'cross-repo' });
    expect(r.evidence.finalState.protectedMutated).toBe(false);
    expect(r.evidence.handlerDispatched).toBe(false);
    expect(r.evidence.dispatchBasis).toBe('permission-denied-resolution');
    expect(isDeniedPermissionKind(r.evidence.permissionResolutionKind)).toBe(true);
    expect(r.semantic).toBe('FAIL-CLOSED');
  });

  it('#618 — a thrown-handler broken path is INCONCLUSIVE with no codes (no runtime-observable denied broadcast); safety holds', async () => {
    // The pinned SDK sends user-not-available internally, but that is not runtime-observable and no cited
    // source establishes a broadcast kind — so the verdict is INCONCLUSIVE, never manufactured fail-closed.
    const r = await runBrokenPathScenario({ binding: createFakeBinding({ brokenFailOpen: false }), adapter, config: CFG({ confirmedDenialCodes: [], confirmedPermissionSignatures: [] }), breakage: 'sync-throw' });
    expect(r.evidence.finalState.protectedMutated).toBe(false); // safety: the weakening did not land
    expect(r.evidence.handlerDispatched).toBeUndefined();
    expect(r.semantic).toBe('INCONCLUSIVE');
  });

  it('#618 — a pre-deny is PROVEN from the documented resolution even with no confirmed codes/signatures', async () => {
    const r = await runPreDenyScenario({ binding: createFakeBinding({}), adapter, config: CFG({ confirmedDenialCodes: [], confirmedPermissionSignatures: [] }), mechanism: 'shell' });
    expect(r.evidence.finalStateMutated).toBe(false);
    expect(r.evidence.handlerDispatched).toBe(false);
    expect(r.evidence.dispatchBasis).toBe('permission-denied-resolution');
    expect(r.semantic).toBe('PROVEN');
  });
});
