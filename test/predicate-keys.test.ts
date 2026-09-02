// The predicate-keys sweep: every dial of the runner's selection predicate that was
// not modelled (jest roots / rootDir / modulePathIgnorePatterns / projects, vitest
// dir / include-negation / projects / workspace / vite.config), the test-script
// flags, the coverage denominator and switches the rule did not read, the `on:`
// keys and the constant-folder short-circuits the workflow rule missed, and the
// shell spellings of "put the old spec back". Every positive here reproduced
// against the built CLI as a silent evasion before the fix; every negative is a
// maintainer edit that blocked before the fix.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy, isProtected } from '../src/policy';
import { testDeletion, countTests } from '../src/detectors/test-deletion';
import { testContentRemoval } from '../src/detectors/test-content-removal';
import { coverageLowering } from '../src/detectors/coverage-lowering';
import { ciTampering, foldConst, isAlwaysFalse, isTruthy } from '../src/detectors/ci-tampering';
import { runnerOf } from '../src/detectors/suite-config';
import { defaultBranch, resetTrackedFiles } from '../src/detectors/repo';
import type { Change, CommandChange, Detector, DetectorContext, FileChange, FileOp } from '../src/types';

const P = defaultPolicy();
const cmd = (raw: string): CommandChange => ({ kind: 'command', raw, argv: raw.split(/\s+/) });

/** A file change with REAL hunks (git diff --no-index), so the line-scanning rules see it. */
function diffed(path: string, before: string | null, after: string | null, op?: FileOp): FileChange {
  const dir = mkdtempSync(join(tmpdir(), 'tw-pk-'));
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

// ── test-deletion: the selection keys that were not modelled ─────────────────
describe('test-deletion — jest selection keys beyond the two lists', () => {
  const repo: DetectorContext = { trackedFiles: ['src/calc.ts', 'test/calc.test.ts', 'test/hard.test.ts', 'test/fixtures/sample.test.ts'] };
  const jest = (body: string) => `module.exports = {\n${body}\n};\n`;
  const on = (after: string, before = jest('')) => msgs(testDeletion, [diffed('jest.config.js', before, after)], repo);

  it.each([
    ['roots pointed away from the specs', jest('  roots: ["<rootDir>/src"],'), 2, /roots no longer covers it/],
    ['rootDir moved under src', jest('  rootDir: "src",'), 2, /rootDir no longer covers it/],
    ['modulePathIgnorePatterns hiding a spec from the resolver', jest('  modulePathIgnorePatterns: ["<rootDir>/test/hard"],'), 1, /modulePathIgnorePatterns now matches it/],
    ['a projects list whose union drops a spec', jest('  projects: [{ displayName: "unit", testMatch: ["<rootDir>/test/calc.test.ts"] }],'), 1, /no project selects it/],
  ])('flags %s', (_n, after, n, re) => {
    const m = on(after);
    expect(m, m.join('\n')).toHaveLength(n);
    expect(m[0]).toMatch(re);
  });

  it('the root testMatch narrowed alongside a projects list that mirrors it (j16)', () => {
    const before = jest('  testMatch: ["**/test/**/*.test.ts"],');
    const after = jest('  testMatch: ["**/test/calc.test.ts"], projects: [{ displayName: "unit", testMatch: ["**/test/calc.test.ts"] }],');
    expect(on(after, before)).toHaveLength(1);
  });

  it('projects are a UNION: two projects that between them keep every spec are silent', () => {
    expect(on(jest('  projects: [{ testMatch: ["**/calc.test.ts"] }, { testMatch: ["**/hard.test.ts"] }],'))).toHaveLength(0);
  });

  it('a project given as a path is unreadable — opaque, never claimed', () => {
    expect(on(jest('  projects: ["<rootDir>/packages/*", { testMatch: ["**/calc.test.ts"] }],'))).toHaveLength(0);
  });

  it('roots that still cover the specs, rootDir "." and a rootDir above the config are silent', () => {
    expect(on(jest('  roots: ["<rootDir>/test", "<rootDir>/src"],'))).toHaveLength(0);
    expect(on(jest('  rootDir: ".",'))).toHaveLength(0);
    expect(on(jest('  rootDir: "..",'))).toHaveLength(0);
  });

  it('ignoring a fixtures directory that holds sample specs is not narrowing (false positive)', () => {
    expect(on(jest('  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/test/fixtures/"],'))).toHaveLength(0);
  });

  it('package.json projects count too', () => {
    const before = '{ "name": "x", "jest": { "testMatch": ["**/*.test.ts"] } }\n';
    const after = '{ "name": "x", "jest": { "projects": [{ "testMatch": ["**/calc.test.ts"] }] } }\n';
    expect(msgs(testDeletion, [diffed('package.json', before, after)], repo)).toHaveLength(1);
  });
});

describe('test-deletion — vitest selection keys beyond the two lists', () => {
  const repo: DetectorContext = { trackedFiles: ['src/calc.ts', 'test/calc.test.ts', 'test/hard.test.ts'] };
  const vitest = (body: string) => `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {\n${body}\n} });\n`;
  const on = (after: string, before = vitest("  include: ['test/**/*.test.ts'],"), path = 'vitest.config.ts') =>
    msgs(testDeletion, [diffed(path, before, after)], repo);

  it.each([
    ['a ! entry inside include (tinyglobby honours it)', vitest("  include: ['test/**/*.test.ts', '!test/hard.test.ts'],"), 1, /test\.include no longer matches it/],
    ['test.dir moved away from the specs', vitest("  dir: 'src', include: ['test/**/*.test.ts'],"), 2, /test\.dir no longer covers it/],
    ['test.projects whose union drops a spec', vitest("  include: ['test/**/*.test.ts'], projects: [{ test: { name: 'a', include: ['test/calc.test.ts'] } }],"), 1, /no project selects it/],
  ])('flags %s', (_n, after, n, re) => {
    const m = on(after);
    expect(m, m.join('\n')).toHaveLength(n);
    expect(m[0]).toMatch(re);
  });

  it.each([
    ['export default [...]', "export default [{ test: { include: ['test/calc.test.ts'] } }];\n"],
    ['defineWorkspace([...])', "import { defineWorkspace } from 'vitest/config';\nexport default defineWorkspace([{ test: { include: ['test/calc.test.ts'] } }]);\n"],
  ])('a new vitest.workspace.ts (%s) replaces the root selection with its projects', (_n, ws) => {
    const m = msgs(testDeletion, [diffed('vitest.workspace.ts', null, ws)], repo);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/vitest\.workspace\.ts/);
  });

  it('a workspace naming a project by glob is opaque', () => {
    expect(msgs(testDeletion, [diffed('vitest.workspace.ts', null, "export default ['packages/*', { test: { include: ['test/calc.test.ts'] } }];\n")], repo)).toHaveLength(0);
  });

  it('vite.config.ts carrying a test: key IS the vitest config', () => {
    const before = "import { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [], test: { include: ['test/**/*.test.ts'] } });\n";
    const after = before.replace("'test/**/*.test.ts'", "'test/calc.test.ts'");
    expect(on(after, before, 'vite.config.ts')).toHaveLength(1);
    expect(runnerOf('vite.config.ts', after)).toBe('vitest');
    expect(runnerOf('vite.config.ts', "export default { build: { outDir: 'dist' } };\n")).toBeNull();
    expect(runnerOf('vitest.workspace.mjs')).toBe('vitest');
  });

  it('the baseline protects vite.config.* and vitest.workspace.* as config (additively)', () => {
    expect(isProtected('vite.config.ts', P, 'config')).toBe(true);
    expect(isProtected('packages/a/vitest.workspace.mts', P, 'config')).toBe(true);
    expect(isProtected('vitest.config.ts', P, 'config')).toBe(true);
  });

  it.each([
    ['typecheck.exclude (another suite)', vitest("  include: ['test/**/*.test.ts'], typecheck: { exclude: ['test/hard.test.ts'] },")],
    ['typecheck.include', vitest("  include: ['test/**/*.test.ts'], typecheck: { include: ['test/**/*.test-d.ts'] },")],
    ['benchmark.include', vitest("  include: ['test/**/*.test.ts'], benchmark: { include: ['bench/**/*.bench.ts'] },")],
    ['a vite.config.ts with no test key', "export default { build: { outDir: 'dist' } };\n"],
  ])('stays silent on %s', (_n, after) => {
    expect(on(after, vitest("  include: ['test/**/*.test.ts'],"), after.includes('build') ? 'vite.config.ts' : 'vitest.config.ts')).toHaveLength(0);
  });
});

describe('test-deletion — narrowing flags added to the package.json test script', () => {
  const pj = (script: string, name = 'test') => `{ "name": "x", "scripts": { "${name}": "${script}" } }\n`;
  const on = (before: string, after: string) => msgs(testDeletion, [diffed('package.json', before, after)]);

  it.each([
    ['jest -t', 'jest --coverage', 'jest --coverage -t adds', /-t added/],
    ['jest --testPathPattern', 'jest --coverage', 'jest --coverage --testPathPattern calc', /--testPathPattern added/],
    ['jest --testPathIgnorePatterns', 'jest', 'jest --testPathIgnorePatterns hard', /--testPathIgnorePatterns/],
    ['vitest --exclude', 'vitest run', 'vitest run --exclude test/hard.test.ts', /--exclude added/],
    ['vitest --dir', 'vitest run', 'vitest run --dir src', /--dir added/],
    ['vitest --project', 'vitest run', 'vitest run --project unit', /--project added/],
  ])('flags %s', (_n, before, after, re) => {
    const m = on(pj(before), pj(after));
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(re);
    expect(m[0]).toContain('scripts.test');
  });

  it('a test:unit script is a deliberate slice, not the suite; test:ci is the suite; a playwright --project is not jest/vitest', () => {
    // Inverted in 2.7.1 (pass-3d s11): `test:unit: vitest run --project unit` beside
    // an untouched `test` script is how a multi-project repo names its slices —
    // only `scripts.test` (and `test:ci`) run THE suite, and only they can narrow it.
    expect(on(pj('vitest run', 'test:unit'), pj('vitest run --project unit', 'test:unit'))).toHaveLength(0);
    expect(on(pj('vitest run', 'test:ci'), pj('vitest run --project unit', 'test:ci'))).toHaveLength(1);
    expect(on(pj('playwright test', 'test:e2e'), pj('playwright test --project chromium', 'test:e2e'))).toHaveLength(0);
  });

  it.each([
    ['a reporter flag', 'jest', 'jest --reporters=default'],
    ['a flag that was already there', 'jest -t adds', 'jest --coverage -t adds'],
    ['a build script gaining --dir', 'jest', 'jest'],
    ['a non-test script', 'jest', 'jest'],
  ])('stays silent on %s', (_n, before, after) => {
    const b = pj(before);
    const a = _n.startsWith('a build') ? '{ "name": "x", "scripts": { "test": "jest", "build": "tsc --dir out" } }\n' : _n.startsWith('a non-test') ? '{ "name": "x", "scripts": { "test": "jest", "docs": "vitest run --dir docs" } }\n' : pj(after);
    expect(on(b, a)).toHaveLength(0);
  });
});

// ── test-deletion: shell spellings of "put the old spec back" ─────────────────
describe('test-deletion — git checkout without --, and the whole-directory tokens', () => {
  const repo: DetectorContext = { trackedFiles: ['src/calc.ts', 'test/a.test.ts', 'packages/a/test/x.test.ts', 'dist/index.js'] };
  const flags = (c: string) => run(testDeletion, [cmd(c)], repo).length;

  it.each([
    'git checkout main test/a.test.ts',
    'git checkout v1.0.0 test',
    'git checkout main -- .',
    'git checkout main .',
    'git checkout HEAD~3 -- ./',
    "git checkout main -- '*'",
    'rm -rf .',
    'rm -rf *',
    'rm -rf ./*',
    'cd src && rm -rf ../test',
    'cd packages/a && git checkout main -- ../../test/a.test.ts',
  ])('flags: %s', (c) => {
    expect(flags(c)).toBeGreaterThan(0);
  });

  it.each([
    'git checkout main',
    'git checkout -b feature/x',
    'git checkout -- test/a.test.ts',
    'git checkout HEAD -- .',
    'git checkout test/a.test.ts',
    'cd dist && rm -rf .',
    'rm -rf ../other-repo',
    'ls .',
    'git add .',
  ])('stays silent on: %s', (c) => {
    expect(flags(c)).toBe(0);
  });

  it('a root with no protected spec at all makes `rm -rf .` a non-event; no listing keeps it covered', () => {
    expect(run(testDeletion, [cmd('rm -rf .')], { trackedFiles: ['src/calc.ts'] })).toHaveLength(0);
    expect(run(testDeletion, [cmd('rm -rf .')]).length).toBeGreaterThan(0);
  });
});

// ── test-deletion: the relocation guard, describe.each ───────────────────────
describe('test-deletion — stubs do not hold a relocation; describe.each multiplies', () => {
  const calc = `import {add} from "../src/calc";
it("adds one", () => { expect(add(1,1)).toBe(2); });
it("adds two", () => { expect(add(2,2)).toBe(4); });
it("adds three", () => { expect(add(3,3)).toBe(6); });
`;
  it('the old lines kept in a string beside three stubs is a deletion, not a move', () => {
    const b = `const legacy = \`
it("adds one", () => { expect(add(1,1)).toBe(2); });
it("adds two", () => { expect(add(2,2)).toBe(4); });
it("adds three", () => { expect(add(3,3)).toBe(6); });
\`;
it("noop", () => {});
it("noop 2", () => {});
it("noop 3", () => { /* later */ });
`;
    const m = msgs(testDeletion, [diffed('test/calc.test.ts', calc, null), diffed('test/b.test.ts', null, b)]);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/deleted/);
  });

  it('the same three tests really moved is still a relocation', () => {
    const b = `import {add} from "../src/calc";\ndescribe("moved", () => {\n${calc.split('\n').slice(1).join('\n')}});\n`;
    expect(msgs(testDeletion, [diffed('test/calc.test.ts', calc, null), diffed('test/b.test.ts', null, b)])).toHaveLength(0);
  });

  it('counts substantive bodies only when asked', () => {
    expect(countTests('it("noop", () => {});', 'x.test.ts', true).min).toBe(0);
    expect(countTests('it("noop", () => {});', 'x.test.ts').min).toBe(1);
    expect(countTests('it("real", () => { expect(add(1,1)).toBe(2); });', 'x.test.ts', true).min).toBe(1);
    expect(countTests('it("concise", () => expect(add(1,1)).toBe(2));', 'x.test.ts', true).min).toBe(1);
    expect(countTests('it("by reference", checkAdd);', 'x.test.ts', true).min).toBe(1);
  });

  it('describe.each rows multiply the enclosed it() count', () => {
    const table = (rows: string) => `describe.each([${rows}])("n %i", (n) => { it("pos", () => { expect(n).toBeGreaterThan(0); }); it("int", () => { expect(Number.isInteger(n)).toBe(true); }); });\n`;
    expect(countTests(table('[1],[2],[3]'), 'x.test.ts').min).toBe(6);
    expect(countTests(table('[1]'), 'x.test.ts').min).toBe(2);
    expect(countTests(table('...rows'), 'x.test.ts').open).toBe(true);
    expect(countTests('describe.each`\n a\n 1\n 2\n`("n", (n) => { it("pos", () => { expect(n).toBe(n); }); });', 'x.test.ts').min).toBe(2);
    const m = msgs(testDeletion, [diffed('test/each.test.ts', table('[1],[2],[3]'), table('[1]'))]);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/6 → 2/);
  });
});

// ── test-content-removal: rows dropped from a table that stays open ──────────
describe('test-content-removal — explicit rows dropped from an open table', () => {
  const one = (rows: string) => `const extra = [];\nit.each([${rows},...extra])("adds %i", (a,b,e) => { expect(a+b).toBe(e); });\n`;
  const multi = (rows: string[]) => `const extra = [];\nit.each([\n${rows.map((r) => `  ${r},`).join('\n')}\n  ...extra,\n])("adds %i", (a,b,e) => { expect(a+b).toBe(e); });\n`;
  const ROWS = ['[1,1,2]', '[2,2,4]', '[3,3,6]', '[4,4,8]'];

  it('three rows gone from a one-line spread table', () => {
    const m = run(testContentRemoval, [diffed('test/each.test.ts', one(ROWS.join(',')), one(ROWS[0]))]);
    expect(m).toHaveLength(1);
    expect(m[0].evidence).toBe('[2,2,4] | [3,3,6] | [4,4,8]');
  });

  it('two rows gone from a multi-line spread table', () => {
    expect(run(testContentRemoval, [diffed('test/each.test.ts', multi(ROWS), multi(ROWS.slice(0, 2)))])).toHaveLength(1);
  });

  it('a literal table replaced by a call that returns fewer rows', () => {
    const after = `function rows(){ return [[1,1,2]]; }\nit.each(rows())("adds %i", (a,b,e) => { expect(a+b).toBe(e); });\n`;
    const before = `it.each([${ROWS.join(',')}])("adds %i", (a,b,e) => { expect(a+b).toBe(e); });\n`;
    const m = run(testContentRemoval, [diffed('test/each.test.ts', before, after)]);
    expect(m).toHaveLength(1);
    expect(m[0].evidence).not.toContain('[1,1,2]'); // that row reappears in rows()
  });

  it.each([
    ['one row gone (below the floor)', one(ROWS.join(',')), one(ROWS.slice(0, 3).join(','))],
    ['a row added', one(ROWS.slice(0, 3).join(',')), one(ROWS.join(','))],
    ['rows reformatted onto one line', multi(ROWS), one(ROWS.join(','))],
  ])('stays silent on %s', (_n, before, after) => {
    expect(run(testContentRemoval, [diffed('test/each.test.ts', before, after)])).toHaveLength(0);
  });
});

// ── coverage-lowering ─────────────────────────────────────────────────────────
describe('coverage-lowering — the denominator as a predicate, the switches, the other files', () => {
  const reasons = (c: Change[], ctx?: DetectorContext) => run(coverageLowering, c, ctx).map((f) => f.evidence);
  const jest = (collect: string) => `module.exports = { collectCoverageFrom: [${collect}], coverageThreshold: { global: { lines: 80 } } };\n`;
  const ts = { trackedFiles: ['src/calc.ts', 'src/ui/app.tsx', 'test/calc.test.ts', 'jest.config.js'] };

  it('collectCoverageFrom src/** → src/**/*.{ts,tsx} measures the same TypeScript files (false positive)', () => {
    expect(reasons([diffed('jest.config.js', jest('"src/**"'), jest('"src/**/*.{ts,tsx}"'))], ts)).toHaveLength(0);
  });

  it('… but in a repository that also has JavaScript source it drops those files', () => {
    const r = reasons([diffed('jest.config.js', jest('"src/**"'), jest('"src/**/*.{ts,tsx}"'))], { trackedFiles: ['src/calc.ts', 'src/legacy.js'] });
    expect(r).toEqual(['collectCoverageFrom no longer measures "src/legacy.js"']);
  });

  it('a negation covering the whole tree names the files it drops, once', () => {
    expect(reasons([diffed('jest.config.js', jest('"src/**"'), jest('"src/**", "!src/**"'))], ts)).toEqual(['collectCoverageFrom no longer measures "src/calc.ts", "src/ui/app.tsx"']);
  });

  const VC = (cov: string) => `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { coverage: { ${cov} } } });\n`;
  it.each([
    ['vitest coverage.include narrowed', VC('include: ["src/**"], thresholds: { lines: 80 }'), VC('include: ["src/calc.ts"], thresholds: { lines: 80 }'), /coverage\.include no longer measures "src\/ui\/app\.tsx"/],
    ['coverage.enabled true → false', VC('enabled: true, thresholds: { lines: 80 }'), VC('enabled: false, thresholds: { lines: 80 }'), /coverage\.enabled switched off/],
    ['thresholds.perFile removed', VC('thresholds: { lines: 80, perFile: true }'), VC('thresholds: { lines: 80 }'), /perFile removed/],
  ])('flags %s', (_n, before, after, re) => {
    const r = reasons([diffed('vitest.config.ts', before, after)], ts);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(re);
  });

  it.each([
    ['coverage.enabled false → true', VC('enabled: false, thresholds: { lines: 80 }'), VC('enabled: true, thresholds: { lines: 80 }')],
    ['perFile added', VC('thresholds: { lines: 80 }'), VC('thresholds: { lines: 80, perFile: true }')],
    ['typecheck.enabled: false (not coverage)', 'export default { test: { typecheck: { enabled: true }, coverage: { thresholds: { lines: 80 } } } };\n', 'export default { test: { typecheck: { enabled: false }, coverage: { thresholds: { lines: 80 } } } };\n'],
    ['coverage.include refined to the same files', VC('include: ["src/**"], thresholds: { lines: 80 }'), VC('include: ["src/**/*.{ts,tsx}"], thresholds: { lines: 80 }')],
  ])('stays silent on %s', (_n, before, after) => {
    expect(reasons([diffed('vitest.config.ts', before, after)], ts)).toHaveLength(0);
  });

  it.each([
    ['.coveragerc [run] omit gaining source', '.coveragerc', '[run]\nsource = src\n[report]\nfail_under = 80\n', '[run]\nsource = src\nomit = src/hard.py\n[report]\nfail_under = 80\n', /omit now exempts "src\/hard\.py"/],
    ['.coveragerc omit continuation lines', '.coveragerc', '[run]\nomit =\n    tests/*\n', '[run]\nomit =\n    tests/*\n    src/hard.py\n', /omit now exempts "src\/hard\.py"/],
    ['pyproject omit array', 'pyproject.toml', '[tool.coverage.run]\nomit = []\n', '[tool.coverage.run]\nomit = ["src/hard.py"]\n', /omit now exempts/],
    ['codecov target: auto', 'codecov.yml', 'coverage:\n  status:\n    project:\n      default:\n        target: 80%\n', 'coverage:\n  status:\n    project:\n      default:\n        target: auto\n', /project target lowered 80 → auto/],
    ['codecov project: off', 'codecov.yml', 'coverage:\n  status:\n    project:\n      default:\n        target: 80%\n', 'coverage:\n  status:\n    project: off\n', /status\.project switched off/],
    ['codecov ignore: gaining source', 'codecov.yml', 'coverage:\n  status:\n    project:\n      default:\n        target: 80%\n', 'ignore:\n  - src/hard.ts\ncoverage:\n  status:\n    project:\n      default:\n        target: 80%\n', /codecov now ignores "src\/hard\.ts"/],
    ['package.json nyc lines lowered', 'package.json', '{"name":"x","nyc":{"check-coverage":true,"lines":80}}\n', '{"name":"x","nyc":{"check-coverage":true,"lines":10}}\n', /nyc lines lowered 80 → 10/],
  ])('flags %s', (_n, path, before, after, re) => {
    const r = reasons([diffed(path, before, after)]);
    expect(r.some((x) => re.test(x)), r.join('\n')).toBe(true);
  });

  it('the patch target lowered is reported with ITS numbers, not the project one', () => {
    const cc = (patch: string) => `coverage:\n  status:\n    project:\n      default:\n        target: 80%\n    patch:\n      default:\n        target: ${patch}%\n`;
    expect(reasons([diffed('codecov.yml', cc('90'), cc('50'))])).toEqual(['patch target lowered 90 → 50']);
  });

  it.each([
    ['omit of tests', '.coveragerc', '[run]\nsource = src\n', '[run]\nsource = src\nomit = tests/*\n'],
    ['codecov ignore of tests', 'codecov.yml', 'coverage:\n  status:\n    project:\n      default:\n        target: 80%\n', 'ignore:\n  - "test/**"\ncoverage:\n  status:\n    project:\n      default:\n        target: 80%\n'],
    ['codecov target raised to auto from nothing', 'codecov.yml', 'coverage:\n  status:\n    project:\n      default:\n        threshold: 1%\n', 'coverage:\n  status:\n    project:\n      default:\n        target: auto\n        threshold: 1%\n'],
    ['nyc lines raised in package.json', 'package.json', '{"name":"x","nyc":{"lines":80}}\n', '{"name":"x","nyc":{"lines":90}}\n'],
  ])('stays silent on %s', (_n, path, before, after) => {
    expect(reasons([diffed(path, before, after)])).toHaveLength(0);
  });

  it('a gate MOVED to another config in the same change is not a deletion', () => {
    const rc = '[report]\nfail_under = 80\n';
    const py = '[tool.coverage.report]\nfail_under = 80\n';
    expect(reasons([diffed('.coveragerc', rc, null), diffed('pyproject.toml', null, py)])).toHaveLength(0);
    expect(reasons([diffed('.coveragerc', rc, null)])).toEqual(['.coveragerc']);
    // moved AND lowered on the way: the deletion is reported
    expect(reasons([diffed('.coveragerc', rc, null), diffed('pyproject.toml', null, py.replace('80', '50'))])).toEqual(['.coveragerc']);
    const jc = 'module.exports = { coverageThreshold: { global: { lines: 80, branches: 80 } } };\n';
    const pj = '{"name":"x","jest":{"coverageThreshold":{"global":{"lines":80,"branches":80}}}}\n';
    expect(reasons([diffed('jest.config.js', jc, 'module.exports = {};\n'), diffed('package.json', '{"name":"x"}\n', pj)])).toHaveLength(0);
    expect(reasons([diffed('jest.config.js', jc, 'module.exports = {};\n'), diffed('package.json', '{"name":"x"}\n', pj.replace('"lines":80', '"lines":50'))])).toEqual(['the coverage threshold gate was removed']);
  });
});

// ── ci-tampering ──────────────────────────────────────────────────────────────
describe('ci-tampering — the constant folder short-circuits like the runner', () => {
  it.each([
    ["github.event_name == 'push' && false", false],
    ["false && github.event_name == 'push'", false],
    ['!cancelled() && false', false],
    ['always() && false', false],
    ["fromJSON(needs.x.outputs.y)[0] && false", false],
    ["contains(github.ref, 'main') && (1 == 2)", false],
    ['!(matrix.experimental || true)', false],
    ["'' || false", false],
  ])('folds %s to falsy', (e, v) => {
    expect(foldConst(e)).toBe(v);
    expect(isAlwaysFalse(`\${{ ${e} }}`)).toBe(true);
  });

  it.each(['matrix.experimental || true', 'contains(a, b) || true', "cancelled() || 'x'", 'true || github.x'])('reads %s as truthy', (e) => {
    expect(isTruthy(`\${{ ${e} }}`)).toBe(true);
  });

  it.each(['matrix.experimental && true', 'matrix.experimental || false', "github.event_name == 'push' && !cancelled()", 'success() && (x || true)', '!cancelled()', 'cancelled()', 'true &&', 'fromJSON(x).y && false'])('leaves %s unknown', (e) => {
    expect(foldConst(e)).toBeUndefined();
    expect(isAlwaysFalse(`\${{ ${e} }}`)).toBe(false);
    expect(isTruthy(`\${{ ${e} }}`)).toBe(false);
  });

  it('a truthy unknown does not compare equal to anything', () => {
    expect(foldConst("(x || true) == 'x'")).toBeUndefined();
    expect(foldConst('(x || true) == 1')).toBeUndefined();
  });
});

describe('ci-tampering — on: paths and types, the default branch, reusable workflows, job scope, command cores', () => {
  const WF = `name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`;
  const ed = (...pairs: string[]): FileChange => {
    let s = WF;
    for (let i = 0; i < pairs.length; i += 2) {
      if (!s.includes(pairs[i])) throw new Error(`fixture lacks ${pairs[i]}`);
      s = s.replace(pairs[i], pairs[i + 1]);
    }
    return diffed('.github/workflows/ci.yml', WF, s);
  };
  const m = (c: Change[], ctx?: DetectorContext) => msgs(ciTampering, c, ctx);

  it.each([
    ['if: <ctx> && false', '      - run: npm test', "      - if: \${{ github.event_name == 'push' && false }}\n        run: npm test", /can never run/],
    ['if: false && <ctx>', '      - run: npm test', "      - if: \${{ false && github.event_name == 'push' }}\n        run: npm test", /can never run/],
    ['if: !cancelled() && false', '      - run: npm test', '      - if: ${{ !cancelled() && false }}\n        run: npm test', /can never run/],
    ['continue-on-error: <ctx> || true', '      - run: npm test', "      - continue-on-error: \${{ github.event_name == 'pull_request' || true }}\n        run: npm test", /continue-on-error/],
    ['paths: docs only on push and pull_request', '    branches: [main]\n  pull_request:', "    branches: [main]\n    paths: ['docs/**']\n  pull_request:\n    paths: ['docs/**']", /on\.push\.paths matches no source file/],
    ['paths: **.md', '  pull_request:', "  pull_request:\n    paths: ['**.md']", /on\.pull_request\.paths matches no source file/],
    ['pull_request.types: [labeled]', '  pull_request:', '  pull_request:\n    types: [labeled]', /types no longer includes opened\/synchronize/],
    ['npm test narrowed to one spec by a positional', '      - run: npm test', '      - run: npm test -- test/a.test.ts', /neutralised in place.*test\/a\.test\.ts/],
    ['npm test respelled as npx jest test/a', '      - run: npm test', '      - run: npx jest test/a', /neutralised in place.*npx jest test\/a/],
    ['npx vitest run src/', '      - run: npm test', '      - run: npx vitest run src/', /neutralised in place/],
    ['timeout 1 npm test', '      - run: npm test', '      - run: timeout 1 npm test', /neutralised in place.*timeout 1 npm test/],
    ['npm test replaced by a lint (a different kind of check)', '      - run: npm test', '      - run: npm run lint', /was removed/],
  ])('flags %s', (_n, from, to, re) => {
    const r = m([ed(from, to)]);
    expect(r.some((x) => re.test(x)), r.join('\n')).toBe(true);
  });

  it('paths narrowed from source to docs; a list that was already docs-only is not re-reported', () => {
    const src = WF.replace('  pull_request:', "  pull_request:\n    paths: ['src/**']");
    const docs = WF.replace('  pull_request:', "  pull_request:\n    paths: ['docs/**']");
    expect(m([diffed('.github/workflows/ci.yml', src, docs)]).filter((x) => /paths matches no source/.test(x))).toHaveLength(1);
    expect(m([diffed('.github/workflows/ci.yml', docs, docs.replace("['docs/**']", "['docs/**', 'README.md']"))])).toHaveLength(0);
  });

  it('paths are matched against the repository\'s own code when a listing is available', () => {
    const py = { trackedFiles: ['app/main.py', 'app/tests/test_main.py', 'README.md'] };
    expect(m([ed('  pull_request:', "  pull_request:\n    paths: ['app/**']")], py)).toHaveLength(0);
    expect(m([ed('  pull_request:', "  pull_request:\n    paths: ['src/**']")], py).some((x) => /paths matches no source/.test(x))).toBe(true);
  });

  it.each([
    ['paths that reach source', '  pull_request:', "  pull_request:\n    paths: ['src/**', 'package.json']"],
    ['paths: everything but docs', '  pull_request:', "  pull_request:\n    paths: ['**', '!docs/**']"],
    ['paths-ignore for docs', '  pull_request:', "  pull_request:\n    paths-ignore: ['docs/**']"],
    ['types that keep synchronize', '  pull_request:', '  pull_request:\n    types: [opened, synchronize, reopened, labeled]'],
    ['a matrix reduced', '        node: [18, 20, 22]', '        node: [20, 22]'],
    ['if: with a context reference that decides', '      - run: npm test', "      - if: \${{ github.event_name == 'push' && !cancelled() }}\n        run: npm test"],
    ['continue-on-error from the matrix', '      - run: npm test', '      - continue-on-error: ${{ matrix.experimental }}\n        run: npm test'],
    ['job-level if: false on a job with no check', '  deploy:\n    runs-on: ubuntu-latest', '  deploy:\n    if: false\n    runs-on: ubuntu-latest'],
    ['job-level continue-on-error on a job with no check', '  deploy:\n    runs-on: ubuntu-latest', '  deploy:\n    runs-on: ubuntu-latest\n    continue-on-error: true'],
    ['npm test → npm run test:ci (respelled)', '      - run: npm test', '      - run: npm run test:ci'],
    ['npm test → npx vitest run (respelled)', '      - run: npm test', '      - run: npx vitest run'],
    ['npm test → npx jest --ci (respelled, no narrowing)', '      - run: npm test', '      - run: npx jest --ci'],
    ['a config flag whose value is a path', '      - run: npm test', '      - run: npm test -- --config jest.ci.js'],
    ['a coverage directory flag', '      - run: npm test', '      - run: npm test -- --coverageDirectory out/cov'],
    ['a redirect to a log path', '      - run: npm test', '      - run: npm test > out/test.log'],
    ['branches: [main] → [master] when the repository cannot say which is default', '    branches: [main]', '    branches: [master]'],
  ])('stays silent on %s', (_n, from, to) => {
    expect(m([ed(from, to)])).toEqual([]);
  });

  it('job-level if: false on the job that runs the check is still reported', () => {
    expect(m([ed('  test:\n    runs-on: ubuntu-latest', '  test:\n    if: false\n    runs-on: ubuntu-latest')]).some((x) => /can never run/.test(x))).toBe(true);
  });

  it('a check moved into a reusable workflow the same change adds is kept', () => {
    const checks = 'name: checks\non:\n  workflow_call:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test\n';
    const ci = WF.replace(/  test:\n[\s\S]*?      - run: npm test\n/, '  checks:\n    uses: ./.github/workflows/checks.yml\n');
    expect(m([diffed('.github/workflows/ci.yml', WF, ci), diffed('.github/workflows/checks.yml', null, checks)])).toEqual([]);
    // the reusable workflow NOT in the change: the check is gone as far as this diff can see
    expect(m([diffed('.github/workflows/ci.yml', WF, ci)]).some((x) => /was removed/.test(x))).toBe(true);
    // the reusable workflow in the change but without the check: removed
    expect(m([diffed('.github/workflows/ci.yml', WF, ci), diffed('.github/workflows/checks.yml', null, checks.replace('      - run: npm test\n', ''))]).some((x) => /was removed/.test(x))).toBe(true);
  });

  it('branches: [main] → [master] is reported when the remote says main is the default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-pk-repo-'));
    try {
      execFileSync('git', ['init', '-q', dir]);
      execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], { cwd: dir });
      resetTrackedFiles();
      expect(defaultBranch({ cwd: dir })).toBe('main');
      const ctx = { cwd: dir, trackedFiles: ['src/index.ts'] };
      expect(m([ed('    branches: [main]', '    branches: [master]')], ctx).some((x) => /no longer names main/.test(x))).toBe(true);
      // and the other way round is silent there
      expect(m([diffed('.github/workflows/ci.yml', WF.replace('[main]', '[master]'), WF)], ctx)).toEqual([]);
    } finally {
      resetTrackedFiles();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(defaultBranch({ trackedFiles: [] })).toBeNull();
  });
});
