// C5: the Stop sweep fed the detectors from `git diff <base>`, which never lists an
// UNTRACKED file. A protected file the turn CREATED — a conftest.py carrying
// `collect_ignore`, a vitest config that passes with no tests — was invisible to
// the sweep; only the `run` envelope scanned untracked files. The sweep now judges
// untracked protected files that are new or changed since the turn began, with
// real hunks (the untracked view used to hand over `hunks: []`, so the hunk-based
// rules read the file as an empty edit).

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preToolUseVerdict, stopVerdict } from '../src/cli/hook';
import { untrackedAdds } from '../src/git/build';
import { evaluate } from '../src/engine';
import { defaultPolicy } from '../src/policy';
import { synthFileChange } from '../src/adapters/claude/changes';
import { testSkip } from '../src/detectors/test-skip';
import { coverageLowering } from '../src/detectors/coverage-lowering';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-sweep-unt-'));
  dirs.push(d);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: d });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  mkdirSync(join(d, 'test'));
  mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'test', 'a.test.js'), `test('adds', () => { expect(add(1, 2)).toBe(3); });\n`);
  writeFileSync(join(d, 'test', 'test_a.py'), `def test_a():\n    assert 1 == 1\n`);
  writeFileSync(join(d, 'src', 'a.js'), 'exports.add = (a, b) => a + b;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return d;
}

const bash = (cwd: string, sid = 's1') => ({ tool_name: 'Bash', tool_input: { command: 'echo ok' }, cwd, session_id: sid });
const stop = (cwd: string, sid = 's1') => stopVerdict({ cwd, session_id: sid });
const reason = (r: { stdout: string }): string => (r.stdout ? JSON.parse(r.stdout).reason : '');

describe('Stop sweep sees untracked protected files (C5)', () => {
  it('an untracked conftest.py carrying collect_ignore blocks the turn', () => {
    const cwd = repo();
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe(''); // turn begins
    writeFileSync(join(cwd, 'test', 'conftest.py'), `collect_ignore = ["test_a.py"]\n`);
    const r = stop(cwd);
    expect(r.exitCode).toBe(0);
    expect(reason(r)).toContain('test-skip');
    expect(reason(r)).toContain('collect_ignore');
  });

  it('an untracked vitest.config.ts that passes with no tests blocks the turn', () => {
    const cwd = repo();
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
    writeFileSync(
      join(cwd, 'vitest.config.ts'),
      `export default { test: { passWithNoTests: true, coverage: { thresholds: { lines: 0 } } } };\n`,
    );
    expect(reason(stop(cwd))).toContain('coverage-lowering');
  });

  it('an untracked ORDINARY source file stays outside the sweep', () => {
    const cwd = repo();
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
    writeFileSync(join(cwd, 'src', 'scratch.ts'), `export const x = (globalThis as any).y;\n`); // would be ts-any-cast if scanned
    expect(stop(cwd).stdout).toBe('');
  });

  it('an untracked honest new test file is allowed (no green-to-red on new tests)', () => {
    const cwd = repo();
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
    writeFileSync(join(cwd, 'test', 'b.test.js'), `test('subtracts', () => { expect(sub(3, 1)).toBe(2); });\n`);
    writeFileSync(join(cwd, 'test', 'conftest.py'), `import pytest\n\n@pytest.fixture\ndef db():\n    return object()\n`);
    expect(stop(cwd).stdout).toBe('');
  });

  it('an untracked protected file that PRE-DATES the turn is not re-litigated', () => {
    const cwd = repo();
    // The developer's own, uncommitted conftest — present before the session's first call.
    writeFileSync(join(cwd, 'test', 'conftest.py'), `collect_ignore = ["test_slow.py"]\n`);
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe(''); // turn begins with it in place
    expect(stop(cwd).stdout).toBe('');
    // …but the turn CHANGING it is the turn's work again.
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
    writeFileSync(join(cwd, 'test', 'conftest.py'), `collect_ignore = ["test_slow.py", "test_a.py"]\n`);
    expect(reason(stop(cwd))).toContain('test-skip');
  });

  it('without a session the sweep judges every untracked protected file (fail closed)', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'test', 'conftest.py'), `collect_ignore = ["test_a.py"]\n`);
    expect(reason(stopVerdict({ cwd }))).toContain('test-skip');
  });

  it('a blocked turn keeps blocking until the file is fixed, then advances', () => {
    const cwd = repo();
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
    writeFileSync(join(cwd, 'test', 'conftest.py'), `collect_ignore = ["test_a.py"]\n`);
    expect(reason(stop(cwd))).toContain('test-skip');
    expect(reason(stop(cwd))).toContain('test-skip');
    writeFileSync(join(cwd, 'test', 'conftest.py'), `import pytest\n`);
    expect(stop(cwd).stdout).toBe('');
  });

  it('untracked adds carry real hunks, so hunk-based rules can read them', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'test', 'conftest.py'), `import os\ncollect_ignore = ["x.py"]\n`);
    const [c] = untrackedAdds({ cwd }, (rel) => rel.endsWith('conftest.py'));
    expect(c.kind).toBe('file');
    if (c.kind !== 'file') return;
    expect(c.op).toBe('add');
    expect(c.hunks).toHaveLength(1);
    expect(c.hunks[0].lines.map((l) => [l.type, l.newLine, l.content])).toEqual([
      ['add', 1, 'import os'],
      ['add', 2, 'collect_ignore = ["x.py"]'],
    ]);
  });
});

describe('pytest spellings test-skip did not know (C6)', () => {
  const P = defaultPolicy();
  const added = (path: string, before: string, line: string) =>
    evaluate(synthFileChange(path, before, before + line + '\n'), P, [testSkip]);

  it.each([
    ['collect_ignore = ["test_slow.py"]', 'collect_ignore'],
    ['collect_ignore_glob = ["test_*_slow.py"]', 'collect_ignore'],
    ['collect_ignore.append("test_a.py")', 'collect_ignore'],
    ['pytestmark = pytest.mark.skip(reason="later")', 'skip/skipif/xfail'],
    ['    pytest.param(1, marks=pytest.mark.xfail),', 'skip/skipif/xfail'],
    ['@mark.skipif(True, reason="x")', 'skip/skipif/xfail'],
    ['def pytest_ignore_collect(collection_path, config):', 'pytest_ignore_collect'],
    ['    __test__ = False', '__test__ = False'],
    ['np = pytest.importorskip("numpy")', 'importorskip'],
  ])('flags %s in a conftest.py', (line, why) => {
    const f = added('test/conftest.py', 'import pytest\n', line);
    expect(f).toHaveLength(1);
    expect(f[0].rule).toBe('test-skip');
    expect(f[0].message).toContain(why);
  });

  it('does not flag an ordinary conftest fixture', () => {
    const f = added('test/conftest.py', 'import pytest\n', '@pytest.fixture\ndef db():\n    return object()');
    expect(f).toHaveLength(0);
  });
});

describe('passWithNoTests as a config key (coverage-lowering)', () => {
  const P = defaultPolicy();
  it('flags a NEW vitest config carrying passWithNoTests: true', () => {
    const f = evaluate(synthFileChange('vitest.config.ts', null, `export default { test: { passWithNoTests: true } };\n`), P, [
      coverageLowering,
    ]);
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain('passWithNoTests');
  });
  it('does not flag passWithNoTests: false', () => {
    const f = evaluate(synthFileChange('vitest.config.ts', null, `export default { test: { passWithNoTests: false } };\n`), P, [
      coverageLowering,
    ]);
    expect(f).toHaveLength(0);
  });
});
