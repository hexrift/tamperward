// Privacy-preserving local audit telemetry and deterministic aggregation.
//
// This channel is deliberately NON-AUTHORITATIVE: recording can fail without
// changing a hook verdict, and the records are never consulted by enforcement.
// Only the allowlisted metadata below is serialised. Prompt text, tool inputs,
// source snippets, absolute paths and environment values never enter the event.

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Finding } from '../types';
import { repoContext } from '../repo-context';
import { appendRegular, openRegular, stateDirectory } from '../disk';

export const AUDIT_SCHEMA_VERSION = 1 as const;
export const AUDIT_LOG_ENV = 'TAMPERWARD_AUDIT_LOG';
// An audit-v1 event serialises to well under 400 bytes. A line past this bound
// is not an event the reader should buffer: `stats` streams the file one line
// at a time, so the bound is what keeps peak memory independent of file size.
export const MAX_AUDIT_LINE_BYTES = 16 * 1024;

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
  hook_latency_ms?: number;
  verify_wall_clock_ms?: number;
  bare_suite_wall_clock_ms?: number;
  oob_signoff?: boolean;
}

/** The M3 measures an event may carry (SPEC §9.1): whole milliseconds, never negative,
 *  and whether an out-of-band sign-off was used. All optional; absent means unmeasured. */
export interface AuditMetrics {
  hook_latency_ms?: number;
  verify_wall_clock_ms?: number;
  bare_suite_wall_clock_ms?: number;
  oob_signoff?: boolean;
}

export const AUDIT_DURATION_FIELDS = ['hook_latency_ms', 'verify_wall_clock_ms', 'bare_suite_wall_clock_ms'] as const;
export type AuditDurationField = (typeof AUDIT_DURATION_FIELDS)[number];

export interface AuditContext {
  cwd: string;
  surface: AuditSurface;
  sessionId?: string;
  metrics?: AuditMetrics;
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
  latency: Record<AuditDurationField, DurationPercentiles | null>;
  oob_signoffs: number;
  interpretation: 'finding-is-not-proof-of-intent';
}

/** Nearest-rank percentiles over the events that carry a duration field. */
export interface DurationPercentiles {
  samples: number;
  p50: number;
  p95: number;
  max: number;
}

function sessionHash(sessionId?: string): string | undefined {
  if (!sessionId) return undefined;
  return 'sha256:' + createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
}

/** Durations as whole, non-negative milliseconds; a boolean kept as given; anything
 *  else dropped. Never throws: the audit channel must not change a verdict. */
function sanitizedMetrics(metrics: AuditMetrics | undefined): AuditMetrics {
  const out: AuditMetrics = {};
  if (!metrics) return out;
  for (const field of AUDIT_DURATION_FIELDS) {
    const v = metrics[field];
    if (typeof v === 'number' && Number.isFinite(v)) out[field] = Math.max(0, Math.round(v));
  }
  if (typeof metrics.oob_signoff === 'boolean') out.oob_signoff = metrics.oob_signoff;
  return out;
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
    // The state directory itself is accepted only as a directory of its own (#721).
    return ctx ? join(stateDirectory(ctx.gitDir), 'audit.jsonl') : null;
  }
  return isAbsolute(value) ? value : resolve(cwd, value);
}

export function defaultAuditPath(cwd: string): string | null {
  const ctx = repoContext(cwd);
  return ctx ? join(stateDirectory(ctx.gitDir), 'audit.jsonl') : null;
}

export function recordAuditFindings(findings: readonly Finding[], context: AuditContext): void {
  if (findings.length === 0) return;

  try {
    // Inside the try: a refused state directory (#721) drops the event like any
    // other write failure; the verdict never depends on this channel.
    const path = configuredAuditPath(context.cwd);
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    const timestamp = new Date().toISOString();
    const session = sessionHash(context.sessionId);
    const metrics = sanitizedMetrics(context.metrics);
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
        ...metrics,
      };
      return JSON.stringify(event);
    });
    // Appended only to a regular file (#718): a link at the path is not followed and a
    // FIFO is not waited on. This runs before the verdict is returned, so an append
    // that blocked held the deny until the runtime's hook timeout let the call through.
    appendRegular(path, lines.join('\n') + '\n');
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
  ...AUDIT_DURATION_FIELDS,
  'oob_signoff',
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
  for (const field of AUDIT_DURATION_FIELDS) {
    const v = value[field];
    if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v < 0)) {
      throw new Error(`${where} has an invalid ${field}`);
    }
  }
  if (value.oob_signoff !== undefined && typeof value.oob_signoff !== 'boolean') {
    throw new Error(`${where} has an invalid oob_signoff`);
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
    ...durationsOf(value),
    ...(typeof value.oob_signoff === 'boolean' ? { oob_signoff: value.oob_signoff } : {}),
  };
}

function durationsOf(value: Record<string, unknown>): Partial<Record<AuditDurationField, number>> {
  const out: Partial<Record<AuditDurationField, number>> = {};
  for (const field of AUDIT_DURATION_FIELDS) {
    const v = value[field];
    if (typeof v === 'number') out[field] = v;
  }
  return out;
}

export function parseAuditLine(line: string, lineNumber: number): AuditEventV1 {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`audit line ${lineNumber} is not valid JSON`);
  }
  return parseAuditEvent(value, lineNumber);
}

export function parseAuditJsonl(raw: string): AuditEventV1[] {
  const events: AuditEventV1[] = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    events.push(parseAuditLine(line, index + 1));
  });
  return events;
}

const STATS_READ_REFUSED = '; stats reads the audit log only as a regular file — remove what stands there so the log can be read';

/**
 * Reads a JSONL file line by line with a fixed read buffer, so memory is
 * bounded by one line (at most `maxLineBytes`) plus the buffer, never by the
 * file. Blank lines are skipped and a trailing `\r` is dropped, matching
 * `parseAuditJsonl`. Line numbers are 1-based and count blank lines. The file
 * is opened only as a regular file (#722): false when nothing stands at the
 * path, true once it has been read, and a StateFileError naming anything else
 * standing there — a link wherever it points, a FIFO, a directory — thrown
 * before a byte is read, never followed or waited on.
 */
export function forEachAuditLine(
  file: string,
  onLine: (line: string, lineNumber: number) => void,
  maxLineBytes = MAX_AUDIT_LINE_BYTES,
): boolean {
  const fd = openRegular(file, STATS_READ_REFUSED);
  if (fd === null) return false;
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let lineNumber = 0;
    const emit = (parts: Buffer[]): void => {
      lineNumber++;
      let line = parts.length === 1 ? parts[0].toString('utf8') : Buffer.concat(parts).toString('utf8');
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim()) onLine(line, lineNumber);
    };
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      let start = 0;
      for (let i = 0; i < read; i++) {
        if (chunk[i] !== 0x0a) continue;
        const part = chunk.subarray(start, i);
        if (pendingBytes + part.length > maxLineBytes) {
          throw new Error(`audit line ${lineNumber + 1} exceeds ${maxLineBytes} bytes (not an audit-v1 event)`);
        }
        emit(pending.length ? [...pending, part] : [part]);
        pending = [];
        pendingBytes = 0;
        start = i + 1;
      }
      if (start < read) {
        // The chunk buffer is reused by the next read: copy the partial line out.
        const rest = Buffer.from(chunk.subarray(start, read));
        pendingBytes += rest.length;
        if (pendingBytes > maxLineBytes) {
          throw new Error(`audit line ${lineNumber + 1} exceeds ${maxLineBytes} bytes (not an audit-v1 event)`);
        }
        pending.push(rest);
      }
    }
    if (pending.length) emit(pending);
  } finally {
    closeSync(fd);
  }
  return true;
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

interface Bound {
  ms: number;
  id: string;
  timestamp: string;
}

export interface AuditAggregator {
  /** Folds one event into the running totals. */
  add(event: AuditEventV1): void;
  /** The stats-v1 summary of every event added so far. */
  finish(): AuditSummary;
}

/**
 * One-pass aggregation. State is bounded by the aggregate cardinality (rules,
 * surfaces, distinct session hashes) plus two bounds, never by the number of
 * events, so a stream of any length can be folded without holding it.
 * `first_event` / `last_event` are ordered by instant and then by event id,
 * exactly as the sorted whole-array summary ordered them.
 */
export function createAuditAggregator(): AuditAggregator {
  let events = 0;
  let blocked = 0;
  let warnings = 0;
  const rules = new Map<string, { events: number; blocked: number; warnings: number }>();
  const surfaces = new Map<AuditSurface, number>();
  const sessions = new Set<string>();
  // One count per distinct whole-millisecond value, so the percentiles are exact and
  // the state is bounded by the distinct values seen, not by the number of events.
  const durations: Record<AuditDurationField, Map<number, number>> = {
    hook_latency_ms: new Map(),
    verify_wall_clock_ms: new Map(),
    bare_suite_wall_clock_ms: new Map(),
  };
  let oobSignoffs = 0;
  // Held in one object so the null checks in finish() narrow the property
  // types; a captured `let` assigned only inside add() would not narrow.
  const bounds: { first: Bound | null; last: Bound | null } = { first: null, last: null };

  return {
    add(event) {
      events++;
      if (event.severity === 'block') blocked++;
      else warnings++;
      const bucket = rules.get(event.rule) ?? { events: 0, blocked: 0, warnings: 0 };
      bucket.events++;
      if (event.severity === 'block') bucket.blocked++;
      else bucket.warnings++;
      rules.set(event.rule, bucket);
      surfaces.set(event.surface, (surfaces.get(event.surface) ?? 0) + 1);
      if (event.session) sessions.add(event.session);
      for (const field of AUDIT_DURATION_FIELDS) {
        const v = event[field];
        if (typeof v === 'number') durations[field].set(v, (durations[field].get(v) ?? 0) + 1);
      }
      if (event.oob_signoff === true) oobSignoffs++;
      const ms = Date.parse(event.timestamp);
      const { first, last } = bounds;
      if (first === null || ms < first.ms || (ms === first.ms && event.id.localeCompare(first.id) < 0)) {
        bounds.first = { ms, id: event.id, timestamp: event.timestamp };
      }
      if (last === null || ms > last.ms || (ms === last.ms && event.id.localeCompare(last.id) > 0)) {
        bounds.last = { ms, id: event.id, timestamp: event.timestamp };
      }
    },
    finish() {
      const by_rule = [...rules.entries()]
        .map(([rule, counts]) => ({ rule, ...counts }))
        .sort((a, b) => b.events - a.events || a.rule.localeCompare(b.rule));
      const by_surface = [...surfaces.entries()]
        .map(([surface, count]) => ({ surface, events: count }))
        .sort((a, b) => b.events - a.events || a.surface.localeCompare(b.surface));
      return {
        schema_version: AUDIT_SCHEMA_VERSION,
        events,
        blocked,
        warnings,
        sessions: sessions.size,
        first_event: bounds.first === null ? null : bounds.first.timestamp,
        last_event: bounds.last === null ? null : bounds.last.timestamp,
        by_rule,
        by_surface,
        latency: {
          hook_latency_ms: percentiles(durations.hook_latency_ms),
          verify_wall_clock_ms: percentiles(durations.verify_wall_clock_ms),
          bare_suite_wall_clock_ms: percentiles(durations.bare_suite_wall_clock_ms),
        },
        oob_signoffs: oobSignoffs,
        interpretation: 'finding-is-not-proof-of-intent',
      };
    },
  };
}

/** Nearest-rank percentiles (the smallest value at or past the rank) over the counted
 *  values, or null when nothing was measured. Order of insertion never matters. */
function percentiles(counts: Map<number, number>): DurationPercentiles | null {
  const values = [...counts.keys()].sort((a, b) => a - b);
  if (values.length === 0) return null;
  const samples = [...counts.values()].reduce((a, b) => a + b, 0);
  const at = (q: number): number => {
    const rank = Math.max(1, Math.ceil(q * samples));
    let seen = 0;
    for (const v of values) {
      seen += counts.get(v) ?? 0;
      if (seen >= rank) return v;
    }
    return values[values.length - 1];
  };
  return { samples, p50: at(0.5), p95: at(0.95), max: values[values.length - 1] };
}

export function summarizeAudit(events: readonly AuditEventV1[]): AuditSummary {
  const aggregator = createAuditAggregator();
  for (const event of events) aggregator.add(event);
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

  const measures: Array<[AuditDurationField, string]> = [
    ['hook_latency_ms', 'Hook latency'],
    ['verify_wall_clock_ms', 'verify wall-clock'],
    ['bare_suite_wall_clock_ms', 'Bare-suite wall-clock'],
  ];
  const measured: Array<[string, DurationPercentiles]> = [];
  for (const [field, label] of measures) {
    const p = summary.latency[field];
    if (p !== null) measured.push([label, p]);
  }
  if (measured.length || summary.oob_signoffs > 0) {
    out.push('', 'Measures');
    for (const [label, p] of measured) {
      out.push(`  ${label.padEnd(22)}  p50 ${p.p50} ms  p95 ${p.p95} ms  max ${p.max} ms  (${p.samples} samples)`);
    }
    if (summary.oob_signoffs > 0) out.push(`  ${'Out-of-band sign-offs'.padEnd(22)}  ${summary.oob_signoffs}`);
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

  // One pass over the file: each line is parsed, filtered by --since and folded
  // into the aggregator, so peak memory is one line plus the aggregate
  // cardinality however large the audit log has grown. The file is read only as
  // a regular file (#722): nothing at the path is the empty summary — or, for an
  // explicit --file, not found — and anything else standing there is refused by
  // name before a byte is read. `existsSync` followed a link and reported its
  // target's absence as "no events", and `openSync` waited on a FIFO.
  const aggregator = createAuditAggregator();
  const read = forEachAuditLine(file, (line, lineNumber) => {
    const event = parseAuditLine(line, lineNumber);
    if (cutoff !== null && Date.parse(event.timestamp) < cutoff) return;
    aggregator.add(event);
  });
  if (!read && explicitFile) throw new Error(`audit file not found: ${file}`);
  const summary = aggregator.finish();
  process.stdout.write(opts.json ? JSON.stringify(summary) + '\n' : renderAuditStats(summary));
  return 0;
}
