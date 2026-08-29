// Per-rule `exclude` globs (1.6.0): one rule's blind spot, everyone else's coverage
// intact — plus the symmetry obligation: adding an exclude is a policy-weakening event.
import { describe, it, expect } from 'vitest';
import { parseDiff } from '../src/diff/parse';
import { evaluate } from '../src/engine';
import { defaultPolicy } from '../src/policy';
import { policyWeakening } from '../src/detectors/policy-diff';
import type { Change, Policy } from '../src/types';

const withExclude = (rule: string, globs: string[]): Policy => {
  const p = defaultPolicy();
  return { ...p, rules: { ...p.rules, [rule]: { ...p.rules[rule], exclude: globs } } };
};

const castIn = (path: string) =>
  parseDiff(`diff --git a/${path} b/${path}
index 1..2 100644
--- a/${path}
+++ b/${path}
@@ -1,0 +1,1 @@
+const x = (window as any).foo;`);

const skipIn = (path: string) =>
  parseDiff(`diff --git a/${path} b/${path}
index 1..2 100644
--- a/${path}
+++ b/${path}
@@ -1,0 +1,1 @@
+it.skip('x', () => {});`);

describe('per-rule exclude', () => {
  const p = withExclude('ts-any-cast', ['**/*.{test,spec}.*', '**/*.test-d.ts']);

  it('drops the excluded rule on matching paths', () => {
    expect(evaluate(castIn('src/a.test-d.ts'), p).filter((f) => f.rule === 'ts-any-cast')).toHaveLength(0);
  });

  it('keeps the excluded rule on non-matching paths', () => {
    expect(evaluate(castIn('src/app.ts'), p).filter((f) => f.rule === 'ts-any-cast')).toHaveLength(1);
  });

  it('leaves every OTHER rule untouched on the excluded path (the global-ignore trap)', () => {
    // test-skip must still fire on a test file even while ts-any-cast is scoped off it.
    expect(evaluate(skipIn('src/a.spec.ts'), p).filter((f) => f.rule === 'test-skip')).toHaveLength(1);
  });

  it('never excludes findings on the policy file itself', () => {
    const gutted: Change[] = [
      {
        kind: 'file',
        path: '.tamperward.yml',
        oldPath: null,
        op: 'modify',
        before: 'ignore: []\n',
        after: "ignore: ['**']\n",
        binary: false,
        hunks: [],
      },
    ];
    const selfBlind = withExclude('hook-tampering', ['**']);
    const control = evaluate(gutted, defaultPolicy()).filter((f) => f.rule === 'hook-tampering');
    expect(control.length).toBeGreaterThan(0); // premise: the weakening is detected at all
    expect(evaluate(gutted, selfBlind).filter((f) => f.rule === 'hook-tampering').length).toBe(control.length);
  });
});

describe('exclude additions are policy weakening', () => {
  const before = "rules:\n  ts-any-cast: { severity: block }\n";
  const after = "rules:\n  ts-any-cast: { severity: block, exclude: ['src/**'] }\n";

  it('flags an added exclude glob', () => {
    expect((policyWeakening(before, after) ?? []).some((r) => /exclude.*src\/\*\*/.test(r))).toBe(true);
  });

  it('does not flag a removed exclude glob (strengthening)', () => {
    expect((policyWeakening(after, before) ?? []).some((r) => /exclude/.test(r))).toBe(false);
  });
});
