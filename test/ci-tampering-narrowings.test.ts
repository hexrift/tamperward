// Issue #436 regressions: four ways a check step is edited so that it decides
// nothing, each of which the rule read as a kept (respelled) check or a wider trigger.
//   1. same-kind respellings that run nothing: `npm run tests --if-present`,
//      `--prefix packages/empty`, `-w empty`, `pnpm --filter nothing`, `jest --shard=1/1000`,
//      `--testMatch '**/nothing.js'`, `cargo test -- --skip failing`, `pytest -k nothing`,
//      a lowered `--cov-fail-under`, `vitest --root packages/empty`, a `working-directory`
//      pointing nowhere, `actions/checkout` pinned to `ref: main`;
//   2. a check "surviving" inside a heredoc body, a folded scalar or an `echo`;
//   3. `if:` built from a function call over constants (`contains('a', 'b')`,
//      `fromJSON('false')`);
//   4. triggers narrowed from an implicit every-branch, a `tags:`-only filter, `!main`
//      negation, and a `paths-ignore` that covers every source file.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ciTampering, foldConst, isAlwaysFalse } from '../src/detectors/ci-tampering';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy } from '../src/policy';
import { Change, DetectorContext, FileChange } from '../src/types';

const P = defaultPolicy();
const WF = '.github/workflows/ci.yml';

function diffed(before: string, after: string): Change[] {
  const dir = mkdtempSync(join(tmpdir(), 'tw-ci436-'));
  writeFileSync(join(dir, 'a'), before);
  writeFileSync(join(dir, 'b'), after);
  let raw = '';
  try {
    raw = execFileSync('git', ['diff', '--no-index', '--no-color', join(dir, 'a'), join(dir, 'b')], { encoding: 'utf8' });
  } catch (e) {
    raw = String((e as { stdout?: Buffer }).stdout ?? '');
  }
  rmSync(dir, { recursive: true, force: true });
  const parsed = parseDiff(raw)[0] as FileChange | undefined;
  return [{ kind: 'file', path: WF, oldPath: null, op: 'modify', before, after, binary: false, hunks: parsed?.hunks ?? [] }];
}

const msgs = (c: Change[], ctx?: DetectorContext) => ciTampering.run(c, P, 'staged', ctx).map((f) => `${f.message} ${f.evidence}`);

const base = (check: string) =>
  `name: ci
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
      - run: ${check}
`;

/** Replace the check line of the base workflow (before) with `to` (after). */
const edit = (check: string, to: string): Change[] => diffed(base(check), base(check).replace(`      - run: ${check}\n`, to));

// ── 1. respellings that run nothing ──────────────────────────────────────────────
describe('#436 · same-kind respellings that run nothing are neutralisations', () => {
  it.each([
    ['npm test', '      - run: npm run tests --if-present\n'],
    ['npm test', '      - run: npm test --if-present\n'],
    ['npm test', '      - run: npm test --prefix packages/empty\n'],
    ['npm test', '      - run: npm test -w empty\n'],
    ['npm test', '      - run: npm test --workspace=empty\n'],
    ['pnpm test', '      - run: pnpm test --filter nothing\n'],
    ['npx jest', '      - run: npx jest --shard=1/1000\n'],
    ['npx jest', "      - run: npx jest --testMatch '**/nothing.js'\n"],
    ['npx jest', '      - run: npx jest --testRegex nothing\n'],
    ['npx jest', '      - run: npx jest --rootDir packages/empty\n'],
    ['npx jest', '      - run: npx jest --modulePathIgnorePatterns .\n'],
    ['npx jest', '      - run: npx jest --selectProjects none\n'],
    ['npx vitest run', '      - run: npx vitest run --root packages/empty\n'],
    ['npx mocha', '      - run: npx mocha --grep nothing\n'],
    ['npx mocha', '      - run: npx mocha -g nothing\n'],
    ['cargo test', '      - run: cargo test -- --skip failing\n'],
    ['go test ./...', '      - run: go test -run NothingMatches ./...\n'],
    ['pytest', '      - run: pytest -k nothing_matches\n'],
    ['pytest', '      - run: pytest -m nothing\n'],
    ['pytest', '      - run: pytest --deselect tests/test_a.py::test_x\n'],
    ['pytest', '      - run: pytest --ignore=tests\n'],
    ['pytest', '      - run: pytest -p no:python\n'],
    ['pytest --cov-fail-under=90', '      - run: pytest --cov-fail-under=10\n'],
    ['pytest --cov-fail-under 90', '      - run: pytest --cov-fail-under 0\n'],
  ])('%s → %s', (check, to) => {
    const m = msgs(edit(check, to));
    expect(m.some((x) => /neutralised in place|was removed/.test(x)), m.join('\n')).toBe(true);
  });

  it.each([
    ['a reporter flag', 'npm test', '      - run: npm test -- --reporter=dot\n'],
    ['a raised coverage floor', 'pytest --cov-fail-under=90', '      - run: pytest --cov-fail-under=95\n'],
    ['-p no:cacheprovider', 'pytest', '      - run: pytest -p no:cacheprovider\n'],
    ['a matrix-valued --shard', 'npx jest', '      - run: npx jest --shard=${{ matrix.shard }}/4\n'],
    ['npm test → npm run test:ci', 'npm test', '      - run: npm run test:ci\n'],
    ['--workspaces (all of them)', 'npm test', '      - run: npm test --workspaces\n'],
  ])('stays silent on %s', (_n, check, to) => {
    expect(msgs(edit(check, to))).toEqual([]);
  });

  const wd = (line: string) => base('npm test').replace('      - run: npm test\n', `      - run: npm test\n${line}\n`);
  const tracked = { trackedFiles: ['package.json', 'src/index.ts', 'test/a.test.ts', 'apps/web/package.json', 'apps/web/src/index.ts'] };

  it('working-directory pointing at nothing on a check step is a neutraliser', () => {
    const m = msgs(diffed(base('npm test'), wd('        working-directory: packages/empty')), tracked);
    expect(m.some((x) => /working-directory/.test(x)), m.join('\n')).toBe(true);
  });

  it('working-directory is reported when the repository cannot say what is there', () => {
    const m = msgs(diffed(base('npm test'), wd('        working-directory: packages/empty')));
    expect(m.some((x) => /working-directory/.test(x)), m.join('\n')).toBe(true);
  });

  it('defaults.run.working-directory at job level is a neutraliser for the job that runs the check', () => {
    const after = base('npm test').replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    defaults:\n      run:\n        working-directory: packages/empty\n');
    const m = msgs(diffed(base('npm test'), after), tracked);
    expect(m.some((x) => /working-directory/.test(x)), m.join('\n')).toBe(true);
  });

  it('working-directory naming a package the repository has is placement, not narrowing', () => {
    expect(msgs(diffed(base('npm test'), wd('        working-directory: apps/web')), tracked)).toEqual([]);
  });

  it('working-directory on a non-check step is not reported', () => {
    const after = base('npm test').replace('      - run: npm ci\n', '      - run: npm ci\n        working-directory: packages/empty\n      - run: npm run build\n        working-directory: packages/empty\n');
    const m = msgs(diffed(base('npm test'), after), tracked);
    expect(m.filter((x) => /working-directory/.test(x))).toEqual([]);
  });

  it('actions/checkout gaining a literal ref: runs the suite against something other than the change', () => {
    const after = base('npm test').replace('      - uses: actions/checkout@v4\n', '      - uses: actions/checkout@v4\n        with:\n          ref: main\n');
    const m = msgs(diffed(base('npm test'), after));
    expect(m.some((x) => /ref: main/.test(x)), m.join('\n')).toBe(true);
  });

  it('a checkout ref that reads the event (the pull_request_target idiom) is not reported', () => {
    const after = base('npm test').replace(
      '      - uses: actions/checkout@v4\n',
      '      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n',
    );
    expect(msgs(diffed(base('npm test'), after))).toEqual([]);
  });
});

// ── 2. survival inside a heredoc, a folded scalar, an echo ─────────────────────
describe('#436 · a check inside a heredoc body, a folded scalar or an echo does not survive', () => {
  it.each([
    ['a heredoc body', '      - run: |\n          cat <<EOF >/dev/null\n          npm test\n          EOF\n'],
    ["a quoted heredoc body", "      - run: |\n          cat <<'EOF' >/dev/null\n          npm test\n          EOF\n"],
    ['a folded scalar', '      - run: >\n          echo\n          npm test\n'],
    ['an echo', '      - run: echo "npm test"\n'],
    ['a step name', '      - name: npm test\n        run: echo ok\n'],
  ])('%s', (_n, to) => {
    const m = msgs(edit('npm test', to));
    expect(m.some((x) => /was removed/.test(x)), m.join('\n')).toBe(true);
  });

  it.each([
    ['a check after a heredoc in the same block', '      - run: |\n          cat <<EOF\n          hello\n          EOF\n          npm test\n'],
    ['a check chained after install', '      - run: npm ci && npm test\n'],
    ['a check behind an env assignment', '      - run: CI=true npm test\n'],
    ['a check in a literal block', '      - run: |\n          npm test\n          npm run typecheck\n'],
  ])('stays silent on %s', (_n, to) => {
    expect(msgs(edit('npm test', to))).toEqual([]);
  });
});

// ── 3. function calls over constants fold ────────────────────────────────────────
describe('#436 · if: built from a function call over constants folds', () => {
  it.each([
    ["if: contains('a', 'b')", "        if: contains('a', 'b')"],
    ["if: ${{ fromJSON('false') }}", "        if: ${{ fromJSON('false') }}"],
    ["if: startsWith('abc', 'x')", "        if: startsWith('abc', 'x')"],
    ["if: endsWith('abc', 'x')", "        if: endsWith('abc', 'x')"],
    ["if: ${{ !contains('abc', 'b') }}", "        if: ${{ !contains('abc', 'b') }}"],
    ["if: ${{ format('{0}', 'x') == 'y' }}", "        if: ${{ format('{0}', 'x') == 'y' }}"],
    ["if: ${{ toJSON(false) == 'true' }}", "        if: ${{ toJSON(false) == 'true' }}"],
    ["if: ${{ join('a', ',') == 'b' }}", "        if: ${{ join('a', ',') == 'b' }}"],
  ])('%s can never run', (_n, line) => {
    const m = msgs(edit('npm test', `      - run: npm test\n${line}\n`));
    expect(m.some((x) => /can never run/.test(x)), m.join('\n')).toBe(true);
  });

  it.each([
    ["contains(github.ref, 'main')", "        if: contains(github.ref, 'main')"],
    ["contains('abc', 'B') (true)", "        if: contains('abc', 'B')"],
    ["fromJSON(needs.plan.outputs.run)", '        if: ${{ fromJSON(needs.plan.outputs.run) }}'],
    ['!cancelled()', '        if: ${{ !cancelled() }}'],
  ])('stays silent on %s', (_n, line) => {
    expect(msgs(edit('npm test', `      - run: npm test\n${line}\n`))).toEqual([]);
  });

  it('folds the documented functions and refuses them with an unknown argument', () => {
    expect(foldConst("contains('a', 'b')")).toBe(false);
    expect(foldConst("contains('abc', 'B')")).toBe(true);
    expect(foldConst("startsWith('abc', 'AB')")).toBe(true);
    expect(foldConst("endsWith('abc', 'x')")).toBe(false);
    expect(foldConst("fromJSON('false')")).toBe(false);
    expect(foldConst("fromJSON('0')")).toBe(0);
    expect(foldConst("format('{0}-{1}', 'a', 1)")).toBe('a-1');
    expect(foldConst('toJSON(false)')).toBe('false');
    expect(foldConst("join('a', ',')")).toBe('a');
    expect(foldConst("contains(github.ref, 'main')")).toBeUndefined();
    expect(foldConst('fromJSON(needs.plan.outputs.run)')).toBeUndefined();
    expect(foldConst("fromJSON('not json')")).toBeUndefined();
    expect(isAlwaysFalse("contains('a', 'b')")).toBe(true);
    expect(isAlwaysFalse("${{ fromJSON('false') }}")).toBe(true);
  });
});

// ── 4. trigger narrowings ──────────────────────────────────────────────────────
describe('#436 · trigger narrowings from an implicit every-branch, tags-only, negation, paths-ignore', () => {
  const wf = (on: string) => `name: ci\n${on}jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`;
  const narrowed = (before: string, after: string, ctx?: DetectorContext) => msgs(diffed(wf(before), wf(after)), ctx).filter((x) => /triggers were narrowed/.test(x));

  it('on: [push, pull_request] → push: branches: [never-exists]', () => {
    const m = narrowed('on: [push, pull_request]\n', 'on:\n  push:\n    branches: [never-exists]\n  pull_request:\n');
    expect(m.some((x) => /on\.push\.branches/.test(x)), m.join('\n')).toBe(true);
  });

  it('pull_request: → pull_request: branches: [release/**]', () => {
    const m = narrowed('on:\n  push:\n    branches: [main]\n  pull_request:\n', 'on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [release/**]\n');
    expect(m.some((x) => /on\.pull_request\.branches/.test(x)), m.join('\n')).toBe(true);
  });

  it('push: branches: [main] → push: tags: ["v*"] no longer runs on any branch', () => {
    const m = narrowed('on:\n  push:\n    branches: [main]\n', 'on:\n  push:\n    tags: ["v*"]\n');
    expect(m.some((x) => /on\.push/.test(x) && /tags/.test(x)), m.join('\n')).toBe(true);
  });

  it('a bare push: → push: tags: ["v*"] no longer runs on any branch', () => {
    const m = narrowed('on:\n  push:\n', 'on:\n  push:\n    tags: ["v*"]\n');
    expect(m.some((x) => /on\.push/.test(x) && /tags/.test(x)), m.join('\n')).toBe(true);
  });

  it('branches: [main, "!main"] negates the default branch', () => {
    const m = narrowed('on:\n  push:\n    branches: [main]\n', 'on:\n  push:\n    branches: [main, "!main"]\n');
    expect(m.some((x) => /on\.push\.branches/.test(x)), m.join('\n')).toBe(true);
  });

  it('branches: ["**", "!main"] negates the default branch', () => {
    const m = narrowed('on:\n  push:\n', 'on:\n  push:\n    branches: ["**", "!main"]\n');
    expect(m.some((x) => /on\.push\.branches/.test(x)), m.join('\n')).toBe(true);
  });

  it('paths-ignore covering every source file never runs on code', () => {
    const ctx = { trackedFiles: ['src/index.ts', 'test/a.test.ts', 'package.json', 'README.md'] };
    const m = narrowed('on:\n  pull_request:\n', 'on:\n  pull_request:\n    paths-ignore: ["src/**", "test/**", "package.json", "*.ts"]\n', ctx);
    expect(m.some((x) => /paths-ignore/.test(x)), m.join('\n')).toBe(true);
  });

  it('the control: [main] → [feature] keeps blocking', () => {
    const m = narrowed('on:\n  push:\n    branches: [main]\n', 'on:\n  push:\n    branches: [feature]\n');
    expect(m.some((x) => /no longer names main/.test(x)), m.join('\n')).toBe(true);
  });

  it.each([
    ['tags added beside branches', 'on:\n  push:\n    branches: [main]\n', 'on:\n  push:\n    branches: [main]\n    tags: ["v*"]\n'],
    ['a negation that spares the default branch', 'on:\n  push:\n', 'on:\n  push:\n    branches: ["**", "!release/**"]\n'],
    ['a negation re-admitting main', 'on:\n  push:\n    branches: [main]\n', 'on:\n  push:\n    branches: ["!main", main]\n'],
    ['a docs-only paths-ignore', 'on:\n  pull_request:\n', 'on:\n  pull_request:\n    paths-ignore: ["docs/**", "**.md"]\n'],
    ['a glob that admits main', 'on:\n  push:\n', 'on:\n  push:\n    branches: ["ma*"]\n'],
    ['an explicit every-branch filter', 'on:\n  push:\n', 'on:\n  push:\n    branches: ["**"]\n'],
    ['a tags-only filter kept as it was', 'on:\n  push:\n    tags: ["v*"]\n', 'on:\n  push:\n    tags: ["v*", "r*"]\n'],
  ])('stays silent on %s', (_n, before, after) => {
    const ctx = { trackedFiles: ['src/index.ts', 'test/a.test.ts', 'package.json', 'docs/a.md'] };
    expect(narrowed(before, after, ctx)).toEqual([]);
  });

  it('an ordinary matrix / caching change stays clean', () => {
    const before = base('npm test');
    const after = before
      .replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [20, 22, 24]\n')
      .replace('      - run: npm ci\n', '      - uses: actions/cache@v4\n        with:\n          path: ~/.npm\n          key: npm-${{ hashFiles(\'package-lock.json\') }}\n      - run: npm ci\n');
    expect(msgs(diffed(before, after))).toEqual([]);
  });
});
