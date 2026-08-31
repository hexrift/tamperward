// Pass-2 external review: rename semantics defeated the CI authority layer.
// Both exploits are ordinary COMMITTED diffs that `check --diff` reported clean,
// which is the fallback every local-layer finding leaned on.

import { describe, it, expect } from 'vitest';
import { evaluate, hasBlocking } from '../src/engine';
import { defaultPolicy } from '../src/policy';
import { Change } from '../src/types';

const spec = (n: number) =>
  Array.from({ length: n }, (_, i) => `it('case${i + 1}', () => { expect(${i + 1}).toBe(${i + 1}); });`).join('\n') + '\n';

const rename = (oldPath: string, path: string, before: string | null, after: string | null): Change => ({
  kind: 'file', path, oldPath, op: 'rename', before, after, binary: false, hunks: [],
});

const WORKFLOW = `on: push
jobs:
  build:
    steps:
      - run: npm test
      - run: npm run lint
`;

describe('P0-7: a rename inside the tests glob is still content-inspected', () => {
  it('rename + dropped it() blocks blocks (git -M linked the pair; op is rename, not modify)', () => {
    const c = rename('test/math.test.js', 'test/calc.test.js', spec(10), spec(7));
    expect(hasBlocking(evaluate([c], defaultPolicy(), undefined, 'range'))).toBe(true);
  });

  it('an honest rename with identical content stays clean', () => {
    const c = rename('test/math.test.js', 'test/renamed.test.js', spec(10), spec(10));
    expect(hasBlocking(evaluate([c], defaultPolicy(), undefined, 'range'))).toBe(false);
  });
});

describe('P0-8: a workflow renamed so it no longer runs is CI tampering', () => {
  it('ci.yml → ci.yml.disabled blocks (still inside the glob, no longer executable)', () => {
    const c = rename('.github/workflows/ci.yml', '.github/workflows/ci.yml.disabled', WORKFLOW, WORKFLOW);
    expect(hasBlocking(evaluate([c], defaultPolicy(), undefined, 'range'))).toBe(true);
  });

  it('ci.yml → build.yml stays clean (still an executable workflow)', () => {
    const c = rename('.github/workflows/ci.yml', '.github/workflows/build.yml', WORKFLOW, WORKFLOW);
    expect(hasBlocking(evaluate([c], defaultPolicy(), undefined, 'range'))).toBe(false);
  });

  it('a workflow moved out of .github/workflows blocks', () => {
    const c = rename('.github/workflows/ci.yml', 'docs/ci.yml', WORKFLOW, WORKFLOW);
    expect(hasBlocking(evaluate([c], defaultPolicy(), undefined, 'range'))).toBe(true);
  });
});
