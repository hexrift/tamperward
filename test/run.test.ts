// `tamperward run` — the enforcement envelope (SPEC row 17). The central
// fixture replays round 2's cssstyle escape in miniature: an "agent" that
// masks the failure and exits 0, i.e. a runtime that released a poisoned
// tree with a success code. The envelope must convert that into a failing
// pipeline regardless of what the runtime claimed.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEnvelope, parseRun } from '../src/cli/run';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CMD = 'node test/check.test.js';

// Same suite shape as verify.test.ts: check.test.js exits nonzero unless
// src.js returns 42. Base commit ships the bug (suite red) unless
// `fixed` — then base is green and honest.
function repo(fixed = false): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-run-'));
  dirs.push(d);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: d });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src.js'), fixed ? 'module.exports = 42;\n' : 'module.exports = 41; // bug\n');
  writeFileSync(
    join(d, 'test', 'check.test.js'),
    `const v = require('../src.js');\nif (v !== 42) { console.error('expected 42, got ' + v); process.exit(1); }\n`,
  );
  git('add', '-A');
  git('commit', '-qm', 'base');
  return d;
}

const sh = (script: string) => ['bash', '-c', script];
const run = (cwd: string, argv: string[], extra: Partial<Parameters<typeof runEnvelope>[0]> = {}) =>
  runEnvelope({ cwd, cmd: CMD, budget: 30, argv, ...extra });

describe('tamperward run — the enforcement envelope', () => {
  it('honest fix, agent exits 0 → green means green (exit 0)', () => {
    const cwd = repo();
    expect(run(cwd, sh(`echo "module.exports = 42;" > src.js`))).toBe(0);
  });

  it('the cssstyle replay: agent masks the failure and "succeeds" → exit 1', () => {
    const cwd = repo();
    // The agent guts the failing test (visible green) and exits 0 — the
    // runtime released a poisoned tree with a success code.
    expect(run(cwd, sh(`echo "" > test/check.test.js`))).toBe(1);
  });

  it('agent COMMITS its tampering — the entry-time base still convicts (exit 1)', () => {
    const cwd = repo();
    expect(
      run(
        cwd,
        sh(`echo "" > test/check.test.js && git add -A && git -c user.email=a@b -c user.name=a commit -qm "fix tests"`),
      ),
    ).toBe(1);
  });

  it('agent fails honestly (exit 7, tree untouched) → its code passes through', () => {
    const cwd = repo(true); // green base: enforcement clean, agent code visible
    expect(run(cwd, sh('exit 7'))).toBe(7);
  });

  it('dirty tree before the agent starts → fail closed (exit 2); --allow-dirty proceeds', () => {
    const cwd = repo(true);
    writeFileSync(join(cwd, 'scratch.txt'), 'uncommitted');
    expect(run(cwd, sh('true'))).toBe(2);
    expect(run(cwd, sh('true'), { allowDirty: true })).toBe(0);
  });

  it('no agent command → exit 2, never a silent pass', () => {
    expect(runEnvelope({ cwd: repo(true), argv: [] })).toBe(2);
  });

  it('no verify command configured → cannot adjudicate, fail closed (exit 2)', () => {
    const cwd = repo(true);
    expect(runEnvelope({ cwd, argv: sh('true') })).toBe(2);
  });
});

describe('parseRun', () => {
  it('splits flags from the agent command at -- and at the first non-flag', () => {
    expect(parseRun(['--base', 'abc', '--allow-dirty', '--', 'claude', '-p', 'x'])).toEqual({
      base: 'abc',
      allowDirty: true,
      argv: ['claude', '-p', 'x'],
    });
    expect(parseRun(['npm', 'test']).argv).toEqual(['npm', 'test']);
    expect(parseRun(['--budget', '60', '--', 'sh', '--', '-c']).argv).toEqual(['sh', '--', '-c']);
  });
});
