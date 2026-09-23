// Privacy-preserving local audit telemetry and deterministic aggregation.
//
// This channel is deliberately NON-AUTHORITATIVE: recording can fail without
// changing a hook verdict, and the records are never consulted by enforcement.
// Only the allowlisted metadata below is serialised. Prompt text, tool inputs,
// source snippets, absolute paths and environment values never enter the event.

import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Finding } from '../types';
import { repoContext } from '../repo-context';

export const AUDIT_SCHEMA_VERSION = 1 as const;
export const AUDIT_LOG_ENV = 'TAMPERWARD_AUDIT_LOG';

// Streaming bound: a single audit line is one JSON event whose fields are all
// short, fixed-shape tokens, so a well-formed record is far under this. The cap
// keeps the line reader's peak memory bounded by one event line regardless of
// total store size, and turns a pathological single-line file into an
// actionable exit-2 diagnostic instead of an out-of-memory crash.
export const MAX_AUDIT_LINE_BYTES = 64 * 1024;

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

// Total order over events matching the previous full-sort tie-break:
// chronological by instant, then by id. Tracking the min and max under this
// order reproduces the old `ordered[0]`/`ordered.at(-1)` first/last bounds
// without materialising or sorting the full event array.
function compareEventOrder(a: { ts: number; id: string }, b: { ts: number; id: string }): number {
  return a.ts - b.ts || a.id.localeCompare(b.id);
}

/**
 * Single-pass audit aggregator. It holds only the summary state — counts, the
 * per-rule and per-surface maps, the distinct-session set, and the extremal
 * timestamps — so peak memory is bounded by aggregate cardinality plus one
 * event at a time, never the total number of events. `summarizeAudit` and the
 * streaming `runStats` path both drive this, so they produce byte-identical
 * summaries by construction.
 */
export class AuditAggregator {
  private events = 0;
  private blocked = 0;
  private warnings = 0;
  private readonly rules = new Map<string, { events: number; blocked: number; warnings: number }>();
  private readonly surfaces = new Map<AuditSurface, number>();
  private readonly sessions = new Set<string>();
  private firstTs: string | null = null;
  private firstKey: { ts: number; id: string } | null = null;
  private lastTs: string | null = null;
  private lastKey: { ts: number; id: string } | null = null;

  add(event: AuditEventV1): void {
    this.events++;
    if (event.severity === 'block') this.blocked++;
    else this.warnings++;
    const bucket = this.rules.get(event.rule) ?? { events: 0, blocked: 0, warnings: 0 };
    bucket.events++;
    if (event.severity === 'block') bucket.blocked++;
    else bucket.warnings++;
    this.rules.set(event.rule, bucket);
    this.surfaces.set(event.surface, (this.surfaces.get(event.surface) ?? 0) + 1);
    if (event.session) this.sessions.add(event.session);

    const key = { ts: Date.parse(event.timestamp), id: event.id };
    if (this.firstKey === null || compareEventOrder(key, this.firstKey) < 0) {
      this.firstKey = key;
      this.firstTs = event.timestamp;
    }
    if (this.lastKey === null || compareEventOrder(key, this.lastKey) > 0) {
      this.lastKey = key;
      this.lastTs = event.timestamp;
    }
  }

  finish(): AuditSummary {
    const by_rule = [...this.rules.entries()]
      .map(([rule, counts]) => ({ rule, ...counts }))
      .sort((a, b) => b.events - a.events || a.rule.localeCompare(b.rule));
    const by_surface = [...this.surfaces.entries()]
      .map(([surface, count]) => ({ surface, events: count }))
      .sort((a, b) => b.events - a.events || a.surface.localeCompare(b.surface));

    return {
      schema_version: AUDIT_SCHEMA_VERSION,
      events: this.events,
      blocked: this.blocked,
      warnings: this.warnings,
      sessions: this.sessions.size,
      first_event: this.firstTs,
      last_event: this.lastTs,
      by_rule,
      by_surface,
      interpretation: 'finding-is-not-proof-of-intent',
    };
  }
}

export function summarizeAudit(events: readonly AuditEventV1[]): AuditSummary {
  const aggregator = new AuditAggregator();
  for (const event of events) aggregator.add(event);
  return aggregator.finish();
}

/**
 * Read an audit JSONL file one line at a time with bounded memory: 64 KiB read
 * chunks and a rolling partial-line buffer that is never allowed to exceed
 * MAX_AUDIT_LINE_BYTES. Each complete non-blank line is handed to `onLine` with
 * its 1-based line number. Synchronous by design so `runStats` can validate its
 * inputs and throw before returning, keeping the CLI's error surface unchanged.
 */
export function forEachAuditLine(file: string, onLine: (line: string, lineNumber: number) => void): void {
  const fd = openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let pending = '';
    let lineNumber = 0;
    let bytesRead: number;
    const flush = (line: string): void => {
      lineNumber++;
      if (Buffer.byteLength(line, 'utf8') > MAX_AUDIT_LINE_BYTES) {
        throw new Error(`audit line ${lineNumber} exceeds the ${MAX_AUDIT_LINE_BYTES}-byte limit`);
      }
      if (line.trim()) onLine(line, lineNumber);
    };
    while ((bytesRead = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      pending += chunk.toString('utf8', 0, bytesRead);
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        let line = pending.slice(0, newline);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        flush(line);
        pending = pending.slice(newline + 1);
      }
      if (Buffer.byteLength(pending, 'utf8') > MAX_AUDIT_LINE_BYTES) {
        throw new Error(
          `audit line ${lineNumber + 1} exceeds the ${MAX_AUDIT_LINE_BYTES}-byte limit`,
        );
      }
    }
    if (pending.length) flush(pending.endsWith('\r') ? pending.slice(0, -1) : pending);
  } finally {
    closeSync(fd);
  }
}

/**
 * Stream a persisted audit store into a summary: parse and validate each line,
 * apply the `--since` cutoff per event, and aggregate in one pass. Never
 * allocates the full event array, so peak memory is bounded by one event line
 * plus the aggregate cardinality — not the file size.
 */
export function streamAuditSummary(file: string, cutoff: number | null): AuditSummary {
  const aggregator = new AuditAggregator();
  forEachAuditLine(file, (line, lineNumber) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`audit line ${lineNumber} is not valid JSON`);
    }
    const event = parseAuditEvent(value, lineNumber);
    if (cutoff !== null && Date.parse(event.timestamp) < cutoff) return;
    aggregator.add(event);
  });
  return aggregator.finish();
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

  const summary = streamAuditSummary(file, cutoff);
  process.stdout.write(opts.json ? JSON.stringify(summary) + '\n' : renderAuditStats(summary));
  return 0;
}
