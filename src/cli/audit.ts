// Privacy-preserving local audit telemetry and deterministic aggregation.
//
// This channel is deliberately NON-AUTHORITATIVE: recording can fail without
// changing a hook verdict, and the records are never consulted by enforcement.
// Only the allowlisted metadata below is serialised. Prompt text, tool inputs,
// source snippets, absolute paths and environment values never enter the event.

import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Finding } from '../types';
import { repoContext } from '../repo-context';

export const AUDIT_SCHEMA_VERSION = 1 as const;
export const AUDIT_LOG_ENV = 'TAMPERWARD_AUDIT_LOG';

export type AuditSurface = 'pretooluse' | 'stop';
export type AuditSeverity = 'block' | 'warn';
export type AuditDecision = 'deny' | 'warn';

export interface AuditEventV1 {
  schema_version: 1;
  id: string;
  timestamp: string;
  surface: AuditSurface;
  agent: string;
  rule: string;
  severity: AuditSeverity;
  decision: AuditDecision;
  session?: string;
}

export interface AuditContext {
  cwd: string;
  surface: AuditSurface;
  sessionId?: string;
}

export interface StatsOpts {
  cwd?: string;
  file?: string;
  since?: string;
  json?: boolean;
}

export interface AuditSummary {
  schema_version: 1;
  events: number;
  blocked: number;
  warnings: number;
  sessions: number;
  first_event: string | null;
  last_event: string | null;
  by_rule: Array<{ rule: string; events: number; blocked: number; warnings: number }>;
  by_surface: Array<{ surface: AuditSurface; events: number }>;
  interpretation: 'finding-is-not-proof-of-intent';
}

function sessionHash(sessionId?: string): string | undefined {
  if (!sessionId) return undefined;
  return 'sha256:' + createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
}

function eventId(): string {
  // Hook invocations normally run in separate Node processes, so a process-local
  // counter is not a durable uniqueness source. Hash fresh entropy instead; the
  // identifier carries no repository, host, path, prompt or session information.
  return 'sha256:' + createHash('sha256').update(randomBytes(32)).digest('hex').slice(0, 32);
}

function configuredAuditPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[AUDIT_LOG_ENV];
  if (!value) return null;
  if (value === 'auto') {
    const ctx = repoContext(cwd);
    return ctx ? join(ctx.gitDir, 'tamperward', 'audit.jsonl') : null;
  }
  return isAbsolute(value) ? value : resolve(cwd, value);
}

export function defaultAuditPath(cwd: string): string | null {
  const ctx = repoContext(cwd);
  return ctx ? join(ctx.gitDir, 'tamperward', 'audit.jsonl') : null;
}

export function recordAuditFindings(findings: readonly Finding[], context: AuditContext): void {
  if (findings.length === 0) return;
  const path = configuredAuditPath(context.cwd);
  if (!path) return;

  try {
    mkdirSync(dirname(path), { recursive: true });
    const timestamp = new Date().toISOString();
    const session = sessionHash(context.sessionId);
    const lines = findings.map((finding) => {
      const severity: AuditSeverity = finding.severity === 'block' ? 'block' : 'warn';
      const event: AuditEventV1 = {
        schema_version: AUDIT_SCHEMA_VERSION,
        id: eventId(),
        timestamp,
        surface: context.surface,
        agent: 'claude-code',
        rule: finding.rule,
        severity,
        decision: severity === 'block' ? 'deny' : 'warn',
        ...(session ? { session } : {}),
      };
      return JSON.stringify(event);
    });
    appendFileSync(path, lines.join('\n') + '\n');
  } catch {
    // Measurement only. Audit failure must never change the enforcement verdict.
  }
}

export function recordAuditSignal(
  rule: string,
  severity: AuditSeverity,
  context: AuditContext,
): void {
  const finding: Finding = {
    rule,
    severity,
    message: '',
    evidence: '',
    remediation: '',
    signoff: { required: severity === 'block', command: '' },
  };
  recordAuditFindings([finding], context);
}

const ALLOWED_KEYS = new Set([
  'schema_version',
  'id',
  'timestamp',
  'surface',
  'agent',
  'rule',
  'severity',
  'decision',
  'session',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseAuditEvent(value: unknown, line = 0): AuditEventV1 {
  const where = line > 0 ? `audit line ${line}` : 'audit event';
  if (!isRecord(value)) throw new Error(`${where} must be a JSON object`);

  const unknown = Object.keys(value).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length) throw new Error(`${where} contains unsupported field "${unknown[0]}"`);
  if (value.schema_version !== AUDIT_SCHEMA_VERSION) {
    throw new Error(`${where} has unsupported schema_version ${String(value.schema_version)}`);
  }
  if (typeof value.id !== 'string' || !/^sha256:[0-9a-f]{32}$/.test(value.id)) {
    throw new Error(`${where} has an invalid id`);
  }
  if (typeof value.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.timestamp) || !Number.isFinite(Date.parse(value.timestamp))) {
    throw new Error(`${where} has an invalid timestamp`);
  }
  if (value.surface !== 'pretooluse' && value.surface !== 'stop') {
    throw new Error(`${where} has an invalid surface`);
  }
  if (typeof value.agent !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.agent)) {
    throw new Error(`${where} has an invalid agent`);
  }
  if (typeof value.rule !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value.rule)) {
    throw new Error(`${where} has an invalid rule`);
  }
  if (value.severity !== 'block' && value.severity !== 'warn') {
    throw new Error(`${where} has an invalid severity`);
  }
  if (value.decision !== 'deny' && value.decision !== 'warn') {
    throw new Error(`${where} has an invalid decision`);
  }
  if ((value.severity === 'block' && value.decision !== 'deny') || (value.severity === 'warn' && value.decision !== 'warn')) {
    throw new Error(`${where} has inconsistent severity and decision`);
  }
  if (value.session !== undefined && (typeof value.session !== 'string' || !/^sha256:[0-9a-f]{24}$/.test(value.session))) {
    throw new Error(`${where} has an invalid session`);
  }

  return {
    schema_version: AUDIT_SCHEMA_VERSION,
    id: value.id,
    timestamp: value.timestamp,
    surface: value.surface,
    agent: value.agent,
    rule: value.rule,
    severity: value.severity,
    decision: value.decision,
    ...(typeof value.session === 'string' ? { session: value.session } : {}),
  };
}

export function parseAuditJsonl(raw: string): AuditEventV1[] {
  const events: AuditEventV1[] = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`audit line ${index + 1} is not valid JSON`);
    }
    events.push(parseAuditEvent(value, index + 1));
  });
  return events;
}

export function parseSince(value: string, nowMs = Date.now()): number {
  const relative = /^(\d+)(m|h|d)$/.exec(value);
  if (relative) {
    const count = Number(relative[1]);
    const unit = relative[2] === 'm' ? 60_000 : relative[2] === 'h' ? 3_600_000 : 86_400_000;
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`invalid --since value "${value}"`);
    return nowMs - count * unit;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid --since value "${value}" (use e.g. 30d, 12h, 90m, or an ISO timestamp)`);
  }
  return parsed;
}

export function summarizeAudit(events: readonly AuditEventV1[]): AuditSummary {
  const ordered = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  const rules = new Map<string, { events: number; blocked: number; warnings: number }>();
  const surfaces = new Map<AuditSurface, number>();
  const sessions = new Set<string>();

  for (const event of ordered) {
    const bucket = rules.get(event.rule) ?? { events: 0, blocked: 0, warnings: 0 };
    bucket.events++;
    if (event.severity === 'block') bucket.blocked++;
    else bucket.warnings++;
    rules.set(event.rule, bucket);
    surfaces.set(event.surface, (surfaces.get(event.surface) ?? 0) + 1);
    if (event.session) sessions.add(event.session);
  }

  const by_rule = [...rules.entries()]
    .map(([rule, counts]) => ({ rule, ...counts }))
    .sort((a, b) => b.events - a.events || a.rule.localeCompare(b.rule));
  const by_surface = [...surfaces.entries()]
    .map(([surface, count]) => ({ surface, events: count }))
    .sort((a, b) => b.events - a.events || a.surface.localeCompare(b.surface));

  return {
    schema_version: AUDIT_SCHEMA_VERSION,
    events: ordered.length,
    blocked: ordered.filter((event) => event.severity === 'block').length,
    warnings: ordered.filter((event) => event.severity === 'warn').length,
    sessions: sessions.size,
    first_event: ordered[0]?.timestamp ?? null,
    last_event: ordered.at(-1)?.timestamp ?? null,
    by_rule,
    by_surface,
    interpretation: 'finding-is-not-proof-of-intent',
  };
}

export function renderAuditStats(summary: AuditSummary): string {
  const out = [
    'TamperWard audit stats',
    '',
    `Events      ${summary.events}`,
    `Blocked     ${summary.blocked}`,
    `Warnings    ${summary.warnings}`,
    `Sessions    ${summary.sessions}`,
  ];

  if (summary.first_event && summary.last_event) {
    out.push(`First       ${summary.first_event}`, `Last        ${summary.last_event}`);
  }

  if (summary.by_rule.length) {
    out.push('', 'By rule');
    const width = Math.max(...summary.by_rule.map((row) => row.rule.length));
    for (const row of summary.by_rule) out.push(`  ${row.rule.padEnd(width)}  ${row.events}`);
  }

  if (summary.by_surface.length) {
    out.push('', 'By surface');
    const width = Math.max(...summary.by_surface.map((row) => row.surface.length));
    for (const row of summary.by_surface) out.push(`  ${row.surface.padEnd(width)}  ${row.events}`);
  }

  out.push('', 'Note: an integrity finding is a signal, not proof of agent intent; legitimate refactors can trigger findings.');
  return out.join('\n') + '\n';
}

export function runStats(opts: StatsOpts = {}): number {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const explicitFile = opts.file !== undefined;
  const configured = process.env[AUDIT_LOG_ENV];
  const file = opts.file
    ? (isAbsolute(opts.file) ? opts.file : resolve(cwd, opts.file))
    : configured && configured !== 'auto'
      ? (isAbsolute(configured) ? configured : resolve(cwd, configured))
      : defaultAuditPath(cwd);

  const cutoff = opts.since ? parseSince(opts.since) : null;
  if (!file) throw new Error('stats needs --file outside a Git repository');
  if (!existsSync(file)) {
    if (explicitFile) throw new Error(`audit file not found: ${file}`);
    const empty = summarizeAudit([]);
    process.stdout.write(opts.json ? JSON.stringify(empty) + '\n' : renderAuditStats(empty));
    return 0;
  }

  let events = parseAuditJsonl(readFileSync(file, 'utf8'));
  if (cutoff !== null) {
    events = events.filter((event) => Date.parse(event.timestamp) >= cutoff);
  }
  const summary = summarizeAudit(events);
  process.stdout.write(opts.json ? JSON.stringify(summary) + '\n' : renderAuditStats(summary));
  return 0;
}
