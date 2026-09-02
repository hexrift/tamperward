// `tamperward run` — the enforcement envelope (SPEC row 17). The central
// fixture replays round 2's cssstyle escape in miniature: an "agent" that
// masks the failure and exits 0, i.e. a runtime that released a poisoned
// tree with a success code. The envelope must convert that into a failing
// pipeline regardless of what the runtime claimed.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEnvelope, parseRun } from '../src/cli/run';
import { runVerify } from '../src/cli/verify';
import { loadPolicy } from '../src/policy-load';
import { diffWorktree, diffWorktreeWithUntracked } from '../src/git/build';

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
  it('P0-2: a tree-authored `protected` glob must not decide what pristine means', () => {
    // GREEN base: restoring it hides the bug the agent introduces. The agent
    // breaks src.js and widens `protected` so the pristine overlay reverts
    // src.js too — policy-diff scores ADDING globs a strengthening, so nothing
    // else objects. With the tree's own policy, verify reports VERIFIED; with
    // the entry-time policy it reports MASKED_FAILURE.
    const cwd = repo(true);
    const entry = loadPolicy(cwd); // frozen BEFORE the agent's edit
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 0; // bug\n');
    writeFileSync(join(cwd, 'test', 'check.test.js'), ''); // visible suite made green
    writeFileSync(join(cwd, '.tamperward.yml'), 'version: 1\nprotected:\n  config: ["**"]\n');

    // Closed in 1.14.3 for the standalone path too: with a --base, verify reads
    // its policy from THAT COMMIT, so the tree-authored glob is never consulted.
    // This assertion used to expect 0 — the hole — because only the envelope
    // passed a frozen policyOverride and standalone `verify` (what the generated
    // CI workflow runs) read the candidate's own policy.
    expect(runVerify({ cwd, base: 'HEAD', cmd: CMD, budget: 30 })).toBe(1);
    // an explicit entry-time override remains equivalent
    expect(runVerify({ cwd, base: 'HEAD', cmd: CMD, budget: 30, policyOverride: entry })).toBe(1);
  });

  it('P0-2b: a tree-authored `verify:` block must not choose the verifier', () => {
    // The exploitable form of the same provenance defect. The agent does not fix
    // the bug; it rewrites the suite command so the re-execution is trivially
    // green. `check --diff` flags that as hook-tampering, so the generated
    // workflow caught it as a PAIR — but only if both jobs are required, and
    // anyone running `verify` alone had no protection. The base governs now, so
    // the guarantee holds job-by-job.
    const cwd = repo(); // RED base: the bug is real and the suite fails
    writeFileSync(
      join(cwd, '.tamperward.yml'),
      'version: 1\nverify:\n  command: "true"\n  budget: 30\n',
    );
    // no --cmd here: the command must come from the policy, and the policy from base
    expect(runVerify({ cwd, base: 'HEAD', budget: 30 })).not.toBe(0);
  });

  // P0-3: `git diff HEAD` never reports untracked files, so an agent could drop
  // a whole new file and the worktree view scanned 0 changes. Tested at the
  // builder, where the property actually lives — an envelope-level assertion
  // passed with the fix reverted (a tracked deletion convicts either way).
  it('P0-3: the untracked-inclusive worktree view sees a dropped file; the plain view does not', () => {
    const cwd = repo(true);
    mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(cwd, '.github', 'workflows', 'evil.yml'), 'on: push\n');

    const tracked = diffWorktree({ cwd }).filter((c) => c.kind === 'file');
    const withUntracked = diffWorktreeWithUntracked({ cwd }).filter((c) => c.kind === 'file');
    const paths = (cs: typeof withUntracked) => cs.map((c) => (c as { path: string }).path);

    expect(paths(tracked)).not.toContain('.github/workflows/evil.yml');
    expect(paths(withUntracked)).toContain('.github/workflows/evil.yml');
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

describe('P0-5: a verdict cannot outlive the tree it describes', () => {
  // `run` owns the agent's exit code, not its descendants. A worker detached
  // with setsid/nohup survives every check and edits the tree afterwards — the
  // masked-green escape one level up from the runtime hole this command closes.
  // A synchronous wrapper cannot reap a new session, so the envelope refuses to
  // certify a tree something is still holding.
  it('a detached worker still holding the tree is NOT_QUIESCENT, not GREEN', () => {
    const cwd = repo(); // failing suite; agent writes the honest fix
    const code = runEnvelope({
      cwd,
      cmd: CMD,
      argv: sh(
        `setsid nohup bash -c "sleep 6; echo > test/check.test.js" >/dev/null 2>&1 & ` +
          `echo "module.exports = 42;" > src.js`,
      ),
    });
    expect(code).toBe(1);
  });

  it('an honest agent with no survivors is still clean (the scan must not convict the caller)', () => {
    // The caller's own shell pipeline shares this working directory, so the
    // survivor scan is keyed on processes that appear AFTER the agent spawns.
    const cwd = repo();
    expect(runEnvelope({ cwd, cmd: CMD, argv: sh('echo "module.exports = 42;" > src.js') })).toBe(0);
  });

  it('a mutation landing DURING adjudication is caught by the fingerprint guard', () => {
    const cwd = repo();
    const code = runEnvelope({
      cwd,
      cmd: CMD,
      argv: sh(`setsid nohup bash -c "sleep 1; echo > test/check.test.js" >/dev/null 2>&1 & echo "module.exports = 42;" > src.js`),
    });
    expect(code).toBe(1);
  });
});

describe('P0-6: the suite runner lives outside every git view', () => {
  // verify symlinks node_modules into BOTH copies — gitignored, so no diff
  // view sees it, and it is where the suite's runner lives. Replacing
  // node_modules/.bin/<runner> replaces the program that decides both
  // verdicts: reproduced as VERIFIED, visible and pristine both exit 0, with
  // the source bug untouched.
  function repoWithRunner(): string {
    const cwd = repo(); // failing suite: src.js is 41
    mkdirSync(join(cwd, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(cwd, '.gitignore'), 'node_modules/\n');
    const runner = join(cwd, 'node_modules', '.bin', 'checker');
    writeFileSync(runner, '#!/bin/sh\nexec node test/check.test.js\n');
    chmodSync(runner, 0o755);
    const git = (...a: string[]) => execFileSync('git', a, { cwd });
    git('add', '-A');
    git('-c', 'user.email=t@b', '-c', 'user.name=tb', 'commit', '-qm', 'runner');
    return cwd;
  }
  const RUNNER_CMD = './node_modules/.bin/checker';

  it('an agent that rewrites the runner is caught as DEPENDENCY_DRIFT', () => {
    const cwd = repoWithRunner();
    const code = runEnvelope({
      cwd,
      cmd: RUNNER_CMD,
      argv: sh('printf "#!/bin/sh\\nexit 0\\n" > node_modules/.bin/checker'),
    });
    expect(code).toBe(1); // verify itself is fooled; the fingerprint is not
  });

  it('an honest agent that leaves dependencies alone still passes', () => {
    const cwd = repoWithRunner();
    expect(runEnvelope({ cwd, cmd: RUNNER_CMD, argv: sh('echo "module.exports = 42;" > src.js') })).toBe(0);
  });

  it('a RELATIVE cwd does not break the verification overlay', () => {
    // The copies' node_modules symlink was built from the caller's cwd
    // verbatim; a relative one resolved against the copy itself, so every
    // suite exited 127 and verify degraded to permanent SUITE_RED — an oracle
    // that always says red is one people switch off.
    const cwd = repoWithRunner();
    const prev = process.cwd();
    try {
      process.chdir(cwd); // the observed case: `tamperward run --cwd .`
      expect(runEnvelope({ cwd: '.', cmd: RUNNER_CMD, argv: sh('echo "module.exports = 42;" > src.js') })).toBe(0);
    } finally {
      process.chdir(prev);
    }
  });
});
