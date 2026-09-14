import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAuditJsonl,
  readAuditLog,
  recordAuditFindings,
  summarizeAudit,
  type AuditFindingEventV1,
} from '../src/audit';
import { preToolUseFromRaw } from '../src/cli/hook';
import { runStats } from '../src/cli/stats';
import { publishAudit } from '../src/cli/audit';
import { validateCliArgs } from '../src/cli/main';
import type { Finding } from '../src/types';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-audit-'));
  dirs.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: d });
  execFileSync('git', ['config', 'user.email', 't@b'], { cwd: d });
  writeFileSync(join(d, 'calc.test.js'), "const { it } = require('node:test'); it('x',()=>{});\n");
  execFileSync('git', ['add', '-A'], { cwd: d });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: d });
  return d;
}

const finding: Finding = {
  rule: 'test-skip',
  severity: 'block',
  file: '/private/operator/project/calc.test.js',
  message: 'supersecret prompt-derived explanation',
  evidence: 'it.skip("do not persist this")',
  remediation: 'fix it',
  signoff: { required: true, command: 'tamperward allow test-skip --reason "private reason"' },
};

function capture(fn: () => number): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  const code = fn();
  vi.restoreAllMocks();
  return { code, out, err };
}

describe('structured audit events', () => {
  it('records only the privacy-minimised finding envelope', () => {
    const cwd = repo();
    const log = join(cwd, '.git', 'audit-test.jsonl');
    recordAuditFindings([finding], 'pretooluse', cwd, 'raw-secret-session-id', {
      ...process.env,
      TAMPERWARD_AUDITLOG: log,
    });

    const raw = readFileSync(log, 'utf8');
    const [event] = parseAuditJsonl(raw);
    expect(event).toMatchObject({
      schema_version: 1,
      event: 'finding',
      agent: 'claude-code',
      source: 'pretooluse',
      rule: 'test-skip',
      severity: 'block',
      decision: 'deny',
    });
    expect(event.session_hash).toMatch(/^[0-9a-f]{20}$/);
    expect(event.head).toMatch(/^[0-9a-f]{40}$/);
    expect(raw).not.toContain('raw-secret-session-id');
    expect(raw).not.toContain('supersecret');
    expect(raw).not.toContain('do not persist this');
    expect(raw).not.toContain('/private/operator');
    expect(raw).not.toContain('private reason');
  });

  it('does not follow an existing audit-log symlink', () => {
    const cwd = repo();
    const outside = join(cwd, 'outside');
    const log = join(cwd, '.git', 'audit-link');
    writeFileSync(outside, 'operator-owned\n');
    symlinkSync(outside, log);
    recordAuditFindings([finding], 'stop', cwd, 's1', {
      ...process.env,
      TAMPERWARD_AUDITLOG: log,
    });
    expect(readFileSync(outside, 'utf8')).toBe('operator-owned\n');
  });

  it('can be disabled explicitly without changing enforcement', () => {
    const cwd = repo();
    const log = join(cwd, '.git', 'disabled.jsonl');
    recordAuditFindings([finding], 'stop', cwd, 's1', {
      ...process.env,
      TAMPERWARD_AUDITLOG: 'off',
    });
    expect(existsSync(log)).toBe(false);
  });

  it('rejects malformed or over-rich JSONL instead of silently counting it', () => {
    const valid: AuditFindingEventV1 = {
      schema_version: 1,
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      recorded_at: '2026-09-14T12:00:00.000Z',
      event: 'finding',
      agent: 'claude-code',
      source: 'stop',
      rule: 'test-skip',
      severity: 'block',
      decision: 'deny',
    };
    expect(parseAuditJsonl(JSON.stringify(valid))).toEqual([valid]);
    expect(() => parseAuditJsonl('{nope')).toThrow(/not valid JSON/);
    expect(() => parseAuditJsonl(JSON.stringify({ ...valid, prompt: 'leak' })))
      .toThrow(/does not match audit schema/);
  });

  it('the real PreToolUse deny path writes a structured event', () => {
    const cwd = repo();
    const log = join(cwd, '.git', 'hook-audit.jsonl');
    const old = process.env.TAMPERWARD_AUDITLOG;
    process.env.TAMPERWARD_AUDITLOG = log;
    try {
      const result = preToolUseFromRaw(JSON.stringify({
        cwd,
        session_id: 'claude-session-secret',
        tool_name: 'Bash',
        tool_input: { command: 'rm calc.test.js' },
      }));
      expect(result.stdout).toContain('"deny"');
      const events = readAuditLog(log);
      expect(events.some((event) => event.rule === 'test-deletion' && event.source === 'pretooluse')).toBe(true);
      expect(readFileSync(log, 'utf8')).not.toContain('rm calc.test.js');
      expect(readFileSync(log, 'utf8')).not.toContain('claude-session-secret');
    } finally {
      if (old === undefined) delete process.env.TAMPERWARD_AUDITLOG;
      else process.env.TAMPERWARD_AUDITLOG = old;
    }
  });
});

describe('tamperward stats', () => {
  const event = (
    id: string,
    recorded_at: string,
    rule: string,
    source: 'pretooluse' | 'stop',
    decision: 'deny' | 'warn',
    session_hash: string,
  ): AuditFindingEventV1 => ({
    schema_version: 1,
    id,
    recorded_at,
    event: 'finding',
    agent: 'claude-code',
    source,
    rule,
    severity: decision === 'deny' ? 'block' : 'warn',
    decision,
    session_hash,
  });

  it('deduplicates event ids and reports rules, surfaces and sessions', () => {
    const a = event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-09-13T10:00:00.000Z', 'test-skip', 'pretooluse', 'deny', '1'.repeat(20));
    const b = event('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-09-14T10:00:00.000Z', 'ci-tampering', 'stop', 'warn', '2'.repeat(20));
    const summary = summarizeAudit([a, a, b]);
    expect(summary).toMatchObject({
      findings: 2,
      blocked: 1,
      warnings: 1,
      sessions_with_findings: 2,
      by_rule: { 'ci-tampering': 1, 'test-skip': 1 },
      by_source: { pretooluse: 1, stop: 1 },
    });
  });

  it('prints an honest text summary and a versioned JSON document', () => {
    const cwd = repo();
    const log = join(cwd, 'audit.jsonl');
    const rows = [
      event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', new Date().toISOString(), 'test-skip', 'pretooluse', 'deny', '1'.repeat(20)),
      event('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', new Date().toISOString(), 'assertion-weakening', 'stop', 'warn', '1'.repeat(20)),
    ];
    writeFileSync(log, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

    let r = capture(() => runStats({ cwd, log }));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Integrity findings\s+2/);
    expect(r.out).toMatch(/Blocked\s+1/);
    expect(r.out).toMatch(/test-skip/);
    expect(r.out).toMatch(/These are integrity findings, not claims about agent intent/);

    r = capture(() => runStats({ cwd, log, json: true }));
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(doc).toMatchObject({
      schema_version: 1,
      source: { kind: 'local' },
      since: 'all time',
      summary: { findings: 2, blocked: 1, warnings: 1 },
    });
  });

  it('supports a bounded time window', () => {
    const cwd = repo();
    const log = join(cwd, 'audit.jsonl');
    const rows = [
      event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2020-01-01T00:00:00.000Z', 'old-rule', 'stop', 'deny', '1'.repeat(20)),
      event('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', new Date().toISOString(), 'new-rule', 'stop', 'deny', '2'.repeat(20)),
    ];
    writeFileSync(log, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const r = capture(() => runStats({ cwd, log, since: '30d', json: true }));
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(doc.summary.findings).toBe(1);
    expect(doc.summary.by_rule).toEqual({ 'new-rule': 1 });
  });

  it('has a strict CLI grammar for local and GitHub modes', () => {
    expect(validateCliArgs('stats', ['--since', '30d', '--json'])).toBeUndefined();
    expect(validateCliArgs('stats', ['--github', 'hexrift/tamperward', '--branch', 'tamperward-audit'])).toBeUndefined();
    expect(validateCliArgs('stats', ['--log', 'a', '--github', 'x/y'])).toMatch(/cannot be combined/);
    expect(validateCliArgs('stats', ['--branch', 'x'])).toMatch(/require --github/);
    expect(validateCliArgs('audit', ['publish', '--github', 'hexrift/tamperward'])).toBeUndefined();
    expect(validateCliArgs('audit', ['publish'])).toMatch(/requires --github/);
  });
});

describe('GitHub publishing boundary', () => {
  it('requires an explicit write credential before doing any network work', () => {
    const cwd = repo();
    const log = join(cwd, 'audit.jsonl');
    recordAuditFindings([finding], 'stop', cwd, 's1', {
      ...process.env,
      TAMPERWARD_AUDITLOG: log,
    });
    const gh = process.env.GH_TOKEN;
    const github = process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const r = capture(() => publishAudit({ cwd, log, github: 'hexrift/tamperward' }));
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/needs GH_TOKEN or GITHUB_TOKEN/);
    } finally {
      if (gh !== undefined) process.env.GH_TOKEN = gh;
      if (github !== undefined) process.env.GITHUB_TOKEN = github;
    }
  });
});
