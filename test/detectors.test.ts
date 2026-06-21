import { describe, it, expect } from 'vitest';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy } from '../src/policy';
import { noVerify } from '../src/detectors/no-verify';
import { tsAnyCast } from '../src/detectors/ts-any-cast';
import { lintSuppression } from '../src/detectors/lint-suppression';
import { testSkip } from '../src/detectors/test-skip';
import { coverageLowering } from '../src/detectors/coverage-lowering';
import { ciTampering } from '../src/detectors/ci-tampering';
import { hookTampering } from '../src/detectors/hook-tampering';
import { testDeletion, countTestBlocks } from '../src/detectors/test-deletion';
import type { Change, CommandChange, FileChange } from '../src/types';

const P = defaultPolicy();
const cmd = (raw: string): CommandChange => ({ kind: 'command', raw, argv: raw.split(/\s+/) });
const fromDiff = (diff: string): Change[] => parseDiff(diff);
const fileLit = (partial: Partial<FileChange>): FileChange => ({
  kind: 'file', path: '', oldPath: null, op: 'modify',
  before: null, after: null, binary: false, hunks: [], ...partial,
});
const run = (d: { run: (c: Change[], p: typeof P) => unknown[] }, c: Change[]) => d.run(c, P);

// ── #9 no-verify ───────────────────────────────────────────────────────────
describe('no-verify', () => {
  it.each([
    'git commit --no-verify -m "x"',
    'git push --no-verify',
    'git commit -n',
    'git commit -nm "x"',
    'HUSKY=0 git commit -m x',
    'HUSKY_SKIP_HOOKS=1 git commit -m x',
  ])('flags: %s', (c) => {
    const f = run(noVerify, [cmd(c)]);
    expect(f).toHaveLength(1);
    expect((f[0] as { severity: string }).severity).toBe('block');
  });

  it.each([
    'git push -n', // -n on push is --dry-run, NOT --no-verify
    'git commit -m "fix"',
    'echo -n hello',
    'npm test',
  ])('does not flag: %s', (c) => {
    expect(run(noVerify, [cmd(c)])).toHaveLength(0);
  });
});

// ── #4 ts-any-cast ─────────────────────────────────────────────────────────
describe('ts-any-cast', () => {
  const mk = (added: string) =>
    fromDiff(`diff --git a/src/x.ts b/src/x.ts
index 1..2 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,0 +1,1 @@
+${added}`);

  it.each([
    'const y = z as any;',
    'let v: any = 1;',
    'const a = b as unknown as Foo;',
    '// @ts-ignore',
    '// @ts-expect-error',
  ])('flags: %s', (line) => {
    expect(run(tsAnyCast, mk(line))).toHaveLength(1);
  });

  it('does not flag a word that merely starts with any', () => {
    expect(run(tsAnyCast, mk('let v: anything;'))).toHaveLength(0);
  });
});

// ── #5 lint-suppression ────────────────────────────────────────────────────
describe('lint-suppression', () => {
  const mk = (added: string) =>
    fromDiff(`diff --git a/src/x.ts b/src/x.ts
index 1..2 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,0 +1,1 @@
+${added}`);

  it.each([
    '// eslint-disable-next-line no-console',
    '/* eslint-disable */',
    '// prettier-ignore',
  ])('flags: %s', (line) => {
    expect(run(lintSuppression, mk(line))).toHaveLength(1);
  });

  it('does not flag an ordinary comment', () => {
    expect(run(lintSuppression, mk('// compute the total'))).toHaveLength(0);
  });
});

// ── #2 test-skip ───────────────────────────────────────────────────────────
describe('test-skip', () => {
  const inSpec = (added: string) =>
    fromDiff(`diff --git a/src/a.spec.ts b/src/a.spec.ts
index 1..2 100644
--- a/src/a.spec.ts
+++ b/src/a.spec.ts
@@ -1,0 +1,1 @@
+${added}`);
  const inApp = (added: string) =>
    fromDiff(`diff --git a/src/app.ts b/src/app.ts
index 1..2 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,0 +1,1 @@
+${added}`);

  it.each([
    "it.skip('x', () => {});",
    "describe.only('x', () => {});",
    "xit('x', () => {});",
    "fit('x', () => {});",
  ])('flags in a spec: %s', (line) => {
    expect(run(testSkip, inSpec(line))).toHaveLength(1);
  });

  it('does not flag a normal test', () => {
    expect(run(testSkip, inSpec("it('x', () => {});"))).toHaveLength(0);
  });

  it('is scoped to test files (no fire in app code)', () => {
    expect(run(testSkip, inApp('foo.only(bar);'))).toHaveLength(0);
  });
});

// ── #6 coverage-lowering ───────────────────────────────────────────────────
describe('coverage-lowering', () => {
  it('flags a lowered threshold', () => {
    const d = fromDiff(`diff --git a/jest.config.ts b/jest.config.ts
index 1..2 100644
--- a/jest.config.ts
+++ b/jest.config.ts
@@ -3,1 +3,1 @@ export default {
-      branches: 80,
+      branches: 50,`);
    const f = run(coverageLowering, d) as Array<{ message: string }>;
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain('80 → 50');
  });

  it('does NOT flag a raised threshold', () => {
    const d = fromDiff(`diff --git a/jest.config.ts b/jest.config.ts
index 1..2 100644
--- a/jest.config.ts
+++ b/jest.config.ts
@@ -3,1 +3,1 @@ export default {
-      branches: 80,
+      branches: 90,`);
    expect(run(coverageLowering, d)).toHaveLength(0);
  });

  it('flags --coverage stripped from a script', () => {
    const d = fromDiff(`diff --git a/package.json b/package.json
index 1..2 100644
--- a/package.json
+++ b/package.json
@@ -5,1 +5,1 @@
-    "test": "jest --coverage"
+    "test": "jest"`);
    expect(run(coverageLowering, d)).toHaveLength(1);
  });

  it('flags --passWithNoTests added', () => {
    const d = fromDiff(`diff --git a/package.json b/package.json
index 1..2 100644
--- a/package.json
+++ b/package.json
@@ -5,1 +5,1 @@
-    "test": "jest"
+    "test": "jest --passWithNoTests"`);
    expect(run(coverageLowering, d)).toHaveLength(1);
  });
});

// ── #7 ci-tampering ────────────────────────────────────────────────────────
describe('ci-tampering', () => {
  it('flags continue-on-error: true', () => {
    const d = fromDiff(`diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 1..2 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -10,1 +10,2 @@ jobs:
       - run: npm test
+        continue-on-error: true`);
    expect(run(ciTampering, d)).toHaveLength(1);
  });

  it('flags removal of a check step', () => {
    const d = fromDiff(`diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 1..2 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -10,2 +10,1 @@ jobs:
       - run: npm run build
-      - run: npm test`);
    expect(run(ciTampering, d)).toHaveLength(1);
  });

  it('does not flag removing a non-check step', () => {
    const d = fromDiff(`diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 1..2 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -10,2 +10,1 @@ jobs:
       - run: npm test
-      - run: npm run build`);
    expect(run(ciTampering, d)).toHaveLength(0);
  });
});

// ── #8 hook-tampering ──────────────────────────────────────────────────────
describe('hook-tampering', () => {
  it('flags deleting a husky hook', () => {
    const d = fromDiff(`diff --git a/.husky/pre-commit b/.husky/pre-commit
deleted file mode 100755
index 1..0
--- a/.husky/pre-commit
+++ /dev/null
@@ -1,1 +0,0 @@
-npx holdfast check --staged`);
    expect(run(hookTampering, d)).toHaveLength(1);
  });

  it('flags lowering a severity in the policy', () => {
    const d = fromDiff(`diff --git a/.holdfast.yml b/.holdfast.yml
index 1..2 100644
--- a/.holdfast.yml
+++ b/.holdfast.yml
@@ -5,1 +5,1 @@ rules:
-    severity: block
+    severity: warn`);
    expect(run(hookTampering, d)).toHaveLength(1);
  });

  it.each(['chmod -x .husky/pre-commit', 'rm .husky/pre-commit'])('flags via shell: %s', (c) => {
    expect(run(hookTampering, [cmd(c)])).toHaveLength(1);
  });
});

// ── #1 test-deletion ───────────────────────────────────────────────────────
describe('test-deletion', () => {
  it('counts test blocks via the AST, not a line regex', () => {
    // `it(` in a comment and `test(` in a string must NOT count
    expect(countTestBlocks(`// it('old') used to be here\nconst s = "test(";`)).toBe(0);
    expect(countTestBlocks(`it('a', () => {}); test('b', () => {});`)).toBe(2);
    expect(countTestBlocks(`it.skip('a', () => {}); it.each([1])('b', () => {});`)).toBe(2);
  });

  it('flags a deleted spec file', () => {
    const d = fromDiff(`diff --git a/src/a.spec.ts b/src/a.spec.ts
deleted file mode 100644
index 1..0
--- a/src/a.spec.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-it('x', () => {});`);
    expect(run(testDeletion, d)).toHaveLength(1);
  });

  it('flags a spec renamed OUT of the test glob', () => {
    const d = fromDiff(`diff --git a/src/a.spec.ts b/src/a.spec.bak
similarity index 100%
rename from src/a.spec.ts
rename to src/a.spec.bak`);
    const f = run(testDeletion, d) as Array<{ message: string }>;
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain('renamed out');
  });

  it('flags test blocks removed inside a modified spec', () => {
    const c = fileLit({
      path: 'src/a.spec.ts',
      op: 'modify',
      before: `it('a', () => {}); it('b', () => {});`,
      after: `it('a', () => {});`,
    });
    const f = run(testDeletion, [c]) as Array<{ message: string }>;
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain('2 → 1');
  });

  it('does NOT flag a spec that gained a test', () => {
    const c = fileLit({
      path: 'src/a.spec.ts',
      op: 'modify',
      before: `it('a', () => {});`,
      after: `it('a', () => {}); it('b', () => {});`,
    });
    expect(run(testDeletion, [c])).toHaveLength(0);
  });

  it.each([
    'rm src/a.spec.ts',
    'sed -i "/expect/d" src/a.spec.ts',
    'mv src/a.spec.ts src/a.spec.bak',
  ])('flags removal via shell: %s', (c) => {
    expect(run(testDeletion, [cmd(c)])).toHaveLength(1);
  });

  it.each(['cat src/a.spec.ts', 'rm src/app.ts'])('does not flag: %s', (c) => {
    expect(run(testDeletion, [cmd(c)])).toHaveLength(0);
  });
});
