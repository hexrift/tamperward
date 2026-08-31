// P1-3 and P1-6: the CI authority's own integrity. Both are AUDIT-class in the
// review — reachable through the documented wiring rather than demonstrated
// end-to-end, so these tests pin the mechanisms directly.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerify } from '../src/cli/verify';
import { applyOobSignoffs, oobHeadFromEnv } from '../src/signoff';
import { Finding } from '../src/types';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): { cwd: string; first: string; second: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-ci-'));
  dirs.push(cwd);
  const git = (...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
  writeFileSync(join(cwd, 'test', 'check.test.js'), 'if(require("../src.js")!==42)process.exit(1);\n');
  git('add', '-A');
  git('-c', 'user.email=t@b', '-c', 'user.name=tb', 'commit', '-qm', 'first');
  const first = git('rev-parse', 'HEAD').trim();
  writeFileSync(join(cwd, 'test', 'strict.test.js'), 'if(require("../src.js")!==43)process.exit(1);\n');
  git('add', '-A');
  git('-c', 'user.email=t@b', '-c', 'user.name=tb', 'commit', '-qm', 'second: stricter');
  const second = git('rev-parse', 'HEAD').trim();
  return { cwd, first, second };
}

const CMD = 'node -e "process.exit(0)"';

describe('P1-3: standalone verify can be anchor-downgraded', () => {
  it('--require-ancestor fails closed when HEAD no longer descends from the base', () => {
    const { cwd, first, second } = repo();
    // the history under review is rewritten beneath the requested base
    execFileSync('git', ['reset', '--hard', '-q', first], { cwd });
    expect(runVerify({ cwd, base: second, cmd: CMD, budget: 30, requireAncestor: true })).toBe(2);
  });

  it('an honest history (base IS an ancestor) is unaffected by the guard', () => {
    const { cwd, first } = repo(); // HEAD = second, which descends from first
    expect(runVerify({ cwd, base: first, cmd: CMD, budget: 30, requireAncestor: true })).toBe(0);
  });
});

describe('P1-6: a CI approval is bound to the commit it was granted for', () => {
  const finding = (): Finding =>
    ({ rule: 'test-deletion', severity: 'block', message: 'm', evidence: 'e', file: 'test/a.test.js' }) as Finding;
  const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';

  it('an unbound label no longer clears once the head is known (it used to clear every push)', () => {
    expect(applyOobSignoffs([finding()], ['test-deletion'], HEAD).cleared).toHaveLength(0);
  });

  it('a label bound to THIS head clears', () => {
    expect(applyOobSignoffs([finding()], [`test-deletion@${HEAD.slice(0, 8)}`], HEAD).cleared).toHaveLength(1);
  });

  it('a label bound to a DIFFERENT head does not — the next push re-blocks', () => {
    expect(applyOobSignoffs([finding()], ['test-deletion@0badbad0'], HEAD).cleared).toHaveLength(0);
  });

  it('workflows generated before this release (no head supplied) keep the old behaviour', () => {
    expect(applyOobSignoffs([finding()], ['test-deletion']).cleared).toHaveLength(1);
  });

  it('a too-short sha is not accepted as a binding', () => {
    expect(applyOobSignoffs([finding()], ['test-deletion@abc'], HEAD).cleared).toHaveLength(0);
    expect(oobHeadFromEnv({ TAMPERWARD_OOB_HEAD: 'abc' })).toBeUndefined();
  });
});
