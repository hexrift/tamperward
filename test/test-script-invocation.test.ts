// #435: the package.json test script read as a CHECK INVOCATION, the way
// ci-tampering reads a workflow line. `"test": "vitest run"` rewritten to `echo ok`,
// `vitest run || true`, a path positional, `--config <new file>`, `--shard=1/1000`
// or an nyc `--check-coverage` dropped left CI running `npm test` unchanged and
// the whole suite neutralised with no finding. Every positive here was a silent
// evasion against the built CLI before the fix; every negative is a maintainer
// edit (a runner migration, a reporter flag) that must stay clean.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy } from '../src/policy';
import { testDeletion } from '../src/detectors/test-deletion';
import { ciTampering } from '../src/detectors/ci-tampering';
import { invocationWeakening } from '../src/detectors/invocation';
import type { Change, Detector, DetectorContext, FileChange, FileOp } from '../src/types';

const P = defaultPolicy();

/** A file change with REAL hunks (git diff --no-index), so the line-scanning rules see it. */
function diffed(path: string, before: string | null, after: string | null, op?: FileOp): FileChange {
  const dir = mkdtempSync(join(tmpdir(), 'tw-tsi-'));
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

const pj = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts }, null, 2) + '\n';
const on = (before: Record<string, string>, after: Record<string, string>, extra: Change[] = []) =>
  msgs(testDeletion, [diffed('package.json', pj(before), pj(after)), ...extra]).filter((m) => m.includes('scripts.'));

describe('test-deletion — the test script rewritten so the suite no longer decides (#435)', () => {
  it.each([
    ['a non-check replaces the runner', { test: 'echo ok' }, /no longer runs the test check/],
    ['a check of another kind replaces the runner', { test: 'npm run lint' }, /no longer runs the test check/],
    ['|| true masks the status', { test: 'vitest run || true' }, /\|\| true added to scripts\.test/],
    ['; exit 0 masks the status', { test: 'vitest run; exit 0' }, /; exit 0 added to scripts\.test/],
    ['a pipe swallows the status', { test: 'vitest run | tee test.log' }, /\| tee test\.log added to scripts\.test/],
    ['a path positional narrows to one spec', { test: 'vitest run src/easy.test.ts' }, /path positional \(src\/easy\.test\.ts\) added to scripts\.test/],
    ['--config pointing at an unprotected file', { test: 'vitest run --config vitest.ci.ts' }, /--config vitest\.ci\.ts added to scripts\.test/],
    ['-c pointing at an unprotected file', { test: 'vitest run -c vitest.ci.ts' }, /-c vitest\.ci\.ts added to scripts\.test/],
    ['--shard=1/1000', { test: 'vitest run --shard=1/1000' }, /--shard added to scripts\.test/],
    ['--passWithNoTests', { test: 'vitest run --passWithNoTests' }, /--passWithNoTests added/],
    ['a timeout wrapper', { test: 'timeout 1 vitest run' }, /timeout wrapper added to scripts\.test/],
  ])('blocks %s', (_n, after, re) => {
    const m = on({ test: 'vitest run' }, after);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(re);
  });

  it.each([
    ['--root', 'jest --root src/easy'],
    ['--rootDir', 'jest --rootDir src/easy'],
    ['--testMatch', 'jest --testMatch **/easy.test.ts'],
    ['--testRegex', 'jest --testRegex easy'],
    ['--modulePathIgnorePatterns', 'jest --modulePathIgnorePatterns hard'],
    ['--selectProjects', 'jest --selectProjects unit'],
    ['--shard', 'jest --shard=1/1000'],
  ])('blocks a jest %s narrowing', (flag, after) => {
    const m = on({ test: 'jest' }, { test: after });
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toContain(`${flag} added to scripts.test`);
  });

  it.each([
    ['pytest -k', 'pytest', 'pytest -k easy', '-k'],
    ['pytest -m', 'pytest', 'pytest -m "not slow"', '-m'],
    ['pytest --deselect', 'pytest', 'pytest --deselect tests/test_hard.py::test_x', '--deselect'],
    ['pytest --ignore', 'pytest', 'pytest --ignore=tests/hard', '--ignore'],
    ['cargo test -- --skip', 'cargo test', 'cargo test -- --skip hard', '-- --skip'],
    ['go test -run', 'go test ./...', 'go test ./... -run TestEasy', '-run'],
    ['mocha --grep', 'mocha', 'mocha --grep easy', '--grep'],
    ['mocha -g', 'mocha', 'mocha -g easy', '-g'],
    ['npm --if-present', 'npm run test:unit', 'npm run test:unit --if-present', '--if-present'],
  ])('blocks %s', (_n, before, after, flag) => {
    const m = on({ test: before }, { test: after });
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toContain(`${flag} added to scripts.test`);
  });

  it('blocks nyc --check-coverage removed from the test script', () => {
    const m = on({ test: 'nyc --check-coverage mocha' }, { test: 'nyc mocha' });
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/--check-coverage removed from scripts\.test/);
  });

  it('blocks --config pointing at a protected config ADDED in the same change', () => {
    const cfg = diffed('vitest.config.ci.ts', null, "export default { test: { include: ['test/none/**'] } };\n");
    const m = on({ test: 'vitest run' }, { test: 'vitest run --config vitest.config.ci.ts' }, [cfg]);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/--config vitest\.config\.ci\.ts added/);
  });

  it.each([
    ['test:ci', { 'test:ci': 'vitest run' }, { 'test:ci': 'echo ok' }, /no longer runs the test check.*scripts\.test:ci/],
    ['test:unit masked', { 'test:unit': 'vitest run --project unit' }, { 'test:unit': 'vitest run --project unit || true' }, /\|\| true added to scripts\.test:unit/],
    ['test:integration replaced', { 'test:integration': 'vitest run test/integration' }, { 'test:integration': 'echo skipped' }, /no longer runs the test check.*scripts\.test:integration/],
    ['pretest replaced', { pretest: 'npm run lint', test: 'vitest run' }, { pretest: 'true', test: 'vitest run' }, /no longer runs the lint check.*scripts\.pretest/],
    ['pretest deleted', { pretest: 'npm run lint', test: 'vitest run' }, { test: 'vitest run' }, /no longer runs the lint check.*scripts\.pretest/],
    ['check dropping its tests', { check: 'npm run lint && npm run typecheck && npm test' }, { check: 'npm run lint && npm run typecheck' }, /no longer runs the test check.*scripts\.check/],
    ['check masking its tests', { check: 'npm run lint && npm test' }, { check: 'npm run lint && npm test || true' }, /\|\| true added to scripts\.check/],
  ])('covers the %s script', (_n, before, after, re) => {
    const m = on(before, after);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(re);
  });

  it.each([
    ['jest → vitest run (runner migration)', { test: 'jest' }, { test: 'vitest run' }],
    ['mocha → vitest (runner migration)', { test: 'mocha' }, { test: 'vitest' }],
    ['jest --coverage → vitest run --coverage', { test: 'jest --coverage' }, { test: 'vitest run --coverage' }],
    ['mocha with ts-node → vitest run', { test: "mocha -r ts-node/register 'test/**/*.spec.ts'" }, { test: 'vitest run' }],
    ['a reporter flag', { test: 'vitest run' }, { test: 'vitest run --reporter=dot' }],
    ['coverage switched on', { test: 'vitest run' }, { test: 'vitest run --coverage' }],
    ['vitest → vitest run', { test: 'vitest' }, { test: 'vitest run' }],
    ['jest gaining CI flags', { test: 'jest' }, { test: 'jest --ci --maxWorkers=2' }],
    ['an env prefix', { test: 'vitest run' }, { test: 'cross-env NODE_ENV=test vitest run' }],
    ['a NODE_OPTIONS assignment', { test: 'jest' }, { test: 'NODE_OPTIONS=--experimental-vm-modules jest' }],
    ['jest through node', { test: 'jest' }, { test: 'node --experimental-vm-modules node_modules/jest/bin/jest.js' }],
    ['pytest → python -m pytest', { test: 'pytest' }, { test: 'python -m pytest' }],
    ['--config pointing at a protected, pre-existing config', { test: 'vitest run' }, { test: 'vitest run --config vitest.config.ci.ts' }],
    ['--config unchanged', { test: 'vitest run --config vitest.ci.ts' }, { test: 'vitest run --config vitest.ci.ts --reporter=dot' }],
    ['a slice gaining --project (deliberate)', { 'test:unit': 'vitest run' }, { 'test:unit': 'vitest run --project unit' }],
    ['a slice gaining a reporter', { 'test:integration': 'vitest run test/integration' }, { 'test:integration': 'vitest run test/integration --reporter=dot' }],
    ['a positional that was already there', { test: 'jest test/' }, { test: 'jest test/ --coverage' }],
    ['a pretest that is not a check', { pretest: 'npm run build', test: 'jest' }, { pretest: 'npm run build:fast', test: 'jest' }],
    ['lint moved out of test into a new lint script', { test: 'npm run lint && jest' }, { test: 'jest', lint: 'eslint .' }],
    ['a coverage floor raised beside --check-coverage', { test: 'nyc --check-coverage mocha' }, { test: 'nyc --check-coverage --lines 90 mocha' }],
    ['a check chained after the suite', { test: 'vitest run' }, { test: 'vitest run && npm run lint' }],
    ['the npm-init placeholder edited', { test: 'echo "Error: no test specified" && exit 1' }, { test: 'echo "no tests yet" && exit 1' }],
    ['a script deleted (npm test then fails loudly)', { test: 'vitest run', 'test:ci': 'vitest run' }, { test: 'vitest run' }],
    ['--exclude of another runner\'s directory', { test: 'vitest run' }, { test: 'vitest run --exclude e2e/**' }],
  ])('stays clean on %s', (_n, before, after) => {
    const m = on(before, after);
    expect(m, m.join('\n')).toEqual([]);
  });
});

describe('invocationWeakening — the shared reading', () => {
  it.each([
    ['npm test', 'npm run test:ci', 'kept'],
    ['npx jest', 'npx vitest run', 'kept'],
    ['npm test', 'npm test -- --reporter=dot', 'kept'],
    ['npm test', 'npm test || true', 'neutralised'],
    ['npm test', 'npm test -- test/a.test.ts', 'neutralised'],
    ['npm test', 'timeout 1 npm test', 'neutralised'],
    ['npm test', 'npm run lint', 'removed'],
    ['npm test', 'echo ok', 'removed'],
    ['echo ok', 'echo done', 'kept'],
  ])('%s → %s is %s', (before, after, state) => {
    expect(invocationWeakening(before, after).state).toBe(state);
  });

  it('names what was added', () => {
    expect(invocationWeakening('vitest run', 'vitest run --shard=1/2')).toMatchObject({ state: 'neutralised', what: '--shard', direction: 'added' });
    expect(invocationWeakening('nyc --check-coverage mocha', 'nyc mocha')).toMatchObject({ state: 'neutralised', what: '--check-coverage', direction: 'removed' });
  });
});

describe('ci-tampering keeps its reading through the shared module', () => {
  const wf = (step: string) => `on: [push]\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${step}\n`;
  const on = (before: string, after: string) => msgs(ciTampering, [diffed('.github/workflows/ci.yml', wf(before), wf(after))]);

  it.each([
    ['npm test', 'npm run test:ci', 0],
    ['npx jest', 'npx vitest run', 0],
    ['npm test', 'npm test -- --reporter=dot', 0],
    ['npm test', 'npm test || true', 1],
    ['npm test', 'npm test -- test/a.test.ts', 1],
    ['npm test', 'timeout 1 npm test', 1],
    ['npm test', 'npm run lint', 1],
  ])('%s → %s: %i finding(s)', (before, after, n) => {
    expect(on(before, after)).toHaveLength(n);
  });
});
