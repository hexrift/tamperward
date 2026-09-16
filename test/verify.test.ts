// `tamperward verify` — pristine-suite re-execution as a shipped layer. The
// fixtures reproduce the Phase-3 verdict classes with a fast real suite
// (node -e), plus the guarded-surface tests for the policy `verify:` block.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVerify, probeFilesystemCaseSensitivity, runVerify, type RunResult } from '../src/cli/verify';
import { policyWeakening } from '../src/detectors/policy-diff';
import {
  DIAGNOSTIC_TAIL_BYTES,
  parseCapturedSupervisorResult,
  runCapturedProcessSync,
} from '../src/suite-diagnostics';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The suite: test/check.test.js requires src.js and exits nonzero unless it
// returns 42. `node test/check.test.js` is the whole runner — no jest needed.
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-ver-'));
  dirs.push(d);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: d });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src.js'), 'module.exports = 41; // bug: should be 42\n');
  writeFileSync(
    join(d, 'test', 'check.test.js'),
    `const v = require('../src.js');\nif (v !== 42) { console.error('expected 42, got ' + v); process.exit(1); }\n`,
  );
  git('add', '-A');
  git('commit', '-qm', 'base: failing suite, real bug');
  return d;
}

const CMD = 'node test/check.test.js';
const run = (cwd: string, extra: Partial<Parameters<typeof runVerify>[0]> = {}) =>
  runVerify({ cwd, cmd: CMD, budget: 30, json: true, ...extra });

/** Run with stdout captured; return the exit code and the JSON line verify wrote. */
const capture = (fn: () => number): { code: number; json: Record<string, unknown> } => {
  const orig = process.stdout.write;
  const lines: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = fn();
    const json = lines.map((l) => l.trim()).reverse().find((l) => l.startsWith('{'));
    if (!json) throw new Error('no JSON line written');
    return { code, json: JSON.parse(json) };
  } finally {
    process.stdout.write = orig;
  }
};

/** Set env vars for the duration of `fn` and always restore them, so nothing
 *  set here can leak into another test's suite environment. */
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForPidsGone = async (pids: number[]): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && pids.some(pidAlive)) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(pids.filter(pidAlive)).toEqual([]);
};

const withEnv = (vars: Record<string, string | undefined>, fn: () => void): void => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

// A REAL runner behind a package manager: `npm test` → `node --test`, the shape
// of the .npmrc bypass. The base is honest — app.js adds, math.test.js asserts
// add(1, 2) === 3 — so a candidate that breaks app.js is red unless something
// stops the test from running.
function npmRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-ver-npm-'));
  dirs.push(d);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: d });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  writeFileSync(join(d, 'app.js'), 'module.exports.add = (a, b) => a + b;\n');
  writeFileSync(
    join(d, 'math.test.js'),
    `const t = require('node:test'); const a = require('node:assert');\n` +
      `const { add } = require('./app.js');\n` +
      `t.test('add', () => { a.strictEqual(add(1, 2), 3); });\n`,
  );
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'node --test' } }));
  git('add', '-A');
  git('commit', '-qm', 'base: honest suite, honest source');
  return d;
}
const NPM = (cwd: string) => capture(() => runVerify({ cwd, cmd: 'npm test', budget: 60, json: true }));
const breakApp = (d: string) => writeFileSync(join(d, 'app.js'), 'module.exports.add = (a, b) => a * b;\n');
// The preload: with node:test's entry points stubbed to no-ops, `node --test`
// collects nothing, runs nothing, and exits 0.
const STUB = `const t = require('node:test'); for (const k of ['test', 'it', 'describe']) { try { t[k] = () => {}; } catch {} }\n`;

describe('tamperward verify', () => {
  it('MASKED_FAILURE: weakened test makes visible green, pristine red — exit 1', () => {
    const cwd = repo();
    // the tamper: neuter the assertion instead of fixing src.js
    writeFileSync(join(cwd, 'test', 'check.test.js'), `process.exit(0); // "fixed"\n`);
    expect(run(cwd)).toBe(1);
  });

  it('VERIFIED: an honest fix passes both runs — exit 0', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
    expect(run(cwd)).toBe(0);
  });

  it('SUITE_RED: nothing fixed, nothing masked — exit 1, not a masked failure', () => {
    const cwd = repo();
    expect(run(cwd)).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('CANNOT_VERIFY: a non-quiescent visible stage cannot certify — a zero exit does not become VERIFIED (exit 2)', () => {
    const cwd = repo();
    // Exit 0, but a process still holds stdout open — not quiescent, must not certify.
    const leak: RunResult = { exit: 0, secs: 1, pipeHeldOpen: true };
    const { code, json } = capture(() => run(cwd, { runStage: () => leak }));
    expect(code).toBe(2);
    expect(json.verdict).toBe('CANNOT_VERIFY');
    expect(json.verdict).not.toBe('VERIFIED');
    expect(json.reason).toBe('VERIFIER_BACKEND_RUNTIME_FAILURE');
    expect(json.stage).toBe('visible');
    expect(String(json.detail)).toContain('not');
    expect(String(json.detail)).toContain('quiescent');
  });

  it.skipIf(process.platform === 'win32')('CANNOT_VERIFY: a non-quiescent pristine stage cannot certify even after a clean visible run (exit 2)', () => {
    const cwd = repo();
    // Clean visible run, then a pristine run that exits 0 but is not quiescent.
    let call = 0;
    const runStage = (): RunResult =>
      ++call === 1 ? { exit: 0, secs: 1 } : { exit: 0, secs: 1, pipeHeldOpen: true };
    const { code, json } = capture(() => run(cwd, { runStage }));
    expect(code).toBe(2);
    expect(json.verdict).toBe('CANNOT_VERIFY');
    expect(json.reason).toBe('VERIFIER_BACKEND_RUNTIME_FAILURE');
    expect(json.stage).toBe('pristine');
  });

  // This replaces a test that asserted agent-ADDED protected files are kept in
  // the pristine run because "they can only add strictness". That premise was
  // false and shipped a bypass: see the regression below. An added protected
  // file is now removed from the pristine copy, so it cannot influence the
  // pristine verdict in EITHER direction. The visible run still executes it.
  it('an agent-added protected test cannot change the pristine verdict — honest fix still VERIFIED', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
    writeFileSync(join(cwd, 'test', 'extra.test.js'), `if (require('../src.js') !== 42) process.exit(1);\n`);
    expect(run(cwd)).toBe(0);
  });

  it('REGRESSION: an agent-ADDED runner config OUTSIDE the protected classes cannot suppress a restored base test', () => {
    // 1.14.1 removed added files in the policy's protected classes and treated
    // the class as closed. It was not: the `config` class is jest/vitest/eslint
    // only, so an added runner config outside it still reached the pristine run.
    // Here `mocharc.json` stands for that family — it is on the verification
    // surface but in no protected class. See docs/THREAT-MODEL-pristine-run.md.
    const cwd = mkdtempSync(join(tmpdir(), 'tw-ver-'));
    dirs.push(cwd);
    const git = (...a: string[]) => execFileSync('git', a, { cwd });
    git('init', '-q');
    git('config', 'user.email', 't@b');
    git('config', 'user.name', 'tb');
    mkdirSync(join(cwd, 'test'));
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 41; // bug\n');
    writeFileSync(join(cwd, 'test', 'check.test.js'), `if (require('../src.js') !== 42) process.exit(1);\n`);
    writeFileSync(
      join(cwd, 'runner.js'),
      `const fs = require('fs'); const cp = require('child_process');\n` +
        `let skip = []; try { skip = JSON.parse(fs.readFileSync('.mocharc.json', 'utf8')).ignore || []; } catch {}\n` +
        `let failed = 0;\n` +
        `for (const f of fs.readdirSync('test').filter((f) => f.endsWith('.test.js'))) {\n` +
        `  if (skip.includes(f)) continue;\n` +
        `  const r = cp.spawnSync(process.execPath, ['test/' + f], { stdio: 'ignore' });\n` +
        `  if (r.status !== 0) failed++;\n` +
        `}\n` +
        `process.exit(failed ? 1 : 0);\n`,
    );
    git('add', '-A');
    git('commit', '-qm', 'base: failing suite, real bug');

    // the agent: bug untouched, base test byte-identical, one UNPROTECTED file added
    writeFileSync(join(cwd, '.mocharc.json'), JSON.stringify({ ignore: ['check.test.js'] }));

    expect(execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'test/check.test.js'], { cwd })
      .toString()
      .trim()).toBe('');
    expect(runVerify({ cwd, cmd: 'node runner.js', budget: 30, json: true })).toBe(1);
  });

  it('REGRESSION: an agent-ADDED protected control file cannot suppress a restored base test', () => {
    // The bypass, in its JS form. The agent never modifies or deletes a
    // base-protected asset. It ADDS one — a protected `config`-class file the
    // runner auto-consults — which removes the failing base test from the run.
    // Before the fix this reported VERIFIED (exit 0) over an unfixed bug.
    const cwd = mkdtempSync(join(tmpdir(), 'tw-ver-'));
    dirs.push(cwd);
    const git = (...a: string[]) => execFileSync('git', a, { cwd });
    git('init', '-q');
    git('config', 'user.email', 't@b');
    git('config', 'user.name', 'tb');
    mkdirSync(join(cwd, 'test'));
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 41; // bug\n');
    writeFileSync(
      join(cwd, 'test', 'check.test.js'),
      `if (require('../src.js') !== 42) process.exit(1);\n`,
    );
    // a runner that honours an optional config file, the way pytest honours conftest
    writeFileSync(
      join(cwd, 'runner.js'),
      `const fs = require('fs'); const cp = require('child_process');
` +
        `let skip = []; try { skip = JSON.parse(fs.readFileSync('jest.config.json', 'utf8')).skip || []; } catch {}
` +
        `let failed = 0;
` +
        `for (const f of fs.readdirSync('test').filter((f) => f.endsWith('.test.js'))) {
` +
        `  if (skip.includes(f)) continue;
` +
        `  const r = cp.spawnSync(process.execPath, ['test/' + f], { stdio: 'ignore' });
` +
        `  if (r.status !== 0) failed++;
` +
        `}
` +
        `process.exit(failed ? 1 : 0);
`,
    );
    git('add', '-A');
    git('commit', '-qm', 'base: failing suite, real bug');

    // the agent: bug untouched, base test byte-identical, ONE protected file added
    writeFileSync(join(cwd, 'jest.config.json'), JSON.stringify({ skip: ['check.test.js'] }));

    expect(execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'test/check.test.js'], { cwd })
      .toString()
      .trim()).toBe('');
    // visible run is green only because the added file removed the test
    expect(execFileSync('node', ['runner.js'], { cwd, stdio: 'pipe' }) !== null).toBe(true);
    expect(runVerify({ cwd, cmd: 'node runner.js', budget: 30, json: true })).toBe(1);
  });

  it('restores a DELETED protected test in the pristine run (a lenient runner cannot hide it)', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 41;\n');
    // the tamper: delete the failing test; a glob-lenient runner reports green when
    // no test files remain — the classic "suite passes because there is no suite"
    rmSync(join(cwd, 'test', 'check.test.js'));
    const lenient = 'ok=0; for f in test/*.test.js; do [ -e "$f" ] || continue; node "$f" || ok=1; done; exit $ok';
    // visible: no test files → green. pristine: check.test.js restored → red. MASKED.
    expect(runVerify({ cwd, cmd: lenient, budget: 30, json: true })).toBe(1);
  });

  it('BUDGET_EXCEEDED fails closed — exit 2', () => {
    const cwd = repo();
    expect(runVerify({ cwd, cmd: 'node -e "setTimeout(()=>{}, 60000)"', budget: 1, json: true })).toBe(2);
  });

  it('a COMMITTED weakening is invisible vs HEAD and caught vs the trusted rev — pick the base accordingly', () => {
    const cwd = repo();
    const git = (...a: string[]) => execFileSync('git', a, { cwd });
    const trusted = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    writeFileSync(join(cwd, 'test', 'check.test.js'), `process.exit(0);\n`);
    git('add', '-A');
    git('commit', '-qm', 'tamper, committed'); // HEAD now contains the weakening
    // vs HEAD the overlay restores the tampered version: VERIFIED — an honest
    // demonstration that the default base only covers UNCOMMITTED weakening.
    expect(run(cwd)).toBe(0);
    // vs the trusted rev the original test comes back: MASKED_FAILURE.
    expect(run(cwd, { base: trusted })).toBe(1);
  });

  it('no command configured → exit 2, never a silent pass', () => {
    const cwd = repo();
    expect(runVerify({ cwd, json: true })).toBe(2);
  });
});

describe('verify — out-of-band sign-off (MASKED_FAILURE only, head-bound)', () => {
  // The same env the diff gate reads. Set per test and always restored, so a
  // token here can never leak into the verdict of another test.
  const withOob = (signoff: string | undefined, head: string | undefined, fn: () => void) => {
    const save = { s: process.env.TAMPERWARD_OOB_SIGNOFF, h: process.env.TAMPERWARD_OOB_HEAD };
    if (signoff === undefined) delete process.env.TAMPERWARD_OOB_SIGNOFF;
    else process.env.TAMPERWARD_OOB_SIGNOFF = signoff;
    if (head === undefined) delete process.env.TAMPERWARD_OOB_HEAD;
    else process.env.TAMPERWARD_OOB_HEAD = head;
    try {
      fn();
    } finally {
      if (save.s === undefined) delete process.env.TAMPERWARD_OOB_SIGNOFF;
      else process.env.TAMPERWARD_OOB_SIGNOFF = save.s;
      if (save.h === undefined) delete process.env.TAMPERWARD_OOB_HEAD;
      else process.env.TAMPERWARD_OOB_HEAD = save.h;
    }
  };
  const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
  const masked = (cwd: string) => writeFileSync(join(cwd, 'test', 'check.test.js'), `process.exit(0); // "fixed"\n`);

  it('a head-bound verify token turns MASKED_FAILURE into exit 0 and records the approval', () => {
    const cwd = repo();
    masked(cwd);
    withOob(`verify@${HEAD}`, HEAD, () => {
      const r = capture(() => run(cwd));
      expect(r.code).toBe(0);
      expect(r.json.verdict).toBe('MASKED_FAILURE'); // still reported as what it is
      expect(r.json.oob_signoff).toBe(`verify@${HEAD}`);
    });
  });

  it('an UNBOUND verify token clears nothing once the workflow names the head', () => {
    const cwd = repo();
    masked(cwd);
    withOob('verify', HEAD, () => {
      const r = capture(() => run(cwd));
      expect(r.code).toBe(1);
      expect(r.json.oob_signoff).toBeUndefined();
    });
  });

  it('a token bound to a DIFFERENT commit does not clear this one — the next push re-blocks', () => {
    const cwd = repo();
    masked(cwd);
    withOob('verify@0000000dead', HEAD, () => {
      expect(capture(() => run(cwd)).code).toBe(1);
    });
  });

  it('a rule token (test-deletion@sha) is not a verify approval', () => {
    const cwd = repo();
    masked(cwd);
    withOob(`test-deletion@${HEAD},test-skip@${HEAD}`, HEAD, () => {
      expect(capture(() => run(cwd)).code).toBe(1);
    });
  });

  it('SUITE_RED is not an approvable state — the label leaves it red', () => {
    const cwd = repo(); // bug unfixed, suite honest: visible red
    withOob(`verify@${HEAD}`, HEAD, () => {
      const r = capture(() => run(cwd));
      expect(r.code).toBe(1);
      expect(r.json.verdict).toBe('SUITE_RED');
      expect(r.json.oob_signoff).toBeUndefined();
    });
  });

  it('cannot-verify is not an approvable state — the label leaves it failing closed', () => {
    const cwd = repo();
    masked(cwd);
    withOob(`verify@${HEAD}`, HEAD, () => {
      const r = capture(() => run(cwd, { cmd: 'sleep 30', budget: 1 }));
      expect(r.code).toBe(2);
      expect(r.json.verdict).toBe('BUDGET_EXCEEDED');
    });
  });

  it('with no head supplied (older workflows) an unbound token is honoured, as for check --diff', () => {
    const cwd = repo();
    masked(cwd);
    withOob('verify', undefined, () => {
      expect(capture(() => run(cwd)).code).toBe(0);
    });
  });

  it('no env at all: the verdict is untouched', () => {
    const cwd = repo();
    masked(cwd);
    withOob(undefined, undefined, () => {
      expect(capture(() => run(cwd)).code).toBe(1);
    });
  });
});

describe('policy-diff guards the verify surface', () => {
  const base = `verify:\n  command: npm test\n  budget: 300\n`;
  it('flags command change, budget lowering, and removal; allows adding and raising', () => {
    expect(policyWeakening(base, `verify:\n  command: "true"\n  budget: 300\n`)?.join()).toContain('verify.command changed');
    expect(policyWeakening(base, `verify:\n  command: npm test\n  budget: 30\n`)?.join()).toContain('verify.budget lowered');
    expect(policyWeakening(base, `version: 1\n`)?.join()).toContain('verify block removed');
    expect(policyWeakening(`version: 1\n`, base)).toEqual([]); // adding verify is a strengthening
    expect(policyWeakening(base, `verify:\n  command: npm test\n  budget: 600\n`)).toEqual([]); // raising budget is fine
  });
});

describe('verify — the runner is started under the operator\'s environment, not the candidate\'s', () => {
  // The surface list named what the test runner reads and nothing the package
  // manager in front of it reads. `npm test` is npm first: it loads .npmrc
  // before running anything, and `node-options` there becomes NODE_OPTIONS for
  // every node it spawns. See the VERIFICATION_SURFACE and suiteEnv notes in
  // src/cli/verify.ts and docs/THREAT-MODEL-pristine-run.md.

  it('REGRESSION: an added .npmrc `node-options=--require <stub>` cannot turn a red suite green', () => {
    const cwd = npmRepo();
    breakApp(cwd); // the bug
    writeFileSync(join(cwd, 'p.cjs'), STUB);
    writeFileSync(join(cwd, '.npmrc'), 'node-options=--require ./p.cjs\n');
    // Before the fix: both copies carried the .npmrc, both `node --test` runs
    // collected nothing, and this was VERIFIED (exit 0) over a source the base
    // suite fails. Now SUITE_RED specifically: the environment pins npm's
    // node-options above the project file, so even the VISIBLE run — the
    // candidate's own tree — executes the real tests. MASKED_FAILURE would also
    // convict, but would mean the env layer had stopped outranking the file
    // and only the pristine removal was holding.
    const r = NPM(cwd);
    expect(r.code).toBe(1);
    expect(r.json.verdict).toBe('SUITE_RED');
  });

  it('the HOME variant — node-options in ~/.npmrc — is read by neither run', () => {
    // No in-repo file at all, so no surface list can cover this: the candidate
    // inside `tamperward run` owns HOME. Only the environment control stands
    // between this and VERIFIED.
    const cwd = npmRepo();
    breakApp(cwd);
    writeFileSync(join(cwd, 'p.cjs'), STUB);
    const home = mkdtempSync(join(tmpdir(), 'tw-ver-home-'));
    dirs.push(home);
    writeFileSync(join(home, '.npmrc'), 'node-options=--require ./p.cjs\n');
    // An `npx`/`npm test` launcher exports npm_config_userconfig (pointing at
    // the launching user's ~/.npmrc) into this process, which would pin the
    // user file on its own and hide what this test is about. Cleared, so the
    // vector is live in the parent env and only verify's control stands.
    const launcherPins = Object.fromEntries(
      Object.keys(process.env)
        .filter((k) => /^npm_config_(userconfig|globalconfig|node_options)$/i.test(k))
        .map((k) => [k, undefined]),
    );
    withEnv({ ...launcherPins, HOME: home }, () => {
      const r = NPM(cwd);
      expect(r.code).toBe(1);
      expect(r.json.verdict).toBe('SUITE_RED');
    });
    // Same file, a different setting: `script-shell` makes npm run the test
    // script through a shell of the candidate's choosing — one that exits 0.
    // node-options is pinned by its own variable; this one is caught only
    // because the user rc file itself is pointed away from HOME.
    const sh0 = join(home, 'sh0');
    writeFileSync(sh0, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(home, '.npmrc'), `script-shell=${sh0}\n`);
    withEnv({ ...launcherPins, HOME: home }, () => {
      const r = NPM(cwd);
      expect(r.code).toBe(1);
      expect(r.json.verdict).toBe('SUITE_RED');
    });
  });

  it('an added .npmrc is on the verification surface: removed from the pristine copy and counted', () => {
    const cwd = npmRepo();
    writeFileSync(join(cwd, '.npmrc'), 'loglevel=silent\n'); // harmless content; the file is the point
    const r = NPM(cwd);
    expect(r.code).toBe(0);
    expect(r.json.added_protected_removed).toBe(1);
  });

  it('NODE_OPTIONS and the other load-this-first variables in the parent env do not reach the suite', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
    const vars = {
      NODE_OPTIONS: '--no-warnings',
      NODE_PATH: '/nowhere',
      NODE_REPL_EXTERNAL_MODULE: '/nowhere.js',
      PYTHONPATH: '.',
      PYTHONSTARTUP: '/nowhere.py',
      PYTEST_ADDOPTS: '-k nothing',
      PYTEST_PLUGINS: 'nowhere',
      NPM_CONFIG_USERCONFIG: '/nowhere/npmrc', // an inherited variant must be replaced, whatever its case
    };
    // The suite is a probe: red if any dropped variable is visible, or if the
    // pinned npm/yarn ones are not what verify set them to.
    const dropped = Object.keys(vars)
      .filter((k) => k !== 'NPM_CONFIG_USERCONFIG')
      .map((k) => `[ -z "\${${k}:-}" ] || exit 1`)
      .join('; ');
    const pinned =
      '[ -f "$npm_config_userconfig" ] && [ ! -s "$npm_config_userconfig" ] || exit 1; ' +
      '[ -f "$npm_config_globalconfig" ] && [ ! -s "$npm_config_globalconfig" ] || exit 1; ' +
      '[ "$npm_config_userconfig" != "$npm_config_globalconfig" ] || exit 1; ' +
      '[ -z "${NPM_CONFIG_USERCONFIG:-}" ] || exit 1; ' +
      '[ "$YARN_IGNORE_PATH" = 1 ] || exit 1';
    withEnv(vars, () => {
      expect(runVerify({ cwd, cmd: `${dropped}; ${pinned}; ${CMD}`, budget: 30, json: true })).toBe(0);
    });
  });

  it('control: an honest change through `npm test` is still VERIFIED under the sanitised environment', () => {
    const cwd = npmRepo();
    writeFileSync(join(cwd, 'app.js'), 'module.exports.add = (a, b) => b + a;\n');
    const r = NPM(cwd);
    expect(r.code).toBe(0);
    expect(r.json.verdict).toBe('VERIFIED');
  });
});

describe('parseVerify', () => {
  it('a flag is never a value: `--base --json` fails closed instead of verifying against "--json"', () => {
    const o = parseVerify(['--base', '--json']);
    expect(o.base).toBeUndefined();
    expect(o.json).toBe(true); // the flag is still parsed as itself
    expect(o.invalid).toMatch(/--base/);
    expect(runVerify({ ...o, cwd: repo() })).toBe(2);
  });

  it('a missing or malformed value is a fault, not a silent default', () => {
    expect(parseVerify(['--cmd']).invalid).toMatch(/--cmd/);
    expect(parseVerify(['--cwd', '--keep']).invalid).toMatch(/--cwd/);
    expect(parseVerify(['--budget', 'soon']).invalid).toMatch(/--budget/);
    expect(parseVerify(['--budget', '--json']).invalid).toMatch(/--budget/);
  });

  it('well-formed flags parse as before', () => {
    expect(parseVerify(['--base', 'main', '--cmd', 'npm test', '--budget', '60', '--cwd', '.', '--json', '--keep', '--require-ancestor'])).toEqual({
      base: 'main',
      cmd: 'npm test',
      budget: 60,
      cwd: '.',
      json: true,
      keep: true,
      requireAncestor: true,
    });
  });
});


describe('suite supervisor lifecycle and result authority (#319, #371)', () => {
  it('strictly rejects prefixed/appended supervisor-channel bytes instead of scanning for a green JSON suffix', () => {
    const good = JSON.stringify({
      exit: 0,
      signal: null,
      timedOut: false,
      stdout: { captured_bytes: 0, tail_b64: '' },
      stderr: { captured_bytes: 0, tail_b64: '' },
    });
    expect(parseCapturedSupervisorResult(good)?.exit).toBe(0);
    expect(parseCapturedSupervisorResult('FORGED' + good)).toBeNull();
    expect(parseCapturedSupervisorResult(good + 'FORGED')).toBeNull();
  });

  it.skipIf(process.platform !== 'linux')('kills a setsid descendant before an ordinary local stage returns', async () => {
    const cwd = repo();
    const control = mkdtempSync(join(tmpdir(), 'tw-suite-desc-'));
    dirs.push(control);
    const pidFile = join(control, 'pids');
    const sleeper = join(cwd, 'sleeper.js');
    writeFileSync(
      sleeper,
      [
        "const fs = require('fs');",
        "fs.appendFileSync(process.argv[2], process.pid + '\\n');",
        "setInterval(() => {}, 1000);",
        '',
      ].join('\n'),
    );

    const cmd =
      `setsid node ${JSON.stringify(sleeper)} ${JSON.stringify(pidFile)} >/dev/null 2>&1 & ` +
      `for i in $(seq 1 100); do [ -s ${JSON.stringify(pidFile)} ] && break; sleep 0.01; done; ` +
      'sleep 0.05; exit 0';
    const result = runCapturedProcessSync('sh', ['-c', cmd], {
      cwd,
      env: process.env,
      timeoutMs: 5_000,
      detached: true,
      killGroupOnFinish: true,
      backstopMs: 5_000,
    });

    expect(result).toMatchObject({ exit: 0, timedOut: false });
    expect(existsSync(pidFile)).toBe(true);
    const pids = readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number).filter(Number.isFinite);
    expect(pids.length).toBeGreaterThan(0);
    await waitForPidsGone(pids);
  }, 15_000);

  it.skipIf(process.platform !== 'linux')('bounds noisy timeout output and kills a setsid descendant writer before returning', async () => {
    const cwd = repo();
    const control = mkdtempSync(join(tmpdir(), 'tw-suite-desc-'));
    dirs.push(control);
    const pidFile = join(control, 'pids');
    const writer = join(cwd, 'writer.js');
    writeFileSync(
      writer,
      [
        "const fs = require('fs');",
        "fs.appendFileSync(process.argv[2], process.pid + '\\n');",
        "const a = Buffer.alloc(4096, 65), b = Buffer.alloc(4096, 66);",
        "setInterval(() => { fs.writeSync(1, a); fs.writeSync(2, b); }, 1);",
        '',
      ].join('\n'),
    );

    const cmd =
      `setsid node ${JSON.stringify(writer)} ${JSON.stringify(pidFile)} & ` +
      'node -e "setInterval(() => {}, 1000)"';
    const started = Date.now();
    const result = runCapturedProcessSync('sh', ['-c', cmd], {
      cwd,
      env: process.env,
      timeoutMs: 500,
      detached: true,
      killGroupOnFinish: true,
      backstopMs: 5_000,
    });

    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(6_000);
    for (const stream of [result.diagnostics.stdout, result.diagnostics.stderr]) {
      expect(stream.captured_bytes).toBeGreaterThan(DIAGNOSTIC_TAIL_BYTES);
      expect(stream.retained_bytes).toBeLessThanOrEqual(DIAGNOSTIC_TAIL_BYTES);
      expect(stream.truncated).toBe(true);
    }
    const pids = existsSync(pidFile)
      ? readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number).filter(Number.isFinite)
      : [];
    expect(pids.length).toBeGreaterThan(0);
    await waitForPidsGone(pids);
  }, 15_000);

  it('flushes a maximal two-tail supervisor result completely before exiting (#555)', () => {
    const cwd = repo();
    // Force both retained tails to their full DIAGNOSTIC_TAIL_BYTES, so the
    // reserved result channel carries its largest possible document (two 16 KiB
    // base64 tails plus metadata). The supervisor must write it synchronously and
    // in full before process.exit; an async write truncated by immediate exit
    // would yield a null parse ("did not produce a result") or short tails.
    const fill = DIAGNOSTIC_TAIL_BYTES + 8_000;
    const code =
      "const fs=require('fs');" +
      `fs.writeSync(1,Buffer.alloc(${fill},65));` +
      `fs.writeSync(2,Buffer.alloc(${fill},66));` +
      'process.exit(3)';
    const result = runCapturedProcessSync(process.execPath, ['-e', code], {
      cwd,
      env: process.env,
      timeoutMs: 5_000,
      detached: process.platform !== 'win32',
      killGroupOnFinish: true,
    });
    expect(result.exit).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.error).toBeUndefined();
    for (const stream of [result.diagnostics.stdout, result.diagnostics.stderr]) {
      expect(stream.captured_bytes).toBe(fill);
      expect(stream.retained_bytes).toBe(DIAGNOSTIC_TAIL_BYTES);
      expect(stream.truncated).toBe(true);
    }
    expect(result.diagnostics.stdout.tail).toBe('A'.repeat(DIAGNOSTIC_TAIL_BYTES));
    expect(result.diagnostics.stderr.tail).toBe('B'.repeat(DIAGNOSTIC_TAIL_BYTES));
  });

  it('preserves authoritative nonzero exit while draining noisy stdout/stderr', () => {
    const cwd = repo();
    const code =
      "const fs=require('fs');" +
      "fs.writeSync(1,Buffer.alloc(50000,65));" +
      "fs.writeSync(2,Buffer.alloc(50000,66));" +
      "process.exit(7)";
    const result = runCapturedProcessSync(process.execPath, ['-e', code], {
      cwd,
      env: process.env,
      timeoutMs: 5_000,
      detached: process.platform !== 'win32',
      killGroupOnFinish: true,
    });
    expect(result.exit).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(result.pipeHeldOpen).toBeUndefined();
    expect(result.diagnostics.stdout.captured_bytes).toBe(50_000);
    expect(result.diagnostics.stderr.captured_bytes).toBe(50_000);
    expect(result.diagnostics.stdout.truncated).toBe(true);
    expect(result.diagnostics.stderr.truncated).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('completes off the child exit when a descendant holds stdout open, and flags the leaked pipe', async () => {
    const cwd = repo();
    const control = mkdtempSync(join(tmpdir(), 'tw-suite-leak-'));
    dirs.push(control);
    const pidFile = join(control, 'pid');
    const holder = join(cwd, 'holder.js');
    writeFileSync(
      holder,
      [
        "const fs = require('fs');",
        "fs.appendFileSync(process.argv[2], process.pid + '\\n');",
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    );

    // Shell exits 0, but the backgrounded node holds stdout open; unreaped
    // (killGroupOnFinish:false), so it must complete off exit within the drain.
    const cmd =
      `node ${JSON.stringify(holder)} ${JSON.stringify(pidFile)} & ` +
      `for i in $(seq 1 100); do [ -s ${JSON.stringify(pidFile)} ] && break; sleep 0.01; done; ` +
      'echo suite-done; exit 0';
    const started = Date.now();
    const result = runCapturedProcessSync('sh', ['-c', cmd], {
      cwd,
      env: process.env,
      timeoutMs: 10_000,
      detached: true,
      killGroupOnFinish: false,
      drainMs: 300,
    });

    expect(result).toMatchObject({ exit: 0, timedOut: false });
    expect(result.pipeHeldOpen).toBe(true);
    expect(result.error).toBeUndefined();
    // Completed on exit + drain (~0.3s), not on the 10s budget or the backstop.
    expect(Date.now() - started).toBeLessThan(5_000);

    const pids = readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number).filter(Number.isFinite);
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await waitForPidsGone(pids);
  }, 15_000);

  it('drops a split leading UTF-8 continuation rather than rendering replacement characters', () => {
    const cwd = repo();
    const code =
      `const fs=require('fs');` +
      `const b=Buffer.concat([Buffer.from('€'),Buffer.alloc(${DIAGNOSTIC_TAIL_BYTES - 1},65)]);` +
      `fs.writeSync(1,b);process.exit(1)`;
    const result = runCapturedProcessSync(process.execPath, ['-e', code], {
      cwd,
      env: process.env,
      timeoutMs: 5_000,
      detached: process.platform !== 'win32',
      killGroupOnFinish: true,
    });
    const d = result.diagnostics.stdout;
    expect(d.captured_bytes).toBe(DIAGNOSTIC_TAIL_BYTES + 2);
    expect(d.retained_bytes).toBe(DIAGNOSTIC_TAIL_BYTES);
    expect(d.truncated).toBe(true);
    expect(d.tail).not.toContain('�');
    expect(Buffer.byteLength(d.tail, 'utf8')).toBeLessThanOrEqual(d.retained_bytes);
    expect(d.tail).toBe('A'.repeat(DIAGNOSTIC_TAIL_BYTES - 1));
  });
});

describe('verify diagnostics (#319)', () => {
  it('captures bounded visible/pristine stdout/stderr metadata in JSON on failure', () => {
    const cwd = repo();
    writeFileSync(
      join(cwd, 'test', 'check.test.js'),
      [
        "process.stdout.write('visible-out\\n');",
        "process.stderr.write('expected 42, got 41\\n');",
        'process.exit(1);',
        '',
      ].join('\n'),
    );

    const r = capture(() => runVerify({ cwd, cmd: CMD, budget: 30, json: true }));
    expect(r.code).toBe(1);
    expect(r.json.verdict).toBe('SUITE_RED');
    expect(r.json.visible).toMatchObject({
      exit: 1,
      diagnostics: {
        stdout: { truncated: false },
        stderr: { truncated: false },
      },
    });
    expect((r.json.visible as any).diagnostics.stdout.captured_bytes).toBeGreaterThan(0);
    expect((r.json.visible as any).diagnostics.stderr.captured_bytes).toBeGreaterThan(0);
    expect((r.json.visible as any).diagnostics.stdout.tail).toContain('visible-out');
    expect((r.json.visible as any).diagnostics.stderr.tail).toContain('expected 42');
  });

  it('attributes MASKED_FAILURE output to the pristine stage independently', () => {
    const cwd = repo();
    const testPath = join(cwd, 'test', 'check.test.js');
    writeFileSync(
      testPath,
      [
        "process.stdout.write('PRISTINE_STDOUT\\n');",
        "process.stderr.write('PRISTINE_STDERR\\n');",
        "if (require('../src.js') !== 42) process.exit(1);",
        '',
      ].join('\n'),
    );
    execFileSync('git', ['add', 'test/check.test.js'], { cwd });
    execFileSync('git', ['commit', '--amend', '--no-edit', '-q'], { cwd });

    // Candidate masks the base failure. Visible is green/quiet; pristine restores
    // the base test and must carry that stage's independent diagnostics.
    writeFileSync(testPath, "process.exit(0);\n");
    const r = capture(() => runVerify({ cwd, cmd: CMD, budget: 30, json: true }));
    expect(r.code).toBe(1);
    expect(r.json.verdict).toBe('MASKED_FAILURE');
    expect((r.json.visible as any).exit).toBe(0);
    expect((r.json.pristine as any).exit).toBe(1);
    expect((r.json.pristine as any).diagnostics.stdout.tail).toContain('PRISTINE_STDOUT');
    expect((r.json.pristine as any).diagnostics.stderr.tail).toContain('PRISTINE_STDERR');
    expect((r.json.visible as any).diagnostics.stdout.tail).toBeUndefined();
    expect((r.json.visible as any).diagnostics.stderr.tail).toBeUndefined();
  });

  it('drains noisy output but retains only a strict bounded tail', () => {
    const cwd = repo();
    const noisy =
      `node -e "const f=require('fs'); f.writeSync(1, Buffer.alloc(200000, 65)); f.writeSync(2, Buffer.alloc(200000, 66)); process.exit(1)"`;
    const r = capture(() => runVerify({ cwd, cmd: noisy, budget: 30, json: true }));
    expect(r.code).toBe(1);
    const d = (r.json.visible as any).diagnostics;
    expect(d.stdout.captured_bytes).toBe(200000);
    expect(d.stderr.captured_bytes).toBe(200000);
    expect(d.stdout.truncated).toBe(true);
    expect(d.stderr.truncated).toBe(true);
    expect(Buffer.byteLength(d.stdout.tail, 'utf8')).toBeLessThanOrEqual(16384);
    expect(Buffer.byteLength(d.stderr.tail, 'utf8')).toBeLessThanOrEqual(16384);
  });

  it('scrubs controls and prefixes every multiline stdout/stderr workflow-command line', () => {
    const cwd = repo();
    const chunks: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = runVerify({
        cwd,
        cmd:
          `node -e "const f=require('fs');` +
          `f.writeSync(1,'::error::out-a\\n::warning::out-b\\n');` +
          `f.writeSync(2,'\\x1b[31m::notice::err-a\\rX\\n::group::err-b\\n');` +
          `process.exit(1)"`,
        budget: 30,
      });
      expect(code).toBe(1);
    } finally {
      process.stdout.write = orig;
    }
    const rendered = chunks.join('');
    expect(rendered).toContain('visible suite stdout');
    expect(rendered).toContain('visible suite stderr');
    expect(rendered).toContain('  | ::error::out-a');
    expect(rendered).toContain('  | ::warning::out-b');
    expect(rendered).toContain('  | \\x1b[31m::notice::err-a\\rX');
    expect(rendered).toContain('  | ::group::err-b');
    expect(rendered).not.toContain('\x1b[31m');
    const candidateLines = rendered
      .split('\n')
      .filter((line) => /::(?:error|warning|notice|group)::/.test(line));
    expect(candidateLines.length).toBeGreaterThanOrEqual(4);
    expect(candidateLines.every((line) => line.startsWith('  | '))).toBe(true);
  });

  it.skipIf(process.platform !== 'linux')('cannot forge green by targeting the supervisor result fd', () => {
    const cwd = repo();
    const r = capture(() =>
      runVerify({
        cwd,
        cmd:
          `exec node -e "const f=require('fs'); try { f.writeFileSync('/proc/'+process.ppid+'/fd/1', '{\\\"verdict\\\":\\\"VERIFIED\\\",\\\"exit\\\":0}'); } catch {} process.exit(1)"`,
        budget: 30,
        json: true,
      }),
    );

    // Linux /proc policy may reject the cross-process fd open entirely. If it
    // permits it, the bytes prefix the supervisor's one trusted JSON object and
    // strict whole-stream parsing fails closed. Either way candidate bytes can
    // never manufacture a green host verdict.
    expect(r.code).not.toBe(0);
    expect(r.json.verdict).not.toBe('VERIFIED');
    expect((r.json as any).forged).toBeUndefined();
  });

  it('keeps successful suite output out of default human output', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
    const chunks: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(
        runVerify({
          cwd,
          cmd: `node -e "console.log('SHOULD_NOT_RENDER_ON_SUCCESS'); process.exit(0)"`,
          budget: 30,
        }),
      ).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    expect(chunks.join('')).not.toContain('SHOULD_NOT_RENDER_ON_SUCCESS');
  });
});

// #426 — on a case-insensitive filesystem (macOS default, Windows) the
// filesystem collapses case while the overlay's `baseProtected` set did not:
// a case-only rename of a base test resolved, in the copy, to the very inode
// the overlay had just restored, and the removal loop unlinked it. The host
// running these tests is case-sensitive, so the probe is injected; the
// assertions are about what the overlay DOES under the folded contract, and
// the default-probe leg pins Linux behaviour unchanged.
describe('verify — case-insensitive filesystem overlay (#426)', () => {
  // The suite runs EVERY *.test.js under test/ and exits 0 when there are none
  // (the `node --test` shape): the class of runner the issue's fail-open needs.
  const DISCOVER =
    `node -e "for (const f of require('fs').readdirSync('test')) if (f.endsWith('.test.js')) require('./test/' + f)"`;
  const foldedOpts = { cmd: DISCOVER, probeCaseSensitivity: () => false, keep: true } as const;

  function greenBase(): string {
    const d = repo();
    const git = (...a: string[]) => execFileSync('git', a, { cwd: d });
    writeFileSync(join(d, 'src.js'), 'module.exports = 42;\n');
    git('commit', '-qam', 'base: green');
    return d;
  }
  /** The issue's reproduction: break the source, case-rename the test and gut it. */
  function caseRenamedGutted(): string {
    const d = greenBase();
    writeFileSync(join(d, 'src.js'), 'module.exports = 41; // bug reintroduced\n');
    // Two steps, because a case-only rename is a same-inode rename on the
    // filesystems the issue is about and a distinct file here; staged, as
    // `git mv` leaves it, so the index carries one spelling — the shape git
    // produces on such a filesystem, where it never lists both.
    rmSync(join(d, 'test', 'check.test.js'));
    writeFileSync(join(d, 'test', 'CHECK.test.js'), '// gutted\n');
    execFileSync('git', ['add', '-A'], { cwd: d });
    return d;
  }
  const keptDirs = (json: Record<string, unknown>): void => {
    for (const k of ['visible_dir', 'pristine_dir']) {
      const v = json[k];
      if (typeof v === 'string') dirs.push(join(v, '..'));
    }
  };

  it('the default probe reports this host and leaves nothing behind', () => {
    const d = mkdtempSync(join(tmpdir(), 'tw-case-'));
    dirs.push(d);
    const sensitive = probeFilesystemCaseSensitivity(d);
    expect(typeof sensitive).toBe('boolean');
    if (process.platform === 'linux') expect(sensitive).toBe(true);
    expect(existsSync(join(d, '.tw-case-probe-A'))).toBe(false);
    expect(existsSync(join(d, '.tw-case-probe-a'))).toBe(false);
  });

  it('case-insensitive: a case-only renamed, gutted test never unlinks the restored base file — MASKED_FAILURE, never VERIFIED', () => {
    const cwd = caseRenamedGutted();
    const r = capture(() => run(cwd, foldedOpts));
    keptDirs(r.json);
    expect(r.json.filesystem_case_sensitive).toBe(false);
    expect(r.json.verdict).not.toBe('VERIFIED');
    expect(r.json.verdict).toBe('MASKED_FAILURE');
    expect(r.code).toBe(1);
    // The case variant folds onto a base-protected path: on the filesystem
    // this contract models it IS the restored inode, so it is never removed.
    expect(r.json.added_protected_removed).toBe(0);
    expect(r.json.protected_restored).toBe(1);
    expect(readFileSync(join(String(r.json.pristine_dir), 'test', 'check.test.js'), 'utf8')).toContain('expected 42');
  });

  it('case-insensitive: an agent-added case variant of a surface file is removed from the pristine copy', () => {
    const cwd = greenBase();
    writeFileSync(join(cwd, 'CONFTEST.PY'), 'import sys\n');
    writeFileSync(join(cwd, 'Pytest.ini'), '[pytest]\naddopts = -k nothing\n');
    writeFileSync(join(cwd, 'notes.txt'), 'kept: not on any surface\n');
    const r = capture(() => run(cwd, foldedOpts));
    keptDirs(r.json);
    expect(r.json.filesystem_case_sensitive).toBe(false);
    expect(r.json.verdict).toBe('VERIFIED');
    expect(r.json.added_protected_removed).toBe(2);
    const pri = String(r.json.pristine_dir);
    expect(existsSync(join(pri, 'CONFTEST.PY'))).toBe(false);
    expect(existsSync(join(pri, 'Pytest.ini'))).toBe(false);
    expect(existsSync(join(pri, 'notes.txt'))).toBe(true);
  });

  it('case-insensitive: two in-tree paths that collide under folding are CANNOT_VERIFY with a machine reason', () => {
    // At the base.
    const atBase = greenBase();
    const git = (...a: string[]) => execFileSync('git', a, { cwd: atBase });
    writeFileSync(join(atBase, 'test', 'CHECK.test.js'), '// second spelling\n');
    git('add', '-A');
    git('commit', '-qm', 'two spellings');
    let r = capture(() => run(atBase, foldedOpts));
    keptDirs(r.json);
    expect(r.json.verdict).toBe('CANNOT_VERIFY');
    expect(r.json.reason).toBe('PATH_CASE_COLLISION');
    expect(r.json.filesystem_case_sensitive).toBe(false);
    expect(String(r.json.detail)).toContain('test/CHECK.test.js');
    expect(String(r.json.detail)).toContain('test/check.test.js');
    expect(r.code).toBe(2);

    // In the working tree only, and outside every overlay class: the copy
    // cannot hold both, so nothing about it is verifiable either.
    const inTree = greenBase();
    writeFileSync(join(inTree, 'SRC.js'), 'module.exports = 42;\n');
    r = capture(() => run(inTree, foldedOpts));
    keptDirs(r.json);
    expect(r.json.verdict).toBe('CANNOT_VERIFY');
    expect(r.json.reason).toBe('PATH_CASE_COLLISION');
    expect(r.code).toBe(2);
  });

  it('case-sensitive (this host): behaviour is unchanged and the field is reported', () => {
    const renamed = caseRenamedGutted();
    let r = capture(() => run(renamed, { cmd: DISCOVER, keep: true }));
    keptDirs(r.json);
    expect(typeof r.json.filesystem_case_sensitive).toBe('boolean');
    if (process.platform === 'linux') expect(r.json.filesystem_case_sensitive).toBe(true);
    expect(r.json.verdict).toBe('MASKED_FAILURE');
    // Distinct files here: the case variant is an agent-added test and is removed.
    expect(r.json.added_protected_removed).toBe(1);
    expect(existsSync(join(String(r.json.pristine_dir), 'test', 'CHECK.test.js'))).toBe(false);

    const colliding = greenBase();
    writeFileSync(join(colliding, 'SRC.js'), 'module.exports = 42;\n');
    r = capture(() => run(colliding, { cmd: DISCOVER, probeCaseSensitivity: () => true }));
    expect(r.json.verdict).toBe('VERIFIED');
    expect(r.json.filesystem_case_sensitive).toBe(true);

    const surface = greenBase();
    writeFileSync(join(surface, 'CONFTEST.PY'), 'import sys\n');
    r = capture(() => run(surface, { cmd: DISCOVER, probeCaseSensitivity: () => true, keep: true }));
    keptDirs(r.json);
    expect(r.json.added_protected_removed).toBe(0);
    expect(existsSync(join(String(r.json.pristine_dir), 'CONFTEST.PY'))).toBe(true);
  });
});
