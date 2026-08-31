// P1 batch from the external review: a detector that fails open, a write that
// escapes the sandbox, and enforcement wiring no glob protected.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, hasBlocking } from '../src/engine';
import { defaultPolicy, isProtected } from '../src/policy';
import { runVerify } from '../src/cli/verify';
import { Change, Detector } from '../src/types';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const throwing: Detector = {
  id: 'boom',
  surface: ['file'],
  certainty: 'mechanical',
  run() {
    throw new Error('repository content made me throw');
  },
};

const aChange = (): Change[] => [
  { kind: 'file', path: 'src/x.ts', oldPath: null, op: 'modify', before: 'a\n', after: 'b\n', binary: false, hunks: [] },
];

describe('P1-7: a detector that cannot run is not a rule that passed', () => {
  it('fails CLOSED at the adjudicating views (range/worktree/staged)', () => {
    for (const view of ['range', 'worktree', 'staged'] as const) {
      const findings = evaluate(aChange(), defaultPolicy(), [throwing], view);
      expect(hasBlocking(findings), `view ${view}`).toBe(true);
    }
  });

  it('stays isolated (non-blocking) at the tool-call hook, where a throw already fails open', () => {
    const findings = evaluate(aChange(), defaultPolicy(), [throwing], 'tool-call');
    expect(hasBlocking(findings)).toBe(false);
  });
});

describe('P1-4: the enforcement wiring is a protected asset', () => {
  it('covers the hook settings and pre-commit config that `init` installs', () => {
    const p = defaultPolicy();
    for (const f of ['.claude/settings.json', '.claude/settings.local.json', '.pre-commit-config.yaml']) {
      expect(isProtected(f, p, 'hooks'), f).toBe(true);
    }
  });
});

describe('P1-1: verification never writes through a symlink', () => {
  it('leaves a file outside the repository untouched', () => {
    const outside = mkdtempSync(join(tmpdir(), 'tw-outside-'));
    dirs.push(outside);
    const victim = join(outside, 'victim.txt');
    const ORIGINAL = 'IMPORTANT ORIGINAL CONTENT\n';
    writeFileSync(victim, ORIGINAL);

    const cwd = mkdtempSync(join(tmpdir(), 'tw-p11-'));
    dirs.push(cwd);
    const git = (...a: string[]) => execFileSync('git', a, { cwd });
    git('init', '-q');
    mkdirSync(join(cwd, 'test'));
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
    writeFileSync(join(cwd, 'test', 'check.test.js'), 'if(require("../src.js")!==42)process.exit(1);\n');
    git('add', '-A');
    git('-c', 'user.email=t@b', '-c', 'user.name=tb', 'commit', '-qm', 'base');

    // the agent replaces a protected test with a link pointing out of the repo
    unlinkSync(join(cwd, 'test', 'check.test.js'));
    symlinkSync(victim, join(cwd, 'test', 'check.test.js'));

    runVerify({ cwd, base: 'HEAD', cmd: 'node -e "process.exit(0)"', budget: 30 });
    expect(readFileSync(victim, 'utf8')).toBe(ORIGINAL);
  });
});
