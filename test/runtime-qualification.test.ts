// #599 — the version-bound, operation-specific runtime capability model.
//
// These tests pin the HONESTY of the derivation: states come only from the adapter's declared
// capabilities, an unproven capability is never PROVEN, a fail-open is surfaced and can never
// aggregate to FULL, no percentage appears, the JSON matches the published schema, and a changed
// load-bearing input marks a stored qualification STALE.

import { describe, it, expect, afterAll } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
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

  it('Claude declares every operation kind in preDeny, so pre-deny capabilities are PROVEN', () => {
    // Guard the premise: the derivation is only honest because the adapter really declares this.
    expect(claudeAdapter.capabilities.preDeny).toEqual(OPERATION_KINDS);
    const a = assessCapabilities(claudeAdapter.capabilities);
    for (const id of ['pre-deny:shell', 'pre-deny:native-edit', 'pre-deny:mcp', 'pre-deny:git-mutation'] as const) {
      expect(stateOf(a, id)).toBe('PROVEN');
    }
    expect(stateOf(a, 'end-of-turn')).toBe('PROVEN');
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

  it('a lifecycle-only end-of-turn is PARTIAL, and post-observe reflects the declaration', () => {
    const copilot = assessCapabilities(copilotAdapter.capabilities);
    expect(stateOf(copilot, 'end-of-turn')).toBe('PARTIAL'); // agentStop is lifecycle-only
    expect(stateOf(copilot, 'post-observe')).toBe('UNSUPPORTED');

    const codex = assessCapabilities(codexAdapter.capabilities);
    expect(codexAdapter.capabilities.postObserve.length).toBeGreaterThan(0);
    expect(stateOf(codex, 'post-observe')).toBe('PROVEN');

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

  it('no proven pre-deny and no proven end-of-turn aggregates to NONE', () => {
    expect(aggregateInLoop(assessCapabilities(copilotAdapter.capabilities))).toBe('NONE');
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

  it('an unchanged binding is not stale', () => {
    const s = qualificationStaleness(binding(), binding({ timestamp: 'later', evidence_id: 'other', tamperward: { version: '2.35.0', commit: 'DIFFERENT' } }));
    // commit is provenance, not load-bearing: a commit-only change is NOT stale.
    expect(s.stale).toBe(false);
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
    // No percentage / numeric score anywhere in the rendered surface.
    expect(raw).not.toMatch(/%/);
    expect(run(cwd, ['runtime', 'verify', '--runtime', 'claude-code'], { TAMPERWARD_RUNTIME_VERSION: '9.9.9' })).not.toMatch(/%/);
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
});

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
