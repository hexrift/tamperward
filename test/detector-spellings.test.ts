// Spellings an audit walked past (each reproduced against the built CLI) and the
// maintainer edits the same rules blocked. Every evasion here is the class the rule
// already covers in another spelling, so closing it is a patch; every control is a
// routine edit that must stay green.

import { describe, expect, it } from 'vitest';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy } from '../src/policy';
import { noVerify } from '../src/detectors/no-verify';
import { testSkip } from '../src/detectors/test-skip';
import { lintSuppression } from '../src/detectors/lint-suppression';
import { tsAnyCast } from '../src/detectors/ts-any-cast';
import { snapshotRewrite } from '../src/detectors/snapshot-rewrite';
import { gitSubcommand, words } from '../src/detectors/command';
import { insideStringLiteral, isCommentLine } from '../src/detectors/files';
import type { Change, CommandChange, FileChange } from '../src/types';

const P = defaultPolicy();
const cmd = (raw: string): CommandChange => ({ kind: 'command', raw, argv: raw.split(/\s+/) });
const added = (path: string, ...lines: string[]): Change[] =>
  parseDiff(`diff --git a/${path} b/${path}
index 1..2 100644
--- a/${path}
+++ b/${path}
@@ -1,0 +1,${lines.length} @@
${lines.map((l) => `+${l}`).join('\n')}`);
const rules = (fs: unknown[]) => (fs as Array<{ rule: string; severity: string }>).map((f) => `${f.rule}[${f.severity}]`);

// ── no-verify ──────────────────────────────────────────────────────────────
describe('no-verify: flags are tokens of the git subcommand, not words in the segment', () => {
  it.each([
    'git commit --no-veri -m x', // git accepts any unambiguous prefix
    'git commit --no-verif -m x',
    "git commit '--no-verify' -m x",
    'git commit "--no-verify" -m x',
    'git commit --no-verify"" -m x',
    'git push --no-verify',
    'git merge --no-verify feature',
    'git -C . commit -q -n -m x',
    'git -c user.name=x commit -nm x',
    'git commit --amend --no-edit -n',
    'export SKIP=tamperward; git commit -m x',
    'export SKIP=tamperward\ngit commit -m x',
    'SKIP=tamperward\ngit commit -m x',
    'SKIP=tamperward git commit -m x',
    'SKIP=tamperward pre-commit run --all-files',
    'export HUSKY=0; git commit -m x',
    'env HUSKY=0 git commit -m x',
    'LEFTHOOK_EXCLUDE=lint git commit -m x',
    'git -c core.hooksPath=/dev/null commit -m x',
  ])('blocks: %s', (c) => {
    const f = noVerify.run([cmd(c)], P);
    expect(f.length, c).toBeGreaterThanOrEqual(1);
    expect(f[0].severity).toBe('block');
  });

  it('names both segments when SKIP= was exported earlier in the command', () => {
    const f = noVerify.run([cmd('export SKIP=tamperward; git commit -m x')], P);
    expect(f).toHaveLength(1);
    expect(f[0].evidence).toBe('export SKIP=tamperward; git commit -m x');
  });

  it.each([
    'git commit --no-ver -m x', // ambiguous with --no-verbose: git refuses it
    'git log -n 5 -- src/cli/commit.ts',
    'git log -n 3 --grep=commit',
    'git commit -m "docs: explain why --no-verify is banned"',
    'git commit -m "feat: SKIP=lint support" -S',
    'git commit -m "add -n flag to CLI"',
    'grep -rn -- --no-verify docs/',
    'git stash list -n 2 && git commit -m x',
    'git commit -m x && npm test -- -n',
    'git commit --no-verbose -m x',
    'git commit -m "chore" --author="N <n@x>"',
    'git push -n origin HEAD',
    'SKIP=tamperward npm test; git commit -m x', // SKIP= scoped to npm, not exported
    'echo SKIP=x',
  ])('passes: %s', (c) => {
    expect(noVerify.run([cmd(c)], P), c).toHaveLength(0);
  });

  it('parses the git subcommand past global options and env prefixes', () => {
    expect(gitSubcommand(words('HUSKY=0 git -C . -c a=b commit -m x'))).toBe('commit');
    expect(gitSubcommand(words('git log -n 5 -- src/cli/commit.ts'))).toBe('log');
    expect(gitSubcommand(words('grep -- --no-verify docs/'))).toBeNull();
    expect(words(`git commit '--no-verify' -m "a b"`)).toEqual(['git', 'commit', '--no-verify', '-m', 'a b']);
  });
});

// ── test-skip (JS/TS) ──────────────────────────────────────────────────────
describe('test-skip: JavaScript spellings', () => {
  const spec = (...lines: string[]) => testSkip.run(added('src/a.spec.ts', ...lines), P);

  it.each([
    'it.skipIf(process.platform === "win32")("adds", () => {});',
    'it.runIf(false)("adds", () => {});',
    'describe.skipIf(cond)("m", () => {});',
    'it.fails("adds", () => {});',
    'test.failing("adds", () => {});',
    'it("adds", function () { this.skip(); expect(1).toBe(1); });',
    'it("adds", { skip: process.env.CI }, () => {});',
    "it('adds', { skip: !hasDb }, () => {});",
    'it("adds", { skip: 1 }, () => {});',
    'it.each([])("adds", () => {});',
    'it.concurrent.skip("adds", () => {});',
    'describe.concurrent.skip("m", () => {});',
    'test.sequential.only("adds", () => {});',
    'fit("adds", () => {});',
    'xdescribe("m", () => {});',
    'xit ("adds", () => {});',
  ])('blocks: %s', (line) => {
    expect(rules(spec(line)), line).toEqual(['test-skip[block]']);
  });

  it.each([
    'it("adds", () => { expect(label).toBe("fit"); });',
    'it("adds", () => { expect(list({ skip: 1, take: 5 })).toHaveLength(5); });',
    '// was xit while flaky; re-enabled',
    '/* fit("adds") used to live here */',
    ' * it.skip was removed in #12',
    'it("adds", () => { const fit = measure(); expect(fit).toBe(1); });',
    'it("adds", { skip: false }, () => {});',
    'it("adds", { timeout: 500 }, () => {});',
    'it.each([[1, 2, 3]])("adds %i %i", (a, b, c) => { expect(add(a, b)).toBe(c); });',
    'it("xit is not a word here", () => {});',
  ])('passes: %s', (line) => {
    expect(spec(line), line).toHaveLength(0);
  });
});

// ── test-skip (other ecosystems) ───────────────────────────────────────────
describe('test-skip: per-language spellings', () => {
  const at = (path: string, ...lines: string[]) => rules(testSkip.run(added(path, ...lines), P));

  it.each<[string, string]>([
    ['tests/test_a.py', 'pytestmark = pytest.mark.skip(reason="x")'],
    ['tests/test_a.py', 'pytestmark = [pytest.mark.slow, pytest.mark.skipif(True, reason="x")]'],
    ['tests/test_a.py', '@skip("x")'],
    ['tests/test_a.py', '@skipIf(sys.platform == "win32", "x")'],
    ['tests/test_a.py', '@pt.mark.skip'],
    ['tests/test_a.py', 'test_add.__test__ = False'],
    ['a_test.go', 'func TestAdd(t *testing.T) { if testing.Short() { return }; if add(1, 2) != 3 { t.Fatal("x") } }'],
    ['a_test.go', '//go:build ignore'],
    ['a_test.go', '// +build ignore'],
    ['tests/a.rs', '#[cfg_attr(not(feature = "never"), ignore)]'],
    ['spec/a_spec.rb', '  before { skip }'],
    ['spec/a_spec.rb', '    skip'],
    ['spec/a_spec.rb', '  it "adds"'],
    ['src/test/java/CalcTest.java', '  @Test void adds() { assumeTrue(false); assertEquals(3, add(1, 2)); }'],
    ['src/test/java/CalcTest.java', '  @Test void adds() { Assumptions.assumeTrue(false, "x"); }'],
    ['src/test/java/CalcTest.java', '  @org.junit.Ignore @Test void adds() {}'],
    ['src/test/kotlin/CalcTest.kt', '  @org.junit.jupiter.api.Disabled @Test fun adds() {}'],
    ['CalcTests.cs', '  [Fact, Explicit] public void Adds() {}'],
    ['CalcTests.cs', '  [Explicit("slow")] public void Adds() {}'],
    ['CalcTests.cs', '  [Fact] public void Adds() { Assert.Inconclusive(); }'],
  ])('blocks in %s: %s', (path, line) => {
    expect(at(path, line), line).toEqual(['test-skip[block]']);
  });

  it.each<[string, string]>([
    ['tests/test_a.py', '    # do not skip this: it guards the parser'],
    ['tests/test_a.py', '@skip_on_windows'],
    ['tests/test_a.py', 'pytestmark = pytest.mark.slow'],
    ['a_test.go', 'func TestAdd(t *testing.T) { if !testing.Short() { runLong(t) } }'],
    ['a_test.go', '//go:build integration'],
    ['tests/a.rs', '#[cfg_attr(test, allow(dead_code))]'],
    ['spec/a_spec.rb', '  it "adds" do'],
    ['spec/a_spec.rb', '  # skip'],
    ['spec/a_spec.rb', '  expect(label).to eq("fit")'],
    ['src/test/java/CalcTest.java', '  @Test void adds() { assumeTrue(db.isUp()); }'],
    ['CalcTests.cs', '  [Fact] public void Adds() { Assert.Equal(3, Calc.Add(1, 2)); }'],
    ['CalcTest.php', '  #[RequiresPhp("99.0")]'], // impossible requirement — out of scope, documented
  ])('passes in %s: %s', (path, line) => {
    expect(at(path, line), line).toHaveLength(0);
  });

  it('isCommentLine knows each language\u2019s comment syntax', () => {
    expect(isCommentLine('// x', 'js')).toBe(true);
    expect(isCommentLine('# x', 'py')).toBe(true);
    expect(isCommentLine('#[ignore]', 'rs')).toBe(false);
    expect(isCommentLine('#[RequiresPhp("99")]', 'php')).toBe(false);
    expect(isCommentLine('# x', 'php')).toBe(true);
    expect(isCommentLine('*ptr = 1', 'go')).toBe(false);
    expect(isCommentLine('* @param x', 'java')).toBe(true);
  });
});

// ── lint-suppression ───────────────────────────────────────────────────────
describe('lint-suppression: spellings and string-literal controls', () => {
  const at = (path: string, ...lines: string[]) => rules(lintSuppression.run(added(path, ...lines), P));

  it.each<[string, string]>([
    ['src.ts', '  /* eslint no-restricted-syntax: "off" */'],
    ['src.ts', '/* eslint no-restricted-syntax: 0, @typescript-eslint/no-explicit-any: 0 */'],
    ['src.ts', '/* eslint no-console: off */'],
    ['src.ts', "/* eslint quotes: ['off'] */"],
    ['src.ts', '/* eslint no-console: "error", no-debugger: 0 */'],
    ['m.py', '# ruff: noqa'],
    ['m.py', '# flake8: noqa'],
    ['m.py', '# mypy: ignore-errors'],
    ['m.py', '# pylint: skip-file'],
    ['m.py', '# pylint: disable=unused-import'],
    ['m.py', 'x = "a"  # noqa'],
    ['m.go', '//lint:ignore SA1019 legacy'],
    ['m.kt', '@file:Suppress("UNCHECKED_CAST")'],
    ['A.java', 'class A { int x = 1; // NOSONAR'],
    ['A.cs', '// ReSharper disable All'],
    ['a.php', '// @codingStandardsIgnoreLine'],
    ['a.php', '$x = 1; // phpcs:ignore'],
    ['src.ts', `const s = 'a'; // eslint-disable-line`], // quotes balanced before the directive
    ['src.ts', `const s = "it's"; // eslint-disable-line`], // a quote inside a string
  ])('blocks in %s: %s', (path, line) => {
    expect(at(path, line), line).toEqual(['lint-suppression[block]']);
  });

  it.each<[string, string]>([
    ['codemod.ts', 'export const HEADER = "/* eslint-disable */";'],
    ['codemod.ts', "const marker = '// eslint-disable-next-line';"],
    ['codemod.ts', 'const tpl = `// prettier-ignore`;'],
    ['m.py', '    """Never add # noqa here; fix the import instead."""'],
    ['m.py', "    msg = 'use # type: ignore sparingly'"],
    ['src.ts', '/* eslint-env node */'],
    ['src.ts', '/* eslint no-console: "error" */'],
    ['src.ts', '/* eslint max-len: ["error", { "code": 0 }] */'],
    ['a.rb', 'x = "# rubocop:disable Style/Foo"'],
  ])('passes in %s: %s', (path, line) => {
    expect(at(path, line), line).toHaveLength(0);
  });

  it('insideStringLiteral tracks quotes, escapes and comment openers per line', () => {
    expect(insideStringLiteral('a = "x // y"', 6, 'js')).toBe(true);
    expect(insideStringLiteral('a = "x"; // y', 9, 'js')).toBe(false);
    expect(insideStringLiteral('a = "it\\"s // y"', 10, 'js')).toBe(true);
    expect(insideStringLiteral('# "quoted" # noqa', 11, 'py')).toBe(false);
    expect(insideStringLiteral('"""doc # noqa"""', 7, 'py')).toBe(true);
  });
});

// ── ts-any-cast ────────────────────────────────────────────────────────────
describe('ts-any-cast: parenthesised and JSDoc casts', () => {
  const content = (path: string, before: string, after: string) => {
    const c: FileChange = { kind: 'file', path, oldPath: null, op: 'modify', before, after, hunks: [], binary: false };
    return rules(tsAnyCast.run([c], P));
  };
  const BASE = 'export function f(x: string): number {\n  return x.length;\n}\n';

  it('blocks `x as (any)` — the parens do not change the cast', () => {
    expect(content('src/x.ts', BASE, BASE.replace('x.length', '(x as (any)).length'))).toEqual(['ts-any-cast[block]']);
    expect(content('src/x.ts', BASE, BASE.replace('x.length', '(x as ((any))).length'))).toEqual(['ts-any-cast[block]']);
  });

  it('blocks the JSDoc cast `/** @type {any} */ (x)` in a JS file', () => {
    const js = 'export function f(x) { return x.length; }\n';
    expect(content('src/x.js', js, 'export function f(x) { return /** @type {any} */ (x).length; }\n')).toEqual(['ts-any-cast[block]']);
  });

  it('does not count the JSDoc cast in a .ts file, where JSDoc types are inert', () => {
    expect(content('src/x.ts', BASE, BASE.replace('x.length', '/** @type {any} */ (x).length'))).toHaveLength(0);
  });

  it('does not count a JSDoc annotation without the cast parens as a cast', () => {
    const js = 'export function f(x) { return x.length; }\n';
    expect(content('src/x.js', js, '/** @type {any} */\nlet y = 1;\nexport function f(x) { return x.length; }\n')).toHaveLength(0);
  });

  it('leaves `x as never` alone (deliberately: too broad to block)', () => {
    expect(content('src/x.ts', BASE, BASE.replace('x.length', '(x as never)'))).toHaveLength(0);
  });

  it('diff-only fallback sees the parenthesised spelling and the JSDoc cast', () => {
    expect(rules(tsAnyCast.run(added('src/x.ts', 'const n = (x as (any)).length;'), P))).toEqual(['ts-any-cast[block]']);
    expect(rules(tsAnyCast.run(added('src/x.js', 'const n = /** @type {any} */ (x).length;'), P))).toEqual(['ts-any-cast[block]']);
    expect(tsAnyCast.run(added('src/x.ts', 'const n = /** @type {any} */ (x).length;'), P)).toHaveLength(0);
  });
});

// ── snapshot-rewrite ───────────────────────────────────────────────────────
describe('snapshot-rewrite: update flags behind a package-manager script, and other ecosystems', () => {
  const run = (raw: string) => rules(snapshotRewrite.run([cmd(raw)], P));

  it.each([
    'npm test -- -u',
    'yarn test -u',
    'pnpm test -u',
    'npm t -- -u',
    'npm test -- --update',
    'npm run test:ci -- -u',
    'node --test --test-update-snapshots',
    "find . -name '*.snap' -delete",
    'find src -name "*.snap" -exec rm {} +',
    'git checkout -- src/__snapshots__/a.snap',
    'git checkout HEAD~3 -- golden/a.golden.txt',
    'git restore __snapshots__/',
    'cargo insta accept',
    'cargo insta test --accept',
    'pytest --snapshot-update',
    'UPDATE_EXPECT=1 cargo test',
  ])('warns: %s', (c) => {
    expect(run(c), c).toEqual(['snapshot-rewrite[warn]']);
  });

  it.each([
    'npm run test:update', // what the script does lives in package.json — not visible here
    'npm run build -- --update',
    'npm update',
    'npm test',
    'yarn test --watch',
    'sort -u names.txt',
    'git checkout main',
    'git checkout -b feat/x',
    'find . -name "*.log" -delete',
    'find . -name "*.snap"',
    'cargo insta review',
    'cargo test',
  ])('does not warn: %s', (c) => {
    expect(run(c), c).toHaveLength(0);
  });
});
