import { afterEach, describe, expect, it, vi } from 'vitest';
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
const originalHelper = process.env.TW_HELPER;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHelper === undefined) delete process.env.TW_HELPER;
  else process.env.TW_HELPER = originalHelper;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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
    join(cwd, 'test', 'helper-check.js'),
    [
      "const candidate = require('../src.js');",
      'process.exit(candidate.value === 42 ? 0 : 1);',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(cwd, 'test', 'check.js'),
    [
      "const cp = require('node:child_process');",
      "const candidate = require('../src.js');",
      "const helper = process.env.TW_HELPER || '/usr/local/bin/node';",
      'candidate.beforeCheck();',
      "const r = cp.spawnSync(helper, ['test/helper-check.js'], { stdio: 'ignore' });",
      'candidate.afterCheck();',
      'process.exit(r.status ?? 1);',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(cwd, '.tamperward.yml'),
    [
      'version: 1',
      'verify:',
      '  command: node test/check.js',
      '  budget: 30',
      '  backend: container',
      `  image: ${BASE_IMAGE}`,
      '',
    ].join('\n'),
  );

  const helper = join(cwd, 'node_modules', '.bin', 'node');
  const helperBytes = Buffer.from(`#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  writeFileSync(helper, helperBytes);
  chmodSync(helper, 0o755);

  git('add', '.gitignore', '.tamperward.yml', 'src.js', 'test/check.js', 'test/helper-check.js');
  git('commit', '-qm', 'trusted base');

  // Candidate regression + fully self-restoring dependency substitution.
  writeFileSync(
    join(cwd, 'src.js'),
    [
      "const fs = require('node:fs');",
      "const helper = process.env.TW_HELPER || '/usr/local/bin/node';",
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
    const { cwd, helper, helperBytes } = repo();

    // Characterize #341 exactly: candidate source swaps the shared ignored
    // node_modules executable, gets a green child, then restores every byte/mode
    // before each stage exits. All checkpoint fingerprints therefore match.
    process.env.TW_HELPER = helper;
    const localBackend: PreparedVerifierBackend = {
      kind: 'local',
      trust: 'checkpointed-local',
      available: true,
    };
    const local = capture(() =>
      runVerify({ cwd, base: 'HEAD', json: true, verifierBackend: localBackend }),
    );
    expect(local.code).toBe(0);
    expect(local.json.verdict).toBe('VERIFIED');
    expect(local.json.verifier_backend.trust).toBe('checkpointed-local');
    expect(readFileSync(helper)).toEqual(helperBytes);

    // Fixed architecture: prepare the real digest-pinned Docker backend. No
    // host node_modules/env crosses the boundary. The candidate now targets
    // /usr/local/bin/node, which belongs to the read-only image; replacement
    // fails, and the image-owned node observes the real value=41.
    delete process.env.TW_HELPER;
    const isolated = capture(() => runVerify({ cwd, base: 'HEAD', json: true }));
    expect(isolated.code).toBe(1);
    expect(isolated.json.verdict).toBe('SUITE_RED');
    expect(isolated.json.verifier_backend).toMatchObject({
      kind: 'container',
      trust: 'isolated-container',
      image: BASE_IMAGE,
      available: true,
    });
    expect(isolated.json.dependency_environment).toMatchObject({
      status: 'verifier-owned',
      image: BASE_IMAGE,
    });
    expect(readFileSync(helper)).toEqual(helperBytes);
  }, 60_000);
});
