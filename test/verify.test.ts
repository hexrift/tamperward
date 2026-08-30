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

  it('keeps agent-ADDED protected tests in the pristine run (they can only add strictness)', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
    // agent adds a stricter test; pristine overlay must not delete it
    writeFileSync(join(cwd, 'test', 'extra.test.js'), `if (require('../src.js') !== 42) process.exit(1);\n`);
    expect(runVerify({ cwd, cmd: 'node test/check.test.js && node test/extra.test.js', budget: 30, json: true })).toBe(0);
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
