// Pass 3c, P2-3: a newline in any path segment defeated isProtected entirely —
// picomatch compiles `**` to a pattern that stops at a newline — so a
// `conftest.py` carrying `collect_ignore` under a directory named `n\nl` was
// dropped by the snapshot walk, by the untracked and ignored keep filters, by
// the hidden-tracked probe and by the envelope's working-tree check: PreToolUse
// and Stop both ALLOWED it. No honest path carries a control character; such a
// path is now protected in every category it is asked about, and shown escaped.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPolicy, escapeControl, hasControlChar, isProtected, protectedCategory } from '../src/policy';
import { hiddenTrackedPaths, ignoredPaths, untrackedAdds } from '../src/git/build';
import { snapshotProtected } from '../src/effect';
import { preToolUseVerdict, stopVerdict } from '../src/cli/hook';
import { runCheck } from '../src/cli/check';
import { formatDenial } from '../src/adapters/claude/deny';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const policy = defaultPolicy();
const NL = 'n\nl/conftest.py';
const TAB = 'a\tb/x.test.ts';
const COLLECT_IGNORE = 'collect_ignore = ["test_a.py"]\n';

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-ctl-'));
  dirs.push(d);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: d });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'test', 'test_a.py'), 'def test_a():\n    assert 1 == 1\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return d;
}

const bash = (cwd: string, sid = 's1') => ({ tool_name: 'Bash', tool_input: { command: 'echo ok' }, cwd, session_id: sid });
const stop = (cwd: string, sid = 's1') => stopVerdict({ cwd, session_id: sid });
const reason = (r: { stdout: string }): string => (r.stdout ? JSON.parse(r.stdout).reason : '');

describe('P2-3: a control character in a path is protected in every category, fail closed', () => {
  it('isProtected and protectedCategory', () => {
    expect(isProtected(NL, policy)).toBe(true);
    expect(isProtected(TAB, policy)).toBe(true);
    expect(isProtected('a\x01b/README.md', policy)).toBe(true); // no glob matches README.md; the control character does
    expect(isProtected('a\x7fb', policy)).toBe(true);
    for (const cat of Object.keys(policy.protected)) {
      expect(isProtected(NL, policy, cat)).toBe(true);
      expect(isProtected(TAB, policy, cat)).toBe(true);
    }
    expect(protectedCategory(NL, policy)).toBe('tests');
    expect(isProtected('README.md', policy)).toBe(false);
    expect(isProtected('test/conftest.py', policy)).toBe(true);
    expect(hasControlChar('plain/path.py')).toBe(false);
    expect(hasControlChar('ünïcode/ok.py')).toBe(false);
  });

  it('escapeControl spells the character out and leaves the rest alone', () => {
    expect(escapeControl(NL)).toBe('n\\nl/conftest.py');
    expect(escapeControl(TAB)).toBe('a\\tb/x.test.ts');
    expect(escapeControl('a\x1bb\r\x00')).toBe('a\\x1bb\\r\\x00');
    expect(escapeControl('ünïcode/ok.py')).toBe('ünïcode/ok.py');
  });

  it('the denial shows the path escaped, and the finding keeps the real one', () => {
    const text = formatDenial([
      { rule: 'test-skip', severity: 'block', file: NL, line: 1, message: 'm', evidence: 'e', remediation: 'r', signoff: { required: true, command: 'c' } },
    ]);
    expect(text).toContain('test-skip (n\\nl/conftest.py:1)');
    expect(text.split('\n').some((l) => l === 'l/conftest.py:1): m')).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('every layer that filters by protection sees the path', () => {
  it('the snapshot walk and the untracked keep filter', () => {
    const cwd = repo();
    mkdirSync(join(cwd, 'n\nl'));
    writeFileSync(join(cwd, NL), COLLECT_IGNORE);
    mkdirSync(join(cwd, 'a\tb'));
    writeFileSync(join(cwd, TAB), "it('x', () => {});\n");
    expect(Object.keys(snapshotProtected(cwd, policy))).toEqual(expect.arrayContaining([NL, TAB]));
    const adds = untrackedAdds({ cwd }, (rel) => isProtected(rel, policy)).map((c) => (c.kind === 'file' ? c.path : ''));
    expect(adds).toEqual(expect.arrayContaining([NL, TAB]));
  });

  it('the ignored keep filter', () => {
    const cwd = repo();
    mkdirSync(join(cwd, 'n\nl'));
    writeFileSync(join(cwd, NL), COLLECT_IGNORE);
    appendFileSync(join(cwd, '.git', 'info', 'exclude'), '*/conftest.py\n');
    expect(untrackedAdds({ cwd }).map((c) => (c.kind === 'file' ? c.path : ''))).not.toContain(NL); // git hides it
    expect(ignoredPaths({ cwd }, (rel) => isProtected(rel, policy))).toContain(NL); // the gate does not
  });

  it('PreToolUse and Stop: the collect_ignore conftest under n\\nl is judged, and the reason is one line', () => {
    const cwd = repo();
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
    mkdirSync(join(cwd, 'n\nl'));
    writeFileSync(join(cwd, NL), COLLECT_IGNORE);
    const r = stop(cwd);
    expect(reason(r)).toContain('test-skip (n\\nl/conftest.py:1)');
    expect(preToolUseVerdict(bash(cwd)).stdout).toContain('test-skip'); // the drift check at the next call, too
  });

  it('hiddenTrackedPaths: a skip-worktree spec at a\\tb is diffed by hand and its it.skip blocks', () => {
    const cwd = repo();
    mkdirSync(join(cwd, 'a\tb'));
    writeFileSync(join(cwd, TAB), "it('adds', () => { expect(1).toBe(1); });\n");
    execFileSync('git', ['add', '-A'], { cwd });
    execFileSync('git', ['commit', '-qm', 'tab'], { cwd });
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
    execFileSync('git', ['update-index', '--skip-worktree', '--', TAB], { cwd });
    expect(hiddenTrackedPaths({ cwd })).toContain(TAB);
    writeFileSync(join(cwd, TAB), "it.skip('adds', () => { expect(1).toBe(1); });\n");
    expect(reason(stop(cwd))).toContain('test-skip (a\\tb/x.test.ts');
  });

  it('check --worktree with untracked files lists and blocks it', () => {
    const cwd = repo();
    mkdirSync(join(cwd, 'n\nl'));
    writeFileSync(join(cwd, NL), COLLECT_IGNORE);
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      expect(runCheck({ worktree: true, includeUntracked: true, cwd, json: true })).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(out.join('')) as { findings: { rule: string; file?: string }[] };
    expect(parsed.findings.some((f) => f.rule === 'test-skip' && f.file === NL)).toBe(true);
  });
});
