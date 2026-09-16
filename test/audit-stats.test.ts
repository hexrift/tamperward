import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAuditEvent,
  parseAuditJsonl,
  parseSince,
  recordAuditFindings,
  renderAuditStats,
  runStats,
  summarizeAudit,
  type AuditEventV1,
} from '../src/cli/audit';
import type { Finding } from '../src/types';

const dirs: string[] = [];
const previousAudit = process.env.TAMPERWARD_AUDIT_LOG;

afterEach(() => {
  if (previousAudit === undefined) delete process.env.TAMPERWARD_AUDIT_LOG;
  else process.env.TAMPERWARD_AUDIT_LOG = previousAudit;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-audit-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function finding(rule: string, severity: 'block' | 'warn' = 'block'): Finding {
  return {
    rule,
    severity,
    file: '/Users/alice/private/secret.test.ts',
    message: 'prompt text must not be recorded',
    evidence: 'TOKEN=super-secret',
    remediation: 'run dangerous command',
    signoff: { required: severity === 'block', command: 'tamperward allow secret' },
  };
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
    session: 'sha256:' + 'b'.repeat(24),
    ...overrides,
  };
}

describe('structured audit logging', () => {
  it('writes only allowlisted privacy-safe metadata to the git-dir audit log', () => {
    const cwd = repo();
    process.env.TAMPERWARD_AUDIT_LOG = 'auto';

    recordAuditFindings([finding('test-skip')], {
      cwd,
      surface: 'pretooluse',
      sessionId: 'raw-session-id',
    });

    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8' }).trim();
    const raw = readFileSync(join(gitDir, 'tamperward', 'audit.jsonl'), 'utf8');
    const parsed = parseAuditJsonl(raw);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      schema_version: 1,
      surface: 'pretooluse',
      agent: 'claude-code',
      rule: 'test-skip',
      severity: 'block',
      decision: 'deny',
    });
    expect(parsed[0].session).toMatch(/^sha256:[0-9a-f]{24}$/);
    expect(raw).not.toContain('raw-session-id');
    expect(raw).not.toContain('/Users/alice');
    expect(raw).not.toContain('prompt text');
    expect(raw).not.toContain('super-secret');
    expect(raw).not.toContain('dangerous command');
  });

  it('keeps audit failure non-authoritative', () => {
    const cwd = repo();
    const blocker = join(cwd, 'not-a-directory');
    writeFileSync(blocker, 'operator-owned\n');
    process.env.TAMPERWARD_AUDIT_LOG = join(blocker, 'audit.jsonl');

    expect(() => recordAuditFindings([finding('test-deletion')], {
      cwd,
      surface: 'stop',
      sessionId: 's1',
    })).not.toThrow();
  });
});

describe('audit schema validation', () => {
  it('rejects unknown fields rather than trying to redact them later', () => {
    expect(() => parseAuditEvent({ ...event(), prompt: 'secret' })).toThrow(/unsupported field "prompt"/);
  });

  it('rejects malformed and semantically inconsistent records', () => {
    expect(() => parseAuditJsonl('{not-json}\n')).toThrow(/not valid JSON/);
    expect(() => parseAuditEvent({ ...event(), severity: 'warn', decision: 'deny' })).toThrow(/inconsistent/);
    expect(() => parseAuditEvent({ ...event(), session: 'raw-session' })).toThrow(/invalid session/);
    expect(() => parseAuditEvent({ ...event(), agent: 'Claude Code' })).toThrow(/invalid agent/);
    expect(parseAuditEvent({ ...event(), agent: 'future-agent' }).agent).toBe('future-agent');
  });
});

describe('audit stats', () => {
  it('aggregates rules, surfaces and sessions deterministically', () => {
    const events = [
      event(),
      event({
        id: 'sha256:' + 'c'.repeat(32),
        timestamp: '2026-09-14T12:01:00.000Z',
        surface: 'stop',
        rule: 'test-skip',
      }),
      event({
        id: 'sha256:' + 'd'.repeat(32),
        timestamp: '2026-09-14T12:02:00.000Z',
        surface: 'stop',
        rule: 'transient-protected-mutation',
        severity: 'warn',
        decision: 'warn',
        session: 'sha256:' + 'e'.repeat(24),
      }),
    ];

    const summary = summarizeAudit(events);
    expect(summary).toMatchObject({
      events: 3,
      blocked: 2,
      warnings: 1,
      sessions: 2,
      first_event: '2026-09-14T12:00:00.000Z',
      last_event: '2026-09-14T12:02:00.000Z',
      interpretation: 'finding-is-not-proof-of-intent',
    });
    expect(summary.by_rule).toEqual([
      { rule: 'test-skip', events: 2, blocked: 2, warnings: 0 },
      { rule: 'transient-protected-mutation', events: 1, blocked: 0, warnings: 1 },
    ]);
    expect(summary.by_surface).toEqual([
      { surface: 'stop', events: 2 },
      { surface: 'pretooluse', events: 1 },
    ]);

    const text = renderAuditStats(summary);
    expect(text).toContain('TamperWard audit stats');
    expect(text).toContain('test-skip');
    expect(text).toContain('not proof of agent intent');
  });

  it('orders first/last by instant when timestamp precision is mixed', () => {
    const whole = event({ id: 'sha256:' + 'c'.repeat(32), timestamp: '2026-09-15T12:00:00Z' });
    const fractional = event({ id: 'sha256:' + 'd'.repeat(32), timestamp: '2026-09-15T12:00:00.500Z' });

    for (const events of [[whole, fractional], [fractional, whole]]) {
      const summary = summarizeAudit(events);
      expect(summary.first_event).toBe('2026-09-15T12:00:00Z');
      expect(summary.last_event).toBe('2026-09-15T12:00:00.500Z');
    }
  });

  it('breaks ties deterministically for equal instants with different representations', () => {
    const noMillis = event({ id: 'sha256:' + 'c'.repeat(32), timestamp: '2026-09-15T12:00:00Z' });
    const withMillis = event({ id: 'sha256:' + 'd'.repeat(32), timestamp: '2026-09-15T12:00:00.000Z' });

    for (const events of [[noMillis, withMillis], [withMillis, noMillis]]) {
      const summary = summarizeAudit(events);
      expect(summary.first_event).toBe('2026-09-15T12:00:00Z');
      expect(summary.last_event).toBe('2026-09-15T12:00:00.000Z');
    }
  });

  it('reports null bounds for empty input', () => {
    const summary = summarizeAudit([]);
    expect(summary.first_event).toBeNull();
    expect(summary.last_event).toBeNull();
    expect(summary.events).toBe(0);
  });

  it('parses relative and absolute --since values', () => {
    const now = Date.parse('2026-09-14T12:00:00.000Z');
    expect(parseSince('30d', now)).toBe(now - 30 * 86_400_000);
    expect(parseSince('12h', now)).toBe(now - 12 * 3_600_000);
    expect(parseSince('90m', now)).toBe(now - 90 * 60_000);
    expect(parseSince('2026-09-01T00:00:00Z', now)).toBe(Date.parse('2026-09-01T00:00:00Z'));
    expect(() => parseSince('forever', now)).toThrow(/invalid --since/);
  });

  it('validates --since even when the default audit store does not exist yet', () => {
    const cwd = repo();
    delete process.env.TAMPERWARD_AUDIT_LOG;
    expect(() => runStats({ cwd, since: 'forever' })).toThrow(/invalid --since/);
  });

  it('parses a persisted file without depending on repository content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-audit-file-'));
    dirs.push(dir);
    const file = join(dir, 'events.jsonl');
    writeFileSync(file, JSON.stringify(event()) + '\n');
    expect(parseAuditJsonl(readFileSync(file, 'utf8'))).toHaveLength(1);
  });
});
