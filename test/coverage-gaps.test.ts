// Coverage gaps from the third audit: places where protection was silently
// absent rather than visibly off. Each case failed against 1.14.6.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { preToolUseVerdict } from '../src/cli/hook';
import { ptreePath } from '../src/effect';
import { defaultEventLog } from '../src/cli/watch';
import { evaluate } from '../src/engine';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy } from '../src/policy';
import { noVerify } from '../src/detectors/no-verify';
import { testSkip } from '../src/detectors/test-skip';
import { lintSuppression } from '../src/detectors/lint-suppression';
import { testDeletion, countTestBlocks } from '../src/detectors/test-deletion';
import { testContentRemoval } from '../src/detectors/test-content-removal';
import { transientFindings } from '../src/detectors/fs-events';
import type { Change, CommandChange, Detector, FileChange, Policy } from '../src/types';

const P = defaultPolicy();
const cmd = (raw: string): CommandChange => ({ kind: 'command', raw, argv: raw.split(/\s+/) });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function gitRepo(prefix: string): string {
  const d = tmp(prefix);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  writeFileSync(join(d, 'a.test.js'), 'test("x", () => {});\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return d;
}
/** Every path under `root` (relative), excluding `.git`. */
function treeOf(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === '.git') continue;
      const p = join(d, n);
      out.push(relative(root, p));
      if (statSync(p).isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}
const added = (path: string, line: string): Change[] =>
  parseDiff(`diff --git a/${path} b/${path}
index 1..2 100644
--- a/${path}
+++ b/${path}
@@ -1,0 +1,1 @@
+${line}`);
const modified = (path: string, before: string, after: string): FileChange => ({
  kind: 'file', path, oldPath: null, op: 'modify', before, after, binary: false, hunks: [],
});
const rules = (d: Detector, c: Change[]) => d.run(c, P).map((f) => f.rule);

// ── 1 · session state never lands inside the working tree ────────────────────
describe('1 · effect and watcher state live in the git dir, wherever it is', () => {
  it('a linked worktree keeps its ptree under the main .git, not inside the worktree', () => {
    const main = gitRepo('tw-wt-main-');
    const wt = join(tmp('tw-wt-'), 'wt');
    execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: main, stdio: 'pipe' });
    const p = ptreePath(wt, 'sess1');
    expect(p).not.toBeNull();
    expect(p!.startsWith(join(main, '.git', 'worktrees'))).toBe(true);

    preToolUseVerdict({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: wt, session_id: 'sess1' });
    expect(existsSync(p!)).toBe(true);
    // nothing appeared inside the worktree itself
    expect(treeOf(wt).filter((r) => r.includes('tamperward'))).toEqual([]);
    expect(defaultEventLog(wt).startsWith(join(main, '.git', 'worktrees'))).toBe(true);
    execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: main, stdio: 'pipe' });
  });

  it('a session started in a subdirectory writes to <repo>/.git, not <subdir>/<abs path>', () => {
    const repo = gitRepo('tw-sub-');
    const sub = join(repo, 'packages', 'a');
    mkdirSync(sub, { recursive: true });
    const p = ptreePath(sub, 'sess2');
    expect(p).toBe(join(repo, '.git', 'tamperward', 'ptree-sess2.json'));
    preToolUseVerdict({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: sub, session_id: 'sess2' });
    expect(existsSync(p!)).toBe(true);
    expect(treeOf(sub)).toEqual([]);
  });
});

// ── 2 · enabled: false is honoured by finding rule id ────────────────────────
describe('2 · enabled: false works for rules that are not detector ids', () => {
  it('ts-any-launder can be disabled although ts-any-cast emits it', () => {
    const policy: Policy = defaultPolicy();
    policy.rules['ts-any-launder'] = { severity: 'warn', enabled: false };
    const c = modified('src/x.ts', 'export const a: string = "x";\n', 'export const a: any = "x";\n');
    expect(evaluate([c], defaultPolicy()).map((f) => f.rule)).toContain('ts-any-launder');
    expect(evaluate([c], policy)).toHaveLength(0);
    // the sibling BLOCK rule from the same detector is untouched
    const cast = modified('src/y.ts', 'const a = b;\n', 'const a = b as any;\n');
    expect(evaluate([cast], policy).map((f) => f.rule)).toContain('ts-any-cast');
  });

  it('transient-protected-mutation can be disabled', () => {
    const policy: Policy = defaultPolicy();
    policy.rules['transient-protected-mutation'] = { severity: 'warn', enabled: false };
    const events = [
      { ts: '1', path: 'a.test.js', kind: 'change' as const, mode: 0o100644, size: 1, hash: 'aaaa' },
      { ts: '2', path: 'a.test.js', kind: 'change' as const, mode: 0o100644, size: 1, hash: 'bbbb' },
    ];
    expect(transientFindings(events, new Set(), defaultPolicy(), () => 'aaaa')).toHaveLength(1);
    expect(transientFindings(events, new Set(), policy, () => 'aaaa')).toHaveLength(0);
  });

  it('the engine\'s own detector-error can NOT be disabled from the policy', () => {
    const policy: Policy = defaultPolicy();
    policy.rules['detector-error'] = { severity: 'block', enabled: false };
    const boom: Detector = { id: 'boom', surface: ['file'], certainty: 'mechanical', run: () => { throw new Error('x'); } };
    const stderr = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = () => true;
    try {
      const f = evaluate([modified('src/x.ts', 'a', 'b')], policy, [boom], 'staged');
      expect(f.map((x) => x.rule)).toEqual(['detector-error']);
    } finally {
      (process.stderr as any).write = stderr;
    }
  });
});

// ── 3 · the other hook frameworks' documented skips ──────────────────────────
describe('3 · no-verify: SKIP= and LEFTHOOK_EXCLUDE=', () => {
  it.each([
    'SKIP=tamperward git commit -m x',
    'SKIP=tamperward,eslint git commit -m x',
    'SKIP=tamperward pre-commit run --all-files',
    'LEFTHOOK_EXCLUDE=pre-commit git commit -m x',
    'export LEFTHOOK_EXCLUDE=pre-commit; git commit -m x',
  ])('flags: %s', (c) => {
    expect(rules(noVerify, [cmd(c)])).toEqual(['no-verify']);
  });
  it.each(['SKIP=1 npm run build', 'SKIP=true node scripts/x.js', 'git commit -m "SKIP=nothing"'])(
    'does not flag: %s',
    (c) => {
      expect(rules(noVerify, [cmd(c)])).toEqual([]);
    },
  );
});

// ── 4 · protected ecosystems get their own skip and suppression spellings ────
describe('4 · test-skip reads the language of the protected file', () => {
  it.each([
    ['tests/test_x.py', '@pytest.mark.skip(reason="later")'],
    ['tests/test_x.py', '@pytest.mark.skipif(sys.platform == "win32")'],
    ['tests/test_x.py', '    pytest.skip("flaky")'],
    ['tests/test_x.py', '@unittest.skip("later")'],
    ['tests/test_x.py', '        self.skipTest("later")'],
    ['pkg/x_test.go', '\tt.Skip("later")'],
    ['pkg/x_test.go', '\tt.Skipf("no %s", why)'],
    ['tests/x.rs', '#[ignore]'],
    ['tests/x.rs', '#[ignore = "later"]'],
    ['spec/x_spec.rb', "    skip 'later'"],
    ['spec/x_spec.rb', '  xit "does x" do'],
    ['spec/x_spec.rb', "  it 'x', skip: true do"],
    ['src/test/java/XTest.java', '    @Disabled("later")'],
    ['src/test/java/XTest.java', '    @Ignore'],
    ['src/test/kotlin/XTest.kt', '    @Ignore'],
    ['tests/XTest.php', '        $this->markTestSkipped("later");'],
    ['XTests.cs', '        [Fact(Skip = "later")]'],
    ['XTests.cs', '        [Ignore("later")]'],
  ])('flags %s: %s', (path, line) => {
    expect(rules(testSkip, added(path, line))).toEqual(['test-skip']);
  });

  it.each([
    ['tests/test_x.py', 'def test_adds():'],
    ['tests/test_x.py', '    assert skip_count == 0'],
    ['pkg/x_test.go', 'func TestAdds(t *testing.T) {'],
    ['tests/x.rs', '#[test]'],
    ['spec/x_spec.rb', "  it 'skips nothing' do"],
    ['spec/x_spec.rb', "    expect(skipped).to eq(false)"],
    ['src/test/java/XTest.java', '    @Test'],
    ['tests/XTest.php', '    public function testAdds(): void'],
    ['XTests.cs', '        [Fact]'],
  ])('does not flag %s: %s', (path, line) => {
    expect(rules(testSkip, added(path, line))).toEqual([]);
  });

  it('a JS marker in a Python spec is not a finding (patterns are per language)', () => {
    expect(rules(testSkip, added('tests/test_x.py', '# was: it.skip in the old js port'))).toEqual([]);
  });
});

describe('4 · lint-suppression reads the language of the file', () => {
  it.each([
    ['src/x.py', 'import os  # noqa: F401'],
    ['src/x.py', 'x = y()  # type: ignore[attr-defined]'],
    ['src/x.py', '# pylint: disable=missing-docstring'],
    ['src/x.go', 'func x() { //nolint:errcheck'],
    ['lib/x.rb', '# rubocop:disable Metrics/AbcSize'],
    ['src/X.java', '@SuppressWarnings("unchecked")'],
    ['src/X.kt', '@Suppress("UNCHECKED_CAST")'],
    ['src/X.php', '// phpcs:ignore'],
    ['src/X.cs', '#pragma warning disable CS8618'],
  ])('flags %s: %s', (path, line) => {
    expect(rules(lintSuppression, added(path, line))).toEqual(['lint-suppression']);
  });

  it.each([
    ['src/x.py', 'noqa = compute()  # the variable, not the directive'],
    ['src/x.rs', '#[allow(dead_code)]'], // deliberately out: see the detector header
    ['README.md', '# noqa'],
    ['src/x.go', '// lint this properly'],
  ])('does not flag %s: %s', (path, line) => {
    expect(rules(lintSuppression, added(path, line))).toEqual([]);
  });
});

describe('4 · test-deletion counts definitions per language', () => {
  it.each([
    ['tests/test_x.py', 'def test_a():\n    pass\n\nasync def test_b():\n    pass\n\ndef helper():\n    pass\n', 2],
    ['pkg/x_test.go', 'func TestA(t *testing.T) {}\nfunc ExampleA() {}\nfunc helper() {}\nfunc BenchmarkA(b *testing.B) {}\n', 2],
    ['tests/x.rs', '#[test]\nfn a() {}\n#[tokio::test]\nasync fn b() {}\nfn helper() {}\n', 2],
    ['spec/x_spec.rb', "it 'a' do\nend\nspecify 'b' do\nend\ndef test_c\nend\n", 3],
    ['src/test/java/XTest.java', '@Test\nvoid a() {}\n@ParameterizedTest\nvoid b() {}\nvoid helper() {}\n', 2],
    ['tests/XTest.php', 'public function testA(): void {}\n#[Test]\npublic function b(): void {}\n', 2],
    ['XTests.cs', '[Fact]\npublic void A() {}\n[Theory]\npublic void B() {}\npublic void Helper() {}\n', 2],
  ])('%s: %i definitions', (path, src, n) => {
    expect(countTestBlocks(src, path)).toBe(n);
  });

  it('fires when a Python test definition disappears', () => {
    const before = 'def test_a():\n    assert add(1, 2) == 3\n\ndef test_b():\n    assert add(2, 2) == 4\n';
    const after = 'def test_a():\n    assert add(1, 2) == 3\n';
    const f = testDeletion.run([modified('tests/test_add.py', before, after)], P);
    expect(f.map((x) => x.rule)).toEqual(['test-deletion']);
    expect(f[0].message).toMatch(/2 → 1/);
  });

  it('removed # comments in a Python spec are not removed content', () => {
    const before =
      'def test_a():\n    # the first case, described at length here\n    # the second comment line, also long\n    # a third comment line for good measure\n    assert add(1, 2) == 3\n';
    const after = 'def test_a():\n    assert add(1, 2) == 3\n';
    expect(testContentRemoval.run([modified('tests/test_add.py', before, after)], P)).toHaveLength(0);
  });

  it('gutted assertions in a Go test still fire test-content-removal', () => {
    const before =
      'func TestA(t *testing.T) {\n\tif add(1, 2) != 3 {\n\t\tt.Fatal("1+2")\n\t}\n\tif add(2, 2) != 4 {\n\t\tt.Fatal("2+2")\n\t}\n\tif add(0, 0) != 0 {\n\t\tt.Fatal("0+0")\n\t}\n}\n';
    const after = 'func TestA(t *testing.T) {\n}\n';
    expect(testContentRemoval.run([modified('pkg/add_test.go', before, after)], P).map((f) => f.rule)).toEqual([
      'test-content-removal',
    ]);
  });
});
