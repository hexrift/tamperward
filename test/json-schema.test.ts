import { afterEach, describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { runCheck } from '../src/cli/check';
import { runVerify } from '../src/cli/verify';
import { runDoctor } from '../src/cli/doctor';
import { runEnvelope, trustedLinuxPython } from '../src/cli/run';
import { runInit } from '../src/cli/init';
import { validateCliArgs } from '../src/cli/main';
import { defaultPolicy } from '../src/policy';
import { defaultEventLog } from '../src/cli/watch';

const ROOT = resolve(__dirname, '..');
const dirs: string[] = [];
const SCHEMA_NAMES = ['check', 'verify', 'run', 'doctor'] as const;
type SchemaName = typeof SCHEMA_NAMES[number];

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function initGit(cwd: string): void {
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.name', 't'], { cwd });
  execFileSync('git', ['config', 'user.email', 't@b'], { cwd });
}

function repo(withTest = false): string {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-schema-'));
  dirs.push(cwd);
  initGit(cwd);
  writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
  if (withTest) {
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(
      join(cwd, 'test', 'check.test.js'),
      "const v=require('../src.js'); if(v!==42){console.error('expected 42, got '+v);process.exit(1)}\n",
    );
  }
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd });
  return cwd;
}

function capture(fn: () => number | void): { code: number; out: string; err: string } {
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
  return { code: typeof code === 'number' ? code : 0, out, err };
}

function parseOnlyJson(out: string): any {
  const trimmed = out.trim();
  expect(trimmed).not.toBe('');
  expect(() => JSON.parse(trimmed)).not.toThrow();
  return JSON.parse(trimmed);
}

function schemaFrom(root: string, name: SchemaName): any {
  const path = join(root, 'schemas', `${name}-v1.schema.json`);
  expect(existsSync(path), `published schema missing: ${path}`).toBe(true);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function ajv(): Ajv2020 {
  return new Ajv2020({ allErrors: true, strict: true });
}

function validateDoc(name: SchemaName, doc: unknown, root = ROOT): string[] {
  const validator = ajv();
  const schema = schemaFrom(root, name);
  expect(validator.validateSchema(schema), JSON.stringify(validator.errors)).toBe(true);
  const validate = validator.compile(schema);
  return validate(doc) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

function writeVerifierPolicy(cwd: string, backend: 'local' | 'container' = 'local'): void {
  const image = 'node@sha256:' + 'a'.repeat(64);
  writeFileSync(
    join(cwd, '.tamperward.yml'),
    [
      'version: 1',
      'verify:',
      '  command: node test/check.test.js',
      '  budget: 30',
      `  backend: ${backend}`,
      ...(backend === 'container' ? [`  image: ${image}`] : []),
      '',
    ].join('\n'),
  );
}

function healthyDoctorRepo(): string {
  const cwd = repo(true);
  writeVerifierPolicy(cwd, 'container');
  capture(() => runInit({ cwd, forceWorkflow: true }));

  const log = defaultEventLog(cwd);
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(
    log + '.health.json',
    JSON.stringify({
      version: 1,
      state: 'healthy',
      backend: 'fallback',
      pid: process.pid,
      started_at: new Date().toISOString(),
      stopped_at: null,
      watched_dirs: 1,
      last_append_at: null,
      event_count: 0,
      dropped_events: 0,
      error_count: 0,
      last_error: null,
      log,
    }) + '\n',
  );
  return cwd;
}

function buildPackExtract(): { packageRoot: string; tarball: string } {
  const tmp = mkdtempSync(join(ROOT, '.tw-pack-schema-'));
  dirs.push(tmp);
  const packageRoot = join(tmp, 'extract', 'package');
  const dist = join(ROOT, 'dist');
  const hadDist = existsSync(dist);
  mkdirSync(dirname(packageRoot), { recursive: true });
  mkdirSync(join(dist, 'cli'), { recursive: true });

  try {
    buildSync({
      entryPoints: [join(ROOT, 'src', 'cli', 'index.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      outfile: join(dist, 'cli', 'index.js'),
    });

    // Pack the ACTUAL repository/package manifest, not a reconstructed staging
    // directory. This is the publish surface users receive.
    const packed = JSON.parse(execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', tmp],
      { cwd: ROOT, encoding: 'utf8' },
    )) as Array<{ filename: string; files?: Array<{ path: string }> }>;
    expect(packed).toHaveLength(1);

    const paths = new Set((packed[0].files ?? []).map((x) => x.path));
    expect(paths.has('dist/cli/index.js')).toBe(true);
    for (const name of SCHEMA_NAMES) {
      expect(paths.has(`schemas/${name}-v1.schema.json`)).toBe(true);
    }

    const tarball = join(tmp, packed[0].filename);
    execFileSync('tar', ['-xzf', tarball, '-C', dirname(packageRoot)]);
    return { packageRoot, tarball };
  } finally {
    if (!hadDist) rmSync(dist, { recursive: true, force: true });
  }
}

function packagedCli(
  packageRoot: string,
  cwd: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    [join(packageRoot, 'dist', 'cli', 'index.js'), ...args],
    { cwd, encoding: 'utf8', env: process.env },
  );
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('machine-readable schema v1 (#333)', () => {
  it('all published schemas are valid Draft 2020-12 schemas, and the validator is not permissive', () => {
    const validator = ajv();
    for (const name of SCHEMA_NAMES) {
      const s = schemaFrom(ROOT, name);
      expect(s.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(validator.validateSchema(s), `${name}: ${JSON.stringify(validator.errors)}`).toBe(true);
      expect(() => validator.compile(s)).not.toThrow();
    }

    const denyEverything = validator.compile(false);
    expect(denyEverything({ schema_version: 1 })).toBe(false);
    expect(
      validator.validateSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'definitely-not-a-json-schema-type',
      }),
    ).toBe(false);
  });

  it('check v1 covers clean, block, and warn without changing exit semantics', () => {
    const clean = repo(true);
    let r = capture(() => runCheck({ cwd: clean, worktree: true, json: true }));
    expect(r.code).toBe(0);
    let doc = parseOnlyJson(r.out);
    expect(validateDoc('check', doc)).toEqual([]);
    expect(doc.summary).toEqual({ block: 0, warn: 0 });

    const block = repo(true);
    rmSync(join(block, 'test', 'check.test.js'));
    r = capture(() => runCheck({ cwd: block, worktree: true, json: true }));
    expect(r.code).toBe(1);
    doc = parseOnlyJson(r.out);
    expect(validateDoc('check', doc)).toEqual([]);
    expect(doc.summary.block).toBeGreaterThan(0);

    const warn = repo(true);
    rmSync(join(warn, 'test', 'check.test.js'));
    const policy = defaultPolicy();
    policy.rules['test-deletion'] = { ...policy.rules['test-deletion'], severity: 'warn' };
    r = capture(() => runCheck({ cwd: warn, worktree: true, json: true, policyOverride: policy }));
    expect(r.code).toBe(0);
    doc = parseOnlyJson(r.out);
    expect(validateDoc('check', doc)).toEqual([]);
    expect(doc.summary.warn).toBeGreaterThan(0);
    expect(doc.summary.block).toBe(0);
  });

  it('verify v1 covers verified, suite-red, masked, budget and cannot-verify paths', () => {
    const ok = repo(true);
    let r = capture(() => runVerify({ cwd: ok, base: 'HEAD', cmd: 'node test/check.test.js', budget: 2, json: true }));
    expect(r.code).toBe(0);
    let doc = parseOnlyJson(r.out);
    expect(doc.verdict).toBe('VERIFIED');
    expect(validateDoc('verify', doc)).toEqual([]);

    const red = repo(true);
    writeFileSync(join(red, 'src.js'), 'module.exports = 41;\n');
    r = capture(() => runVerify({ cwd: red, base: 'HEAD', cmd: 'node test/check.test.js', budget: 2, json: true }));
    expect(r.code).toBe(1);
    doc = parseOnlyJson(r.out);
    expect(doc.verdict).toBe('SUITE_RED');
    expect(validateDoc('verify', doc)).toEqual([]);

    const masked = repo(true);
    writeFileSync(join(masked, 'src.js'), 'module.exports = 41;\n');
    writeFileSync(join(masked, 'test', 'check.test.js'), 'process.exit(0);\n');
    r = capture(() => runVerify({ cwd: masked, base: 'HEAD', cmd: 'node test/check.test.js', budget: 2, json: true }));
    expect(r.code).toBe(1);
    doc = parseOnlyJson(r.out);
    expect(doc.verdict).toBe('MASKED_FAILURE');
    expect(validateDoc('verify', doc)).toEqual([]);

    const budget = repo(true);
    r = capture(() => runVerify({
      cwd: budget,
      base: 'HEAD',
      cmd: `${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},5000)"`,
      budget: 0.1,
      json: true,
    }));
    expect(r.code).toBe(2);
    doc = parseOnlyJson(r.out);
    expect(doc.verdict).toBe('BUDGET_EXCEEDED');
    expect(validateDoc('verify', doc)).toEqual([]);

    const invalid = repo(true);
    r = capture(() => runVerify({ cwd: invalid, json: true, invalid: '--base needs a value' }));
    expect(r.code).toBe(2);
    doc = parseOnlyJson(r.out);
    expect(doc).toMatchObject({ schema_version: 1, verdict: 'CANNOT_VERIFY', reason: 'INVALID_ARGUMENTS' });
    expect(validateDoc('verify', doc)).toEqual([]);
  }, 30_000);

  it('doctor v1 covers authoritative healthy/degraded posture, broken posture, and malformed policy', () => {
    if (process.platform === 'linux' && trustedLinuxPython().path) {
      const healthy = healthyDoctorRepo();
      let r = capture(() => runDoctor({ cwd: healthy, json: true }));
      expect(r.code).toBe(0);
      let doc = parseOnlyJson(r.out);
      expect(doc.authoritative).toBe(true);
      expect(doc.checks.every((x: any) => x.state === 'OK')).toBe(true);
      expect(validateDoc('doctor', doc)).toEqual([]);

      rmSync(defaultEventLog(healthy) + '.health.json', { force: true });
      r = capture(() => runDoctor({ cwd: healthy, json: true }));
      expect(r.code).toBe(0);
      doc = parseOnlyJson(r.out);
      expect(doc.authoritative).toBe(true);
      expect(doc.checks.some((x: any) => x.state === 'WARN')).toBe(true);
      expect(validateDoc('doctor', doc)).toEqual([]);
    }

    const broken = repo(true);
    writeVerifierPolicy(broken);
    let r = capture(() => runDoctor({ cwd: broken, json: true }));
    expect(r.code).toBe(2);
    let doc = parseOnlyJson(r.out);
    expect(doc.authoritative).toBe(false);
    expect(doc.checks.some((x: any) => x.state === 'BROKEN')).toBe(true);
    expect(validateDoc('doctor', doc)).toEqual([]);

    const malformed = repo(true);
    writeFileSync(join(malformed, '.tamperward.yml'), 'verify: [not-a-mapping\n');
    r = capture(() => runDoctor({ cwd: malformed, json: true }));
    expect(r.code).toBe(2);
    doc = parseOnlyJson(r.out);
    expect(doc.authoritative).toBe(false);
    expect(doc.checks.some((x: any) => x.id === 'policy' && x.state === 'BROKEN')).toBe(true);
    expect(validateDoc('doctor', doc)).toEqual([]);
  }, 30_000);

  it.skipIf(process.platform !== 'linux' || !trustedLinuxPython().path)('run v1 covers success, agent failure, timeout, enforcement failure and cannot-adjudicate', () => {
    expect(validateCliArgs('run', ['--json', '--', 'sh', '-c', 'true'])).toBeUndefined();

    const ok = repo(true);
    let r = capture(() => runEnvelope({ cwd: ok, cmd: 'node test/check.test.js', budget: 2, json: true, argv: ['sh', '-c', 'true'] }));
    expect(r.code).toBe(0);
    let doc = parseOnlyJson(r.out);
    expect(doc.verdict).toBe('VERIFIED');
    expect(validateDoc('run', doc)).toEqual([]);

    const failed = repo(true);
    r = capture(() => runEnvelope({ cwd: failed, cmd: 'node test/check.test.js', budget: 2, json: true, argv: ['sh', '-c', 'exit 7'] }));
    expect(r.code).toBe(7);
    doc = parseOnlyJson(r.out);
    expect(doc).toMatchObject({ verdict: 'AGENT_FAILED', exit_code: 7 });
    expect(validateDoc('run', doc)).toEqual([]);

    const timeout = repo(true);
    r = capture(() => runEnvelope({
      cwd: timeout,
      cmd: 'node test/check.test.js',
      budget: 2,
      agentBudget: 0.1,
      json: true,
      argv: ['sh', '-c', 'sleep 5'],
    }));
    expect(r.code).toBe(124);
    doc = parseOnlyJson(r.out);
    expect(doc).toMatchObject({ verdict: 'AGENT_TIMEOUT', exit_code: 124 });
    expect(validateDoc('run', doc)).toEqual([]);

    const blocked = repo(true);
    r = capture(() => runEnvelope({
      cwd: blocked,
      cmd: 'true',
      budget: 2,
      json: true,
      argv: ['sh', '-c', 'rm test/check.test.js'],
    }));
    expect(r.code).toBe(1);
    doc = parseOnlyJson(r.out);
    expect(doc.exit_code).toBe(1);
    expect(['ENFORCEMENT_FAILED', 'NOT_QUIESCENT']).toContain(doc.verdict);
    expect(validateDoc('run', doc)).toEqual([]);

    const cannot = repo(true);
    r = capture(() => runEnvelope({
      cwd: cannot,
      cmd: 'true',
      budget: 2,
      json: true,
      lifecycleTestMode: 'drain-timeout',
      argv: ['sh', '-c', 'true'],
    }));
    expect(r.code).toBe(2);
    doc = parseOnlyJson(r.out);
    expect(doc).toMatchObject({
      verdict: 'CANNOT_ADJUDICATE',
      exit_code: 2,
      reason: 'AGENT_LIFECYCLE_NOT_OWNED',
    });
    expect(validateDoc('run', doc)).toEqual([]);
  }, 45_000);

  it('negative fixtures prove required fields, nested types, discriminants, versions and numeric constraints', () => {
    const cwd = repo(true);
    const r = capture(() => runVerify({ cwd, base: 'HEAD', cmd: 'node test/check.test.js', budget: 2, json: true }));
    const doc = parseOnlyJson(r.out);
    expect(validateDoc('verify', doc)).toEqual([]);

    const badVersion = structuredClone(doc);
    badVersion.schema_version = 2;
    expect(validateDoc('verify', badVersion)).not.toEqual([]);

    const missingBackendCore = structuredClone(doc);
    delete missingBackendCore.verifier_backend.available;
    expect(validateDoc('verify', missingBackendCore)).not.toEqual([]);

    const wrongNestedType = structuredClone(doc);
    wrongNestedType.visible.exit = '0';
    expect(validateDoc('verify', wrongNestedType)).not.toEqual([]);

    const badDiscriminator = structuredClone(doc);
    badDiscriminator.verdict = 'TOTALLY_GREEN';
    expect(validateDoc('verify', badDiscriminator)).not.toEqual([]);

    const negativeNumeric = structuredClone(doc);
    negativeNumeric.visible.secs = -1;
    expect(validateDoc('verify', negativeNumeric)).not.toEqual([]);

    const additive = structuredClone(doc);
    additive.future_evidence = { safe_to_ignore_in_v1: true };
    additive.verifier_backend.future_backend_evidence = 1;
    expect(validateDoc('verify', additive)).toEqual([]);
  });

  it('npm pack contains usable schemas and the packaged CLI emits one clean JSON document with a noisy agent', () => {
    const { packageRoot, tarball } = buildPackExtract();
    expect(existsSync(tarball)).toBe(true);

    for (const name of SCHEMA_NAMES) {
      const s = schemaFrom(packageRoot, name);
      const validator = ajv();
      expect(validator.validateSchema(s), `${name}: ${JSON.stringify(validator.errors)}`).toBe(true);
      expect(() => validator.compile(s)).not.toThrow();
    }

    const cwd = repo(true);
    const check = packagedCli(packageRoot, cwd, ['check', '--json', '--worktree']);
    expect(check.status).toBe(0);
    expect(validateDoc('check', parseOnlyJson(check.stdout), packageRoot)).toEqual([]);

    const verify = packagedCli(packageRoot, cwd, ['verify', '--json', '--base', 'HEAD', '--cmd', 'node test/check.test.js', '--budget', '2']);
    expect(verify.status).toBe(0);
    expect(validateDoc('verify', parseOnlyJson(verify.stdout), packageRoot)).toEqual([]);

    const doctor = packagedCli(packageRoot, cwd, ['doctor', '--json']);
    expect(doctor.status).toBe(2);
    expect(validateDoc('doctor', parseOnlyJson(doctor.stdout), packageRoot)).toEqual([]);

    if (process.platform === 'linux' && trustedLinuxPython().path) {
      const run = packagedCli(packageRoot, cwd, [
        'run', '--json', '--cmd', 'node test/check.test.js', '--budget', '2', '--',
        'sh', '-c', 'printf "agent-stdout\\n"; printf "agent-stderr\\n" >&2',
      ]);
      expect(run.status).toBe(0);
      const runDoc = parseOnlyJson(run.stdout);
      expect(run.stdout.trim().split('\n')).toHaveLength(1);
      expect(run.stdout).not.toContain('agent-stdout');
      expect(run.stderr).toContain('agent-stdout');
      expect(run.stderr).toContain('agent-stderr');
      expect(validateDoc('run', runDoc, packageRoot)).toEqual([]);
    }
  }, 60_000);
});
