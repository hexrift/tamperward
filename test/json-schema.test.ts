import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { report } from '../src/cli/report';
import { runVerify } from '../src/cli/verify';
import { runDoctor } from '../src/cli/doctor';
import { runEnvelope } from '../src/cli/run';
import { validateCliArgs } from '../src/cli/main';
import type { Finding } from '../src/types';

const ROOT = resolve(__dirname, '..');
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-schema-'));
  dirs.push(cwd);
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.name', 't'], { cwd });
  execFileSync('git', ['config', 'user.email', 't@b'], { cwd });
  writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
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
  return { code: typeof code === 'number' ? code : 0, out, err };
}

type Schema = {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: boolean;
};

function validate(value: unknown, schema: Schema, at = '$'): string[] {
  const errors: string[] = [];
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.some((x) => Object.is(x, value))) {
    errors.push(`${at}: expected one of ${schema.enum.map((x) => JSON.stringify(x)).join(', ')}`);
    return errors;
  }
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${at}: expected object`);
      return errors;
    }
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) errors.push(`${at}: missing ${key}`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        errors.push(...validate(object[key], child, `${at}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(object)) if (!allowed.has(key)) errors.push(`${at}: unexpected ${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${at}: expected array`);
      return errors;
    }
    if (schema.items) value.forEach((item, i) => errors.push(...validate(item, schema.items!, `${at}[${i}]`)));
  } else if (schema.type === 'string' && typeof value !== 'string') {
    errors.push(`${at}: expected string`);
  } else if (schema.type === 'number' && typeof value !== 'number') {
    errors.push(`${at}: expected number`);
  } else if (schema.type === 'integer' && !(typeof value === 'number' && Number.isInteger(value))) {
    errors.push(`${at}: expected integer`);
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') {
    errors.push(`${at}: expected boolean`);
  }
  return errors;
}

function schema(name: 'check' | 'verify' | 'run' | 'doctor'): Schema {
  const path = join(ROOT, 'schemas', `${name}-v1.schema.json`);
  expect(existsSync(path), `published schema missing: ${path}`).toBe(true);
  return JSON.parse(readFileSync(path, 'utf8')) as Schema;
}

function parseOnlyJson(out: string): any {
  const trimmed = out.trim();
  expect(trimmed).not.toBe('');
  expect(() => JSON.parse(trimmed)).not.toThrow();
  return JSON.parse(trimmed);
}

describe('machine-readable schema v1 (#333)', () => {
  it('check --json output carries schema_version and validates against the published check schema', () => {
    const finding: Finding = {
      rule: 'test-deletion',
      severity: 'block',
      file: 'test/a.test.ts',
      line: 2,
      message: 'test removed',
      evidence: '- expect(x)',
      remediation: 'restore the test',
      signoff: { required: true, command: 'tamperward allow test-deletion --reason "..."' },
    };
    const r = capture(() => report({ findings: [finding], scanned: 3, ignoredFiles: 1, json: true }));
    const doc = parseOnlyJson(r.out);
    expect(doc.schema_version).toBe(1);
    expect(validate(doc, schema('check'))).toEqual([]);
  });

  it('verify --json output carries schema_version and validates against the published verify schema', () => {
    const cwd = repo();
    const r = capture(() => runVerify({ cwd, base: 'HEAD', cmd: 'true', budget: 2, json: true }));
    expect(r.code).toBe(0);
    const doc = parseOnlyJson(r.out);
    expect(doc.schema_version).toBe(1);
    expect(doc.verdict).toBe('VERIFIED');
    expect(validate(doc, schema('verify'))).toEqual([]);
  }, 10_000);

  it('doctor --json output carries schema_version and validates against the published doctor schema', () => {
    const cwd = repo();
    const r = capture(() => runDoctor({ cwd, json: true }));
    const doc = parseOnlyJson(r.out);
    expect(doc.schema_version).toBe(1);
    expect(doc.command).toBe('doctor');
    expect(validate(doc, schema('doctor'))).toEqual([]);
  });

  it.skipIf(process.platform !== 'linux')('run --json emits one schema-valid final verdict document', () => {
    const cwd = repo();
    expect(validateCliArgs('run', ['--json', '--', 'sh', '-c', 'true'])).toBeUndefined();
    const r = capture(() => runEnvelope({
      cwd,
      cmd: 'true',
      budget: 2,
      json: true,
      argv: ['sh', '-c', 'true'],
    } as any));
    expect(r.code).toBe(0);
    const doc = parseOnlyJson(r.out);
    expect(doc.schema_version).toBe(1);
    expect(doc.verdict).toBe('VERIFIED');
    expect(doc.exit_code).toBe(0);
    expect(validate(doc, schema('run'))).toEqual([]);
  }, 20_000);

  it.skipIf(process.platform !== 'linux')('run --json remains schema-valid on a post-agent lifecycle cannot-adjudicate path', () => {
    const cwd = repo();
    const r = capture(() => runEnvelope({
      cwd,
      cmd: 'true',
      budget: 2,
      json: true,
      lifecycleTestMode: 'drain-timeout',
      argv: ['sh', '-c', 'true'],
    }));
    expect(r.code).toBe(2);
    const doc = parseOnlyJson(r.out);
    expect(doc).toMatchObject({
      schema_version: 1,
      verdict: 'CANNOT_ADJUDICATE',
      exit_code: 2,
      reason: 'AGENT_LIFECYCLE_NOT_OWNED',
    });
    expect(validate(doc, schema('run'))).toEqual([]);
  }, 20_000);

  it('ships all v1 schemas in the npm package file set', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('schemas');
    for (const name of ['check', 'verify', 'run', 'doctor']) {
      expect(existsSync(join(ROOT, 'schemas', `${name}-v1.schema.json`))).toBe(true);
    }
  });
});
