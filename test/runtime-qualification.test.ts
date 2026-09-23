// #599 — the version-bound, operation-specific runtime capability model.
//
// These tests pin the HONESTY of the derivation: PROVEN comes ONLY from a retained real-runtime
// probe matching the full binding — a static adapter/contract declaration alone can never earn
// PROVEN (it grades PARTIAL at most). A fail-open is surfaced and can never aggregate to FULL, a
// binding mismatch strips PROVEN back to the declaration's PARTIAL, no percentage appears, the
// JSON matches the published schema, and a changed load-bearing input marks a stored
// qualification STALE.

import { describe, it, expect, afterAll } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';

import {
  assessCapabilities,
  aggregateInLoop,
  capabilityHash,
  evidenceId,
  qualificationStaleness,
  CAPABILITY_STATES,
  RUNTIME_CAPABILITY_IDS,
  EVIDENCE_SOURCES,
  IN_LOOP_AGGREGATES,
  FINAL_AUTHORITY,
  type QualificationBinding,
  type CapabilityAssessment,
  type RuntimeCapabilityId,
} from '../src/runtime-qualification';
import { RuntimeCapabilities, OPERATION_KINDS } from '../src/adapters/contract';
import { claudeAdapter } from '../src/adapters/claude/adapter';
import { codexAdapter } from '../src/adapters/codex/adapter';
import { copilotAdapter } from '../src/adapters/copilot/adapter';
import { copilotSdkAdapter } from '../src/adapters/copilot-sdk/adapter';
import { RETAINED_EVIDENCE, matchRetainedEvidence, evidenceBindingMatches, type EvidenceMatchKey, type RetainedRuntimeEvidence } from '../src/adapters/evidence';
import { TW_VERSION } from '../src/wiring';

const ROOT = resolve(__dirname, '..');
const stateOf = (a: CapabilityAssessment[], id: RuntimeCapabilityId) => a.find((x) => x.id === id)!.state;

describe('capability derivation is honest (#599)', () => {
  it('assesses every listed capability, exactly once, with a legal state', () => {
    const a = assessCapabilities(claudeAdapter.capabilities);
    expect(a.map((x) => x.id)).toEqual([...RUNTIME_CAPABILITY_IDS]);
    for (const cap of a) {
      expect(CAPABILITY_STATES).toContain(cap.state);
      expect(EVIDENCE_SOURCES).toContain(cap.evidence.source);
      expect(cap.evidence.detail.length).toBeGreaterThan(0);
    }
  });

  it('a full static preDeny declaration alone is PARTIAL, never PROVEN (the review fix)', () => {
    // Guard the premise: Claude Code really declares every operation kind in preDeny...
    expect(claudeAdapter.capabilities.preDeny).toEqual(OPERATION_KINDS);
    // ...and there is NO retained real-runtime probe for it, so nothing may be PROVEN.
    expect(matchRetainedEvidence({
      runtime_id: 'claude-code', runtime_version: '9.9.9', component_versions: [],
      tamperward_version: '2.37.0+deadbeef', adapter_capability_hash: 'abc', tested_capabilities: [],
      model: null, platform: `${process.platform}-${process.arch}`, execution_mode: 'headless', hook_config_hash: null,
    })).toBeNull();
    const a = assessCapabilities(claudeAdapter.capabilities);
    // The maintainer's exact objection: static preDeny membership must NOT become PROVEN.
    for (const id of ['pre-deny:shell', 'pre-deny:native-edit', 'pre-deny:mcp', 'pre-deny:git-mutation', 'pre-deny:delete', 'pre-deny:rename'] as const) {
      expect(stateOf(a, id), id).toBe('PARTIAL');
      expect(a.find((x) => x.id === id)!.evidence.source).toBe('adapter-declaration');
    }
    // The declared stop event is likewise only PARTIAL absent a probe that proves the sweep lands.
    expect(stateOf(a, 'end-of-turn')).toBe('PARTIAL');
    // Nothing at all is PROVEN from a static declaration.
    expect(a.some((x) => x.state === 'PROVEN')).toBe(false);
  });

  it('PROVEN appears ONLY with retained real-runtime evidence matching the full binding', () => {
    const record = RETAINED_EVIDENCE.find((r) => r.binding.runtime_id === 'github-copilot-sdk-hosted')!;
    // With the matching retained evidence, the observed capabilities are PROVEN / INCONCLUSIVE...
    const proven = assessCapabilities(copilotSdkAdapter.capabilities, record);
    expect(stateOf(proven, 'pre-deny:shell')).toBe('PROVEN');
    expect(proven.find((x) => x.id === 'pre-deny:shell')!.evidence.source).toBe('committed-evidence');
    expect(stateOf(proven, 'hook-not-invoked')).toBe('PROVEN');
    expect(stateOf(proven, 'transport:timeout')).toBe('INCONCLUSIVE'); // a probed-but-unresolved path is never PROVEN
    // ...while the SAME adapter WITHOUT the evidence stays PARTIAL/UNPROVEN (never PROVEN).
    const noEvidence = assessCapabilities(copilotSdkAdapter.capabilities);
    expect(stateOf(noEvidence, 'pre-deny:shell')).toBe('UNPROVEN'); // sdk declares empty preDeny
    expect(noEvidence.some((x) => x.state === 'PROVEN')).toBe(false);
  });

  it('the applicability match compares EVERY evidence-defining field; any one differing breaks it', () => {
    const record = RETAINED_EVIDENCE.find((r) => r.binding.runtime_id === 'github-copilot-sdk-hosted')!;
    // A synthetic record + a current key that matches on every field — the ONLY way PROVEN is
    // reachable in principle. `adapter_capability_hash` is concrete on both sides (a null recorded
    // hash fails closed and can never match — see the copilot-sdk record, which stores null).
    const synthRecord: RetainedRuntimeEvidence = {
      ...record,
      binding: {
        ...record.binding,
        tamperward_version: '9.9.9+abcdef12',
        adapter_capability_hash: 'cap-hash-xyz',
      },
    };
    const match: EvidenceMatchKey = { ...synthRecord.binding };
    expect(evidenceBindingMatches(synthRecord.binding, match)).toBe(true); // exact binding matches
    // Every single evidence-defining field, flipped in isolation, must break the match — the
    // legacy fields AND the four the review required be added.
    const overrides: Partial<EvidenceMatchKey>[] = [
      // legacy fields
      { runtime_version: 'copilot-runtime@1.0.86' },
      { runtime_version: null },
      { platform: 'linux-x64' },
      { model: 'gpt-6' },
      { execution_mode: 'interactive' },
      { hook_config_hash: 'deadbeef' },
      // newly-required evidence-defining fields
      { tamperward_version: '9.9.10+abcdef12' }, // a TamperWard version bump
      { tamperward_version: '9.9.9+ffffffff' }, // a TamperWard commit change
      { tamperward_version: null },
      { component_versions: ['@github/copilot-sdk@1.0.15', 'copilot-protocol@3'] }, // one component bumped
      { component_versions: ['@github/copilot-sdk@1.0.14'] }, // a component dropped
      { adapter_capability_hash: 'cap-hash-DIFFERENT' }, // adapter capabilities changed
      { adapter_capability_hash: null }, // an unresolved current hash never matches
      { tested_capabilities: [...synthRecord.binding.tested_capabilities, 'end-of-turn'] }, // tested set grew
      { tested_capabilities: ['pre-deny:shell'] }, // tested set shrank
    ];
    for (const over of overrides) {
      expect(evidenceBindingMatches(synthRecord.binding, { ...match, ...over }), JSON.stringify(over)).toBe(false);
    }
    // Order/duplicates never affect the set-compared fields.
    expect(evidenceBindingMatches(synthRecord.binding, {
      ...match,
      component_versions: ['copilot-protocol@3', '@github/copilot-sdk@1.0.14', '@github/copilot-sdk@1.0.14'],
      tested_capabilities: [...synthRecord.binding.tested_capabilities].reverse(),
    })).toBe(true);
  });

  it('reproduces the review concern, then shows the fix closes it (stale evidence cannot promote)', () => {
    const record = RETAINED_EVIDENCE.find((r) => r.binding.runtime_id === 'github-copilot-sdk-hosted')!;
    // A "current" binding that agrees with the retained capture on the OLD six match fields
    // (runtime id/version, model, platform, mode, hook-config hash) but reflects a NEWER world:
    // a bumped TamperWard build, changed SDK/protocol, a different adapter hash, a wider tested set.
    const current: EvidenceMatchKey = {
      runtime_id: record.binding.runtime_id,
      runtime_version: record.binding.runtime_version,
      model: record.binding.model,
      platform: record.binding.platform,
      execution_mode: record.binding.execution_mode,
      hook_config_hash: record.binding.hook_config_hash,
      // the evidence-defining fields the review said were being IGNORED, now moved on:
      tamperward_version: '2.37.0+00000000',
      component_versions: ['@github/copilot-sdk@1.0.20', 'copilot-protocol@4'],
      adapter_capability_hash: 'current-adapter-hash',
      tested_capabilities: [...RUNTIME_CAPABILITY_IDS],
    };
    // BEFORE the fix (legacy six-field logic) this would have MATCHED — reproduce that here:
    const legacyMatch =
      record.binding.runtime_id === current.runtime_id &&
      record.binding.runtime_version === current.runtime_version &&
      record.binding.model === current.model &&
      record.binding.platform === current.platform &&
      record.binding.execution_mode === current.execution_mode &&
      record.binding.hook_config_hash === current.hook_config_hash;
    expect(legacyMatch).toBe(true); // the old lookup WOULD have promoted stale evidence
    // AFTER the fix: the full-binding match rejects it, so nothing is promoted.
    expect(evidenceBindingMatches(record.binding, current)).toBe(false);
    expect(matchRetainedEvidence(current)).toBeNull();
  });

  it('under the CURRENT repo binding (TamperWard 2.37.x) the copilot-sdk record does NOT match', () => {
    // The concrete consequence the review asked us to assert: with the committed catalogue and a
    // like-for-like current binding built the way the CLI builds it, nothing matches — so nothing
    // grades PROVEN in this repo today. The capture is tamperward@2.31.0; this repo is 2.37.x.
    expect(TW_VERSION.startsWith('2.31.0')).toBe(false);
    const record = RETAINED_EVIDENCE.find((r) => r.binding.runtime_id === 'github-copilot-sdk-hosted')!;
    // Build a current key that is otherwise as favourable as possible (same runtime env), differing
    // only where the current repo genuinely differs: TamperWard build, resolved component set,
    // adapter hash, tested surface.
    const current: EvidenceMatchKey = {
      runtime_id: record.binding.runtime_id,
      runtime_version: record.binding.runtime_version,
      model: record.binding.model,
      platform: record.binding.platform,
      execution_mode: record.binding.execution_mode,
      hook_config_hash: record.binding.hook_config_hash,
      tamperward_version: `${TW_VERSION}+00000000`,
      component_versions: [], // no live resolver ships; the current side is the unresolved set
      adapter_capability_hash: capabilityHash(copilotSdkAdapter.capabilities),
      tested_capabilities: [...RUNTIME_CAPABILITY_IDS],
    };
    expect(matchRetainedEvidence(current)).toBeNull();
    // And even if a caller somehow reconstructed the capture's component set and tested surface,
    // the null recorded adapter_capability_hash alone keeps it fail-closed.
    expect(matchRetainedEvidence({
      ...current,
      component_versions: [...record.binding.component_versions],
      tamperward_version: record.binding.tamperward_version,
      tested_capabilities: [...record.binding.tested_capabilities],
    })).toBeNull();
  });

  it('a fully-matching synthetic record still yields PROVEN — the mechanism works when everything matches', () => {
    // Prove reachability-in-principle with a synthetic record whose binding fully matches a
    // synthetic current binding (concrete adapter hash on both sides). This keeps the
    // evidence-gated-PROVEN path meaningful even though the real catalogue proves nothing today.
    const proto = RETAINED_EVIDENCE.find((r) => r.binding.runtime_id === 'github-copilot-sdk-hosted')!;
    const synth: RetainedRuntimeEvidence = {
      ...proto,
      ref: 'synthetic-fully-matching',
      binding: {
        ...proto.binding,
        tamperward_version: '9.9.9+abcdef12',
        adapter_capability_hash: 'cap-hash-xyz',
      },
    };
    const current: EvidenceMatchKey = { ...synth.binding };
    const matched = matchRetainedEvidence(current, [synth]);
    expect(matched).toBe(synth);
    // With the matched record in hand, the observed capabilities grade PROVEN / INCONCLUSIVE.
    const a = assessCapabilities(copilotSdkAdapter.capabilities, matched);
    expect(stateOf(a, 'pre-deny:shell')).toBe('PROVEN');
    expect(stateOf(a, 'hook-not-invoked')).toBe('PROVEN');
    expect(stateOf(a, 'transport:timeout')).toBe('INCONCLUSIVE');
  });

  it('a conservative adapter that declares no preDeny reports UNPROVEN, never PROVEN', () => {
    expect(codexAdapter.capabilities.preDeny).toEqual([]);
    const a = assessCapabilities(codexAdapter.capabilities);
    for (const id of RUNTIME_CAPABILITY_IDS.filter((x) => x.startsWith('pre-deny:'))) {
      expect(stateOf(a, id as RuntimeCapabilityId), id).toBe('UNPROVEN');
    }
  });

  it('a declared fail-open failure mode is surfaced as FAIL-OPEN with the exact evidence', () => {
    const a = assessCapabilities(copilotAdapter.capabilities);
    const timeout = a.find((x) => x.id === 'transport:timeout')!;
    expect(timeout.state).toBe('FAIL-OPEN');
    expect(timeout.evidence.source).toBe('adapter-unsupported');
    // The evidence is preserved verbatim from the adapter's own declaration.
    expect(copilotAdapter.capabilities.unsupported).toContain(timeout.evidence.detail);
    expect(timeout.evidence.detail.toLowerCase()).toContain('fails open');
  });

  it('an adapter that says its fail-closed transport is unproven reports UNPROVEN, not PARTIAL', () => {
    const a = assessCapabilities(codexAdapter.capabilities);
    expect(stateOf(a, 'transport:timeout')).toBe('UNPROVEN');
  });

  it('a lifecycle-only end-of-turn is PARTIAL, and a declared post-observe is PARTIAL not PROVEN', () => {
    const copilot = assessCapabilities(copilotAdapter.capabilities);
    expect(stateOf(copilot, 'end-of-turn')).toBe('PARTIAL'); // agentStop is lifecycle-only
    expect(stateOf(copilot, 'post-observe')).toBe('UNSUPPORTED');

    const codex = assessCapabilities(codexAdapter.capabilities);
    expect(codexAdapter.capabilities.postObserve.length).toBeGreaterThan(0);
    // A declared postObserve is a contract-boundary fact, not a live proof → PARTIAL, never PROVEN.
    expect(stateOf(codex, 'post-observe')).toBe('PARTIAL');

    // Claude has no per-tool post-observe; it says so, so it is UNSUPPORTED not UNPROVEN.
    expect(stateOf(assessCapabilities(claudeAdapter.capabilities), 'post-observe')).toBe('UNSUPPORTED');
  });

  it('no capability id maps to a fabricated PROVEN when the kind is absent and unnamed', () => {
    const bare: RuntimeCapabilities = { preDeny: [], postObserve: [], endOfTurn: false, unsupported: [] };
    const a = assessCapabilities(bare);
    for (const cap of a) expect(cap.state).not.toBe('PROVEN');
  });
});

describe('in-loop aggregation cannot launder a fail-open (#599)', () => {
  it('FULL requires every required capability PROVEN', () => {
    const allProven: RuntimeCapabilities = {
      preDeny: OPERATION_KINDS,
      postObserve: OPERATION_KINDS,
      endOfTurn: true,
      unsupported: [],
    };
    // Even fully declared, transport stays PARTIAL (contract-only), so the honest aggregate is PARTIAL.
    expect(aggregateInLoop(assessCapabilities(allProven))).toBe('PARTIAL');
  });

  it('a FAIL-OPEN in the required set is never rendered as FULL', () => {
    const withFailOpen: RuntimeCapabilities = {
      preDeny: OPERATION_KINDS,
      postObserve: [],
      endOfTurn: true,
      unsupported: ['the preToolUse hook timeout fails open: a timed-out hook lets the tool proceed'],
    };
    const a = assessCapabilities(withFailOpen);
    expect(stateOf(a, 'transport:timeout')).toBe('FAIL-OPEN');
    expect(aggregateInLoop(a)).not.toBe('FULL');
  });

  it('a runtime with no declared or proven steering surface aggregates to NONE', () => {
    // A genuinely bare runtime (no preDeny, no end-of-turn) is protected by the neutral layers only.
    const bare: RuntimeCapabilities = { preDeny: [], postObserve: [], endOfTurn: false, unsupported: [] };
    expect(aggregateInLoop(assessCapabilities(bare))).toBe('NONE');
  });

  it('a declared-but-unproven steering surface aggregates to PARTIAL, not FULL and not NONE', () => {
    // Copilot CLI declares a (lifecycle-only) end-of-turn but no proven pre-deny → PARTIAL,
    // matching the issue's own UX example. Claude declares a full preDeny surface, unproven live
    // → also PARTIAL. Neither is FULL (nothing is PROVEN without evidence), neither is NONE.
    expect(aggregateInLoop(assessCapabilities(copilotAdapter.capabilities))).toBe('PARTIAL');
    expect(aggregateInLoop(assessCapabilities(claudeAdapter.capabilities))).toBe('PARTIAL');
  });

  it('final authority is a constant, independent of the runtime hook', () => {
    expect(FINAL_AUTHORITY).toBe('AVAILABLE');
    expect(IN_LOOP_AGGREGATES).toContain(aggregateInLoop(assessCapabilities(copilotSdkAdapter.capabilities)));
  });
});

describe('version/config binding and staleness (#599)', () => {
  const binding = (over: Partial<QualificationBinding> = {}): QualificationBinding => ({
    runtime: { id: 'claude-code', label: 'Claude Code', version: '1.2.3' },
    tamperward: { version: '2.35.0', commit: 'abc' },
    adapter: { name: 'claude-code', capability_hash: capabilityHash(claudeAdapter.capabilities) },
    hook_config_hash: 'hookhash',
    execution_mode: 'headless',
    platform: 'linux-x64',
    model: null,
    tested_capabilities: [...RUNTIME_CAPABILITY_IDS],
    timestamp: '2026-09-23T00:00:00.000Z',
    evidence_id: 'eid',
    ...over,
  });

  it('an unchanged binding is not stale, but a commit-only change IS stale', () => {
    // A genuinely unchanged binding (only the provenance-only timestamp/evidence_id differ) is
    // not stale.
    expect(qualificationStaleness(binding(), binding({ timestamp: 'later', evidence_id: 'other' })).stale).toBe(false);
    // TamperWard's OWN build commit is load-bearing (blocker at 5799408805): the retained-evidence
    // matcher keys on TamperWard's `version+commit` build tag, so a TamperWard build under a
    // different commit uses a different build identity and rejects evidence taken under the prior
    // build. A stored record from that prior TamperWard build must therefore read STALE. (This
    // commit is TamperWard's own build identity — sourced from package metadata, never a qualified
    // repo's HEAD; see the CLI end-to-end test that a consumer commit alone does NOT flip STALE.)
    const s = qualificationStaleness(binding(), binding({ tamperward: { version: '2.35.0', commit: 'DIFFERENT' } }));
    expect(s.stale).toBe(true);
    expect(s.changed.join('\n')).toContain('tamperward.commit: abc → DIFFERENT');
  });

  it('a changed runtime version marks the qualification STALE and names the change', () => {
    const s = qualificationStaleness(binding({ runtime: { id: 'claude-code', label: 'Claude Code', version: '0.1.0' } }), binding({ runtime: { id: 'claude-code', label: 'Claude Code', version: '0.2.0' } }));
    expect(s.stale).toBe(true);
    expect(s.changed.join('\n')).toContain('runtime.version: 0.1.0 → 0.2.0');
  });

  it('a changed adapter capability hash marks the qualification STALE', () => {
    const s = qualificationStaleness(binding(), binding({ adapter: { name: 'claude-code', capability_hash: 'CHANGED' } }));
    expect(s.stale).toBe(true);
  });

  it('a changed execution mode, platform, hook-config or tested set marks it STALE', () => {
    expect(qualificationStaleness(binding(), binding({ execution_mode: 'interactive' })).stale).toBe(true);
    expect(qualificationStaleness(binding(), binding({ platform: 'darwin-arm64' })).stale).toBe(true);
    expect(qualificationStaleness(binding(), binding({ hook_config_hash: 'other' })).stale).toBe(true);
    expect(qualificationStaleness(binding(), binding({ tested_capabilities: ['pre-deny:shell'] })).stale).toBe(true);
  });

  it('the capability hash changes when the declaration changes, and the evidence id is deterministic', () => {
    const h1 = capabilityHash(claudeAdapter.capabilities);
    const h2 = capabilityHash({ ...claudeAdapter.capabilities, endOfTurn: false });
    expect(h1).not.toBe(h2);
    const a = assessCapabilities(claudeAdapter.capabilities);
    const base = { ...binding() } as Omit<QualificationBinding, 'timestamp' | 'evidence_id'>;
    expect(evidenceId(base, a)).toBe(evidenceId(base, a));
  });
});

// ————————————————————————————————————————————————————————————————————————
// End-to-end through the built CLI: JSON matches the schema, no percentage, staleness works.
// ————————————————————————————————————————————————————————————————————————

const dirs: string[] = [];
function bundleCli(): string {
  const out = mkdtempSync(join(tmpdir(), 'tw-rt-cli-'));
  dirs.push(out);
  const file = join(out, 'cli.mjs');
  buildSync({ entryPoints: [join(ROOT, 'src', 'cli', 'index.ts')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: file });
  // The lazy `yaml`/`picomatch` requires resolve from the CLI's own directory, so point it at
  // the checkout's node_modules (mirrors test/json-schema.test.ts) rather than bundling deps in.
  if (existsSync(join(ROOT, 'node_modules'))) symlinkSync(join(ROOT, 'node_modules'), join(out, 'node_modules'), 'dir');
  return file;
}
function initRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-rt-repo-'));
  dirs.push(cwd);
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd });
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'root'], { cwd });
  return cwd;
}

describe('runtime CLI end-to-end (#599)', () => {
  const cli = bundleCli();
  const run = (cwd: string, args: string[], env: Record<string, string> = {}) =>
    execFileSync('node', [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

  const validator = () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'runtime-qualification-v1.schema.json'), 'utf8'));
    return ajv.compile(schema);
  };

  it('verify --json emits a schema-valid document with no percentage score', () => {
    const cwd = initRepo();
    const raw = run(cwd, ['runtime', 'verify', '--runtime', 'claude-code', '--json'], { TAMPERWARD_RUNTIME_VERSION: '9.9.9' });
    const doc = JSON.parse(raw);
    expect(validator()(doc)).toBe(true);
    expect(doc).toMatchObject({ command: 'runtime', subcommand: 'verify', final_authority: 'AVAILABLE', recorded: true });
    expect(doc.runtime.version).toBe('9.9.9');
    // Through the real CLI, with no retained probe for this runtime, NOTHING is PROVEN: a static
    // preDeny declaration grades PARTIAL. This is the maintainer's fix, enforced end-to-end.
    expect(doc.capabilities.some((c: { state: string }) => c.state === 'PROVEN')).toBe(false);
    const shell = doc.capabilities.find((c: { id: string }) => c.id === 'pre-deny:shell');
    expect(shell.state).toBe('PARTIAL');
    expect(shell.evidence.source).toBe('adapter-declaration');
    // No percentage / numeric score anywhere in the rendered surface.
    expect(raw).not.toMatch(/%/);
    expect(run(cwd, ['runtime', 'verify', '--runtime', 'claude-code'], { TAMPERWARD_RUNTIME_VERSION: '9.9.9' })).not.toMatch(/%/);
  });

  it('verify for copilot-sdk reports NO PROVEN under the current repo build (stale evidence excluded)', () => {
    // End-to-end proof of the review fix: the committed copilot-sdk capture ran under
    // tamperward@2.31.0; this repo is 2.37.x, so the full-binding match rejects it and the real
    // CLI promotes nothing. Every capability is PARTIAL/UNPROVEN/UNSUPPORTED — never PROVEN.
    const cwd = initRepo();
    const doc = JSON.parse(run(cwd, ['runtime', 'verify', '--runtime', 'copilot-sdk', '--json']));
    expect(doc.runtime.id).toBe('github-copilot-sdk-hosted');
    expect(doc.capabilities.some((c: { state: string }) => c.state === 'PROVEN')).toBe(false);
    expect(doc.capabilities.every((c: { evidence: { source: string } }) => c.evidence.source !== 'committed-evidence')).toBe(true);
    expect(doc.in_loop_protection).not.toBe('FULL');
  });

  it('schema enums equal the emitter constants (no drift)', () => {
    const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'runtime-qualification-v1.schema.json'), 'utf8'));
    const capItem = schema.properties.capabilities.items;
    expect(capItem.properties.id.enum).toEqual([...RUNTIME_CAPABILITY_IDS]);
    expect(capItem.properties.state.enum).toEqual([...CAPABILITY_STATES]);
    expect(capItem.properties.evidence.properties.source.enum).toEqual([...EVIDENCE_SOURCES]);
    expect(schema.properties.in_loop_protection.enum).toEqual([...IN_LOOP_AGGREGATES]);
    expect(schema.properties.schema_version).toEqual({ const: 1 });
  });

  it('status renders the stored qualification without rerunning, and flags a changed version STALE', () => {
    const cwd = initRepo();
    run(cwd, ['runtime', 'verify', '--runtime', 'claude-code', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' });
    expect(existsSync(join(cwd, '.git', 'tamperward', 'runtime-qualification.json'))).toBe(true);

    // Same version → applicable, not stale.
    const same = JSON.parse(run(cwd, ['runtime', 'status', '--runtime', 'claude-code', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' }));
    expect(same).toMatchObject({ subcommand: 'status', recorded: true, stale: false });
    expect(same.capabilities.length).toBe(RUNTIME_CAPABILITY_IDS.length);

    // A newer runtime version → STALE, with the change named and a re-verify hint.
    const bumped = run(cwd, ['runtime', 'status', '--runtime', 'claude-code'], { TAMPERWARD_RUNTIME_VERSION: '1.1.0' });
    expect(bumped).toMatch(/STALE/);
    expect(bumped).toMatch(/runtime\.version: 1\.0\.0 → 1\.1\.0/);
    expect(bumped).toMatch(/tamperward runtime verify/);

    const bumpedJson = JSON.parse(run(cwd, ['runtime', 'status', '--runtime', 'claude-code', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.1.0' }));
    expect(bumpedJson.stale).toBe(true);
  });

  it('status with no recorded qualification is honest, not a synthesized PROVEN', () => {
    const cwd = initRepo();
    const doc = JSON.parse(run(cwd, ['runtime', 'status', '--runtime', 'claude-code', '--json']));
    expect(doc.recorded).toBe(false);
    expect(doc.capabilities).toEqual([]);
    expect(doc.in_loop_protection).toBe('NONE');
  });

  it('rejects an unknown subcommand and an unknown runtime', () => {
    const cwd = initRepo();
    expect(() => run(cwd, ['runtime', 'nope'])).toThrow();
    expect(() => run(cwd, ['runtime', 'verify', '--runtime', 'does-not-exist'])).toThrow();
  });

  // Run and capture a non-zero exit without throwing away status/stderr.
  const runFail = (cwd: string, args: string[], env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } => {
    try {
      run(cwd, args, env);
      return { status: 0, stdout: '', stderr: '' };
    } catch (e) {
      const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
      return { status: err.status ?? -1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
    }
  };
  const storeFileOf = (cwd: string) => join(cwd, '.git', 'tamperward', 'runtime-qualification.json');

  it('finding 1: status rejects a hand-edited all-PROVEN / FULL record (stale evidence_id) as unrecorded', () => {
    const cwd = initRepo();
    run(cwd, ['runtime', 'verify', '--runtime', 'claude-code', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' });
    const store = JSON.parse(readFileSync(storeFileOf(cwd), 'utf8'));
    // Forge every capability to PROVEN and force FULL in-loop protection, leaving evidence_id stale.
    for (const c of store.records['claude-code'].capabilities) c.state = 'PROVEN';
    store.records['claude-code'].in_loop_protection = 'FULL';
    writeFileSync(storeFileOf(cwd), JSON.stringify(store));
    const doc = JSON.parse(run(cwd, ['runtime', 'status', '--runtime', 'claude-code', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' }));
    expect(doc.recorded).toBe(false);
    expect(doc.capabilities).toEqual([]);
    expect(doc.in_loop_protection).toBe('NONE');
    expect(doc.note).toMatch(/rejected/);
  });

  it('finding 1: status fails safe (no exit-2 internal error) when stored capabilities is not an array', () => {
    const cwd = initRepo();
    run(cwd, ['runtime', 'verify', '--runtime', 'claude-code', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' });
    const store = JSON.parse(readFileSync(storeFileOf(cwd), 'utf8'));
    store.records['claude-code'].capabilities = { not: 'an-array' };
    writeFileSync(storeFileOf(cwd), JSON.stringify(store));
    // Must NOT throw / exit 2 — it fails safe to recorded:false and exit 0.
    const raw = run(cwd, ['runtime', 'status', '--runtime', 'claude-code', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' });
    const doc = JSON.parse(raw);
    expect(doc.recorded).toBe(false);
  });

  it('finding 1: status rejects a record whose evidence_id no longer matches its binding+states', () => {
    const cwd = initRepo();
    run(cwd, ['runtime', 'verify', '--runtime', 'claude-code', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' });
    const store = JSON.parse(readFileSync(storeFileOf(cwd), 'utf8'));
    store.records['claude-code'].evidence_id = 'deadbeefdeadbeef';
    writeFileSync(storeFileOf(cwd), JSON.stringify(store));
    const doc = JSON.parse(run(cwd, ['runtime', 'status', '--runtime', 'claude-code', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' }));
    expect(doc.recorded).toBe(false);
    expect(doc.note).toMatch(/evidence_id mismatch/);
  });

  it('finding 2: disableAllHooks beside an unchanged hooks block flips the qualification STALE', () => {
    const cwd = initRepo();
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    const hooks = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'tamperward hook claude-code' }] }] } };
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify(hooks));
    run(cwd, ['runtime', 'verify', '--runtime', 'claude-code', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' });
    // Same hooks block, but disableAllHooks now turns them off — the old hooks-only hash missed this.
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: true, ...hooks }));
    const doc = JSON.parse(run(cwd, ['runtime', 'status', '--runtime', 'claude-code', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' }));
    expect(doc.stale).toBe(true);
    expect(doc.changed_inputs.join('\n')).toMatch(/hook_config_hash/);
  });

  it('finding 2: a .claude/settings.local.json override flips the qualification STALE', () => {
    const cwd = initRepo();
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
    run(cwd, ['runtime', 'verify', '--runtime', 'claude-code', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' });
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ disableAllHooks: true }));
    const doc = JSON.parse(run(cwd, ['runtime', 'status', '--runtime', 'claude-code', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' }));
    expect(doc.stale).toBe(true);
    expect(doc.changed_inputs.join('\n')).toMatch(/hook_config_hash/);
  });

  it('finding 2: an edited Copilot hook config at the documented path (.github/hooks/tamperward.json) flips STALE', () => {
    const cwd = initRepo();
    mkdirSync(join(cwd, '.github', 'hooks'), { recursive: true });
    writeFileSync(join(cwd, '.github', 'hooks', 'tamperward.json'), JSON.stringify({ hooks: { preToolUse: 'a' } }));
    run(cwd, ['runtime', 'verify', '--runtime', 'copilot', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' });
    const before = JSON.parse(run(cwd, ['runtime', 'status', '--runtime', 'copilot', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' }));
    expect(before.hook_config_hash).not.toBeNull();
    expect(before.stale).toBe(false);
    writeFileSync(join(cwd, '.github', 'hooks', 'tamperward.json'), JSON.stringify({ hooks: { preToolUse: 'CHANGED' } }));
    const after = JSON.parse(run(cwd, ['runtime', 'status', '--runtime', 'copilot', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' }));
    expect(after.stale).toBe(true);
    expect(after.changed_inputs.join('\n')).toMatch(/hook_config_hash/);
  });

  it('finding 3: --mode that is neither headless nor interactive exits 2 (no silent headless default)', () => {
    const cwd = initRepo();
    const r = runFail(cwd, ['runtime', 'verify', '--runtime', 'claude-code', '--mode', 'interactve'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--mode needs one of headless \| interactive/);
  });

  it('finding 4: verify reports a write failure on stderr and exits non-zero when nothing is persisted', () => {
    const cwd = initRepo();
    // Occupy the store directory path with a FILE so mkdir of `.git/tamperward` fails.
    writeFileSync(join(cwd, '.git', 'tamperward'), 'not a directory');
    const r = runFail(cwd, ['runtime', 'verify', '--runtime', 'claude-code', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/could not persist the qualification/);
    // The blocker (comment 5800297319): stdout must NOT claim `recorded: true` when nothing was
    // persisted — a machine consumer parsing stdout would otherwise retain the opposite state from
    // the (empty) store. stdout is either absent or an explicit `recorded: false` failure document.
    if (r.stdout.trim()) {
      const doc = JSON.parse(r.stdout);
      expect(doc.recorded).toBe(false);
      expect(doc.subcommand).toBe('verify');
      expect(doc.capabilities).toEqual([]);
      expect(doc.in_loop_protection).toBe('NONE');
      // Schema-valid even in the failure shape.
      expect(validator()(doc)).toBe(true);
    }
    // And never a success-claiming document, regardless of formatting.
    expect(r.stdout).not.toMatch(/"recorded"\s*:\s*true/);
  });

  it('finding 4: the human (non-JSON) write-failure path prints no success-shaped output', () => {
    const cwd = initRepo();
    writeFileSync(join(cwd, '.git', 'tamperward'), 'not a directory');
    const r = runFail(cwd, ['runtime', 'verify', '--runtime', 'claude-code'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/could not persist the qualification/);
    // The text render for an unrecorded document is the UNQUALIFIED block, not a capability table.
    expect(r.stdout).toMatch(/UNQUALIFIED/);
  });

  it('finding 6: refuses to qualify an absent runtime (no --runtime, nothing detected) at exit 2, recording nothing', () => {
    const cwd = initRepo();
    const r = runFail(cwd, ['runtime', 'verify', '--json']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no runtime detected/);
    expect(existsSync(storeFileOf(cwd))).toBe(false);
  });

  it('review 5800329016 item 1: a consumer-repo commit (HEAD change) alone does NOT flip STALE', () => {
    // The TamperWard build identity is sourced from TamperWard's OWN package metadata, not the
    // qualified repository's HEAD. So making an unrelated commit in the consumer repo — nothing
    // about the runtime, adapter or hook wiring changed — must NOT mark the stored qualification
    // stale, and the recorded `tamperward.commit` must NOT be the consumer repo's HEAD. Before the
    // fix `buildQualification` filled `tamperward.commit` from `git rev-parse HEAD` of the qualified
    // repo, so every consumer commit flipped `status` STALE with `tamperward.commit: X → Y`.
    const cwd = initRepo();
    const beforeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    run(cwd, ['runtime', 'verify', '--runtime', 'claude-code', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' });
    const before = JSON.parse(run(cwd, ['runtime', 'status', '--runtime', 'claude-code', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' }));
    expect(before.stale).toBe(false);
    // The recorded TamperWard build commit is never the consumer repo's HEAD (here it is null,
    // since the bundled CLI carries no published `gitHead`).
    expect(before.tamperward.commit).not.toBe(beforeSha);

    // A new, unrelated commit in the consumer repo advances HEAD...
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'unrelated consumer change'], { cwd });
    const afterSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    expect(afterSha).not.toBe(beforeSha);

    // ...and the stored qualification is STILL applicable — not stale, no tamperward.commit change.
    const after = JSON.parse(run(cwd, ['runtime', 'status', '--runtime', 'claude-code', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' }));
    expect(after.stale).toBe(false);
    expect(after.changed_inputs.join('\n')).not.toMatch(/tamperward\.commit/);
    expect(after.tamperward.commit).not.toBe(afterSha);

    // A genuine TamperWard identity change still flips STALE (proved at the qualificationStaleness
    // unit level above); only the QUALIFIED repo's HEAD is decoupled here.
  });

  it('review 5800329016 item 2: a rejected/tampered store prints its reason on the TEXT surface', () => {
    // A record `validateStoredReport` rejects (here: every capability forged to PROVEN + FULL, so
    // the recomputed evidence_id no longer reproduces) must explain itself in text mode, not only
    // under `--json`. Before the fix `renderText` returned in the unrecorded branch before printing
    // `note`, so the text surface showed only "no qualification recorded" with no reason.
    const cwd = initRepo();
    run(cwd, ['runtime', 'verify', '--runtime', 'claude-code', '--json'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' });
    const store = JSON.parse(readFileSync(storeFileOf(cwd), 'utf8'));
    for (const c of store.records['claude-code'].capabilities) c.state = 'PROVEN';
    store.records['claude-code'].in_loop_protection = 'FULL';
    writeFileSync(storeFileOf(cwd), JSON.stringify(store));
    const text = run(cwd, ['runtime', 'status', '--runtime', 'claude-code'], { TAMPERWARD_RUNTIME_VERSION: '1.0.0' });
    expect(text).toMatch(/UNQUALIFIED/);
    // The rejection reason (the same one carried in the `--json` note) is now visible in text mode.
    expect(text).toMatch(/rejected/);
    expect(text).toMatch(/evidence_id mismatch/);
  });
});

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
