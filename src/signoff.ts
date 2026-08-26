// Three-layer sign-off trust model. The discipline: each layer may only honor a signal that
// the party it protects against CANNOT forge.
//
//   AGENT  (PreToolUse + Stop hook): honors NOTHING — never consults the ledger at all. The
//          agent can write the ledger (observed self-invoking `tamperward allow` 3×), so an
//          in-loop sign-off is forgeable → ignored, always.
//   LOCAL  (pre-commit / `check --staged`): MAY honor a ledger entry, but bound to the SPECIFIC
//          triggering tamper (rule + file + evidence fingerprint) and an expiry — a one-time
//          human judgment on one tamper, not a standing license. A developer at their machine is
//          a human; residual pre-plant risk is visible in the diff and backstopped by CI.
//   CI     (`check --diff`): honors ONLY an out-of-band signal (a reviewed-label/CODEOWNERS
//          approval surfaced via env by the workflow), NEVER the committed ledger — anything in
//          the repo is something the PR (and thus the agent) can author.
//
// The fingerprint binds to the triggering tamper, NOT the whole diff: an unrelated edit
// elsewhere doesn't evaporate a sign-off, but a DIFFERENT tamper of the same rule+file isn't
// covered by it either.

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Finding, Policy } from './types';

export interface LedgerEntry {
  rule: string;
  file?: string;
  fingerprint: string;
  reason: string;
  recordedAt: number;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Stable id of the specific tamper a finding flagged (rule + file + evidence). */
export function fingerprint(rule: string, file: string | undefined, evidence: string): string {
  return createHash('sha256').update(`${rule}\0${file ?? ''}\0${evidence}`).digest('hex').slice(0, 16);
}
export const fingerprintOf = (f: Finding): string => fingerprint(f.rule, f.file, f.evidence);

export function ledgerPath(cwd: string, policy: Policy): string {
  return join(cwd, policy.signoff?.ledger ?? '.tamperward/ledger.jsonl');
}

export function readLedger(cwd: string, policy: Policy): LedgerEntry[] {
  const p = ledgerPath(cwd, policy);
  if (!existsSync(p)) return [];
  const out: LedgerEntry[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.fingerprint === 'string') out.push(e as LedgerEntry);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

export function appendEntry(cwd: string, policy: Policy, e: LedgerEntry): void {
  const p = ledgerPath(cwd, policy);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(e) + '\n');
}

export function makeEntry(f: Finding, reason: string, now: number, ttlMs = DEFAULT_TTL_MS): LedgerEntry {
  return { rule: f.rule, file: f.file, fingerprint: fingerprintOf(f), reason, recordedAt: now, expiresAt: now + ttlMs };
}

export interface SignoffResult {
  findings: Finding[]; // remaining (still in force)
  cleared: Finding[]; // dropped by a valid sign-off
}

/** LOCAL layer: drop block findings that a valid (matching fingerprint, unexpired) ledger entry signs off. */
export function applyLocalSignoffs(findings: Finding[], cwd: string, policy: Policy, now: number = Date.now()): SignoffResult {
  const ledger = readLedger(cwd, policy).filter((e) => e.expiresAt > now);
  const valid = new Set(ledger.map((e) => e.fingerprint));
  const cleared: Finding[] = [];
  const remaining: Finding[] = [];
  for (const f of findings) {
    if (f.severity === 'block' && valid.has(fingerprintOf(f))) cleared.push(f);
    else remaining.push(f);
  }
  return { findings: remaining, cleared };
}

/** CI layer: honor ONLY out-of-band approvals (rule or rule:file), NEVER the committed ledger. */
export function applyOobSignoffs(findings: Finding[], oob: string[]): SignoffResult {
  const set = new Set(oob.map((s) => s.trim()).filter(Boolean));
  const cleared: Finding[] = [];
  const remaining: Finding[] = [];
  for (const f of findings) {
    const ok = f.severity === 'block' && (set.has(f.rule) || (f.file ? set.has(`${f.rule}:${f.file}`) : false));
    if (ok) cleared.push(f);
    else remaining.push(f);
  }
  return { findings: remaining, cleared };
}

/** Parse the out-of-band approval env the CI workflow sets (only after verifying a trusted label). */
export function oobFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.TAMPERWARD_OOB_SIGNOFF ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
