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

describe('envelope hardening — the trust anchor cannot move', () => {
  it('EXPLOIT 1: agent resets HEAD to an ancestor predating the failing test → must fail, not pass', () => {
    // commit1: green (src=42, weak suite). commit2 (entry HEAD): adds a strict
    // failing test — the task. Agent resets to commit1: diff base...HEAD is
    // empty (merge-base downgrades to commit1), worktree clean, verify green
    // against the downgraded anchor. Without an ancestry guard: exit 0.
    const cwd = repo(true); // commit1: green
    const git = (...a: string[]) => execFileSync('git', a, { cwd });
    writeFileSync(join(cwd, 'test', 'strict.test.js'), `const v = require('../src.js');\nif (v !== 43) process.exit(1);\n`);
    git('add', '-A');
    git('commit', '-qm', 'task: strict failing test');
    const code = run(cwd, sh('git reset --hard -q HEAD~1'));
    expect(code).not.toBe(0);
  });

  it('EXPLOIT 2: no verifier at entry; agent supplies verify.command "true" → must fail closed, not VERIFIED', () => {
    const cwd = repo();
    const code = runEnvelope({
      cwd,
      argv: sh(`printf 'version: 1\\nverify:\\n  command: "true"\\n' > .tamperward.yml && echo "" > test/check.test.js`),
    });
    expect(code).toBe(2); // no verifier existed at entry: refuse before trusting an agent-authored one
  });
});

describe('envelope hardening — the tree the agent left cannot judge itself', () => {
  // P0-1: an uncommitted .tamperward.yml that disables the rules must not be
  // the policy the worktree check runs under. The envelope freezes the
  // entry-time policy (from the base commit); the agent's version is ignored.
  it('P0-1: agent disables test-deletion+hook-tampering in an uncommitted policy → still convicted', () => {
    const cwd = repo(); // failing suite at entry
    const disable =
      'printf "version: 1\\nrules:\\n  test-deletion:\\n    enabled: false\\n  hook-tampering:\\n    enabled: false\\n" > .tamperward.yml';
    const code = runEnvelope({ cwd, cmd: 'true', argv: sh(`${disable} && rm test/check.test.js`) });
    expect(code).not.toBe(0);
  });

  // P0-2: widening `protected` so the pristine overlay reverts the agent's own
  // source bug — scored a strengthening by policy-diff, so the agent's policy
  // must not reach verify. Frozen entry policy defines the overlay classes.
  it('P0-2: agent broadens protected to mask its bug → MASKED_FAILURE still fires', () => {
    const cwd = repo();
    const widen = 'printf "version: 1\\nprotected:\\n  config: [\\"**\\"]\\n" >> .tamperward.yml';
    // agent leaves src.js broken and guts the visible test, then widens protected
    const code = runEnvelope({ cwd, cmd: CMD, argv: sh(`echo "" > test/check.test.js && ${widen}`) });
    expect(code).not.toBe(0);
  });

  // P0-3: untracked files are invisible to `git diff HEAD`. The envelope's
  // worktree view must include untracked (not-ignored) files, so a dropped
  // shadow file is at least SCANNED rather than silently absent.
  it('P0-3: untracked file is included in the worktree scan (not 0 changes)', () => {
    const cwd = repo(true); // green base
    const untrackedPolicyDisable =
      'printf "version: 1\\nrules:\\n  test-deletion:\\n    enabled: false\\n" > sneaky.yml';
    // the point: an untracked file exists and is enumerated. We assert the
    // envelope no longer green-lights a run whose only defense is that the
    // change was never committed — here by deleting a tracked test under the
    // frozen policy, with an untracked file also present.
    const code = runEnvelope({ cwd, cmd: 'true', argv: sh(`${untrackedPolicyDisable} && rm test/check.test.js`) });
    expect(code).not.toBe(0);
  });

  // P0-4: the agent can run `tamperward allow`, writing the local ledger. The
  // envelope adjudicates at the CI layer, which honors only out-of-band
  // approval, never the (agent-writable) committed/local ledger.
  it('P0-4: agent self-signs-off with `tamperward allow` → not cleared', () => {
    const cwd = repo();
    const cli = join(__dirname, '..', 'dist', 'cli', 'index.js');
    const code = runEnvelope({
      cwd,
      cmd: 'true',
      argv: sh(`rm test/check.test.js && node ${cli} allow test-deletion --file test/check.test.js --reason x >/dev/null 2>&1 || true`),
    });
    expect(code).not.toBe(0);
  });
});
