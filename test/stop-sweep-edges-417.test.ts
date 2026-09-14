// #417: two fail-open edges in the Stop path.
//
// 1. The sweep allowed on ANY cwd `git rev-parse` failed in: a directory that does not
//    exist, one the hook cannot read, and a genuine non-repository all produced the same
//    empty stdout at exit 0, while PreToolUse denies the first two. "Nothing to compare"
//    is only the case when the directory is there, readable, and git itself reports that
//    it lies outside every repository; every other failure is a verdict the gate could not
//    compute, and is denied with a diagnostic.
//
// 2. The turn baseline was written with a plain writeFileSync and any bookkeeping failure
//    returned null, which silently downgraded the sweep to `git diff HEAD` — making a
//    mid-turn commit invisible again, the exact case the baseline exists for. A parallel
//    hook could read a half-written sha, and the guard accepted 7–40 hex characters so a
//    truncated prefix passed. The baseline is now written to a temp file and renamed into
//    place, read only as exactly 40 hex characters (anything else is absent and is
//    re-established), and a write that fails denies the turn with a diagnostic.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopVerdict } from '../src/cli/hook';
import { turnBaseline } from '../src/session';

const isRoot = typeof process.geteuid === 'function' && process.geteuid() === 0;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { chmodSync(d, 0o755); } catch { /* may already be writable */ }
    try { chmodSync(join(d, '.git', 'tamperward'), 0o755); } catch { /* may not exist */ }
    rmSync(d, { recursive: true, force: true });
  }
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const TWO = `it('one', () => {}); it('two', () => {});\n`;
const ONE = `it('one', () => {});\n`;

/** A repository with one committed protected spec and a policy protecting it. */
function repo(): { dir: string; git: (...a: string[]) => string; head: () => string } {
  const dir = tmp('tw-417-');
  const git = (...a: string[]): string =>
    execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.spec.ts'), TWO);
  writeFileSync(join(dir, '.tamperward.yml'), "version: 1\nprotected:\n  tests: ['**/*.spec.ts']\n");
  git('add', '-A');
  git('commit', '-qm', 'seed');
  return { dir, git, head: () => git('rev-parse', 'HEAD') };
}

function decision(r: { exitCode: number; stdout: string }): { decision?: string; reason?: string } {
  expect(r.exitCode).toBe(0);
  expect(r.stdout).not.toBe('');
  const j: unknown = JSON.parse(r.stdout);
  if (typeof j !== 'object' || j === null) throw new Error('not an object');
  const o: Record<string, unknown> = Object.fromEntries(Object.entries(j));
  return {
    decision: typeof o.decision === 'string' ? o.decision : undefined,
    reason: typeof o.reason === 'string' ? o.reason : undefined,
  };
}

describe('#417 the sweep allows only a real, readable non-repository', () => {
  it('a cwd that does not exist is denied with a diagnostic, not allowed', () => {
    const cwd = join(tmpdir(), 'tw-417-nonexistent-' + process.pid, 'dir');
    expect(existsSync(cwd)).toBe(false);
    const d = decision(stopVerdict({ session_id: 'n1', cwd }));
    expect(d.decision).toBe('block');
    expect(d.reason).toContain('tamperward-unavailable');
    expect(d.reason).toContain(cwd);
  });

  it.skipIf(isRoot)('a cwd the hook cannot read is denied with a diagnostic', () => {
    const cwd = tmp('tw-417-unreadable-');
    chmodSync(cwd, 0o000);
    const d = decision(stopVerdict({ session_id: 'n2', cwd }));
    expect(d.decision).toBe('block');
    expect(d.reason).toContain('tamperward-unavailable');
    expect(d.reason).toContain(cwd);
  });

  it('a real directory outside every repository is still an allow', () => {
    const cwd = tmp('tw-417-plain-');
    writeFileSync(join(cwd, 'notes.txt'), 'nothing to compare\n');
    expect(stopVerdict({ session_id: 'n3', cwd })).toEqual({ exitCode: 0, stdout: '' });
  });
});

describe('#417 the turn baseline fails closed', () => {
  it('a baseline that cannot be written denies the turn with a diagnostic (state path is a file)', () => {
    const { dir } = repo();
    // mkdir -p of `.git/tamperward` cannot succeed over a regular file, whoever runs it.
    writeFileSync(join(dir, '.git', 'tamperward'), 'not a directory\n');
    const d = decision(stopVerdict({ session_id: 's-file', cwd: dir }));
    expect(d.decision).toBe('block');
    expect(d.reason).toContain('tamperward-unavailable');
    expect(d.reason).toMatch(/baseline/i);
  });

  it.skipIf(isRoot)('a read-only session directory denies the turn, never a HEAD-relative diff', () => {
    const { dir, git } = repo();
    mkdirSync(join(dir, '.git', 'tamperward'));
    chmodSync(join(dir, '.git', 'tamperward'), 0o555);
    // The mid-turn commit `git diff HEAD` cannot see: the turn must not pass on its strength.
    writeFileSync(join(dir, 'a.spec.ts'), ONE);
    git('add', '-A');
    git('commit', '-qm', 'wip');
    const d = decision(stopVerdict({ session_id: 's-ro', cwd: dir }));
    expect(d.decision).toBe('block');
    expect(d.reason).toContain('tamperward-unavailable');
    expect(d.reason).toMatch(/baseline/i);
  });

  it('turnBaseline throws on a write failure rather than returning null', () => {
    const { dir } = repo();
    writeFileSync(join(dir, '.git', 'tamperward'), 'not a directory\n');
    expect(() => turnBaseline(dir, 's-throw')).toThrow(/baseline/i);
  });

  it('the baseline is written atomically: no temp file survives and the content is a full sha', () => {
    const { dir, head } = repo();
    expect(turnBaseline(dir, 's-atomic')).toBe(head());
    const stateDir = join(dir, '.git', 'tamperward');
    const p = join(stateDir, 'session-s-atomic');
    expect(readFileSync(p, 'utf8')).toMatch(/^[0-9a-f]{40}$/);
    const leftovers = execFileSync('ls', ['-A', stateDir], { encoding: 'utf8' }).trim().split('\n');
    expect(leftovers).toEqual(['session-s-atomic']);
  });

  it('a truncated baseline is treated as absent and re-established at 40 hex characters', () => {
    const { dir, head } = repo();
    const stateDir = join(dir, '.git', 'tamperward');
    mkdirSync(stateDir, { recursive: true });
    const p = join(stateDir, 'session-s-trunc');
    writeFileSync(p, head().slice(0, 12)); // a torn write: 7–40 hex used to pass the guard
    expect(turnBaseline(dir, 's-trunc')).toBe(head());
    expect(readFileSync(p, 'utf8')).toBe(head());
  });

  it('after a truncated baseline is re-established, a mid-turn commit is still judged', () => {
    const { dir, git, head } = repo();
    const stateDir = join(dir, '.git', 'tamperward');
    mkdirSync(stateDir, { recursive: true });
    const p = join(stateDir, 'session-s-turn');
    writeFileSync(p, head().slice(0, 12));
    // A clean turn re-establishes the marker as a full sha.
    expect(stopVerdict({ session_id: 's-turn', cwd: dir })).toEqual({ exitCode: 0, stdout: '' });
    const base = head();
    expect(readFileSync(p, 'utf8')).toBe(base);
    // The next turn commits its tamper; the working tree equals HEAD, so only the
    // baseline-relative diff can see it.
    writeFileSync(join(dir, 'a.spec.ts'), ONE);
    git('add', '-A');
    git('commit', '-qm', 'wip');
    expect(head()).not.toBe(base);
    const d = decision(stopVerdict({ session_id: 's-turn', cwd: dir }));
    expect(d.decision).toBe('block');
    expect(d.reason).toContain('test-deletion');
    // A blocked turn keeps its baseline, so the tamper stays visible until fixed.
    expect(readFileSync(p, 'utf8')).toBe(base);
  });
});
