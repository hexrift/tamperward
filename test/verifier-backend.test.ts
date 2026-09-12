import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerify } from '../src/cli/verify';
import { runEnvelope } from '../src/cli/run';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FAKE_IMAGE =
  'registry.invalid/tamperward/verifier@sha256:' + 'a'.repeat(64);

function repo(backend: 'local' | 'container' = 'local'): string {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-backend-'));
  dirs.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
  writeFileSync(
    join(cwd, 'test', 'check.js'),
    `if (require('../src.js') !== 42) process.exit(1);\n`,
  );
  writeFileSync(
    join(cwd, '.tamperward.yml'),
    [
      'version: 1',
      'verify:',
      '  command: node test/check.js',
      '  budget: 30',
      `  backend: ${backend}`,
      ...(backend === 'container' ? [`  image: ${FAKE_IMAGE}`] : []),
      '',
    ].join('\n'),
  );
  git('add', '-A');
  git('commit', '-qm', 'base');
  return cwd;
}

function capture(fn: () => number): { code: number; text: string; json?: any } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const code = fn();
  const text = chunks.join('');
  let json: any;
  try { json = JSON.parse(text.trim().split('\n').at(-1)!); } catch {}
  return { code, text, json };
}

describe('trusted verifier backend boundary', () => {
  it('reports the legacy local verifier as explicitly weaker trust', () => {
    const cwd = repo('local');
    const r = capture(() => runVerify({ cwd, base: 'HEAD', json: true }));

    expect(r.code).toBe(0);
    expect(r.json.verifier_backend).toMatchObject({
      kind: 'local',
      trust: 'checkpointed-local',
    });
  });

  it('never silently falls back to local when the pinned isolated image cannot be established', () => {
    const cwd = repo('container');
    const r = capture(() => runVerify({ cwd, base: 'HEAD', json: true }));

    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({
      verdict: 'CANNOT_VERIFY',
      reason: 'VERIFIER_BACKEND_UNAVAILABLE',
      verifier_backend: {
        kind: 'container',
        trust: 'isolated-container',
        image: FAKE_IMAGE,
      },
    });
  });

  it('the envelope establishes the isolated boundary before executing the agent', () => {
    const cwd = repo('container');
    const sideEffect = join(cwd, 'agent-ran');

    const code = runEnvelope({
      cwd,
      argv: ['bash', '-c', 'touch agent-ran'],
    });

    expect(code).toBe(2);
    expect(existsSync(sideEffect)).toBe(false);
  });

  it('trusted-base container policy still binds after the candidate rewrites its working policy to local', () => {
    const cwd = repo('container');
    writeFileSync(
      join(cwd, '.tamperward.yml'),
      'version: 1\nverify:\n  command: node test/check.js\n  budget: 30\n  backend: local\n',
    );

    const r = capture(() => runVerify({ cwd, base: 'HEAD', json: true }));
    expect(r.code).toBe(2);
    expect(r.json?.verifier_backend?.kind).toBe('container');
  });
});
