// The config-narrowing sweep: the runner is told not to open the spec, the coverage
// denominator is shrunk, the workflow is told not to run, the check line survives
// inside a neutralised block. Every positive here reproduced against the built CLI
// before the fix; every negative is a maintainer edit that blocked before the fix.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy } from '../src/policy';
import { testDeletion, countTests, countTestBlocks } from '../src/detectors/test-deletion';
import { testContentRemoval } from '../src/detectors/test-content-removal';
import { coverageLowering } from '../src/detectors/coverage-lowering';
import { ciTampering, foldConst, isAlwaysFalse, isTruthy } from '../src/detectors/ci-tampering';
import { isSignificantLine } from '../src/detectors/files';
import type { Change, CommandChange, Detector, DetectorContext, FileChange, FileOp } from '../src/types';

const P = defaultPolicy();
const cmd = (raw: string): CommandChange => ({ kind: 'command', raw, argv: raw.split(/\s+/) });

/** A file change with REAL hunks (git diff --no-index), so the line-scanning rules see it. */
function diffed(path: string, before: string | null, after: string | null, op?: FileOp): FileChange {
  const dir = mkdtempSync(join(tmpdir(), 'tw-cn-'));
  writeFileSync(join(dir, 'a'), before ?? '');
  writeFileSync(join(dir, 'b'), after ?? '');
  let raw = '';
  try {
    raw = execFileSync('git', ['diff', '--no-index', '--no-color', join(dir, 'a'), join(dir, 'b')], { encoding: 'utf8' });
  } catch (e) {
    raw = String((e as { stdout?: Buffer }).stdout ?? '');
  }
  rmSync(dir, { recursive: true, force: true });
  const parsed = parseDiff(raw)[0] as FileChange | undefined;
  return {
    kind: 'file', path, oldPath: null,
    op: op ?? (before == null ? 'add' : after == null ? 'delete' : 'modify'),
    before, after, binary: false, hunks: parsed?.hunks ?? [],
  };
}
const run = (d: Detector, c: Change[], ctx?: DetectorContext) => d.run(c, P, 'staged', ctx);
const msgs = (d: Detector, c: Change[], ctx?: DetectorContext) => run(d, c, ctx).map((f) => `${f.message} ${f.evidence}`);

// ── test-deletion: the runner's selection config ──────────────────────────────
describe('test-deletion — the runner is told not to open the spec', () => {
  const repo: DetectorContext = { trackedFiles: ['src/calc.ts', 'test/calc.test.ts', 'test/hard.test.ts', 'e2e/login.spec.ts'] };
  const jest = (body: string) => `module.exports = {\n${body}\n};\n`;
  const vitest = (body: string) => `import { configDefaults, defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {\n${body}\n} });\n`;

  it('jest testPathIgnorePatterns gaining an entry that hides a tracked spec', () => {
    const m = msgs(testDeletion, [diffed('jest.config.js', jest(''), jest('  testPathIgnorePatterns: ["<rootDir>/test/hard"],'))], repo);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/test\/hard\.test\.ts/);
    expect(m[0]).toMatch(/testPathIgnorePatterns/);
  });

  it('a NEW jest config that ignores the test directory (the audit reproduction)', () => {
    const m = msgs(testDeletion, [diffed('jest.config.js', null, jest('  testPathIgnorePatterns: ["<rootDir>/test/"],'))], repo);
    expect(m.length).toBe(2); // both specs under test/
  });

  it('jest testMatch narrowed to nothing', () => {
    expect(msgs(testDeletion, [diffed('jest.config.js', null, jest('  testMatch: ["**/nothing/*.ts"],'))], repo)).toHaveLength(2);
  });

  it('jest testRegex narrowed', () => {
    const before = jest('  testRegex: "\\\\.test\\\\.ts$",');
    const after = jest('  testRegex: "^nothing$",');
    expect(msgs(testDeletion, [diffed('jest.config.js', before, after)], repo)).toHaveLength(2);
  });

  it('vitest test.exclude gaining a spec, spread over configDefaults', () => {
    const m = msgs(testDeletion, [diffed('vitest.config.ts', vitest(''), vitest("  exclude: [...configDefaults.exclude, 'test/hard.test.ts'],"))], repo);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/test\.exclude/);
  });

  it('vitest test.include losing the directory', () => {
    const m = msgs(testDeletion, [diffed('vitest.config.ts', vitest("  include: ['test/**/*.test.ts', 'src/**/*.test.ts'],"), vitest("  include: ['src/**/*.test.ts'],"))], repo);
    expect(m).toHaveLength(2);
  });

  it('package.json jest section counts too', () => {
    const before = '{ "name": "x", "jest": { "testMatch": ["**/*.test.ts"] } }\n';
    const after = '{ "name": "x", "jest": { "testMatch": ["**/*.test.ts"], "testPathIgnorePatterns": ["/test/hard"] } }\n';
    expect(msgs(testDeletion, [diffed('package.json', before, after)], repo)).toHaveLength(1);
  });

  it.each([
    ['a benign ignore entry', jest('  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/dist/"],')],
    ['an equivalent testMatch respelling', jest('  testMatch: ["**/*.{test,spec}.ts"],')],
    ['an unrelated config edit', jest('  verbose: true,')],
    ['a computed list (opaque — nothing claimed)', jest('  testPathIgnorePatterns: ignored(),')],
  ])('stays silent on %s', (_n, after) => {
    const before = jest('  testMatch: ["**/*.test.ts", "**/*.spec.ts"],');
    expect(msgs(testDeletion, [diffed('jest.config.js', before, after)], repo)).toHaveLength(0);
  });

  it('excluding another runner\'s directory (e2e/, playwright) is set-up, not narrowing', () => {
    expect(msgs(testDeletion, [diffed('vitest.config.ts', vitest(''), vitest("  exclude: [...configDefaults.exclude, 'e2e/**'],"))], repo)).toHaveLength(0);
  });

  it('a multi-project jest config is the UNION of its projects: a spec some project still selects is kept', () => {
    const before = jest('  projects: [{ testMatch: ["**/*.test.ts"] }, { testMatch: ["**/*.spec.ts"] }],');
    const after = jest('  projects: [{ testMatch: ["**/*.test.ts"] }, { testMatch: ["**/nothing.ts"] }],');
    expect(msgs(testDeletion, [diffed('jest.config.js', before, after)], repo)).toHaveLength(0); // no .spec.ts in this repo
    expect(msgs(testDeletion, [diffed('jest.config.js', before, after)], { trackedFiles: ['test/a.spec.ts', 'test/b.test.ts'] })).toHaveLength(1);
  });

  it('without a repository listing the canonical layouts stand in', () => {
    expect(msgs(testDeletion, [diffed('jest.config.js', null, jest('  testMatch: ["**/nothing/*.ts"],'))]).length).toBeGreaterThan(0);
  });
});

// ── test-deletion: shell spellings ────────────────────────────────────────────
describe('test-deletion — shell spellings that erase a spec', () => {
  const repo: DetectorContext = { trackedFiles: ['src/calc.ts', 'test/a.test.ts', '__tests__/b.ts', 'packages/a/test/x.test.ts'] };
  it.each([
    'cp /dev/null test/a.test.ts',
    'cat /dev/null | tee test/a.test.ts',
    'sed --in-place "/it(/d" test/a.test.ts',
    'sed -i.bak "/it(/d" test/a.test.ts',
    'perl -pi -e "s/it\\(/xit(/" test/a.test.ts',
    'truncate -s0 test/a.test.ts',
    'find test -name "*.test.ts" -delete',
    'find . -name "*.test.ts" -exec rm {} +',
    'git checkout HEAD~5 -- test/a.test.ts',
    'git checkout main -- test',
    'git restore --source=v1.0.0 test/a.test.ts',
    'rm -rf test',
    'rm -rf __tests__',
    'rm -r ./test/',
    'cd packages/a && rm -rf test',
    'mv __tests__ archive',
  ])('flags: %s', (c) => {
    expect(run(testDeletion, [cmd(c)], repo).length).toBeGreaterThan(0);
  });

  it.each([
    'rm -rf dist/__tests__',
    'rm -rf coverage/test',
    'rm -rf node_modules && npm ci',
    'npm test',
    'npm test | tee test.log',
    'git checkout -- test/a.test.ts',
    'git restore --staged test/a.test.ts',
    'git checkout -b feature/test',
    'cat test/a.test.ts | tee /tmp/copy',
    'tee -a test/a.test.ts < notes.txt',
    'cp test/a.test.ts test/b.test.ts',
    'mv test tests',
    'sed -n "1,20p" test/a.test.ts',
    'find test -name "*.test.ts"',
    'cd test && ls',
  ])('stays silent: %s', (c) => {
    expect(run(testDeletion, [cmd(c)], repo)).toHaveLength(0);
  });

  it('a spec named from a cwd the listing cannot see is still covered (no false negative)', () => {
    expect(run(testDeletion, [cmd('rm packages/b/test/z.test.ts')], repo)).toHaveLength(1);
    expect(run(testDeletion, [cmd('cd /somewhere && rm -rf __tests__')], repo)).toHaveLength(1);
  });
});

// ── test-deletion: maintainer edits that used to block ────────────────────────
describe('test-deletion — relocation pooling, each-tables, JVM annotations', () => {
  const T4 = `import { add, sub } from "../src/calc";
describe("calc", () => {
  it("adds", () => { expect(add(1, 2)).toBe(3); });
  it("adds negatives", () => { expect(add(-1, -2)).toBe(-3); });
  it("subs", () => { expect(sub(1, 2)).toBe(-1); });
  it("subs zero", () => { expect(sub(0, 0)).toBe(0); });
});
`;
  const file = (path: string, before: string | null, after: string | null): FileChange => diffed(path, before, after);

  it('splitting a spec into two files (modify + add) is a move', () => {
    const calc = `import { add } from "../src/calc";
describe("add", () => {
  it("adds", () => { expect(add(1, 2)).toBe(3); });
  it("adds negatives", () => { expect(add(-1, -2)).toBe(-3); });
});
`;
    const sub = `import { sub } from "../src/calc";
describe("sub", () => {
  it("subs", () => { expect(sub(1, 2)).toBe(-1); });
  it("subs zero", () => { expect(sub(0, 0)).toBe(0); });
});
`;
    expect(run(testDeletion, [file('test/calc.test.ts', T4, calc), file('test/sub.test.ts', null, sub)])).toHaveLength(0);
  });

  it('merging a spec into an existing one (delete + modify) is a move', () => {
    const mul = `import { mul } from "../src/calc";
describe("mul", () => {
  it("multiplies", () => { expect(mul(2, 3)).toBe(6); });
  it("multiplies by zero", () => { expect(mul(2, 0)).toBe(0); });
});
`;
    expect(run(testDeletion, [file('test/mul.test.ts', mul, null), file('test/calc.test.ts', T4, T4 + mul)])).toHaveLength(0);
  });

  it('a split that drops a test on the way still fires', () => {
    const calc = `import { add } from "../src/calc";
describe("add", () => {
  it("adds", () => { expect(add(1, 2)).toBe(3); });
});
`;
    const sub = `import { sub } from "../src/calc";
describe("sub", () => {
  it("subs", () => { expect(sub(1, 2)).toBe(-1); });
  it("subs zero", () => { expect(sub(0, 0)).toBe(0); });
});
`;
    expect(run(testDeletion, [file('test/calc.test.ts', T4, calc), file('test/sub.test.ts', null, sub)])).toHaveLength(1);
  });

  it('two it() folded into one it.each with two rows is the same suite', () => {
    const each = `import { add, sub } from "../src/calc";
describe("calc", () => {
  it.each([[1, 2, 3], [-1, -2, -3]])("adds %i+%i", (a, b, c) => { expect(add(a, b)).toBe(c); });
  it.each([[1, 2, -1], [0, 0, 0]])("subs %i-%i", (a, b, c) => { expect(sub(a, b)).toBe(c); });
});
`;
    expect(run(testDeletion, [file('test/calc.test.ts', T4, each)])).toHaveLength(0);
  });

  it('a row deleted from a literal each-table is a deleted test', () => {
    const rows = (n: number) => `it.each([\n${['["1 + 2", 3]', '["2 * 3", 6]', '["(1 + 2) * 3", 9]', '["10 / 2", 5]', '["7 - 10", -3]'].slice(0, n).join(',\n')}\n])("evaluates %s", (i, e) => { expect(parse(i)).toBe(e); });\n`;
    const f = run(testDeletion, [file('test/parse.test.ts', rows(5), rows(2))]);
    expect(f).toHaveLength(1);
    expect(f[0].evidence).toMatch(/3 test block\(s\) removed/);
  });

  it('counts each-table rows, template tables, and reads a spread as open', () => {
    expect(countTests('it.each([[1], [2], [3]])("x", () => {});')).toEqual({ min: 3, open: false });
    expect(countTests('it.each`\n a | b\n 1 | 2\n 3 | 4\n`("x", () => {});')).toEqual({ min: 2, open: false });
    expect(countTests('it.each([...rows, [1]])("x", () => {});')).toEqual({ min: 1, open: true });
    expect(countTests('it.each(rows)("x", () => {});')).toEqual({ min: 1, open: true });
    expect(countTestBlocks('it("a", () => {}); test.each([[1], [2]])("b", () => {});')).toBe(3);
  });

  it('a table that became open (spread from elsewhere) is not claimed as a block drop', () => {
    const before = 'it.each([\n  [1, 2],\n  [3, 4],\n  [5, 6],\n])("x", () => {});\n';
    const after = 'it.each([...rows,\n  [1, 2],\n])("x", () => {});\n';
    expect(run(testDeletion, [file('a.test.ts', before, after)])).toHaveLength(0); // test-content-removal's row signal owns it
  });

  it('Java: annotations sharing the @Test line still count', () => {
    const before = 'class CalcTest {\n  @Test void adds() { assertEquals(3, add(1, 2)); }\n  @Test void subs() { assertEquals(-1, sub(1, 2)); }\n}\n';
    const after = before.replace('  @Test void adds', '  @Timeout(5) @Test void adds');
    expect(run(testDeletion, [file('src/test/java/CalcTest.java', before, after)])).toHaveLength(0);
    expect(countTestBlocks(after, 'CalcTest.java')).toBe(2);
    expect(countTestBlocks('  @DisplayName("x") @ParameterizedTest\n', 'X.kt')).toBe(1);
  });
});

// ── test-content-removal ──────────────────────────────────────────────────────
describe('test-content-removal — open each-tables and debug chatter', () => {
  const spec = (table: string, rows: string[]) => `import { parse } from "../src/parse";
describe("parse", () => {
  ${table}
${rows.map((r) => `    ${r},`).join('\n')}
  ])("evaluates %s", (input, expected) => {
    expect(parse(input)).toBe(expected);
  });
});
`;
  const ALL = ['["1 + 2", 3]', '["2 * 3", 6]', '["(1 + 2) * 3", 9]', '["10 / 2", 5]', '["7 - 10", -3]'];
  const file = (path: string, before: string | null, after: string | null): FileChange => diffed(path, before, after);

  it('three rows gone behind a lengthened `it.each([...rows,` line (net drop 2) now fires', () => {
    const f = run(testContentRemoval, [file('test/parse.test.ts', spec('it.each([', ALL), spec('it.each([...rows,', ALL.slice(0, 2)))]);
    expect(f).toHaveLength(1);
    expect(f[0].message).toMatch(/Rows removed/);
    expect(f[0].evidence).toContain('["10 / 2", 5]');
  });

  it('the same edit with the rows extracted to a helper module is a refactor', () => {
    const helper = 'export const rows = [\n    ["(1 + 2) * 3", 9],\n    ["10 / 2", 5],\n    ["7 - 10", -3],\n];\n';
    const changes = [file('test/parse.test.ts', spec('it.each([', ALL), spec('it.each([...rows,', ALL.slice(0, 2))), file('test/helpers.ts', null, helper)];
    expect(run(testContentRemoval, changes)).toHaveLength(0);
    expect(run(testDeletion, changes)).toHaveLength(0);
  });

  it('rows gone from a CLOSED table are test-deletion\'s (one mechanism reports once)', () => {
    const changes = [file('test/parse.test.ts', spec('it.each([', ALL), spec('it.each([', ALL.slice(0, 2)))];
    expect(run(testContentRemoval, changes)).toHaveLength(0);
    expect(run(testDeletion, changes)).toHaveLength(1);
  });

  it('removing console.log debug lines from a spec is not gutting', () => {
    const body = (debug: string) => `it("throws on garbage", () => {\n${debug}  expect(() => parse("@@")).toThrow("unexpected token");\n  expect(() => parse("1 +")).toThrow("unexpected end");\n  expect(() => parse("")).toThrow("empty");\n});\n`;
    const before = body('  console.log("debug: starting garbage test");\n  console.log("debug: parser state", parse);\n  console.log("debug: about to assert throws");\n  debugger;\n');
    expect(run(testContentRemoval, [file('test/parse.test.ts', before, body(''))])).toHaveLength(0);
    expect(isSignificantLine('console.log("debug: starting garbage test");', 'js')).toBe(false);
    expect(isSignificantLine('expect(console.log).toHaveBeenCalledWith("x");', 'js')).toBe(true);
  });

  it('toThrow("msg") → toThrow() one-for-one is assertion-weakening territory, left alone here', () => {
    const body = (arg: string) => `it("throws", () => {\n  expect(() => parse("@@")).toThrow(${arg});\n  expect(() => parse("1 +")).toThrow(${arg});\n  expect(() => parse("")).toThrow(${arg});\n});\n`;
    expect(run(testContentRemoval, [file('test/parse.test.ts', body('"some message here"'), body(''))])).toHaveLength(0);
  });
});

// ── coverage-lowering ─────────────────────────────────────────────────────────
describe('coverage-lowering — the other dials', () => {
  const JC = (extra = '', th = 'global: { lines: 80, branches: 70, functions: 80, statements: 80 }') =>
    `module.exports = {\n  collectCoverageFrom: ["src/**/*.ts"],\n${extra}  coverageThreshold: { ${th} },\n};\n`;
  const file = (path: string, before: string | null, after: string | null): FileChange => diffed(path, before, after);
  const reasons = (c: Change[], ctx?: DetectorContext) => run(coverageLowering, c, ctx).map((f) => f.evidence);

  it.each([
    ['passWithNoTests as a jest config key', JC('  passWithNoTests: true,\n'), /passWithNoTests/],
    ['coveragePathIgnorePatterns gaining source', JC('  coveragePathIgnorePatterns: ["src/hard"],\n'), /exempts "src\/hard"/],
    ['collectCoverageFrom narrowed', JC().replace('"src/**/*.ts"', '"src/index.ts"'), /no longer measures/],
    ['collectCoverageFrom gaining a source exemption', JC().replace('"src/**/*.ts"', '"src/**/*.ts", "!src/hard.ts"'), /now exempts "!src\/hard\.ts"/],
  ])('flags %s', (_n, after, re) => {
    const r = reasons([file('jest.config.js', JC(), after)]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(re);
  });

  it.each([
    ['exempting type declarations and tests from the denominator', JC().replace('"src/**/*.ts"', '"src/**/*.ts", "!src/**/*.d.ts", "!src/**/*.test.ts"')],
    ['ignoring node_modules and dist', JC('  coveragePathIgnorePatterns: ["/node_modules/", "<rootDir>/dist/"],\n')],
    ['a stricter per-path override naming one metric', JC('', 'global: { lines: 80, branches: 70, functions: 80, statements: 80 }, "./src/core.ts": { lines: 100 }')],
    ['a spread refactor (unseen, not removed)', 'const base = { branches: 70, functions: 80, statements: 80 };\nmodule.exports = { coverageThreshold: { global: { ...base, lines: 80 } } };\n'],
    ['thresholds bound through a const', 'const thresholds = { global: { lines: 80, branches: 70, functions: 80, statements: 80 } };\nmodule.exports = { coverageThreshold: thresholds };\n'],
    ['a metric that is an expression', JC('', 'global: { lines: 40 * 2, branches: 70, functions: 80, statements: 80 }')],
    ['a raise', JC('', 'global: { lines: 90, branches: 70, functions: 80, statements: 80 }')],
  ])('stays silent on %s', (_n, after) => {
    expect(reasons([file('jest.config.js', JC(), after)])).toHaveLength(0);
  });

  it('a new override BELOW global on a named metric is still the live leak', () => {
    const r = reasons([file('jest.config.js', JC(), JC('', 'global: { lines: 80, branches: 70, functions: 80, statements: 80 }, "./src/hard.ts": { lines: 10 }'))]);
    expect(r).toEqual(['required coverage for src/hard.ts: lines threshold lowered 80 → 10']);
  });

  it('removing an override: silent for a file no longer in the repo, reported for one that is', () => {
    const before = 'module.exports = { coverageThreshold: { global: { lines: 80 }, "./src/old.ts": { lines: 100 } } };\n';
    const after = 'module.exports = { coverageThreshold: { global: { lines: 80 } } };\n';
    expect(reasons([file('jest.config.js', before, after)], { trackedFiles: ['src/new.ts'] })).toHaveLength(0);
    expect(reasons([file('jest.config.js', before, after)], { trackedFiles: ['src/old.ts'] })).toHaveLength(1);
    expect(reasons([file('jest.config.js', before, after)])).toHaveLength(1); // no listing: reported as before
  });

  it('a lowering routed through a const binding is read through it', () => {
    const after = 'const thresholds = { global: { lines: 50, branches: 70, functions: 80, statements: 80 } };\nmodule.exports = { coverageThreshold: thresholds };\n';
    expect(reasons([file('jest.config.js', JC(), after)])).toEqual(['global lines threshold lowered 80 → 50']);
  });

  it('a spread refactor that ALSO lowers a visible metric is still caught', () => {
    const after = 'const base = { branches: 70, functions: 80, statements: 80 };\nmodule.exports = { coverageThreshold: { global: { ...base, lines: 50 } } };\n';
    expect(reasons([file('jest.config.js', JC(), after)])).toEqual(['global lines threshold lowered 80 → 50']);
  });

  const VC = (test: string) => `export default { test: { ${test} } };\n`;
  it.each([
    ['vitest passWithNoTests', VC('passWithNoTests: true, coverage: { thresholds: { lines: 80 } }'), /passWithNoTests/],
    ['vitest thresholds.autoUpdate', VC('coverage: { thresholds: { lines: 80, autoUpdate: true } }'), /autoUpdate/],
    ['vitest coverage.exclude gaining source', VC('coverage: { exclude: ["src/hard.ts"], thresholds: { lines: 80 } }'), /exempts "src\/hard\.ts"/],
  ])('flags %s', (_n, after, re) => {
    const r = reasons([file('vitest.config.ts', VC('coverage: { thresholds: { lines: 80 } }'), after)]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(re);
  });

  it('vitest coverage.exclude of tests, configs and types is housekeeping', () => {
    expect(reasons([file('vitest.config.ts', VC('coverage: { thresholds: { lines: 80 } }'), VC('coverage: { exclude: ["**/*.test.ts", "**/*.config.*", "src/types/**"], thresholds: { lines: 80 } }'))])).toHaveLength(0);
  });

  const PJ = (script: string, extra = '') => `{ "name": "x", "scripts": { "test": "${script}" }, "jest": { "coverageThreshold": { "global": { "lines": 80 } } }${extra} }\n`;
  it.each([
    ['--coverage=false', PJ('jest --coverage=false')],
    ['--coverageThreshold={}', PJ('jest --coverage --coverageThreshold={}')],
    ["--coverageThreshold='{}'", PJ("jest --coverage --coverageThreshold='{}'")],
    ['an nyc section switching check-coverage off', PJ('jest --coverage', ', "nyc": { "check-coverage": false }')],
  ])('flags %s in a package.json script', (_n, after) => {
    expect(reasons([file('package.json', PJ('jest --coverage'), after)]).length).toBeGreaterThan(0);
  });

  it('moving the flag to a second script (test:cov) keeps --coverage present', () => {
    const after = '{ "name": "x", "scripts": { "test": "jest", "test:cov": "jest --coverage" }, "jest": { "coverageThreshold": { "global": { "lines": 80 } } } }\n';
    expect(reasons([file('package.json', PJ('jest --coverage'), after)])).toHaveLength(0);
  });

  it.each([
    ['.coveragerc fail_under', '.coveragerc', '[report]\nfail_under = 90\n', '[report]\nfail_under = 10\n', /fail_under lowered 90 → 10/],
    ['pyproject [tool.coverage.report] fail_under', 'pyproject.toml', '[tool.coverage.report]\nfail_under = 90\n', '[tool.coverage.report]\nfail_under = 10\n', /fail_under lowered/],
    ['.nycrc lines', '.nycrc', '{ "check-coverage": true, "lines": 90 }\n', '{ "check-coverage": true, "lines": 10 }\n', /lines lowered 90 → 10/],
    ['.nycrc check-coverage off', '.nycrc', '{ "check-coverage": true, "lines": 90 }\n', '{ "check-coverage": false, "lines": 90 }\n', /check-coverage/],
    ['codecov target', 'codecov.yml', 'coverage:\n  status:\n    project:\n      default:\n        target: 90%\n', 'coverage:\n  status:\n    project:\n      default:\n        target: 0%\n', /target lowered 90 → 0/],
    ['codecov threshold widened', '.codecov.yml', 'coverage:\n  status:\n    project:\n      default:\n        target: 90%\n        threshold: 1%\n', 'coverage:\n  status:\n    project:\n      default:\n        target: 90%\n        threshold: 50%\n', /threshold raised 1 → 50/],
    ['codecov informational', 'codecov.yml', 'coverage:\n  status:\n    project:\n      default:\n        target: 90%\n', 'coverage:\n  status:\n    project:\n      default:\n        target: 90%\n        informational: true\n', /informational/],
  ])('flags %s', (_n, path, before, after, re) => {
    const r = reasons([file(path, before, after)]);
    expect(r.some((x) => re.test(x))).toBe(true);
  });

  it.each([
    ['.coveragerc raised', '.coveragerc', '[report]\nfail_under = 80\n', '[report]\nfail_under = 90\n'],
    ['codecov targets reordered', 'codecov.yml', 'a:\n  target: 90%\nb:\n  target: 80%\n', 'b:\n  target: 80%\na:\n  target: 90%\n'],
    ['pyproject dependency edit', 'pyproject.toml', '[project]\ndependencies = ["a"]\n[tool.coverage.report]\nfail_under = 90\n', '[project]\ndependencies = ["a", "b"]\n[tool.coverage.report]\nfail_under = 90\n'],
  ])('stays silent on %s', (_n, path, before, after) => {
    expect(reasons([file(path, before, after)])).toHaveLength(0);
  });

  it('deleting .coveragerc removes the gate', () => {
    expect(reasons([file('.coveragerc', '[report]\nfail_under = 90\n', null)])).toEqual(['.coveragerc']);
  });
});

// ── ci-tampering ──────────────────────────────────────────────────────────────
describe('ci-tampering — neutralised blocks, narrowed triggers, folded constants, kept edits', () => {
  const WF = `name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm test
      - run: npm run lint
      - uses: golangci/golangci-lint-action@v3
      - run: npm run deploy
`;
  const ed = (...pairs: string[]): Change[] => {
    let s = WF;
    for (let i = 0; i < pairs.length; i += 2) {
      if (!s.includes(pairs[i])) throw new Error(`fixture lacks ${pairs[i]}`);
      s = s.replace(pairs[i], pairs[i + 1]);
    }
    return [diffed('.github/workflows/ci.yml', WF, s)];
  };
  const m = (c: Change[]) => msgs(ciTampering, c);

  it.each([
    ['set +e before the check', '      - run: npm test', '      - run: |\n          set +e\n          npm test', /set \+e/],
    ['exit 0 before the check', '      - run: npm test', '      - run: |\n          exit 0\n          npm test', /exit 0/],
    ['if false; then around the check', '      - run: npm test', '      - run: |\n          if false; then\n            npm test\n          fi', /if false/],
    ['a heredoc comment swallowing the check', '      - run: npm test', '      - run: |\n          : <<SKIP\n          npm test\n          SKIP', /heredoc/],
    ['shell: bash {0} on the check step', '      - run: npm test', '      - run: |\n          npm test\n          true\n        shell: bash {0}', /\{0\}/],
    ['|| true on the check line', '      - run: npm test', '      - run: npm test || true', /neutralised in place/],
    ['| tee masking the status', '      - run: npm test', '      - run: npm test | tee out.log', /neutralised in place/],
    ['--passWithNoTests appended', '      - run: npm test', '      - run: npm test -- --passWithNoTests', /neutralised in place/],
    ['-t narrowing the suite', '      - run: npm test', '      - run: npm test -- -t "trivial"', /neutralised in place/],
    ['pull_request trigger removed', '  pull_request:\n', '', /pull_request trigger was removed/],
    ['paths-ignore everything', '  pull_request:', "  pull_request:\n    paths-ignore: ['**']", /paths-ignore now ignores every path/],
    ['branches no longer naming main', '    branches: [main]', '    branches: [nonexistent-branch]', /no longer names main/],
    ['branches-ignore covering main', '    branches: [main]', '    branches-ignore: [main]', /branches-ignore now covers the default branch/],
    ['continue-on-error: "true"', '      - run: npm test', '      - run: npm test\n        continue-on-error: "true"', /continue-on-error/],
    ['continue-on-error: yes', '      - run: npm test', '      - run: npm test\n        continue-on-error: yes', /continue-on-error/],
    ['continue-on-error: ${{ 1 == 1 }}', '      - run: npm test', '      - run: npm test\n        continue-on-error: ${{ 1 == 1 }}', /continue-on-error/],
    ["if: ${{ 'a' == 'b' }}", '      - run: npm test', "      - run: npm test\n        if: ${{ 'a' == 'b' }}", /can never run/],
    ['if: ${{ false && true }}', '      - run: npm test', '      - run: npm test\n        if: ${{ false && true }}', /can never run/],
    ['if: ${{ !true }}', '      - run: npm test', '      - run: npm test\n        if: ${{ !true }}', /can never run/],
    ['if: "false" (quoted)', '      - run: npm test', '      - run: npm test\n        if: "false"', /can never run/],
    ["if: 'x' != 'X' (case-insensitive compare)", '      - run: npm test', "      - run: npm test\n        if: ${{ 'x' != 'X' }}", /can never run/],
    ['job-level if: false', '    runs-on: ubuntu-latest', '    runs-on: ubuntu-latest\n    if: false', /can never run/],
    ['job-level continue-on-error', '    runs-on: ubuntu-latest', '    runs-on: ubuntu-latest\n    continue-on-error: true', /continue-on-error/],
  ])('flags %s', (_n, from, to, re) => {
    const r = m(ed(from, to));
    expect(r.some((x) => re.test(x)), r.join('\n')).toBe(true);
  });

  it('on: [push, pull_request] → on: workflow_dispatch', () => {
    const before = 'name: ci\non: [push, pull_request]\njobs:\n  t:\n    steps:\n      - run: npm test\n';
    const after = before.replace('on: [push, pull_request]', 'on: workflow_dispatch');
    expect(m([diffed('.github/workflows/ci.yml', before, after)]).filter((x) => /trigger was removed/.test(x))).toHaveLength(2);
  });

  it.each([
    ['a reporter flag added', '      - run: npm test', '      - run: npm test -- --reporter=dot'],
    ['npm run test', '      - run: npm test', '      - run: npm run test'],
    ['npm t', '      - run: npm test', '      - run: npm t'],
    ['quoted', '      - run: npm test', "      - run: 'npm test'"],
    ['a pnpm migration', '      - run: npm ci\n      - run: npm test\n      - run: npm run lint', '      - run: pnpm install --frozen-lockfile\n      - run: pnpm test\n      - run: pnpm run lint'],
    ['an action bump', '      - uses: golangci/golangci-lint-action@v3', '      - uses: golangci/golangci-lint-action@v4'],
    ['a checkout bump', 'actions/checkout@v4', 'actions/checkout@v5'],
    ['an argument dropped', '      - run: npm run lint', '      - run: npm run lint'.replace('npm run lint', 'npm run lint')],
    ['a name added', '      - run: npm test', '      - name: Run the tests\n        run: npm test'],
    ['a reachable if:', '      - run: npm test', '      - run: npm test\n        if: github.event.pull_request.draft == false'],
    ['if: ${{ !cancelled() }}', '      - run: npm test', '      - run: npm test\n        if: ${{ !cancelled() }}'],
    ['if: cancelled()', '      - run: npm test', '      - run: npm test\n        if: cancelled()'],
    ['an always-true constant', '      - run: npm test', '      - run: npm test\n        if: ${{ 1 == 1 }}'],
    ['continue-on-error on a non-check step', '      - run: npm run lint', '      - run: npm run lint\n      - run: npm audit\n        continue-on-error: true'],
    ['if: false on the deploy step', '      - run: npm run deploy', '      - run: npm run deploy\n        if: false'],
    ['set +e where the status is propagated', '      - run: npm test', '      - run: |\n          set +e\n          npm test\n          code=$?\n          set -e\n          echo "tests: $code"\n          exit $code'],
    ['a second command chained with &&', '      - run: npm test', '      - run: npm test && npm run typecheck'],
    ['a multiline split', '      - run: npm test', '      - run: |\n          npm test\n          npm run typecheck'],
    ['branches widened', '    branches: [main]', '    branches: [main, develop]'],
    ['a non-default branch dropped from the list', '    branches: [main]', '    branches: [main]'],
    ['the branches filter dropped entirely (wider)', '    branches: [main]\n', ''],
    ['paths-ignore for docs', '  pull_request:', "  pull_request:\n    paths-ignore: ['docs/**', '**.md']"],
    ['a workflow_dispatch trigger added', '  pull_request:', '  pull_request:\n  workflow_dispatch:'],
  ])('stays silent on %s', (_n, from, to) => {
    expect(m(ed(from, to))).toEqual([]);
  });

  it('[main, develop] → [main] keeps the default branch and stays silent', () => {
    const before = WF.replace('branches: [main]', 'branches: [main, develop]');
    expect(m([diffed('.github/workflows/ci.yml', before, WF)])).toEqual([]);
  });

  it('a new workflow file has no before-triggers to narrow', () => {
    expect(m([diffed('.github/workflows/new.yml', null, WF.replace('  pull_request:\n', ''))])).toEqual([]);
  });

  it('the removal that IS a removal still fires', () => {
    expect(m(ed('      - run: npm test\n', ''))).toEqual(['A CI check command was removed from a run block. - run: npm test']);
    expect(m(ed('      - run: npm test', '      - run: echo "tests run elsewhere"'))).toHaveLength(1);
  });

  it('folds the literal subset and refuses anything with a context reference', () => {
    expect(foldConst("'a' == 'b'")).toBe(false);
    expect(foldConst('false && true')).toBe(false);
    expect(foldConst('!true')).toBe(false);
    expect(foldConst('1 == 1')).toBe(true);
    expect(foldConst("(false || 'x') && 2 > 1")).toBe(true);
    expect(foldConst("'It''s' == 'it''s'")).toBe(true);
    expect(foldConst('github.event_name == \'push\'')).toBeUndefined();
    expect(foldConst('!cancelled()')).toBeUndefined();
    expect(foldConst('true &&')).toBeUndefined();
    expect(isAlwaysFalse("${{ 'a' == 'b' }}")).toBe(true);
    expect(isAlwaysFalse('${{ inputs.run }}')).toBe(false);
    expect(isAlwaysFalse('${{ 0 }}')).toBe(true);
    expect(isAlwaysFalse("''")).toBe(false); // an empty if: is not a condition
    expect(isTruthy('on')).toBe(true);
    expect(isTruthy('${{ 1 == 1 }}')).toBe(true);
    expect(isTruthy('${{ matrix.experimental }}')).toBe(false);
    expect(isTruthy('false')).toBe(false);
  });
});
