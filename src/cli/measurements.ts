// Opt-in measurements are evidence, never enforcement authority. Keep them in
// a sidecar so historical audit-v1 readers and finding counts remain unchanged.
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { appendRegular } from '../disk';
import { isRecord } from '../narrow';

export const MEASUREMENT_OUTCOMES = ['VERIFIED', 'MASKED_FAILURE', 'SUITE_RED', 'BUDGET_EXCEEDED', 'CANNOT_VERIFY', 'INCOMPLETE', 'PASSED', 'FAILED'] as const;
export type MeasurementOutcome = typeof MEASUREMENT_OUTCOMES[number];
export interface VerificationMeasurement {
  schema_version: 1;
  id: string;
  timestamp: string;
  kind: 'verify' | 'bare-suite';
  outcome: MeasurementOutcome;
  duration_ms: number;
  // Correlate only identical head/tree/command/machine combinations. No raw
  // machine identifier, command, path or approval token is retained.
  comparison?: string;
  oob_signoff?: boolean;
}

export function measurementComparison(head: string, tree: string, command: string): string {
  return createHash('sha256').update(JSON.stringify([head, tree, command, hostname()])).digest('hex');
}

export function parseMeasurement(value: unknown): VerificationMeasurement {
  if (!isRecord(value)) throw new Error('measurement must be an object');
  const v = value;
  const allowed = new Set(['schema_version', 'id', 'timestamp', 'kind', 'outcome', 'duration_ms', 'comparison', 'oob_signoff']);
  const outcome = MEASUREMENT_OUTCOMES.find(o => o === v.outcome);
  if (Object.keys(v).some(k => !allowed.has(k))) throw new Error('measurement contains unsupported field');
  if (v.schema_version !== 1 || typeof v.id !== 'string' || !/^sha256:[a-f0-9]{32}$/.test(v.id)
    || typeof v.timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v.timestamp) || !Number.isFinite(Date.parse(v.timestamp))
    || (v.kind !== 'verify' && v.kind !== 'bare-suite')
    || outcome === undefined
    || typeof v.duration_ms !== 'number' || !Number.isSafeInteger(v.duration_ms) || v.duration_ms < 0
    || (v.comparison !== undefined && (typeof v.comparison !== 'string' || !/^[a-f0-9]{64}$/.test(v.comparison)))
    || (v.oob_signoff !== undefined && (typeof v.oob_signoff !== 'boolean' || v.kind !== 'verify'))
    || (v.kind === 'bare-suite' && !['PASSED', 'FAILED', 'INCOMPLETE'].includes(String(v.outcome)))
    || (v.kind === 'verify' && ['PASSED', 'FAILED'].includes(String(v.outcome)))) {
    throw new Error('invalid measurement');
  }
  // Construct explicitly: even an object with surprising prototype properties
  // cannot carry extra metadata into the writer.
  return {
    schema_version: 1, id: v.id, timestamp: v.timestamp, kind: v.kind,
    outcome, duration_ms: v.duration_ms,
    ...(typeof v.comparison === 'string' ? { comparison: v.comparison } : {}),
    ...(typeof v.oob_signoff === 'boolean' ? { oob_signoff: v.oob_signoff } : {}),
  };
}

export function recordMeasurement(auditPath: string | null, measurement: Omit<VerificationMeasurement, 'schema_version' | 'id' | 'timestamp'>): void {
  if (!auditPath) return;
  try {
    const event = parseMeasurement({ ...measurement, schema_version: 1, id: 'sha256:' + randomBytes(16).toString('hex'), timestamp: new Date().toISOString() });
    const file = auditPath + '.measurements';
    mkdirSync(dirname(file), { recursive: true });
    appendRegular(file, JSON.stringify(event) + '\n');
  } catch {
    // A refused path or unavailable telemetry sink never changes a verdict.
  }
}
