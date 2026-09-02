// D-6 / F10: the CLI never escapes as a stack trace. Anything `main` cannot
// handle is one `tamperward: …` line on stderr at exit 2 (cannot evaluate —
// fail closed, never 0, never 1), and an empty range says so on stderr while
// keeping exit 0.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardedMain } from '../src/cli/main';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-guard-'));
  dirs.push(d);
  return d;
}
function repo(): string {
  const d = tmp();
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: d });
  return d;
}

/** Run the CLI in-process with stdout/stderr captured. */
function run(argv: string[]): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { err += s; return true; };
  try {
    const code = guardedMain(argv);
    return { code, out, err };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = so;
    (process.stderr as unknown as { write: unknown }).write = se;
  }
}

const ONE_CLEAN_LINE = /^tamperward: [^\n]+\n$/;

describe('D-6: crash paths exit 2 with one clean line', () => {
  it('an unknown base revision in --diff', () => {
    const r = run(['check', '--diff', 'nope...HEAD', '--cwd', repo()]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(ONE_CLEAN_LINE);
    expect(r.err).not.toMatch(/at .*\.(ts|js):\d+/); // no stack frame
    expect(r.err).toMatch(/nope/);
  });

  it('an ancestor that does not exist (HEAD~9 on a one-commit repo)', () => {
    const r = run(['check', '--diff', 'HEAD~9...HEAD', '--cwd', repo()]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(ONE_CLEAN_LINE);
  });

  it('--worktree outside a git repository', () => {
    const r = run(['check', '--worktree', '--cwd', tmp()]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(ONE_CLEAN_LINE);
    expect(r.err).toMatch(/not inside a git repository/);
  });

  it('a malformed range with four dots', () => {
    const r = run(['check', '--diff', 'a....b', '--cwd', repo()]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/invalid --diff range "a\.\.\.\.b"/);
  });

  it('a range whose revisions contain dots is still accepted (control)', () => {
    const d = repo();
    execFileSync('git', ['tag', 'v1.2.3'], { cwd: d });
    const r = run(['check', '--diff', 'v1.2.3...HEAD', '--cwd', d]);
    expect(r.code).toBe(0);
  });

  it('allow with an invalid policy', () => {
    const d = repo();
    writeFileSync(join(d, '.tamperward.yml'), 'rules: [x]\n');
    const r = run(['allow', 'test-deletion', '--reason', 'x', '--cwd', d]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(ONE_CLEAN_LINE);
    expect(r.err).toMatch(/rules must be a mapping/);
  });

  it('init on a broken layout is error rows at exit 2, never a crash, and applies the rest', () => {
    const d = repo();
    // a directory where init expects a file, twice over
    execFileSync('mkdir', ['-p', join(d, '.tamperward.yml'), join(d, '.git', 'hooks', 'pre-commit')]);
    const r = run(['init', '--cwd', d]);
    expect(r.code).toBe(2);
    expect(r.err).toBe('');
    expect(r.out).toMatch(/policy\s+error\s+\.tamperward\.yml/);
    expect(r.out).toMatch(/pre-commit\s+error\s+\.git\/hooks\/pre-commit\s+— exists but is not a regular file/);
    expect(r.out).toMatch(/agent\s+create/);
    expect(r.out).toMatch(/2 item\(s\) need your attention/);
  });
});

describe('F10: an empty range is reported on stderr and stays clean', () => {
  it('HEAD...HEAD scans zero changes, exits 0, and says so', () => {
    const r = run(['check', '--diff', 'HEAD...HEAD', '--cwd', repo()]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/0 changes scanned/);
    expect(r.err).toMatch(/note: the range HEAD\.\.\.HEAD contains no changes/);
  });

  it('a range with changes prints no such note (control)', () => {
    const d = repo();
    writeFileSync(join(d, 'a.txt'), 'x\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: d });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'a'], { cwd: d });
    const r = run(['check', '--diff', 'HEAD~1...HEAD', '--cwd', d]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/1 change scanned/);
    expect(r.err).not.toMatch(/contains no changes/);
  });
});
