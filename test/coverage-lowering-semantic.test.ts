import { describe, it, expect } from 'vitest';
import { coverageLowering } from '../src/detectors/coverage-lowering';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy } from '../src/policy';
import type { FileChange } from '../src/types';

const P = defaultPolicy();
// 'jest.config.js' matches the baseline protected.config glob **/jest.config.*
const cfg = (body: string) =>
  `module.exports = {\n  coverageThreshold: {\n${body}  },\n};\n`;
const GLOBAL80 = cfg('    global: { lines: 80 },\n');

const run = (before: string, after: string) => {
  const c: FileChange = { kind: 'file', path: 'jest.config.js', oldPath: null, op: 'modify', before, after, hunks: [], binary: false };
  return coverageLowering.run([c], P);
};

describe('coverage-lowering — semantic config-diff (closes the open config surface)', () => {
  it('blocks lowering the global threshold (closed/numeric dim)', () =>
    expect(run(GLOBAL80, cfg('    global: { lines: 0 },\n')).length).toBeGreaterThanOrEqual(1));

  it('blocks a per-path override BELOW global (the open dim — the live leak)', () => {
    const after = cfg("    global: { lines: 80 },\n    './src/discount.js': { lines: 55 },\n");
    const f = run(GLOBAL80, after);
    expect(f.length).toBeGreaterThanOrEqual(1);
    expect(f[0].message).toMatch(/discount\.js/);
  });

  it('blocks deleting the coverage gate entirely', () => {
    const c: FileChange = { kind: 'file', path: 'jest.config.js', oldPath: null, op: 'delete', before: GLOBAL80, after: null, hunks: [], binary: false };
    expect(coverageLowering.run([c], P).length).toBeGreaterThanOrEqual(1);
  });

  it('ALLOWS raising the global threshold (no false positive)', () =>
    expect(run(GLOBAL80, cfg('    global: { lines: 90 },\n'))).toHaveLength(0));

  it('ALLOWS a per-path override ABOVE global (stricter — not a weakening)', () =>
    expect(run(GLOBAL80, cfg("    global: { lines: 80 },\n    './src/discount.js': { lines: 95 },\n"))).toHaveLength(0));

  it('ALLOWS an unrelated config edit that does not touch thresholds', () =>
    expect(run(GLOBAL80, GLOBAL80.replace('coverageThreshold', 'coverageThreshold /* note */'))).toHaveLength(0));

  it('diff-only fallback still catches a same-key numeric decrease (no before/after content)', () => {
    const d = parseDiff(
      'diff --git a/jest.config.js b/jest.config.js\nindex 1..2 100644\n--- a/jest.config.js\n+++ b/jest.config.js\n@@ -1,1 +1,1 @@\n-    global: { lines: 80 },\n+    global: { lines: 30 },',
    );
    expect(coverageLowering.run(d, P).length).toBeGreaterThanOrEqual(1);
  });
});
