import { describe, it, expect } from 'vitest';
import { testDeletion } from '../src/detectors/test-deletion';
import { protectedCategory, defaultPolicy } from '../src/policy';
import type { FileChange } from '../src/types';

const P = defaultPolicy();
const del = (path: string, before: string): FileChange => ({ kind: 'file', path, oldPath: null, op: 'delete', before, after: null, hunks: [], binary: false });
const add = (path: string, after: string): FileChange => ({ kind: 'file', path, oldPath: null, op: 'add', before: null, after, hunks: [], binary: false });
const SPEC = `import { test, expect } from "vitest";
test("adds two numbers correctly together", () => {
  const result = addNumbers(2, 3);
  expect(result).toStrictEqual(5);
});
test("rejects a negative input value cleanly", () => {
  expect(() => addNumbers(-1, 2)).toThrowError("negative");
});`;

describe('glob fix — test extensions beyond .test.ts', () => {
  it.each(['a.test.tsx', 'a.spec.tsx', 'a.test.mts', 'a.test.jsx', 'pkg/x.spec.cts'])(
    'classifies %s as a test file',
    (p) => expect(protectedCategory(p, P)).toBe('tests'),
  );
});

describe('relocation fix — a moved test does not fire test-deletion', () => {
  it('SUPPRESSES when the deleted test reappears (same content) in an added test file', () => {
    const changes = [del('src/old/calc.spec.ts', SPEC), add('packages/core/test/calc.spec.ts', SPEC)];
    expect(testDeletion.run(changes, P)).toHaveLength(0); // relocation, not a tamper
  });

  it('handles a cross-extension move (.spec.ts -> .test.tsx)', () => {
    const changes = [del('src/calc.spec.ts', SPEC), add('runtime/calc.test.tsx', SPEC)];
    expect(testDeletion.run(changes, P)).toHaveLength(0);
  });

  it('STILL FIRES on a genuine deletion (no re-add)', () => {
    expect(testDeletion.run([del('src/calc.spec.ts', SPEC)], P)).toHaveLength(1);
  });

  it('STILL FIRES on the empty-stub dodge (re-add shares no test body)', () => {
    const stub = 'import { test } from "vitest";\n// TODO: restore tests\n';
    expect(testDeletion.run([del('src/calc.spec.ts', SPEC), add('src/calc.spec.ts', stub)], P)).toHaveLength(1);
  });

  it('STILL FIRES on a move that drops test blocks (gutted in transit)', () => {
    const gutted = `import { test, expect } from "vitest";
test("adds two numbers correctly together", () => {
  const result = addNumbers(2, 3);
  expect(result).toStrictEqual(5);
});`; // one of two blocks kept
    expect(testDeletion.run([del('src/calc.spec.ts', SPEC), add('pkg/calc.spec.ts', gutted)], P)).toHaveLength(1);
  });
});
