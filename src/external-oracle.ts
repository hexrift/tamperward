// A deliberately narrow out-of-process oracle: the trusted host owns expected
// values and assertion completion; a container owns only JSON RPC responses.
// No candidate-provided completion claim or suite exit is a passing assertion.
import { isDeepStrictEqual } from 'node:util';
import { randomBytes } from 'node:crypto';
import { isRecord } from './narrow';
import type { BackendRunResult, ContainerProgram } from './verifier-backend';

export interface OracleCase { module: string; export: string; args: unknown[]; expected: unknown }
export interface OraclePlan { protocol: 'node-json-rpc-v1'; image: string; budget_secs: number; cases: OracleCase[] }
export interface OracleRequest { module: string; export: string; args: unknown[]; nonce: string }
export interface OracleEvaluation {
  verdict: 'VERIFIED' | 'ORACLE_RED' | 'CANNOT_VERIFY';
  planned: number;
  completed: number;
  passed: number;
  reason?: 'INVALID_RESPONSE' | 'EXECUTION_FAILED' | 'BUDGET_EXCEEDED' | 'ASSERTION_FAILED';
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}
function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(v => jsonValue(v, depth + 1));
  return isRecord(value) && Object.values(value).every(v => jsonValue(v, depth + 1));
}
export function parseOraclePlan(value: unknown): OraclePlan {
  if (!isRecord(value) || !keys(value, ['protocol', 'image', 'budget_secs', 'cases'])
    || value.protocol !== 'node-json-rpc-v1' || typeof value.image !== 'string' || !/^(?!-)[^\s@]+@sha256:[a-f0-9]{64}$/.test(value.image)
    || typeof value.budget_secs !== 'number' || !Number.isFinite(value.budget_secs) || value.budget_secs <= 0 || value.budget_secs > 300
    || !Array.isArray(value.cases) || value.cases.length === 0 || value.cases.length > 64) throw new Error('invalid external oracle plan');
  const cases: OracleCase[] = value.cases.map(c => {
    if (!isRecord(c) || !keys(c, ['module', 'export', 'args', 'expected']) || typeof c.module !== 'string'
      || c.module.length > 240 || !/^[A-Za-z0-9_./-]+\.cjs$/.test(c.module) || c.module.startsWith('/')
      || c.module.split('/').some(p => p === '..' || p === '' || p === '.')
      || typeof c.export !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(c.export) || !Array.isArray(c.args)
      || !jsonValue(c.args) || !jsonValue(c.expected) || JSON.stringify(c.args).length > 8192 || JSON.stringify(c.expected).length > 8192) throw new Error('invalid external oracle case');
    return { module: c.module, export: c.export, args: c.args, expected: c.expected };
  });
  return { protocol: 'node-json-rpc-v1', image: value.image, budget_secs: value.budget_secs, cases };
}

// This worker is intentionally not oracle authority. A candidate may interpose
// on it or fabricate its response. Only the independent host's comparison with
// withheld expected values and completed assertion count can produce VERIFIED.
export const ORACLE_WORKER = `
const request = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
(async () => {
  const mod = require('/workspace/' + request.module);
  const f = request.export === 'default' && typeof mod === 'function' ? mod : Object.hasOwn(mod, request.export) ? mod[request.export] : null;
  if (typeof f !== 'function') throw new Error('not a function export');
  const value = await f.apply(mod, request.args);
  const encoded = JSON.stringify({ protocol: 'node-json-rpc-v1', nonce: request.nonce, value }, (_key, v) => {
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint' || (typeof v === 'number' && !Number.isFinite(v))) throw new Error('non-JSON result');
    return v;
  });
  process.stdout.write(encoded + '\\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
export function oracleProgram(request: OracleRequest): ContainerProgram {
  // Fixed program text and request data are separate argv entries. Neither a
  // shell nor eval interprets any request field as JavaScript source.
  return { executable: '/usr/local/bin/node', args: ['-e', ORACLE_WORKER, Buffer.from(JSON.stringify(request)).toString('base64')] };
}
export function evaluateOracleCases(plan: OraclePlan, invoke: (request: OracleRequest, budget: number) => BackendRunResult): OracleEvaluation {
  const counts = { planned: plan.cases.length, completed: 0, passed: 0 };
  const started = performance.now();
  if (counts.planned === 0) return { ...counts, verdict: 'CANNOT_VERIFY', reason: 'INVALID_RESPONSE' };
  for (const c of plan.cases) {
    const budget = plan.budget_secs - (performance.now() - started) / 1000;
    if (budget <= 0) return { ...counts, verdict: 'CANNOT_VERIFY', reason: 'BUDGET_EXCEEDED' };
    const request: OracleRequest = { module: c.module, export: c.export, args: c.args, nonce: randomBytes(16).toString('hex') };
    let result: BackendRunResult;
    try { result = invoke(request, budget); } catch { return { ...counts, verdict: 'CANNOT_VERIFY', reason: 'EXECUTION_FAILED' }; }
    if (result.failure || result.exit !== 0 || !result.diagnostics) return { ...counts, verdict: 'CANNOT_VERIFY', reason: result.failure === 'budget' ? 'BUDGET_EXCEEDED' : 'EXECUTION_FAILED' };
    const stdout = result.diagnostics.stdout;
    if (stdout.truncated || stdout.captured_bytes !== stdout.retained_bytes) return { ...counts, verdict: 'CANNOT_VERIFY', reason: 'INVALID_RESPONSE' };
    let response: unknown;
    try { response = JSON.parse(stdout.tail); } catch { return { ...counts, verdict: 'CANNOT_VERIFY', reason: 'INVALID_RESPONSE' }; }
    if (!isRecord(response) || !keys(response, ['protocol', 'nonce', 'value']) || response.protocol !== plan.protocol || response.nonce !== request.nonce || !jsonValue(response.value)) return { ...counts, verdict: 'CANNOT_VERIFY', reason: 'INVALID_RESPONSE' };
    counts.completed++;
    if (!isDeepStrictEqual(response.value, c.expected)) return { ...counts, verdict: 'ORACLE_RED', reason: 'ASSERTION_FAILED' };
    counts.passed++;
  }
  return { ...counts, verdict: 'VERIFIED' };
}
