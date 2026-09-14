// Structured, privacy-minimised audit events for TamperWard's observational
// self-hosting telemetry.
//
// This channel is deliberately NOT part of the enforcement authority. The agent
// can run as the same OS identity as the local log and can therefore delete or
// forge local telemetry. Its purpose is longitudinal measurement: what findings
// fired, where in the hook lifecycle, and how often. Never put prompts, commands,
// source snippets, absolute paths, environment values or sign-off reasons here.

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Finding } from './types';

export const AUDIT_SCHEMA_VERSION = 1 as const;
export const DEFAULT_AUDIT_BRANCH = 'tamperward-audit';
export const DEFAULT_AUDIT_ROOT = 'audit/v1/events';

export type AuditSource = 'pretooluse' | 'stop';
export type AuditDecision = 'deny' | 'warn';

export interface AuditFindingEventV1 {
  schema_version: typeof AUDIT_SCHEMA_VERSION;
  id: string;
  recorded_at: string;
  event: 'finding';
  agent: 'claude-code';
  source: AuditSource;
  rule: string;
  severity: 'block' | 'warn';
  decision: AuditDecision;
  /** One-way correlation token. The Claude session id itself is never persisted. */
  session_hash?: string;
  /** Git object id only; never a branch name or local path. */
  head?: string;
}

export interface AuditSummary {
  schema_version: typeof AUDIT_SCHEMA_VERSION;
  findings: number;
  blocked: number;
  warnings: number;
  sessions_with_findings: number;
  first_recorded_at: string | null;
  last_recorded_at: string | null;
  by_rule: Record<string, number>;
  by_source: Record<AuditSource, number>;
}

function safeHead(cwd: string): string | undefined {
  try {
    const v = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    return /^[0-9a-f]{40,64}$/i.test(v) ? v.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function sessionHash(sessionId?: string): string | undefined {
  if (!sessionId) return undefined;
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 20);
}

/** Resolve the audit file through Git itself. Null means this cwd is not backed
 * by a Git repository (or Git could not safely answer), so the hook must not
 * manufacture a .git directory merely to record non-authoritative telemetry. */
function repositoryAuditLog(cwd: string): string | null {
  try {
    const p = execFileSync('git', ['rev-parse', '--git-path', 'tamperward/audit-v1.jsonl'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    return p ? resolve(cwd, p) : null;
  } catch {
    return null;
  }
}

/** The conventional local path used by stats when no repository-backed path can
 * be resolved. Reading this fallback is harmless; hook recording uses the stricter
 * configuredAuditLog() path below and never creates it outside a real repository. */
export function defaultAuditLog(cwd: string): string {
  return repositoryAuditLog(cwd) ?? resolve(cwd, '.git', 'tamperward', 'audit-v1.jsonl');
}

export function configuredAuditLog(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.TAMPERWARD_AUDITLOG;
  if (configured === '0' || configured?.toLowerCase() === 'off') return null;
  return configured ? resolve(cwd, configured) : repositoryAuditLog(cwd);
}

export function makeAuditEvents(
  findings: readonly Finding[],
  source: AuditSource,
  cwd: string,
  sessionId?: string,
  now: Date = new Date(),
): AuditFindingEventV1[] {
  const recorded = now.toISOString();
  const head = safeHead(cwd);
  const session = sessionHash(sessionId);
  return findings.map((finding) => ({
    schema_version: AUDIT_SCHEMA_VERSION,
    id: randomUUID(),
    recorded_at: recorded,
    event: 'finding',
    agent: 'claude-code',
    source,
    rule: finding.rule,
    severity: finding.severity,
    decision: finding.severity === 'block' ? 'deny' : 'warn',
    ...(session ? { session_hash: session } : {}),
    ...(head ? { head } : {}),
  }));
}

/** Best-effort observational write. It can never change an enforcement verdict. */
export function recordAuditFindings(
  findings: readonly Finding[],
  source: AuditSource,
  cwd: string,
  sessionId?: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (findings.length === 0) return;
  const path = configuredAuditLog(cwd, env);
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return;
    const events = makeAuditEvents(findings, source, cwd, sessionId);
    appendFileSync(path, events.map((event) => JSON.stringify(event)).join('\n') + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // Measurement channel only. A failed audit write must never turn deny into
    // allow, nor turn an otherwise clean enforcement decision into a block.
  }
}

export function isAuditEvent(value: unknown): value is AuditFindingEventV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const allowed = new Set([
    'schema_version',
    'id',
    'recorded_at',
    'event',
    'agent',
    'source',
    'rule',
    'severity',
    'decision',
    'session_hash',
    'head',
  ]);
  if (Object.keys(v).some((key) => !allowed.has(key))) return false;
  const consistentDecision =
    (v.severity === 'block' && v.decision === 'deny') ||
    (v.severity === 'warn' && v.decision === 'warn');
  return (
    v.schema_version === AUDIT_SCHEMA_VERSION &&
    typeof v.id === 'string' &&
    /^[0-9a-f-]{20,}$/i.test(v.id) &&
    typeof v.recorded_at === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v.recorded_at) &&
    Number.isFinite(Date.parse(v.recorded_at)) &&
    v.event === 'finding' &&
    v.agent === 'claude-code' &&
    (v.source === 'pretooluse' || v.source === 'stop') &&
    typeof v.rule === 'string' &&
    v.rule.length > 0 &&
    (v.severity === 'block' || v.severity === 'warn') &&
    consistentDecision &&
    (v.session_hash === undefined || (typeof v.session_hash === 'string' && /^[0-9a-f]{20}$/i.test(v.session_hash))) &&
    (v.head === undefined || (typeof v.head === 'string' && /^[0-9a-f]{40,64}$/i.test(v.head)))
  );
}

export function parseAuditJsonl(text: string): AuditFindingEventV1[] {
  const out: AuditFindingEventV1[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`audit record ${index + 1} is not valid JSON`);
    }
    if (!isAuditEvent(value)) throw new Error(`audit record ${index + 1} does not match audit schema v1`);
    out.push(value);
  }
  return out;
}

export function readAuditLog(path: string): AuditFindingEventV1[] {
  if (!existsSync(path)) return [];
  return parseAuditJsonl(readFileSync(path, 'utf8'));
}

export function summarizeAudit(events: readonly AuditFindingEventV1[]): AuditSummary {
  const unique = new Map(events.map((event) => [event.id, event]));
  const rows = [...unique.values()].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  const byRule: Record<string, number> = {};
  const bySource: Record<AuditSource, number> = { pretooluse: 0, stop: 0 };
  const sessions = new Set<string>();
  let blocked = 0;
  let warnings = 0;
  for (const event of rows) {
    byRule[event.rule] = (byRule[event.rule] ?? 0) + 1;
    bySource[event.source]++;
    if (event.decision === 'deny') blocked++;
    else warnings++;
    if (event.session_hash) sessions.add(event.session_hash);
  }
  return {
    schema_version: AUDIT_SCHEMA_VERSION,
    findings: rows.length,
    blocked,
    warnings,
    sessions_with_findings: sessions.size,
    first_recorded_at: rows[0]?.recorded_at ?? null,
    last_recorded_at: rows.at(-1)?.recorded_at ?? null,
    by_rule: Object.fromEntries(Object.entries(byRule).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    by_source: bySource,
  };
}
