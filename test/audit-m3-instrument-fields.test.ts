// #751 step 1: the audit event carries the four M3 measures as optional, additive fields —
// hook latency, `verify` wall-clock, the bare-suite wall-clock it is compared against, and
// whether an out-of-band sign-off was used — and `stats` reports deterministic p50/p95 where
// they are present. The hook writes its own latency on every deny it records; the other
// three are accepted and summarised but have no in-tree writer yet.

import { describe, it, expect, afterEach } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAuditEvent, parseAuditJsonl, recordAuditFindings, renderAuditStats, summarizeAudit, type AuditEventV1 } from '../src/cli/audit';
import { preToolUseVerdict } from '../src/cli/hook';
import type { Finding } from '../src/types';

const ROOT = join(__dirname, '..');
const dirs: string[] = [];
const previousAudit = process.env.TAMPERWARD_AUDIT_LOG;
afterEach(() => {
  if (previousAudit === undefined) delete process.env.TAMPERWARD_AUDIT_LOG;
  else process.env.TAMPERWARD_AUDIT_LOG = previousAudit;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-audit-m3-'));
  dirs.push(dir);
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir });
  g(['init', '-q']);
  g(['config', 'user.email', 'h@x']);
  g(['config', 'user.name', 'h']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.spec.ts'), `it('one', () => {}); it('two', () => {});\n`);
  writeFileSync(join(dir, '.tamperward.yml'), "version: 1\nprotected:\n  tests: ['**/*.spec.ts']\n");
  g(['add', '-A']);
  g(['commit', '-qm', 'seed']);
  return dir;
}

function auditLog(cwd: string): AuditEventV1[] {
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8' }).trim();
  return parseAuditJsonl(readFileSync(join(gitDir, 'tamperward', 'audit.jsonl'), 'utf8'));
}

function finding(rule: string, severity: 'block' | 'warn' = 'block'): Finding {
  return { rule, severity, message: 'm', evidence: 'e', remediation: 'r', signoff: { required: severity === 'block', command: 'c' } };
}

function event(overrides: Partial<AuditEventV1> = {}): AuditEventV1 {
  return {
    schema_version: 1,
    id: 'sha256:' + 'a'.repeat(32),
    timestamp: '2026-09-14T12:00:00.000Z',
    surface: 'pretooluse',
    agent: 'claude-code',
    rule: 'test-skip',
    severity: 'block',
    decision: 'deny',
    ...overrides,
  };
}

const schema = (name: string) => JSON.parse(readFileSync(join(ROOT, 'schemas', `${name}-v1.schema.json`), 'utf8'));
const validate = (name: string, doc: unknown): string[] => {
  const v = new Ajv2020({ allErrors: true, strict: true }).compile(schema(name));
  return v(doc) ? [] : (v.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
};

const INSTRUMENTED = { hook_latency_ms: 42, verify_wall_clock_ms: 91000, bare_suite_wall_clock_ms: 60500, oob_signoff: true } as const;

describe('the audit event carries the M3 measures as optional fields', () => {
  it('the published schema validates an event with and without them', () => {
    expect(validate('audit', event())).toEqual([]);
    expect(validate('audit', event(INSTRUMENTED))).toEqual([]);
    expect(validate('audit', event({ hook_latency_ms: -1 }))).not.toEqual([]);
    expect(validate('audit', event({ hook_latency_ms: 1.5 }))).not.toEqual([]);
    expect(validate('audit', event({ oob_signoff: 'yes' } as unknown as Partial<AuditEventV1>))).not.toEqual([]);
  });

  it('the parser accepts them, keeps them, and rejects the wrong shapes', () => {
    expect(parseAuditEvent(event(INSTRUMENTED))).toEqual(event(INSTRUMENTED));
    expect(parseAuditEvent(event())).toEqual(event());
    expect(() => parseAuditEvent(event({ hook_latency_ms: -1 }))).toThrow(/invalid hook_latency_ms/);
    expect(() => parseAuditEvent(event({ verify_wall_clock_ms: 1.5 }))).toThrow(/invalid verify_wall_clock_ms/);
    expect(() => parseAuditEvent(event({ bare_suite_wall_clock_ms: '60' } as unknown as Partial<AuditEventV1>))).toThrow(/invalid bare_suite_wall_clock_ms/);
    expect(() => parseAuditEvent(event({ oob_signoff: 1 } as unknown as Partial<AuditEventV1>))).toThrow(/invalid oob_signoff/);
    expect(() => parseAuditEvent({ ...event(), prompt: 'secret' })).toThrow(/unsupported field "prompt"/);
  });

  it('the writer records the measures a caller supplies and nothing else', () => {
    const cwd = repo();
    process.env.TAMPERWARD_AUDIT_LOG = 'auto';
    recordAuditFindings([finding('test-skip')], { cwd, surface: 'pretooluse', sessionId: 's', metrics: { hook_latency_ms: 7, oob_signoff: false } });
    recordAuditFindings([finding('test-skip')], { cwd, surface: 'pretooluse', sessionId: 's' });
    const [withMetrics, without] = auditLog(cwd);
    expect(withMetrics).toMatchObject({ hook_latency_ms: 7, oob_signoff: false });
    expect(withMetrics).not.toHaveProperty('verify_wall_clock_ms');
    expect(without).not.toHaveProperty('hook_latency_ms');
    expect(without).not.toHaveProperty('oob_signoff');
  });

  it('a fractional or negative latency from a caller is rounded and floored, never written as-is', () => {
    const cwd = repo();
    process.env.TAMPERWARD_AUDIT_LOG = 'auto';
    recordAuditFindings([finding('test-skip')], { cwd, surface: 'pretooluse', metrics: { hook_latency_ms: 2.6 } });
    recordAuditFindings([finding('test-skip')], { cwd, surface: 'pretooluse', metrics: { hook_latency_ms: -3 } });
    const [a, b] = auditLog(cwd);
    expect(a.hook_latency_ms).toBe(3);
    expect(b.hook_latency_ms).toBe(0);
  });

  it('the PreToolUse hook writes its own latency on every deny it records', () => {
    const cwd = repo();
    process.env.TAMPERWARD_AUDIT_LOG = 'auto';
    const r = preToolUseVerdict({ tool_name: 'Bash', tool_input: { command: 'rm src/a.spec.ts' }, cwd, session_id: 's1' });
    expect(r.stdout).toContain('test-deletion');
    const events = auditLog(cwd);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(Number.isInteger(e.hook_latency_ms), JSON.stringify(e)).toBe(true);
      expect(e.hook_latency_ms).toBeGreaterThanOrEqual(0);
      expect(e).not.toHaveProperty('verify_wall_clock_ms');
      expect(e).not.toHaveProperty('oob_signoff');
    }
  });
});

describe('stats summarises the measures deterministically where they are present', () => {
  const latencies = [100, 10, 40, 20, 30];
  const events = latencies.map((hook_latency_ms, i) => event({ id: 'sha256:' + String(i).repeat(32), hook_latency_ms, oob_signoff: i % 2 === 0 }));

  it('nearest-rank p50 / p95 over the samples, with their count and maximum', () => {
    const s = summarizeAudit(events);
    expect(s.latency.hook_latency_ms).toEqual({ samples: 5, p50: 30, p95: 100, max: 100 });
    expect(s.latency.verify_wall_clock_ms).toBeNull();
    expect(s.latency.bare_suite_wall_clock_ms).toBeNull();
    expect(s.oob_signoffs).toBe(3);
  });

  it('is independent of event order and counts only events that carry the field', () => {
    const shuffled = [...events].reverse();
    expect(summarizeAudit(shuffled).latency).toEqual(summarizeAudit(events).latency);
    const mixed = [...events, event({ id: 'sha256:' + 'f'.repeat(32) })];
    expect(summarizeAudit(mixed).latency.hook_latency_ms?.samples).toBe(5);
    expect(summarizeAudit(mixed).oob_signoffs).toBe(3);
  });

  it('one sample is its own p50, p95 and max; no samples is null', () => {
    expect(summarizeAudit([event({ verify_wall_clock_ms: 91000 })]).latency.verify_wall_clock_ms).toEqual({ samples: 1, p50: 91000, p95: 91000, max: 91000 });
    expect(summarizeAudit([]).latency).toEqual({ hook_latency_ms: null, verify_wall_clock_ms: null, bare_suite_wall_clock_ms: null });
    expect(summarizeAudit([]).oob_signoffs).toBe(0);
  });

  it('the published stats schema validates the summary with and without samples', () => {
    expect(validate('stats', summarizeAudit([]))).toEqual([]);
    expect(validate('stats', summarizeAudit(events))).toEqual([]);
  });

  it('the text view names the measures only when there are samples', () => {
    const text = renderAuditStats(summarizeAudit(events));
    expect(text).toMatch(/Hook latency\s+p50 30 ms\s+p95 100 ms\s+max 100 ms\s+\(5 samples\)/);
    expect(text).toMatch(/Out-of-band sign-offs\s+3/);
    expect(text).not.toMatch(/verify wall-clock/i);
    expect(renderAuditStats(summarizeAudit([]))).not.toMatch(/Hook latency/);
  });
});
