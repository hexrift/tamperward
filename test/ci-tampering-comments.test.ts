// ci-tampering must not read a YAML comment as a step. Rewording a comment that
// quoted `tamperward:allow:<rule>` blocked the repo's own workflow edit: the
// backtick before the word satisfied the invocation-position test.

import { describe, it, expect } from 'vitest';
import { ciTampering } from '../src/detectors/ci-tampering';
import { defaultPolicy } from '../src/policy';
import type { Change } from '../src/types';

const P = defaultPolicy();
const wf = (before: string, after: string): Change => ({
  kind: 'file',
  path: '.github/workflows/ci.yml',
  oldPath: null,
  op: 'modify',
  before,
  after,
  binary: false,
  hunks: [
    {
      oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: [
        { type: 'del', content: before, oldLine: 1, newLine: null },
        { type: 'add', content: after, oldLine: null, newLine: 1 },
      ],
    },
  ],
});

describe('ci-tampering ignores YAML comments', () => {
  it.each([
    ['      # is a PR label `tamperward:allow:<rule>`, which only someone with write access can', '      # is a PR label `tamperward:allow:<rule>@<sha>`'],
    ['# - run: npm test', '# (the test step moved below)'],
    ['  # npx tamperward check --diff', '  # see the gate job'],
  ])('a removed comment line is not a removed check: %s', (before, after) => {
    expect(ciTampering.run([wf(before, after)], P)).toHaveLength(0);
  });

  it('a real removed check still fires', () => {
    expect(ciTampering.run([wf('      - run: npm test', '      - run: echo skipped')], P).map((f) => f.rule)).toEqual([
      'ci-tampering',
    ]);
  });
});
