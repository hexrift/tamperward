// Layer (b): SELF-TEST for the GitHub Copilot SDK-hosted qualification spike (#611, Phase 0).
// Proves the spike's PURE classifiers cannot false-green: each Phase-0 proof and failure mode is
// asserted against every deterministic input, the granular capability vocabulary the review
// fixed is locked in, and the provenance gate rejects an unpinned / `auto`-model run. This layer
// runs in CI; the real SDK spike (layer c, `npm run spike:copilot-sdk`) needs a pinned
// @github/copilot-sdk + credentials and does NOT run in CI.
//
// The decisive #611 unknown — whether a rejected / thrown / timed-out permission handler actually
// blocks tool dispatch — can only be MEASURED on a pinned SDK. These classifiers encode how that
// evidence is judged; they never assert the runtime behaves.

import { describe, it, expect } from 'vitest';
// @ts-expect-error - the spike is a plain .mjs harness module, no d.ts
import {
  classifyPreDispatchDeny,
  classifyDecisionPathFailure,
  classifyEndOfTurn,
  classifyIdentityBinding,
  buildSpikeMatrix,
  provenanceGate,
  evidenceEntry,
  EVIDENCE_SCHEMA_VERSION,
} from '../harness/adapters/copilot-sdk-spike.mjs';

describe('classifyPreDispatchDeny — the 7-point Phase-0 #1/#2 proof (host-observed)', () => {
  const full = {
    proposalReceived: true,
    tamperwardEvaluated: true,
    denyReturned: true,
    handlerDispatched: false,
    finalStateMutated: false,
    reasonReached: true,
    agentContinued: true,
  };

  it('all seven points → PROVEN', () => {
    const r = classifyPreDispatchDeny(full);
    expect(r.pass).toBe(true);
    expect(r.semantic).toBe('PROVEN');
  });

  it('a DISPATCHED handler (or a mutated final state) is FAIL-OPEN, never a pass — the decisive failure', () => {
    expect(classifyPreDispatchDeny({ ...full, handlerDispatched: true }).semantic).toBe('FAIL-OPEN');
    expect(classifyPreDispatchDeny({ ...full, handlerDispatched: true }).pass).toBe(false);
    expect(classifyPreDispatchDeny({ ...full, finalStateMutated: true }).semantic).toBe('FAIL-OPEN');
  });

  it('any missing point (proposal / evaluation / deny / reason / continuation) fails, not-proven', () => {
    for (const k of ['proposalReceived', 'tamperwardEvaluated', 'denyReturned', 'reasonReached', 'agentContinued']) {
      const r = classifyPreDispatchDeny({ ...full, [k]: false });
      expect(r.pass).toBe(false);
      expect(r.semantic).not.toBe('FAIL-OPEN'); // missing evidence is INCOMPLETE, not a fail-open
    }
  });
});

describe('classifyDecisionPathFailure — Phase-0 #3, a broken decision path must fail CLOSED', () => {
  it('the tool NOT dispatching while the break was exercised → FAIL-CLOSED, eligible', () => {
    const r = classifyDecisionPathFailure({ brokenPathExercised: true, handlerDispatched: false, finalStateMutated: false });
    expect(r.semantic).toBe('FAIL-CLOSED');
    expect(r.eligible).toBe(true);
  });

  it('a dispatched handler (or mutated state) on a broken path → FAIL-OPEN, INELIGIBLE', () => {
    expect(classifyDecisionPathFailure({ brokenPathExercised: true, handlerDispatched: true, finalStateMutated: false }).eligible).toBe(false);
    expect(classifyDecisionPathFailure({ brokenPathExercised: true, handlerDispatched: true, finalStateMutated: false }).semantic).toBe('FAIL-OPEN');
    expect(classifyDecisionPathFailure({ brokenPathExercised: true, handlerDispatched: false, finalStateMutated: true }).semantic).toBe('FAIL-OPEN');
  });

  it('a break that was never exercised is INCONCLUSIVE, never a pass', () => {
    const r = classifyDecisionPathFailure({ brokenPathExercised: false, handlerDispatched: false, finalStateMutated: false });
    expect(r.semantic).toBe('INCONCLUSIVE');
    expect(r.eligible).toBe(false);
  });
});

describe('classifyEndOfTurn — Phase-0 #4, block + observed continuation', () => {
  const full = { endOfTurnFired: true, sweepDetected: true, blockReturned: true, continuationObserved: true };
  it('fires → sweep detects → block → continuation observed → pass', () => {
    expect(classifyEndOfTurn(full).pass).toBe(true);
  });
  it('a missing continuation (agent just exited) is not a pass', () => {
    expect(classifyEndOfTurn({ ...full, continuationObserved: false }).pass).toBe(false);
    expect(classifyEndOfTurn({ ...full, sweepDetected: false }).pass).toBe(false);
  });
});

describe('classifyIdentityBinding — adversarial cwd claims fail closed', () => {
  it('cross-repo / symlink / malformed claims must be denied and not dispatch', () => {
    for (const claimKind of ['cross-repo', 'symlink', 'malformed']) {
      expect(classifyIdentityBinding({ claimKind, denied: true, handlerDispatched: false }).pass).toBe(true);
      expect(classifyIdentityBinding({ claimKind, denied: false, handlerDispatched: false }).pass).toBe(false);
      expect(classifyIdentityBinding({ claimKind, denied: true, handlerDispatched: true }).pass).toBe(false);
    }
  });
});

describe('buildSpikeMatrix — granular, honest vocabulary (#611 review)', () => {
  // The review fixed this vocabulary: shell is a CANDIDATE, file-edit CONTENT pre-deny is
  // UNSUPPORTED, file-edit PATH interception is AVAILABLE/LIMITED (never a generic pre-deny),
  // end-of-turn content is a CANDIDATE. FULL is structurally unreachable while content pre-deny
  // is unsupported — the honest ceiling is PARTIAL.
  it('emits the granular rows and never promotes file-edit as a generic pre-deny', () => {
    const m = buildSpikeMatrix({});
    const rows = Object.fromEntries(m.rows.map((r) => [r.label, r.value]));
    expect(rows['pre-deny:shell']).toBe('CANDIDATE');
    expect(rows['pre-deny:file-edit-content']).toBe('UNSUPPORTED');
    expect(rows['pre-deny:file-edit-path']).toMatch(/AVAILABLE|LIMITED|INCONCLUSIVE/);
    expect(rows['end-of-turn:file-edit-content']).toBe('CANDIDATE');
    expect(rows['pre-deny:file-edit']).toBeUndefined(); // never a generic file-edit pre-deny row
  });

  it('a single observed FAIL-OPEN (shell or decision-path) makes overall INELIGIBLE', () => {
    const m = buildSpikeMatrix({ shell: { semantic: 'FAIL-OPEN' }, provenanceFull: true });
    expect(m.overall).toBe('INELIGIBLE');
    const m2 = buildSpikeMatrix({ decisionPath: { semantic: 'FAIL-OPEN', eligible: false }, provenanceFull: true });
    expect(m2.overall).toBe('INELIGIBLE');
  });

  it('without a pinned provenance the overall is INSUFFICIENT, never FULL/PARTIAL', () => {
    const m = buildSpikeMatrix({ shell: { semantic: 'PROVEN', pass: true }, endOfTurn: { pass: true }, decisionPath: { semantic: 'FAIL-CLOSED', eligible: true }, provenanceFull: false });
    expect(m.overall).toBe('INSUFFICIENT');
  });

  it('even fully proven candidates + pinned provenance cap at PARTIAL — FULL is unreachable while content pre-deny is unsupported', () => {
    const m = buildSpikeMatrix({
      shell: { semantic: 'PROVEN', pass: true },
      endOfTurn: { pass: true },
      decisionPath: { semantic: 'FAIL-CLOSED', eligible: true },
      fileEdit: { interceptionObserved: true },
      provenanceFull: true,
    });
    expect(m.overall).toBe('PARTIAL');
    expect(['FULL']).not.toContain(m.overall);
  });
});

describe('provenanceGate — a pinned, exact-model run is required', () => {
  const complete = {
    sdk_version: '@github/copilot-sdk@1.2.3',
    model: 'gpt-5',
    tamperward_version: 'tamperward@2.31.0',
    host_config_sha256: 'abc',
    network_mode: 'live',
    approval_mode: 'onPermissionRequest',
    evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
  };

  it('all pins present, exact model → full', () => {
    expect(provenanceGate(complete).full).toBe(true);
  });

  it('an `auto` (or missing) model caps below full', () => {
    expect(provenanceGate({ ...complete, model: 'auto' }).full).toBe(false);
    expect(provenanceGate({ ...complete, model: '' }).full).toBe(false);
  });

  it('a missing pin caps below full', () => {
    for (const k of ['sdk_version', 'tamperward_version', 'host_config_sha256', 'evidence_schema_version']) {
      expect(provenanceGate({ ...complete, [k]: undefined }).full).toBe(false);
    }
  });
});

describe('evidenceEntry — the host-owned evidence schema (#611)', () => {
  it('carries the append-only proposal→callback→deny→dispatch chain and the schema version', () => {
    const e = evidenceEntry({
      session_id: 's',
      turn_id: 't',
      proposal_id: 'p',
      operation_kind: 'shell',
      tamperward_decision: 'deny',
      handler_dispatched: false,
    });
    expect(e.schema_version).toBe(EVIDENCE_SCHEMA_VERSION);
    // the fields that establish attempted → callback received → deny → no dispatch are present
    for (const k of ['session_id', 'turn_id', 'proposal_id', 'operation_kind', 'tamperward_decision', 'handler_dispatched', 'recorded_at']) {
      expect(k in e).toBe(true);
    }
  });
});
