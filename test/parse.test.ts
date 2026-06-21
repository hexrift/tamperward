import { describe, it, expect } from 'vitest';
import { parseDiff } from '../src/diff/parse';
import { addedLines, removedLines } from '../src/diff/select';
import type { FileChange } from '../src/types';

const file = (c: ReturnType<typeof parseDiff>[number]) => c as FileChange;

describe('parseDiff — file op classification', () => {
  it('classifies a plain modification', () => {
    const diff = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,6 +10,6 @@ export function login(u) {
   const token = sign(u);
   if (!token) {
-    throw new Error('no token');
+    throw new Error('missing token');
   }
   return token;
 }`;
    const [c] = parseDiff(diff).map(file);
    expect(c.op).toBe('modify');
    expect(c.path).toBe('src/auth.ts');
    expect(c.oldPath).toBeNull();
    expect(c.binary).toBe(false);
  });

  it('classifies a new file (add) with no before side', () => {
    const diff = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;`;
    const [c] = parseDiff(diff).map(file);
    expect(c.op).toBe('add');
    expect(c.path).toBe('src/new.ts');
    expect(addedLines(c).map((l) => l.newLine)).toEqual([1, 2]);
  });

  it('classifies a deletion with no after side', () => {
    const diff = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const a = 1;
-export const b = 2;`;
    const [c] = parseDiff(diff).map(file);
    expect(c.op).toBe('delete');
    expect(c.path).toBe('src/old.ts');
    expect(removedLines(c).map((l) => l.oldLine)).toEqual([1, 2]);
  });
});

describe('parseDiff — renames (the load-bearing case for test-deletion)', () => {
  it('models a pure rename as ONE change carrying oldPath, no hunks', () => {
    const diff = `diff --git a/src/a.spec.ts b/src/a.spec.bak
similarity index 100%
rename from src/a.spec.ts
rename to src/a.spec.bak`;
    const changes = parseDiff(diff).map(file);
    expect(changes).toHaveLength(1); // not add + delete
    const [c] = changes;
    expect(c.op).toBe('rename');
    expect(c.oldPath).toBe('src/a.spec.ts'); // the path test-deletion needs
    expect(c.path).toBe('src/a.spec.bak');
    expect(c.hunks).toHaveLength(0);
  });

  it('models a rename + edit with both paths and the hunk', () => {
    const diff = `diff --git a/src/util.ts b/src/helpers.ts
similarity index 80%
rename from src/util.ts
rename to src/helpers.ts
index 5555555..6666666 100644
--- a/src/util.ts
+++ b/src/helpers.ts
@@ -1,3 +1,3 @@
 export function f() {
-  return 1;
+  return 2;
 }`;
    const [c] = parseDiff(diff).map(file);
    expect(c.op).toBe('rename');
    expect(c.oldPath).toBe('src/util.ts');
    expect(c.path).toBe('src/helpers.ts');
    expect(addedLines(c)).toHaveLength(1);
    expect(addedLines(c)[0].newLine).toBe(2);
  });
});

describe('parseDiff — binary and opacity', () => {
  it('flags a binary file and leaves hunks empty', () => {
    const diff = `diff --git a/logo.png b/logo.png
index 7777777..8888888 100644
Binary files a/logo.png and b/logo.png differ`;
    const [c] = parseDiff(diff).map(file);
    expect(c.binary).toBe(true);
    expect(c.op).toBe('modify');
    expect(c.path).toBe('logo.png');
    expect(c.hunks).toHaveLength(0);
  });
});

describe('parseDiff — line numbers (every Finding.line inherits these)', () => {
  it('computes correct new-file line numbers ACROSS multiple hunks', () => {
    const diff = `diff --git a/src/multi.ts b/src/multi.ts
index aaaaaaa..bbbbbbb 100644
--- a/src/multi.ts
+++ b/src/multi.ts
@@ -1,3 +1,4 @@
 line1
+inserted at 2
 line2
 line3
@@ -20,3 +21,3 @@
 line20
-line21old
+line21new
 line22`;
    const [c] = parseDiff(diff).map(file);
    expect(c.hunks).toHaveLength(2);

    const added = addedLines(c);
    expect(added).toHaveLength(2);
    // first hunk inserts a line at new-line 2
    expect(added[0].content).toBe('inserted at 2');
    expect(added[0].newLine).toBe(2);
    // second hunk's replacement lands at new-line 22 — offset by the earlier insertion
    expect(added[1].content).toBe('line21new');
    expect(added[1].newLine).toBe(22);

    // the removed line is numbered in the BEFORE file, not the after
    const removed = removedLines(c);
    expect(removed).toHaveLength(1);
    expect(removed[0].content).toBe('line21old');
    expect(removed[0].oldLine).toBe(21);
    expect(removed[0].newLine).toBeNull();
  });

  it('handles a hunk header with omitted counts (defaults to 1)', () => {
    const diff = `diff --git a/x.ts b/x.ts
index ccc..ddd 100644
--- a/x.ts
+++ b/x.ts
@@ -5 +5 @@
-old
+new`;
    const [c] = parseDiff(diff).map(file);
    const [h] = c.hunks;
    expect(h.oldStart).toBe(5);
    expect(h.oldLines).toBe(1);
    expect(h.newStart).toBe(5);
    expect(h.newLines).toBe(1);
    expect(addedLines(c)[0].newLine).toBe(5);
    expect(removedLines(c)[0].oldLine).toBe(5);
  });

  it('ignores the "No newline at end of file" marker', () => {
    const diff = `diff --git a/y.ts b/y.ts
index eee..fff 100644
--- a/y.ts
+++ b/y.ts
@@ -1 +1 @@
-a
\\ No newline at end of file
+b
\\ No newline at end of file`;
    const [c] = parseDiff(diff).map(file);
    expect(addedLines(c).map((l) => l.content)).toEqual(['b']);
    expect(removedLines(c).map((l) => l.content)).toEqual(['a']);
  });
});

describe('parseDiff — multiple files in one diff', () => {
  it('splits each file into its own change', () => {
    const diff = `diff --git a/src/keep.ts b/src/keep.ts
index 111..222 100644
--- a/src/keep.ts
+++ b/src/keep.ts
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
diff --git a/src/added.ts b/src/added.ts
new file mode 100644
index 0000000..333
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1,1 @@
+const b = 3;`;
    const changes = parseDiff(diff).map(file);
    expect(changes.map((c) => c.path)).toEqual(['src/keep.ts', 'src/added.ts']);
    expect(changes.map((c) => c.op)).toEqual(['modify', 'add']);
  });
});
