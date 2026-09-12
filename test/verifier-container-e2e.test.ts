import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerify } from '../src/cli/verify';
import type { PreparedVerifierBackend } from '../src/verifier-backend';

const ENABLED = process.env.TAMPERWARD_CONTAINER_E2E === '1';
const containerIt = ENABLED ? it : it.skip;
const BASE_IMAGE = 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32';

const dirs: string[] = [];
let builtImage: string | null = null;
const originalHelper = process.env.TW_HELPER;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHelper === undefined) delete process.env.TW_HELPER;
  else process.env.TW_HELPER = originalHelper;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

afterAll(() => {
  if (builtImage) {
    try { execFileSync('docker', ['image', 'rm', '-f', builtImage], { stdio: 'ignore' }); } catch {}
  }
});

function buildImage(): string {
  if (builtImage) return builtImage;
  const ctx = mkdtempSync(join(tmpdir(), 'tw-verifier-image-'));
  dirs.push(ctx);
  writeFileSync(
    join(ctx, 'Dockerfile'),
    [
      `FROM ${BASE_IMAGE}`,
      'USER root',
      'RUN mkdir -p /opt/tw-deps && printf \'#!/bin/sh\\ngrep -q "exports.value = 42" "$1"\\n\' > /opt/tw-deps/helper && chmod 0755 /opt/tw-deps/helper',
      '',
    ].join('\n'),
  );
  const tag = `tw-verifier-e2e:${process.pid}`;
  execFileSync('docker', ['build', '--pull=false', '-q', '-t', tag, ctx], { stdio: 'pipe' });
  builtImage = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], {
    encoding: 'utf8',
  }).trim();
  return builtImage;
}

function repo(): { cwd: string; helper: string; helperBytes: Buffer } {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-self-restore-'));
  dirs.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');

  mkdirSync(join(cwd, 'test'));
  mkdirSync(join(cwd, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(cwd, '.gitignore'), 'node_modules/\n');
  writeFileSync(
    join(cwd, 'src.js'),
    [
      'exports.value = 42;',
      'exports.beforeCheck = () => {};',
      'exports.afterCheck = () => {};',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(cwd, 'test', 'check.js'),
    [
      "const cp = require('node:child_process');",
      "const candidate = require('../src.js');",
      "const helper = process.env.TW_HELPER || '/opt/tw-deps/helper';",
      'candidate.beforeCheck();',
      "const r = cp.spawnSync(helper, ['src.js'], { stdio: 'ignore' });",
      'candidate.afterCheck();',
      'process.exit(r.status ?? 1);',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(cwd, '.tamperward.yml'),
    'version: 1\nverify:\n  command: node test/check.js\n  budget: 30\n',
  );

  const helper = join(cwd, 'node_modules', '.bin', 'helper');
  const helperBytes = Buffer.from('#!/bin/sh\ngrep -q "exports.value = 42" "$1"\n');
  writeFileSync(helper, helperBytes);
  chmodSync(helper, 0o755);

  git('add', '.gitignore', '.tamperward.yml', 'src.js', 'test/check.js');
  git('commit', '-qm', 'trusted base');

  // Candidate regression + fully self-restoring dependency substitution.
  writeFileSync(
    join(cwd, 'src.js'),
    [
      "const fs = require('node:fs');",
      "const helper = process.env.TW_HELPER || '/opt/tw-deps/helper';",
      'exports.value = 41;',
      'let saved = null;',
      'exports.beforeCheck = () => {',
      '  try {',
      '    const bytes = fs.readFileSync(helper);',
      '    const mode = fs.statSync(helper).mode & 0o777;',
      "    fs.writeFileSync(helper, '#!/bin/sh\\nexit 0\\n', { mode: 0o755 });",
      '    saved = { bytes, mode };',
      '  } catch { saved = null; }',
      '};',
      'exports.afterCheck = () => {',
      '  if (!saved) return;',
      '  fs.writeFileSync(helper, saved.bytes, { mode: saved.mode });',
      '  saved = null;',
      '};',
      '',
    ].join('\n'),
  );

  return { cwd, helper, helperBytes };
}

function capture(fn: () => number): { code: number; json: any } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const code = fn();
  const json = JSON.parse(chunks.join('').trim().split('\n').at(-1)!);
  vi.restoreAllMocks();
  return { code, json };
}

describe('isolated backend closes fully self-restoring dependency substitution (#341)', () => {
  containerIt('pre-fix local boundary is fooled, isolated verifier-owned dependency is not', () => {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
    const image = buildImage();
    const { cwd, helper, helperBytes } = repo();

    // Characterization of the residual from #341: both stages execute a shared,
    // writable helper. Candidate source swaps it to exit 0 and restores every
    // byte/mode before each stage exits, so checkpoint hashes remain identical.
    process.env.TW_HELPER = helper;
    const local = capture(() => runVerify({ cwd, base: 'HEAD', json: true }));
    expect(local.code).toBe(0);
    expect(local.json.verdict).toBe('VERIFIED');
    expect(readFileSync(helper)).toEqual(helperBytes);

    // Fixed architecture: no host dependency tree/env crosses the boundary.
    // The same candidate tries /opt/tw-deps/helper, but that helper belongs to
    // the digest-derived image and the container rootfs is read-only. The write
    // cannot happen; the honest helper observes value=41 and the suite is red.
    delete process.env.TW_HELPER;
    const backend: PreparedVerifierBackend = {
      kind: 'container',
      trust: 'isolated-container',
      available: true,
      engine: 'docker',
      image,
    };
    const isolated = capture(() =>
      runVerify({ cwd, base: 'HEAD', json: true, verifierBackend: backend }),
    );
    expect(isolated.code).toBe(1);
    expect(isolated.json.verdict).toBe('SUITE_RED');
    expect(isolated.json.verifier_backend).toMatchObject({
      kind: 'container',
      trust: 'isolated-container',
    });
    expect(readFileSync(helper)).toEqual(helperBytes);
  }, 60_000);
});
