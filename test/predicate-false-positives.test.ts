// The pass-3d false-positive sweep over 2.7.0 (77 honest edits against the built
// CLI): every case below blocked before 2.7.1 and is a maintainer's routine edit —
// a Playwright project matrix, a Biome migration, a hardened `shell:`, a snapshot
// deleted from jest's default layout, `git checkout main -- test/` while on main,
// vitest 3's `test.for`, a `describe.each` rewritten as a loop, `extends: true`
// projects, a `test:unit` script, Django boilerplate exempted from coverage, the
// `100: true` shorthand. Each honest edit is paired with the tamper next to it, which
// must keep firing: the fix narrows the predicate to the class, never the rule.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy } from '../src/policy';
import { testDeletion, countTests } from '../src/detectors/test-deletion';
import { coverageLowering } from '../src/detectors/coverage-lowering';
import { ciTampering, foldExpressions } from '../src/detectors/ci-tampering';
import { branchExists, resetTrackedFiles, revIsHead } from '../src/detectors/repo';
import type { Change, CommandChange, Detector, DetectorContext, FileChange, FileOp } from '../src/types';

const P = defaultPolicy();
const cmd = (raw: string): CommandChange => ({ kind: 'command', raw, argv: raw.split(/\s+/) });

/** A file change with REAL hunks (git diff --no-index), so the line-scanning rules see it. */
function diffed(path: string, before: string | null, after: string | null, op?: FileOp): FileChange {
  const dir = mkdtempSync(join(tmpdir(), 'tw-fp-'));
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

/** A throwaway repository with one commit on `main` holding a spec. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-fp-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main', '.');
  git('config', 'user.email', 'a@b');
  git('config', 'user.name', 'a');
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'test', 'a.test.ts'), 'it("a", () => { expect(1).toBe(1); });\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  resetTrackedFiles();
  return dir;
}

// ── ci-tampering ──────────────────────────────────────────────────────────────
describe('ci-tampering — matrix expressions, the wider runner set, cd prefixes (FP-1, FP-2)', () => {
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
      - run: npm ci
      - run: npm test
      - run: npm run lint
      - run: npx playwright test
`;
  const ed = (from: string, to: string): Change[] => {
    if (!WF.includes(from)) throw new Error(`fixture lacks ${from}`);
    return [diffed('.github/workflows/ci.yml', WF, WF.replace(from, to))];
  };
  const m = (c: Change[]) => msgs(ciTampering, c);

  it.each([
    ['--shard=${{ matrix.shard }}/4 (w05)', '      - run: npm test', '      - run: npm run test -- --shard=${{ matrix.shard }}/4'],
    ['--shard ${{ matrix.shard }}/${{ strategy.job-total }} (w24)', '      - run: npm test', '      - run: npx vitest run --shard ${{ matrix.shard }}/${{ strategy.job-total }}'],
    ['playwright --project=${{ matrix.project }} (w17)', '      - run: npx playwright test', '      - run: npx playwright test --project=${{ matrix.project }}'],
    ['--project ${{ inputs.project }} from a workflow input', '      - run: npx playwright test', '      - run: npx playwright test --project ${{ inputs.project }}'],
    ['npm run lint → npx biome ci . (w09)', '      - run: npm run lint', '      - run: npx biome ci .'],
    ['npm run lint → npx oxlint', '      - run: npm run lint', '      - run: npx oxlint .'],
    ['npm test → node --test (w11)', '      - run: npm test', '      - run: node --test'],
    ['npm test → npx mocha', '      - run: npm test', '      - run: npx mocha --recursive'],
    ['npm test → deno test', '      - run: npm test', '      - run: deno test -A'],
    ['npm run lint → npx eslint "src/**/*.{ts,tsx}" --max-warnings=0 (w10)', '      - run: npm run lint', '      - run: npx eslint "src/**/*.{ts,tsx}" --max-warnings=0'],
    ['npm run lint → npx eslint src/ test/ (w20)', '      - run: npm run lint', '      - run: npx eslint src/ test/ --max-warnings=0'],
    ['npm test → cd apps/web && npm test (w22)', '      - run: npm test', '      - run: cd apps/web && npm test'],
    ['npm run lint → cd apps/web && npm run lint (w22)', '      - run: npm run lint', '      - run: cd apps/web && npm run lint'],
  ])('stays silent on %s', (_n, from, to) => {
    expect(m(ed(from, to))).toEqual([]);
  });

  it.each([
    ['a literal --project=unit with no matrix', '      - run: npx playwright test', '      - run: npx playwright test --project=unit', /neutralised in place/],
    ["a --project=${{ 'unit' }} that folds to the literal", '      - run: npx playwright test', "      - run: npx playwright test --project=${{ 'unit' }}", /neutralised in place/],
    ['-t ${{ github.sha }} — a pattern nothing matches', '      - run: npm test', '      - run: npm test -- -t ${{ github.sha }}', /neutralised in place/],
    ['a spec positional behind a cd prefix', '      - run: npm test', '      - run: cd apps/web && npm test -- test/a.test.ts', /neutralised in place/],
    ['npx mocha narrowed to one spec', '      - run: npm test', '      - run: npx mocha test/a.test.ts', /neutralised in place/],
    ['npm test replaced by a lint of another kind', '      - run: npm test', '      - run: npx biome ci .', /was removed/],
    ['node --test removed outright', '      - run: npm test', '      - run: echo skip', /was removed/],
  ])('still flags %s', (_n, from, to, re) => {
    const r = m(ed(from, to));
    expect(r.some((x) => re.test(x)), r.join('\n')).toBe(true);
  });

  it('folds expressions: constants to their value, matrix references to a matrix token, the rest opaque', () => {
    expect(foldExpressions("--project=${{ 'unit' }}")).toBe('--project=unit');
    expect(foldExpressions('--shard=${{ matrix.shard }}/${{ strategy.job-total }}')).toBe('--shard=__matrix__/__matrix__');
    expect(foldExpressions('-t ${{ github.sha }}')).toBe('-t __expr__');
  });
});

describe('ci-tampering — shell -e, reporter actions, the stale origin/HEAD (FP-6, FP-7, FP-8)', () => {
  const WF = `name: ci
on:
  push:
    branches: [master]
  pull_request:
    branches: [master]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
      - run: npm run lint
`;
  const ed = (from: string, to: string): Change[] => {
    if (!WF.includes(from)) throw new Error(`fixture lacks ${from}`);
    return [diffed('.github/workflows/ci.yml', WF, WF.replace(from, to))];
  };
  const m = (c: Change[], ctx?: DetectorContext) => msgs(ciTampering, c, ctx);

  it.each([
    ['defaults.run.shell: bash -euo pipefail {0} (w12)', 'jobs:', 'defaults:\n  run:\n    shell: bash -euo pipefail {0}\njobs:'],
    ['shell: bash -eo pipefail {0} on the check step', '      - run: npm test', '      - run: npm test\n        shell: bash -eo pipefail {0}'],
    ['shell: bash --noprofile --norc -eo pipefail {0}', '      - run: npm test', '      - run: npm test\n        shell: bash --noprofile --norc -eo pipefail {0}'],
    ['shell: bash -o errexit {0}', '      - run: npm test', '      - run: npm test\n        shell: bash -o errexit {0}'],
    ['continue-on-error on dorny/test-reporter (w13)', '      - run: npm run lint', '      - run: npm run lint\n      - uses: dorny/test-reporter@v1\n        if: always()\n        continue-on-error: true\n        with:\n          path: reports/*.xml'],
    ['continue-on-error on publish-unit-test-result-action', '      - run: npm run lint', '      - run: npm run lint\n      - uses: EnricoMi/publish-unit-test-result-action@v2\n        continue-on-error: true'],
    ['continue-on-error on upload-artifact of the test report', '      - run: npm run lint', '      - run: npm run lint\n      - uses: actions/upload-artifact@v4\n        continue-on-error: true\n        with:\n          name: test-results'],
    ['continue-on-error on codecov', '      - run: npm run lint', '      - run: npm run lint\n      - uses: codecov/codecov-action@v5\n        continue-on-error: true'],
  ])('stays silent on %s', (_n, from, to) => {
    expect(m(ed(from, to))).toEqual([]);
  });

  it('a reporter action removed was never the check; a test action removed still is', () => {
    const withReporter = WF + '      - uses: dorny/test-reporter@v1\n';
    expect(m([diffed('.github/workflows/ci.yml', withReporter, WF)])).toEqual([]);
    const withAction = WF + '      - uses: acme/run-tests@v1\n';
    expect(m([diffed('.github/workflows/ci.yml', withAction, WF)]).some((x) => /check step .* was removed/.test(x))).toBe(true);
  });

  it.each([
    ['shell: bash {0} without -e', '      - run: npm test', '      - run: |\n          npm test\n          true\n        shell: bash {0}', /\{0\}/],
    ['shell: bash -x {0} (no e in the group)', '      - run: npm test', '      - run: npm test\n        shell: bash -x {0}', /\{0\}/],
    ['defaults.run.shell: bash {0} at workflow level', 'jobs:', 'defaults:\n  run:\n    shell: bash {0}\njobs:', /\{0\}/],
    ['continue-on-error on the test step itself', '      - run: npm test', '      - run: npm test\n        continue-on-error: true', /continue-on-error/],
    ['continue-on-error on a test action that is not a reporter', '      - run: npm run lint', '      - run: npm run lint\n      - uses: acme/run-tests@v1\n        continue-on-error: true', /continue-on-error/],
  ])('still flags %s', (_n, from, to, re) => {
    const r = m(ed(from, to));
    expect(r.some((x) => re.test(x)), r.join('\n')).toBe(true);
  });

  it('[master] → [main] with a local main branch and origin/HEAD still on master is a rename (w19)', () => {
    const dir = repo(); // on `main`
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      git('update-ref', 'refs/remotes/origin/master', 'HEAD');
      git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master');
      resetTrackedFiles();
      expect(branchExists('main', { cwd: dir })).toBe(true);
      expect(branchExists('master', { cwd: dir })).toBe(true); // origin/master
      expect(branchExists('develop', { cwd: dir })).toBe(false);
      const ctx = { cwd: dir, trackedFiles: ['src/index.ts'] };
      expect(m([diffed('.github/workflows/ci.yml', WF, WF.replace(/\[master\]/g, '[main]'))], ctx)).toEqual([]);
      // the narrowing that IS one: a branch the repository does not have
      expect(m([diffed('.github/workflows/ci.yml', WF, WF.replace(/\[master\]/g, '[trunk]'))], ctx).some((x) => /no longer names master/.test(x))).toBe(true);
    } finally {
      resetTrackedFiles();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(branchExists('main', { trackedFiles: [] })).toBeNull();
  });
});

// ── test-deletion ─────────────────────────────────────────────────────────────
describe('test-deletion — test.for, describe.for, loops over a literal table (FP-3)', () => {
  const EACH = 'import {add} from "../src/calc";\nit.each([\n  [1, 1, 2],\n  [2, 2, 4],\n  [3, 3, 6],\n])("add(%i, %i) = %i", (a, b, e) => { expect(add(a, b)).toBe(e); });\n';
  const FOR = EACH.replace('it.each(', 'test.for(').replace('(a, b, e) =>', '([a, b, e]) =>');
  const DEACH = 'import {add} from "../src/calc";\ndescribe.each([[1], [2], [3]])("n=%i", (n) => {\n  it("is positive", () => { expect(add(n, 0)).toBeGreaterThan(0); });\n});\n';
  const DFOR = DEACH.replace('describe.each(', 'describe.for(').replace('(n) =>', '([n]) =>');
  const LOOP = (rows: string) => `import {add} from "../src/calc";\nfor (const n of [${rows}]) {\n  describe(\`n=\${n}\`, () => {\n    it("is positive", () => { expect(add(n, 0)).toBeGreaterThan(0); });\n  });\n}\n`;
  const FOREACH = 'import {add} from "../src/calc";\n[1, 2, 3].forEach((n) => {\n  describe(`n=${n}`, () => {\n    it("is positive", () => { expect(add(n, 0)).toBeGreaterThan(0); });\n  });\n});\n';
  const on = (before: string, after: string) => msgs(testDeletion, [diffed('test/calc.test.ts', before, after)]);

  it.each([
    ['it.each → test.for (t03)', EACH, FOR],
    ['describe.each → describe.for (t11)', DEACH, DFOR],
    ['describe.each → for … of over the same literal (t04)', DEACH, LOOP('1, 2, 3')],
    ['describe.each → [..].forEach', DEACH, FOREACH],
    ['for … of → describe.each', LOOP('1, 2, 3'), DEACH],
  ])('stays silent on %s', (_n, before, after) => {
    expect(on(before, after)).toEqual([]);
  });

  it.each([
    ['a row dropped from a test.for table', FOR, FOR.replace('  [3, 3, 6],\n', ''), /3 → 2/],
    ['a row dropped from a describe.for table', DFOR, DFOR.replace('[[1], [2], [3]]', '[[1], [2]]'), /3 → 2/],
    ['describe.each → a loop over FEWER literal rows', DEACH, LOOP('1, 2'), /3 → 2/],
  ])('still flags %s', (_n, before, after, re) => {
    const r = on(before, after);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(re);
  });

  it('counts: for/each alike, a literal loop exactly, any other loop as open', () => {
    expect(countTests('test.for([[1], [2], [3]])("x", () => {});')).toEqual({ min: 3, open: false });
    expect(countTests('describe.for([[1], [2]])("x", () => { it("a", () => {}); it("b", () => {}); });')).toEqual({ min: 4, open: false });
    expect(countTests('for (const n of [1, 2, 3]) { it("a", () => {}); }')).toEqual({ min: 3, open: false });
    expect(countTests('[1, 2, 3].forEach((n) => { it("a", () => {}); });')).toEqual({ min: 3, open: false });
    expect(countTests('for (const n of rows) { it("a", () => {}); }')).toEqual({ min: 1, open: true });
    expect(countTests('rows.forEach((n) => { it("a", () => {}); });')).toEqual({ min: 1, open: true });
    expect(countTests('for (let i = 0; i < 3; i++) { it("a", () => {}); }')).toEqual({ min: 1, open: true });
  });

  it('a describe.each table rewritten as a loop over an identifier is open, never claimed', () => {
    expect(on(DEACH, 'const ns = [1, 2, 3];\n' + LOOP('').replace('[]', 'ns'))).toEqual([]);
  });
});

describe('test-deletion — extends: true, mergeConfig over a base, test.root (FP-4)', () => {
  const repo: DetectorContext = { trackedFiles: ['src/calc.ts', 'src/__tests__/util.ts', 'test/calc.test.ts', 'test/hard.test.ts'] };
  const vitest = (test: string) => `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { ${test} } });\n`;
  const INCLUDE = 'include: ["**/__tests__/**/*.ts", "**/*.test.ts"]';
  const on = (before: string | null, after: string, path = 'vitest.config.ts', ctx = repo) => msgs(testDeletion, [diffed(path, before, after)], ctx);

  it('projects with extends: true inherit the root include (s04)', () => {
    const after = vitest(`${INCLUDE}, projects: [\n  { extends: true, test: { name: "node", environment: "node" } },\n  { extends: true, test: { name: "jsdom", environment: "jsdom" } },\n]`);
    expect(on(vitest(INCLUDE), after)).toEqual([]);
    // the projects listed BEFORE the include they inherit
    expect(on(vitest(INCLUDE), vitest(`projects: [{ extends: true, test: { name: "node" } }], ${INCLUDE}`))).toEqual([]);
  });

  it('a project that extends the root and then narrows its own include still drops the spec', () => {
    const after = vitest(`${INCLUDE}, projects: [{ extends: true, test: { name: "unit", include: ["test/calc.test.ts"] } }]`);
    const r = on(vitest(INCLUDE), after);
    expect(r.length).toBeGreaterThan(0);
    expect(r.some((x) => /test\/hard\.test\.ts/.test(x))).toBe(true);
  });

  it('a project WITHOUT extends runs the runner default, which the evidence now names', () => {
    const r = on(vitest(INCLUDE), vitest(`${INCLUDE}, projects: [{ test: { name: "node" } }]`));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/src\/__tests__\/util\.ts/);
    expect(r[0]).toMatch(/test\.include \(default\)/);
    expect(r[0]).not.toMatch(/testRegex/);
  });

  it('mergeConfig over an imported base is opaque (s06); over a literal base it is read (s05)', () => {
    const shared = 'import { mergeConfig } from "vitest/config";\nimport { shared } from "./vitest.shared";\nexport default mergeConfig(shared, { test: { exclude: ["**/node_modules/**", "**/dist/**"] } });\n';
    expect(on(vitest(INCLUDE), shared)).toEqual([]);
    const literal = 'import { mergeConfig } from "vitest/config";\nexport default mergeConfig({ plugins: [] }, { test: { include: ["test/calc.test.ts"] } });\n';
    expect(on(vitest(INCLUDE), literal).length).toBeGreaterThan(0);
  });

  it('a ...base spread into the config or its test object is opaque', () => {
    expect(on(vitest(INCLUDE), 'import base from "./base";\nexport default { ...base, test: { exclude: ["**/dist/**"] } };\n')).toEqual([]);
    expect(on(vitest(INCLUDE), 'import base from "./base";\nexport default { test: { ...base.test, exclude: ["**/dist/**"] } };\n')).toEqual([]);
  });

  it('a workspace entry with extends: "<path>" is opaque; test.root rebases the project globs (s09)', () => {
    const pk: DetectorContext = { trackedFiles: ['packages/a/src/a.test.ts', 'packages/b/src/b.test.ts'] };
    const ws = (extra: string) => `import { defineWorkspace } from "vitest/config";\nexport default defineWorkspace([\n  { ${extra}test: { name: "a", root: "./packages/a", include: ["src/**/*.test.ts"] } },\n  { ${extra}test: { name: "b", root: "./packages/b", include: ["src/**/*.test.ts"] } },\n]);\n`;
    expect(on(null, ws('extends: "./vitest.config.ts", '), 'vitest.workspace.ts', pk)).toEqual([]);
    expect(on(null, ws(''), 'vitest.workspace.ts', pk)).toEqual([]);
    // root pointed at one package only: the other package's spec is dropped
    const r = on(null, ws('').replace('root: "./packages/b"', 'root: "./packages/a"'), 'vitest.workspace.ts', pk);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/packages\/b\/src\/b\.test\.ts/);
    expect(r[0]).toMatch(/test\.dir no longer covers it/);
  });
});

describe('test-deletion — which package.json scripts are the suite (FP-5)', () => {
  const pj = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts }) + '\n';
  const on = (before: string, after: string, ctx?: DetectorContext) => msgs(testDeletion, [diffed('package.json', before, after)], ctx);
  const base = pj({ test: 'vitest run' });

  it.each([
    ['test:unit / test:browser with --project beside test (s11)', pj({ test: 'vitest run', 'test:unit': 'vitest run --project unit', 'test:browser': 'vitest run --project browser' })],
    ['test:watch --changed and test:staged --findRelatedTests (s13)', pj({ test: 'vitest run', 'test:watch': 'vitest --changed', 'test:staged': 'jest --findRelatedTests' })],
    ['test --exclude e2e/** beside test:e2e (s12)', pj({ test: 'vitest run --exclude e2e/**', 'test:e2e': 'playwright test' })],
    ['test --exclude=cypress/', pj({ test: 'vitest run --exclude=cypress/' })],
  ])('stays silent on %s', (_n, after) => {
    expect(on(base, after)).toEqual([]);
  });

  it.each([
    ['test --exclude test/hard.test.ts', pj({ test: 'vitest run --exclude test/hard.test.ts' }), /--exclude added to scripts\.test/],
    ['test --exclude e2e/** --exclude test/hard.test.ts', pj({ test: 'vitest run --exclude e2e/** --exclude test/hard.test.ts' }), /--exclude added/],
    ['test:ci --project unit', pj({ test: 'vitest run', 'test:ci': 'vitest run --project unit' }), /--project added to scripts\.test:ci/],
    ['test --changed', pj({ test: 'vitest run --changed' }), /--changed added to scripts\.test/],
  ])('still flags %s', (_n, after, re) => {
    const r = on(base, after);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(re);
  });
});

describe('test-deletion — snapshots under __tests__ are snapshot-rewrite territory (FP-10)', () => {
  const repo: DetectorContext = { trackedFiles: ['src/__tests__/render.test.ts', 'src/__tests__/__snapshots__/render.test.ts.snap', 'src/__tests__/__snapshots__/old.test.ts.snap', 'test/a.test.ts'] };
  const snap = '// Jest Snapshot v1\nexports[`old 1`] = `1`;\n';

  it('deleting an obsolete .snap inside __tests__/ is not a deleted test file (t07)', () => {
    expect(msgs(testDeletion, [diffed('src/__tests__/__snapshots__/old.test.ts.snap', snap, null)], repo)).toEqual([]);
    expect(msgs(testDeletion, [diffed('src/__tests__/__snapshots__/old.test.ts.snap', snap, snap.replace('`1`', '`2`'))], repo)).toEqual([]);
  });

  it('deleting the spec beside it still fires', () => {
    expect(msgs(testDeletion, [diffed('src/__tests__/render.test.ts', 'it("r", () => { expect(1).toBe(1); });\n', null)], repo)).toHaveLength(1);
  });

  it.each(['rm -rf src/__tests__/__snapshots__', 'rm src/__tests__/__snapshots__/old.test.ts.snap', 'git rm -r src/__tests__/__snapshots__'])('stays silent on the command surface: %s', (c) => {
    expect(run(testDeletion, [cmd(c)], repo)).toHaveLength(0);
    expect(run(testDeletion, [cmd(c)])).toHaveLength(0); // without a listing, the globs decide the same way
  });

  it.each(['rm -rf src/__tests__', 'rm -rf src/__tests__/render.test.ts', 'rm -rf test'])('still flags: %s', (c) => {
    expect(run(testDeletion, [cmd(c)], repo).length).toBeGreaterThan(0);
  });
});

describe('test-deletion — git checkout <rev> where <rev> is HEAD by another name (FP-11)', () => {
  it('main while on main restores nothing older; HEAD~1 does', () => {
    const dir = repo();
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      writeFileSync(join(dir, 'test', 'a.test.ts'), 'it("a", () => { expect(1).toBe(1); });\nit("b", () => { expect(2).toBe(2); });\n');
      git('add', '-A');
      git('commit', '-qm', 'second');
      git('tag', 'v1');
      resetTrackedFiles();
      const ctx = { cwd: dir };
      expect(revIsHead('main', ctx)).toBe(true);
      expect(revIsHead('v1', ctx)).toBe(true);
      expect(revIsHead('HEAD~1', ctx)).toBe(false);
      expect(revIsHead('nope', ctx)).toBeNull();
      const flags = (c: string) => run(testDeletion, [cmd(c)], ctx).length;
      expect(flags('git checkout main -- test/')).toBe(0);
      expect(flags('git checkout main -- test/a.test.ts')).toBe(0);
      expect(flags('git checkout @ -- test/')).toBe(0);
      expect(flags('git restore --source=main test/a.test.ts')).toBe(0);
      expect(flags('git checkout HEAD~1 -- test/')).toBeGreaterThan(0);
      expect(flags('git checkout HEAD~1 test/a.test.ts')).toBeGreaterThan(0);
      expect(flags('git restore --source=HEAD~1 test/')).toBeGreaterThan(0);
      expect(flags('rm -rf test/')).toBeGreaterThan(0);
    } finally {
      resetTrackedFiles();
      rmSync(dir, { recursive: true, force: true });
    }
    // without a repository to ask, a rev other than HEAD is judged as before
    expect(run(testDeletion, [cmd('git checkout main -- test/')], { trackedFiles: ['test/a.test.ts'] }).length).toBeGreaterThan(0);
    expect(revIsHead('main', { trackedFiles: [] })).toBeNull();
  });
});

// ── coverage-lowering ─────────────────────────────────────────────────────────
describe('coverage-lowering — generated code, migrations, boilerplate, the 100 shorthand, scoped switches (FP-9, FP-12)', () => {
  const reasons = (c: Change[], ctx?: DetectorContext) => run(coverageLowering, c, ctx).map((f) => f.evidence);
  const VC = (cov: string) => `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { coverage: { ${cov} } } });\n`;
  const TH = 'thresholds: { lines: 80 }';

  it('vitest coverage.exclude of generated code, migrations and entrypoints is housekeeping (c04)', () => {
    const after = VC(`${TH}, exclude: ["src/generated/**", "**/migrations/**", "**/*.generated.ts", "**/*.gen.ts", "**/*.pb.ts", "**/main.ts", "**/*.e2e-spec.ts", "**/__generated__/**", "src/codegen/**"]`);
    expect(reasons([diffed('vitest.config.ts', VC(TH), after)])).toEqual([]);
  });

  it('… while **/index.ts and a real module stay reported', () => {
    expect(reasons([diffed('vitest.config.ts', VC(TH), VC(`${TH}, exclude: ["**/index.ts"]`))])).toEqual(['coverage now exempts "**/index.ts" (coveragePathIgnorePatterns / coverage.exclude)']);
    expect(reasons([diffed('vitest.config.ts', VC(TH), VC(`${TH}, exclude: ["src/discount.ts"]`))])).toHaveLength(1);
  });

  it('.coveragerc omit of Django boilerplate is housekeeping (c06); a view is not', () => {
    const rc = (omit: string) => `[run]\nsource = app\nomit =\n    */tests/*\n${omit}\n[report]\nfail_under = 85\n`;
    expect(reasons([diffed('.coveragerc', rc(''), rc('    */migrations/*\n    manage.py\n    */wsgi.py\n    */asgi.py\n    */__init__.py'))])).toEqual([]);
    expect(reasons([diffed('.coveragerc', rc(''), rc('    */views.py'))])).toEqual(['omit now exempts "*/views.py"']);
  });

  it('thresholds: { 100: true } is every metric at 100 (c10)', () => {
    expect(reasons([diffed('vitest.config.ts', VC('thresholds: { lines: 80, branches: 80 }'), VC('thresholds: { 100: true }'))])).toEqual([]);
    expect(reasons([diffed('vitest.config.ts', VC('thresholds: { 100: true }'), VC('thresholds: { lines: 80 }'))]).some((x) => /lines threshold lowered 100 → 80/.test(x))).toBe(true);
    expect(reasons([diffed('vitest.config.ts', VC('thresholds: { 100: true }'), VC('thresholds: { lines: 100 }'))]).some((x) => /branches threshold removed/.test(x))).toBe(true);
  });

  it('codecov informational: true under patch: is not the project gate (c07); under project: it is', () => {
    const cc = (extra: string) => `coverage:\n  status:\n    project:\n      default:\n        target: 80%\n        threshold: 1%\n${extra}`;
    const patch = cc('    patch:\n      default:\n        target: auto\n        informational: true\n');
    expect(reasons([diffed('codecov.yml', cc(''), patch)])).toEqual([]);
    const project = cc('').replace('threshold: 1%', 'threshold: 1%\n        informational: true');
    expect(reasons([diffed('codecov.yml', cc(''), project)])).toEqual(['codecov project status informational: true added — the status can no longer fail']);
    expect(reasons([diffed('codecov.yml', project, project.replace('target: 80%', 'target: 85%'))])).toEqual([]); // already there: not an addition
  });

  it('--passWithNoTests in a new package that has no spec is not a dodge (c09)', () => {
    const pj = '{"name":"newpkg","version":"0.0.1","scripts":{"test":"jest --passWithNoTests"}}\n';
    const mono = { trackedFiles: ['packages/core/src/index.ts', 'packages/core/test/a.test.ts', 'packages/newpkg/src/index.ts', 'packages/newpkg/package.json'] };
    expect(reasons([diffed('packages/newpkg/package.json', null, pj)], mono)).toEqual([]);
    // the package that HAS a suite, the root of a repo with one, and no listing at all: reported
    expect(reasons([diffed('packages/core/package.json', '{"name":"core","scripts":{"test":"jest"}}\n', pj)], mono)).toHaveLength(1);
    expect(reasons([diffed('package.json', '{"name":"x","scripts":{"test":"jest"}}\n', pj)], mono)).toHaveLength(1);
    expect(reasons([diffed('packages/newpkg/package.json', null, pj)])).toHaveLength(1);
  });
});
