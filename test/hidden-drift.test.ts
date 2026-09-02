// C1 (drift side): the effect layer found a protected file changed, asked git for the
// change, got NOTHING — the file had been taken out of git's view (`update-index
// --skip-worktree`, `--assume-unchanged`, or it was never tracked) — evaluated an
// empty list, and `savePtree(current)` absorbed the tamper as the new sanctioned
// state. The layer built to catch what the matcher missed ratified what git missed.
// Now: hidden tracked files are diffed by hand (trusted blob vs disk) and judged by
// the ordinary rules; drift nothing can reconstruct is a block, never an absorb.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preToolUseVerdict, stopVerdict } from '../src/cli/hook';
import { hiddenTrackedPaths } from '../src/git/build';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const OK = `it('adds', () => { expect(add(1, 2)).toBe(3); });\n`;
const SKIPPED = `it.skip('adds', () => { expect(add(1, 2)).toBe(3); });\n`;

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-hidden-'));
  dirs.push(d);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: d });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'test', 'a.test.ts'), OK);
  writeFileSync(join(d, 'src.ts'), 'export const add = (a: number, b: number) => a + b;\n');
  writeFileSync(join(d, '.gitignore'), 'test/local.test.ts\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return d;
}

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const bash = (cwd: string, sid = 's1') => ({ tool_name: 'Bash', tool_input: { command: 'echo ok' }, cwd, session_id: sid });
const stop = (cwd: string, sid = 's1') => stopVerdict({ cwd, session_id: sid });
const denial = (r: { stdout: string }): string => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason : '');
const reason = (r: { stdout: string }): string => (r.stdout ? JSON.parse(r.stdout).reason : '');

describe('a protected file hidden from git (skip-worktree) is still judged', () => {
  it('skip-worktree + it.skip on disk: the next call DENIES, keeps denying, and Stop BLOCKS', () => {
    const cwd = repo();
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe(''); // session pinned, tree snapshotted
    git(cwd, 'update-index', '--skip-worktree', 'test/a.test.ts');
    writeFileSync(join(cwd, 'test', 'a.test.ts'), SKIPPED);
    expect(git(cwd, 'diff', 'HEAD')).toBe(''); // git's view: nothing happened
    expect(git(cwd, 'status', '--porcelain')).toBe('');

    const r = preToolUseVerdict(bash(cwd));
    expect(r.stdout).toContain('"deny"');
    expect(denial(r)).toContain('test-skip');
    // NOT absorbed: the deny repeats.
    expect(denial(preToolUseVerdict(bash(cwd)))).toContain('test-skip');
    expect(reason(stop(cwd))).toContain('test-skip');

    // Restoring the content clears it — even while the file stays skip-worktree.
    writeFileSync(join(cwd, 'test', 'a.test.ts'), OK);
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
    expect(stop(cwd).stdout).toBe('');
  });

  it('control: the same edit without skip-worktree is denied exactly as before', () => {
    const cwd = repo();
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
    writeFileSync(join(cwd, 'test', 'a.test.ts'), SKIPPED);
    expect(git(cwd, 'diff', 'HEAD')).not.toBe('');
    expect(denial(preToolUseVerdict(bash(cwd)))).toContain('test-skip');
    expect(reason(stop(cwd))).toContain('test-skip');
    writeFileSync(join(cwd, 'test', 'a.test.ts'), OK);
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
  });

  it('assume-unchanged is the same hole, closed the same way', () => {
    const cwd = repo();
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
    git(cwd, 'update-index', '--assume-unchanged', 'test/a.test.ts');
    writeFileSync(join(cwd, 'test', 'a.test.ts'), SKIPPED);
    expect(git(cwd, 'diff', 'HEAD')).toBe('');
    expect(denial(preToolUseVerdict(bash(cwd)))).toContain('test-skip');
    expect(reason(stop(cwd))).toContain('test-skip');
  });

  it('a skip-worktree file DELETED on disk is a test deletion', () => {
    const cwd = repo();
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
    git(cwd, 'update-index', '--skip-worktree', 'test/a.test.ts');
    unlinkSync(join(cwd, 'test', 'a.test.ts'));
    expect(git(cwd, 'status', '--porcelain')).toBe('');
    expect(denial(preToolUseVerdict(bash(cwd)))).toContain('test-deletion');
    expect(reason(stop(cwd))).toContain('test-deletion');
  });

  it('the Stop sweep catches it even when no PreToolUse call ran after the hide', () => {
    const cwd = repo();
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
    git(cwd, 'update-index', '--skip-worktree', 'test/a.test.ts');
    writeFileSync(join(cwd, 'test', 'a.test.ts'), SKIPPED);
    expect(reason(stop(cwd))).toContain('test-skip');
  });

  it('without a session (no effect state to fall back on) the sweep still sees it', () => {
    const cwd = repo();
    git(cwd, 'update-index', '--skip-worktree', 'test/a.test.ts');
    writeFileSync(join(cwd, 'test', 'a.test.ts'), SKIPPED);
    expect(reason(stopVerdict({ cwd }))).toContain('test-skip');
  });

  it('hiddenTrackedPaths lists exactly the S / assume-unchanged entries', () => {
    const cwd = repo();
    expect(hiddenTrackedPaths({ cwd })).toEqual([]);
    git(cwd, 'update-index', '--skip-worktree', 'test/a.test.ts');
    git(cwd, 'update-index', '--assume-unchanged', 'src.ts');
    expect(hiddenTrackedPaths({ cwd }).sort()).toEqual(['src.ts', 'test/a.test.ts']);
  });
});

describe('drift nothing can reconstruct is a block, not an absorb', () => {
  it('a gitignored protected file rewritten by the shell blocks with hidden-drift', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'test', 'local.test.ts'), OK); // ignored: outside every git view
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe(''); // snapshotted as sanctioned
    writeFileSync(join(cwd, 'test', 'local.test.ts'), `it('adds', () => {});\n`); // gutted, no marker
    const r = preToolUseVerdict(bash(cwd));
    expect(denial(r)).toContain('hidden-drift');
    expect(denial(r)).toContain('test/local.test.ts');
    expect(denial(preToolUseVerdict(bash(cwd)))).toContain('hidden-drift'); // not absorbed
    expect(reason(stop(cwd))).toContain('hidden-drift');
    // Put back exactly what the turn started with: clean.
    writeFileSync(join(cwd, 'test', 'local.test.ts'), OK);
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
  });

  it('an Edit the hook sanctioned but the tool never applied is not drift', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'test', 'local.test.ts'), OK);
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
    for (const file of ['test/a.test.ts', 'test/local.test.ts']) {
      const edit = {
        tool_name: 'Edit',
        tool_input: { file_path: join(cwd, file), old_string: OK, new_string: OK + `it('adds zero', () => { expect(add(0, 0)).toBe(0); });\n` },
        cwd,
        session_id: 's1',
      };
      expect(preToolUseVerdict(edit).stdout).toBe(''); // allowed and sanctioned (predicted)
    }
    // …the user rejects both tool calls; the disk never changes.
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
    expect(stop(cwd).stdout).toBe('');
  });
});
