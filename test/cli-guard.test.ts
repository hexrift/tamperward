// D-6 / F10: the CLI never escapes as a stack trace. Anything `main` cannot
// handle is one `tamperward: …` line on stderr at exit 2 (cannot evaluate —
// fail closed, never 0, never 1), and an empty range says so on stderr while
// keeping exit 0.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardedMain, validateCliArgs } from '../src/cli/main';

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


describe('run observer CLI grammar (#335)', () => {
  it('accepts --observe-transients only as an explicit run flag before the delimiter', () => {
    expect(validateCliArgs('run', ['--observe-transients', '--', 'true'])).toBeUndefined();
    expect(validateCliArgs('run', ['--observe-transients', '--allow-dirty', '--', 'true'])).toBeUndefined();
  });
});

describe('strict CLI argument boundary (#312)', () => {
  const malformed: Array<[string, string[], RegExp]> = [
    ['check unknown option', ['check', '--staged', '--typo'], /unknown option "--typo"/],
    ['allow unknown option', ['allow', 'test-deletion', '--reason', 'x', '--typo'], /unknown option "--typo"/],
    ['init unknown option', ['init', '--dry-rnu'], /unknown option "--dry-rnu"/],
    ['doctor unknown option', ['doctor', '--githbu'], /unknown option "--githbu"/],
    ['verify unknown option', ['verify', '--json', '--bogus'], /unknown option "--bogus"/],
    ['watch unknown option', ['watch', '--bogus'], /unknown option "--bogus"/],

    ['check missing value', ['check', '--diff'], /--diff needs a value/],
    ['allow missing value', ['allow', 'test-deletion', '--reason'], /--reason needs a value/],
    ['init missing value', ['init', '--cwd'], /--cwd needs a value/],
    ['doctor missing value', ['doctor', '--base'], /--base needs a value/],
    ['verify missing value', ['verify', '--base'], /--base needs a value/],
    ['watch missing value', ['watch', '--dir'], /--dir needs a value/],
    ['run missing value', ['run', '--budget', '--', 'true'], /--budget needs a value/],

    ['verify zero budget', ['verify', '--budget', '0'], /--budget needs a positive number/],
    ['verify NaN budget', ['verify', '--budget', 'nope'], /--budget needs a positive number/],
    ['run zero verifier budget', ['run', '--budget', '0', '--', 'true'], /--budget needs a positive number/],
    ['run NaN verifier budget', ['run', '--budget', 'nope', '--', 'true'], /--budget needs a positive number/],
    ['run zero agent budget', ['run', '--agent-budget', '0', '--', 'true'], /--agent-budget needs a positive number/],
    ['run negative agent budget', ['run', '--agent-budget', '-1', '--', 'true'], /--agent-budget needs a positive number/],
    ['run negative settle', ['run', '--settle', '-1', '--', 'true'], /--settle needs a non-negative number/],
    ['run NaN settle', ['run', '--settle', 'nope', '--', 'true'], /--settle needs a non-negative number/],

    ['check conflicting views', ['check', '--staged', '--worktree'], /choose exactly one of --staged, --worktree, or --diff/],
    ['check json and format conflict', ['check', '--staged', '--json', '--format', 'text'], /--json cannot be combined with --format/],
    ['run implicit command grammar', ['run', 'true'], /requires an explicit "--" before the wrapped command/],
    ['run unknown option before delimiter', ['run', '--bogus', '--', 'true'], /unknown option "--bogus"/],
  ];

  it.each(malformed)('%s fails closed before command execution', (_name, argv, diagnostic) => {
    const r = run(argv);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toMatch(ONE_CLEAN_LINE);
    expect(r.err).toMatch(diagnostic);
  });

  it('rejects a flag in place of a value without consuming the next option', () => {
    const r = run(['check', '--diff', '--staged']);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toBe('tamperward: --diff needs a value (got the flag "--staged")\n');
  });

  it('rejects extra positional arguments instead of silently ignoring them', () => {
    expect(run(['allow', 'test-deletion', 'extra', '--reason', 'x']).err)
      .toBe('tamperward: unexpected argument "extra"\n');
    expect(run(['init', 'extra']).err)
      .toBe('tamperward: unexpected argument "extra"\n');
    expect(run(['verify', 'extra']).err)
      .toBe('tamperward: unexpected argument "extra"\n');
  });

  it('preserves valid command grammars', () => {
    const d = repo();
    expect(run(['check', '--staged', '--cwd', d]).code).toBe(0);

    const initDry = run(['init', '--dry-run', '--cwd', d]);
    expect(initDry.code).toBe(0);
    expect(initDry.out).toMatch(/change\(s\) planned|everything already wired/);

    const verify = run(['verify', '--cmd', 'true', '--budget', '1', '--cwd', d]);
    expect(verify.code).toBe(0);

    const envelope = run(['run', '--cmd', 'true', '--budget', '1', '--cwd', d, '--', 'true']);
    expect(envelope.code).toBe(0);
  }, 15_000);
});
