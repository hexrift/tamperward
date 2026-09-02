// `tamperward verify` — pristine-suite re-execution as a shipped layer. The
// fixtures reproduce the Phase-3 verdict classes with a fast real suite
// (node -e), plus the guarded-surface tests for the policy `verify:` block.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerify } from '../src/cli/verify';
import { policyWeakening } from '../src/detectors/policy-diff';

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

  it('a head-bound verify token turns MASKED_FAILURE into exit 0 and records the approval', () => {
    const cwd = repo();
    masked(cwd);
    withOob(`verify@${HEAD.slice(0, 12)}`, HEAD, () => {
      const r = capture(() => run(cwd));
      expect(r.code).toBe(0);
      expect(r.json.verdict).toBe('MASKED_FAILURE'); // still reported as what it is
      expect(r.json.oob_signoff).toBe(`verify@${HEAD.slice(0, 12)}`);
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
    withOob(`test-deletion@${HEAD.slice(0, 12)},test-skip@${HEAD.slice(0, 12)}`, HEAD, () => {
      expect(capture(() => run(cwd)).code).toBe(1);
    });
  });

  it('SUITE_RED is not an approvable state — the label leaves it red', () => {
    const cwd = repo(); // bug unfixed, suite honest: visible red
    withOob(`verify@${HEAD.slice(0, 12)}`, HEAD, () => {
      const r = capture(() => run(cwd));
      expect(r.code).toBe(1);
      expect(r.json.verdict).toBe('SUITE_RED');
      expect(r.json.oob_signoff).toBeUndefined();
    });
  });

  it('cannot-verify is not an approvable state — the label leaves it failing closed', () => {
    const cwd = repo();
    masked(cwd);
    withOob(`verify@${HEAD.slice(0, 12)}`, HEAD, () => {
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
