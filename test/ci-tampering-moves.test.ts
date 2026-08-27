// Issue #15 regressions. Both real-world false positives this rule produced were the
// same mistake from two directions: treating line identity as check identity.
//   PR #14: `- run: npm test` re-added as an indented `run: npm test` under a new `if:`
//           read as a deletion — the check had MOVED.
//   PR #19: `TAGS="$(npm view tamperward dist-tags ...)"` read as a removed check —
//           "tamperward" was a package name in ARGUMENT position; the line checks nothing.
// The rule now compares command cores against the whole after-file, and only counts
// check keywords in invocation position.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ciTampering } from '../src/detectors/ci-tampering';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy } from '../src/policy';
import { Change, FileChange } from '../src/types';

const P = defaultPolicy();
const WF = '.github/workflows/release.yml';

function diffed(before: string, after: string): Change[] {
  const dir = mkdtempSync(join(tmpdir(), 'tw-ci-'));
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

const msgs = (c: Change[]) => ciTampering.run(c, P).map((f) => f.message);

describe('moves are not removals (the PR #14 false positive)', () => {
  const before = 'jobs:\n  publish:\n    steps:\n      - run: npm ci\n      - run: npm run typecheck\n      - run: npm test\n      - run: npm publish\n';
  const moved =
    'jobs:\n  publish:\n    steps:\n      - run: npm ci\n' +
    "      - if: steps.plan.outputs.publish == 'true'\n        run: npm run typecheck\n" +
    "      - if: steps.plan.outputs.publish == 'true'\n        run: npm test\n" +
    '      - run: npm publish\n';

  it('stays silent when checks move behind a reachable if:', () => {
    expect(msgs(diffed(before, moved))).toHaveLength(0);
  });

  it('still flags the checks when they are removed outright', () => {
    const gone = 'jobs:\n  publish:\n    steps:\n      - run: npm ci\n      - run: npm publish\n';
    const m = msgs(diffed(before, gone));
    expect(m.filter((x) => /removed/.test(x))).toHaveLength(2);
  });

  it('a move behind a literal if:false is still caught — by the added-line scan', () => {
    const dead =
      'jobs:\n  publish:\n    steps:\n      - run: npm ci\n' +
      '      - if: ${{ false }}\n        run: npm test\n      - run: npm publish\n';
    const m = msgs(diffed(before, dead));
    expect(m.some((x) => /can never run/.test(x))).toBe(true);
    // and typecheck vanished entirely, which is still a removal
    expect(m.some((x) => /removed/.test(x))).toBe(true);
  });

  it('a reindent/reformat of the same command is silent', () => {
    const reformatted = before.replace('      - run: npm test\n', '      -  run:  npm   test\n');
    expect(msgs(diffed(before, reformatted))).toHaveLength(0);
  });
});

describe('argument-position keywords are not checks (the PR #19 false positive)', () => {
  it('stays silent when a registry-query line naming a check-like package is replaced', () => {
    const before =
      'jobs:\n  publish:\n    steps:\n      - run: |\n' +
      '          TAGS="$(npm view tamperward dist-tags --json 2>/dev/null || echo \'{}\')"\n' +
      '          LATEST="$(printf \'%s\' "$TAGS" | jq -r \'.latest // empty\')"\n';
    const after =
      'jobs:\n  publish:\n    steps:\n      - run: |\n' +
      '          LATEST="$(npm view tamperward@latest version 2>/dev/null || true)"\n';
    expect(msgs(diffed(before, after))).toHaveLength(0);
  });

  it('still flags a real check invocation removed from a run body', () => {
    const before = 'jobs:\n  ci:\n    steps:\n      - run: |\n          npm ci\n          npx vitest run --coverage\n';
    const after = 'jobs:\n  ci:\n    steps:\n      - run: |\n          npm ci\n';
    expect(msgs(diffed(before, after)).some((x) => /run block/.test(x))).toBe(true);
  });

  it('tool names count in command position after chains and substitutions', () => {
    const before = 'jobs:\n  ci:\n    steps:\n      - run: npm ci && npx jest --ci\n';
    const after = 'jobs:\n  ci:\n    steps:\n      - run: npm ci\n';
    expect(msgs(diffed(before, after))).toHaveLength(1);
  });

  it('a removed uses: step naming a check action still fires', () => {
    const before = 'jobs:\n  ci:\n    steps:\n      - uses: reviewdog/action-eslint@v1\n      - run: npm ci\n';
    const after = 'jobs:\n  ci:\n    steps:\n      - run: npm ci\n';
    expect(msgs(diffed(before, after)).some((x) => /check step/.test(x))).toBe(true);
  });

  it('removing non-check plumbing (checkout, install, echo) is silent', () => {
    const before =
      'jobs:\n  ci:\n    steps:\n      - uses: actions/checkout@v5\n      - run: npm ci\n      - run: echo done\n      - run: npm test\n';
    const after = 'jobs:\n  ci:\n    steps:\n      - run: npm test\n';
    expect(msgs(diffed(before, after))).toHaveLength(0);
  });
});
