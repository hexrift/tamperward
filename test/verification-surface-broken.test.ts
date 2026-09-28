// A base tree git cannot list is an unevaluable authority, not a changed surface (#707).
//
// The `surface` binding input is the protected file set at the trusted base, listed with
// `git ls-tree -r <base>`. `computeBinding` promises to throw — never to return a partial
// binding — when the recorded authority can no longer be evaluated, and `status` maps that
// throw to BROKEN carrying the cause. A listing that failed used to come back as the EMPTY
// surface instead, so a base whose tree object could not be read reported STALE, "protected
// verification surface changed since verification" — a load-bearing change that never
// happened — and git's own error was shown nowhere. These tests hide a tree object under the
// base commit (the commit itself still resolves; only the recursive listing fails), and put
// it back to prove that the failed listing was the only difference.

import { afterEach, describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runVerify } from '../src/cli/verify';
import { runStatus } from '../src/cli/status';
import {
  evaluateVerificationState,
  invalidateVerificationRecordIfCurrent,
  readVerificationRecord,
  verificationRecordPath,
} from '../src/verification-state';
import { resetRepoContextCache } from '../src/repo-context';

const ROOT = resolve(__dirname, '..');
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  resetRepoContextCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A repository with a passing suite and a local-backend verifier policy, as the
 *  verification-state tests build it. */
function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-surface-'));
  dirs.push(cwd);
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.name', 't']);
  git(cwd, ['config', 'user.email', 't@b']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
  mkdirSync(join(cwd, 'test'), { recursive: true });
  writeFileSync(
    join(cwd, 'test', 'check.test.js'),
    "const v=require('../src.js'); if(v!==42){console.error('bad');process.exit(1)}\n",
  );
  writeFileSync(
    join(cwd, '.tamperward.yml'),
    ['version: 1', 'verify:', '  command: node test/check.test.js', '  budget: 30', '  backend: local', ''].join('\n'),
  );
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-qm', 'base']);
  return cwd;
}

function capture(fn: () => number): { code: number; out: string; err: string } {
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
  return { code, out, err };
}

function verify(cwd: string): number {
  return capture(() => runVerify({ cwd, silent: true })).code;
}

function validateStatus(doc: unknown): string[] {
  const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'status-v1.schema.json'), 'utf8'));
  const validator = new Ajv2020({ allErrors: true, strict: true });
  const validate = validator.compile(schema);
  return validate(doc) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

function statusJson(cwd: string): any {
  const r = capture(() => runStatus({ cwd, json: true }));
  expect(r.code).toBe(0);
  const doc = JSON.parse(r.out.trim());
  expect(validateStatus(doc), JSON.stringify(doc)).toEqual([]);
  return doc;
}

/** Move the loose object `spec` names out of the object store, so the commit above it
 *  still resolves while the recursive listing of its tree fails. The object is parked
 *  under `.git/`, which no worktree listing walks, so the candidate tree is unchanged.
 *  Returns the function that puts it back. */
function hideObject(cwd: string, spec: string): () => void {
  const sha = git(cwd, ['rev-parse', '--verify', spec]).trim();
  const path = join(cwd, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
  const aside = join(cwd, '.git', `hidden-${sha}`);
  renameSync(path, aside);
  return () => renameSync(aside, path);
}

const DETAIL = /^cannot list the protected verification surface at base [0-9a-f]{40,64}: \S/;

describe.skipIf(process.platform === 'win32')('a base tree git cannot list is BROKEN, not a changed surface (#707)', () => {
  it('evaluates to BROKEN naming the listing failure, and to CURRENT again once the tree reads', () => {
    const cwd = repo();
    expect(verify(cwd)).toBe(0);
    expect(evaluateVerificationState(cwd).state).toBe('CURRENT');

    const restore = hideObject(cwd, 'HEAD:test');
    resetRepoContextCache();
    // The commit still resolves — only the listing of the tree under it fails.
    expect(git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()).toMatch(/^[0-9a-f]{40,64}$/);
    expect(() => git(cwd, ['ls-tree', '-r', '--name-only', 'HEAD'])).toThrow();

    const s = evaluateVerificationState(cwd);
    expect(s.state).toBe('BROKEN');
    expect(s.changed_input).toBeUndefined();
    expect(s.reason).toBe('verification authority wiring is invalid or unavailable');
    expect(s.detail).toMatch(DETAIL);
    // The record is still the one verify wrote: BROKEN reports on it, never replaces it.
    expect(s.verified_at).toBe(readVerificationRecord(cwd)?.verified_at);

    restore();
    resetRepoContextCache();
    expect(evaluateVerificationState(cwd).state).toBe('CURRENT');
  });

  it('reports BROKEN with the cause on `status --json`, and the record is left in place by rule', () => {
    const cwd = repo();
    expect(verify(cwd)).toBe(0);
    const recordPath = verificationRecordPath(cwd);
    expect(recordPath).not.toBeNull();
    const before = readFileSync(recordPath!, 'utf8');

    const restore = hideObject(cwd, 'HEAD:test');
    resetRepoContextCache();
    const doc = statusJson(cwd);
    expect(doc.verification.state).toBe('BROKEN');
    expect(doc.verification.detail).toMatch(DETAIL);
    expect(doc.verification.changed_input).toBeUndefined();
    expect(doc.verification.reason).not.toMatch(/surface changed/);

    // Invalidation leaves an unevaluable authority for the BROKEN path: nothing is removed
    // and nothing is rewritten.
    expect(invalidateVerificationRecordIfCurrent(cwd)).toBe(false);
    expect(readFileSync(recordPath!, 'utf8')).toBe(before);
    restore();
  });

  it('still reports a genuine surface change as STALE naming `surface`', () => {
    const cwd = repo();
    expect(verify(cwd)).toBe(0);
    writeFileSync(
      join(cwd, '.tamperward.yml'),
      ['version: 1', 'protected:', '  extra:', '    - "**/src.js"', 'verify:', '  command: node test/check.test.js', '  budget: 30', '  backend: local', ''].join('\n'),
    );
    const s = evaluateVerificationState(cwd);
    expect(s.state).toBe('STALE');
    expect(s.changed_input).toBe('surface');
  });
});
