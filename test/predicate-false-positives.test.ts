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
import { ciTampering, foldExpressions } from '../src/detectors/ci-tampering';
import { branchExists, resetTrackedFiles } from '../src/detectors/repo';
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
