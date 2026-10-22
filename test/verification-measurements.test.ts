import { afterEach, describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerify } from '../src/cli/verify';
import { configuredAuditPath, runStats } from '../src/cli/audit';
import { parseMeasurement, recordMeasurement } from '../src/cli/measurements';
import { runMeasureSuite } from '../src/cli/measure-suite';
import { guardedMain } from '../src/cli/main';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-measure-')); dirs.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd });
  git('init', '-q'); git('config', 'user.name', 'h'); git('config', 'user.email', 'h@x');
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, 'src.cjs'), 'module.exports = 42;\n');
  writeFileSync(join(cwd, 'test', 'check.cjs'), "if (require('../src.cjs') !== 42) process.exit(1);\n");
  writeFileSync(join(cwd, '.tamperward.yml'), 'version: 1\nverify:\n  command: node test/check.cjs\n  budget: 10\n');
  git('add', '.'); git('commit', '-qm', 'seed');
  return cwd;
}
function events(cwd: string) {
  return readFileSync(configuredAuditPath(cwd) + '.measurements', 'utf8').trim().split('\n').map(line => parseMeasurement(JSON.parse(line)));
}
const unix = process.platform !== 'win32';
describe('verification measurement producers (#779)', () => {
  it.runIf(unix)('records independent bare and verify samples without fabricating findings', () => {
    const cwd = fixture(); vi.stubEnv('TAMPERWARD_AUDIT_LOG', 'auto');
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(runMeasureSuite(['--cwd', cwd, '--cmd', 'node test/check.cjs', '--budget', '10'])).toBe(0);
    expect(runVerify({ cwd, silent: true })).toBe(0);
    const measured = events(cwd);
    expect(measured.map(e => e.outcome)).toEqual(['PASSED', 'VERIFIED']);
    expect(measured[0].comparison).toBe(measured[1].comparison);
    expect(measured[1].oob_signoff).toBe(false);
    expect(measured[1].duration_ms).toBeGreaterThanOrEqual(0);
    const validate = new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync(join(__dirname, '../schemas/measurement-v1.schema.json'), 'utf8')));
    for (const e of measured) expect(validate(e), JSON.stringify(validate.errors)).toBe(true);
    // The write-authorized publisher uses an independent, dependency-free
    // validator. It must accept the new sidecar schema as well.
    execFileSync(process.execPath, [join(__dirname, '../.github/audit/audit-verify.mjs'), join(__dirname, '../schemas/measurement-v1.schema.json'), configuredAuditPath(cwd) + '.measurements']);
    // Duplicate transport must not double-count an invocation.
    writeFileSync(configuredAuditPath(cwd) + '.measurements', measured.concat(measured[0]).map(e => JSON.stringify(e)).join('\n'));
    stdout.mockClear(); runStats({ cwd, json: true });
    const summary = JSON.parse(String(stdout.mock.calls[0][0]));
    expect(summary).toMatchObject({ events: 0, blocked: 0, warnings: 0, sessions: 0, by_rule: [], measurements: { verify: 1, bare_suite: 1, incomplete: 0, signoffs: 0 } });
    expect(summary.latency.verify_wall_clock_ms.samples).toBe(1);
    expect(summary.latency.bare_suite_wall_clock_ms.samples).toBe(1);
    const validateStats = new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync(join(__dirname, '../schemas/stats-v1.schema.json'), 'utf8')));
    expect(validateStats(summary), JSON.stringify(validateStats.errors)).toBe(true);
  });
  it.runIf(unix)('keeps red verification red and records only actual authorized sign-offs', () => {
    const cwd = fixture(); vi.stubEnv('TAMPERWARD_AUDIT_LOG', 'auto');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    writeFileSync(join(cwd, 'src.cjs'), 'module.exports = 0;\n');
    expect(runVerify({ cwd, silent: true })).toBe(1);
    writeFileSync(join(cwd, 'test', 'check.cjs'), '// removed checks\n');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    vi.stubEnv('TAMPERWARD_OOB_HEAD', head);
    vi.stubEnv('TAMPERWARD_OOB_SIGNOFF', `verify@${head}`);
    expect(runVerify({ cwd, silent: true })).toBe(0);
    const measured = events(cwd);
    expect(measured.map(e => [e.outcome, e.oob_signoff])).toEqual([['SUITE_RED', false], ['MASKED_FAILURE', true]]);
    expect(JSON.stringify(measured)).not.toContain(head);
    expect(JSON.stringify(measured)).not.toContain('verify@');
  });
  it('records early failure as measured, but unknown sign-off remains absent', () => {
    const cwd = fixture(); vi.stubEnv('TAMPERWARD_AUDIT_LOG', 'auto');
    expect(runVerify({ cwd, silent: true, invalid: 'test fault' })).toBe(2);
    expect(events(cwd)[0]).toMatchObject({ outcome: 'CANNOT_VERIFY' });
    expect(events(cwd)[0]).not.toHaveProperty('oob_signoff');
  });
  it('does not let telemetry failure change a verdict, and opt-out writes nothing', () => {
    const cwd = fixture(); vi.stubEnv('TAMPERWARD_AUDIT_LOG', '');
    expect(runVerify({ cwd, silent: true, invalid: 'test fault' })).toBe(2);
    expect(existsSync(join(cwd, '.git/tamperward/audit.jsonl.measurements'))).toBe(false);
    vi.stubEnv('TAMPERWARD_AUDIT_LOG', 'auto');
    mkdirSync(configuredAuditPath(cwd) + '.measurements', { recursive: true });
    expect(runVerify({ cwd, silent: true, invalid: 'test fault' })).toBe(2);
  });
  it('preserves an observer exception and records an incomplete invocation', () => {
    const cwd = fixture(); vi.stubEnv('TAMPERWARD_AUDIT_LOG', 'auto');
    expect(() => runVerify({ cwd, silent: true, invalid: 'test fault', onVerdict: () => { throw new Error('observer fault'); } })).toThrow('observer fault');
    expect(events(cwd)[0].outcome).toBe('INCOMPLETE');
    expect(events(cwd)[0]).not.toHaveProperty('oob_signoff');
  });
  it('strictly rejects private fields and inconsistent outcomes', () => {
    const e = { schema_version: 1, id: 'sha256:' + 'a'.repeat(32), timestamp: '2026-10-22T00:00:00.000Z', kind: 'verify', outcome: 'VERIFIED', duration_ms: 1 };
    expect(parseMeasurement(e).outcome).toBe('VERIFIED');
    expect(() => parseMeasurement({ ...e, command: 'secret' })).toThrow(/unsupported/);
    expect(() => parseMeasurement({ ...e, duration_ms: -1 })).toThrow();
    expect(() => parseMeasurement({ ...e, kind: 'bare-suite' })).toThrow();
    expect(() => parseMeasurement({ ...e, outcome: 'PASSED' })).toThrow();
    expect(() => parseMeasurement({ ...e, kind: 'bare-suite', outcome: 'PASSED', oob_signoff: false })).toThrow();
    expect(() => recordMeasurement(null, { kind: 'verify', outcome: 'INCOMPLETE', duration_ms: 0 })).not.toThrow();
  });
  it.runIf(unix)('refuses to treat a suite that mutates its inputs as a comparator', () => {
    const cwd = fixture(); vi.stubEnv('TAMPERWARD_AUDIT_LOG', 'auto');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(runMeasureSuite(['--cwd', cwd, '--cmd', "node -e \"require('fs').writeFileSync('src.cjs','changed')\""])).toBe(2);
    expect(events(cwd)[0].outcome).toBe('INCOMPLETE');
  });
  it.runIf(unix)('records timeout as incomplete without a completed duration sample', () => {
    const cwd = fixture(); vi.stubEnv('TAMPERWARD_AUDIT_LOG', 'auto');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(runMeasureSuite(['--cwd', cwd, '--cmd', 'node -e "setInterval(() => {}, 1000)"', '--budget', '0.05'])).toBe(2);
    expect(events(cwd)[0].outcome).toBe('INCOMPLETE');
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true); output.mockClear();
    runStats({ cwd, json: true });
    expect(JSON.parse(String(output.mock.calls[0][0]))).toMatchObject({ latency: { bare_suite_wall_clock_ms: null }, measurements: { incomplete: 1 } });
  });
  it('rejects a missing command before execution', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(guardedMain(['measure-suite', '--budget', '1'])).toBe(2);
    expect(String(stderr.mock.calls[0][0])).toContain('requires --cmd');
  });
});
