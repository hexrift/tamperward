// Two ways the git views (and the PreToolUse hook) were blinded by the shape of the
// diff rather than by its content. Both reproduced against the built CLI before the fix.
//
// A · git's binary heuristic. A committed `.gitattributes` line (`x.spec.ts -diff` or
//     `x.spec.ts binary`) or a single NUL byte in the file made every `git diff` print
//     "Binary files a/x and b/x differ" instead of hunks; the parser set `binary`, the
//     builder skipped before/after on that flag, and every content detector went silent
//     — range, staged, worktree, and the hook's `git diff --no-index` alike.
//     Fix: `--text` on every diff Tamperward runs, and enrichment regardless of the flag.
//
// B · a path containing a space. git writes `--- a/my tests/b.test.ts<TAB>`; the parser
//     kept the tab, so `path` ended in `\t` and matched no protected glob. Deleting or
//     `.skip`-ing a test under such a directory was invisible to every git view.
//     Fix: strip the trailing tab from the unquoted `---`/`+++` tokens.
//
// Mutation-checked: each exploit test below fails with its fix reverted
// (harness/mutation-check.sh), and the controls stay green.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDiff } from '../src/diff/parse';
import { diffRange, diffStaged, diffWorktree } from '../src/git/build';
import { changesFromClaudeHook } from '../src/adapters/claude/changes';
import { preToolUseVerdict } from '../src/cli/hook';
import { evaluate, hasBlocking } from '../src/engine';
import { defaultPolicy } from '../src/policy';
import type { Change, FileChange } from '../src/types';

const P = defaultPolicy();
const SPEC3 = "it('a', () => {});\nit('b', () => {});\nit('c', () => {});\n";
const SPEC1 = "it('a', () => {});\n";
const GUT_RULES = ['test-deletion', 'test-content-removal'];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): { cwd: string; git: (...a: string[]) => string } {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-text-'));
  dirs.push(cwd);
  const git = (...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  return { cwd, git };
}

function write(cwd: string, rel: string, content: string | Buffer): void {
  mkdirSync(join(cwd, rel, '..'), { recursive: true });
  writeFileSync(join(cwd, rel), content);
}

/** Findings for the staged view, then (after committing) for the range view. */
function stagedThenRange(cwd: string, git: (...a: string[]) => string) {
  git('add', '-A');
  const staged = evaluate(diffStaged({ cwd }), P, undefined, 'staged');
  const stagedChanges = diffStaged({ cwd });
  git('commit', '-qm', 'change');
  const range = evaluate(diffRange('HEAD~1', 'HEAD', { cwd }), P, undefined, 'range');
  return { staged, range, stagedChanges };
}

const rules = (f: ReturnType<typeof evaluate>) => f.map((x) => x.rule);
const fileChanges = (cs: Change[]) => cs.filter((c): c is FileChange => c.kind === 'file');

// ── A · binary blinding ───────────────────────────────────────────────────────
describe('A · a "binary" spec still reaches every content detector', () => {
  it.each(['-diff', 'binary'])('gitattribute `%s` on the spec does not hide gutting it (staged + range)', (attr) => {
    const { cwd, git } = repo();
    write(cwd, 'src/x.spec.ts', SPEC3);
    write(cwd, '.gitattributes', `src/x.spec.ts ${attr}\n`);
    git('add', '-A');
    git('commit', '-qm', 'base');

    write(cwd, 'src/x.spec.ts', SPEC1);
    const { staged, range, stagedChanges } = stagedThenRange(cwd, git);

    // the parser saw hunks, not "Binary files differ"
    const spec = fileChanges(stagedChanges).find((c) => c.path === 'src/x.spec.ts')!;
    expect(spec.hunks.length).toBeGreaterThan(0);
    expect(spec.before).toBe(SPEC3);
    expect(spec.after).toBe(SPEC1);

    expect(hasBlocking(staged)).toBe(true);
    expect(rules(staged).some((r) => GUT_RULES.includes(r))).toBe(true);
    expect(hasBlocking(range)).toBe(true);
    expect(rules(range).some((r) => GUT_RULES.includes(r))).toBe(true);
  });

  it('a NUL byte appended to the spec does not hide gutting it (staged + range + worktree)', () => {
    const { cwd, git } = repo();
    write(cwd, 'src/x.spec.ts', SPEC3);
    git('add', '-A');
    git('commit', '-qm', 'base');

    const gutted = SPEC1 + '// \0\n';
    write(cwd, 'src/x.spec.ts', gutted);
    const worktree = evaluate(diffWorktree({ cwd }), P, undefined, 'worktree');
    expect(hasBlocking(worktree)).toBe(true);
    expect(rules(worktree).some((r) => GUT_RULES.includes(r))).toBe(true);

    const { staged, range, stagedChanges } = stagedThenRange(cwd, git);
    const spec = fileChanges(stagedChanges).find((c) => c.path === 'src/x.spec.ts')!;
    expect(spec.hunks.length).toBeGreaterThan(0);
    expect(spec.after).toBe(gutted);
    expect(hasBlocking(staged)).toBe(true);
    expect(rules(staged).some((r) => GUT_RULES.includes(r))).toBe(true);
    expect(hasBlocking(range)).toBe(true);
    expect(rules(range).some((r) => GUT_RULES.includes(r))).toBe(true);
  });

  it('a NUL byte in the file does not hide a .skip from the staged view (line-based rule)', () => {
    const { cwd, git } = repo();
    write(cwd, 'src/x.spec.ts', SPEC3);
    git('add', '-A');
    git('commit', '-qm', 'base');

    write(cwd, 'src/x.spec.ts', SPEC3.replace("it('a'", "it.skip('a'") + '// \0\n');
    const { staged, range } = stagedThenRange(cwd, git);
    expect(rules(staged)).toContain('test-skip');
    expect(rules(range)).toContain('test-skip');
  });

  it('a genuinely binary file is no longer opaque: hunks and content are loaded', () => {
    const { cwd, git } = repo();
    const { stagedChanges } = goldenUpdate(cwd, git);
    const gold = fileChanges(stagedChanges).find((c) => c.path === 'golden/render.png')!;
    expect(gold.hunks.length).toBeGreaterThan(0);
    expect(gold.before).not.toBeNull();
    expect(gold.after).not.toBeNull();
  });

  it('hook adapter: a Write adding it.skip plus a NUL byte still carries the hunk and is denied', () => {
    const { cwd, git } = repo();
    write(cwd, 'src/x.spec.ts', SPEC3);
    git('add', '-A');
    git('commit', '-qm', 'base');

    const input = {
      tool_name: 'Write',
      cwd,
      tool_input: {
        file_path: join(cwd, 'src/x.spec.ts'),
        content: SPEC3.replace("it('a'", "it.skip('a'") + '// \0\n',
      },
    };
    const changes = changesFromClaudeHook(input, cwd);
    expect(fileChanges(changes)[0].hunks.length).toBeGreaterThan(0);
    const f = evaluate(changes, P);
    expect(rules(f)).toContain('test-skip');

    const verdict = preToolUseVerdict(input);
    expect(verdict.exitCode).toBe(0);
    expect(verdict.stdout).toContain('"deny"');
    expect(verdict.stdout).toContain('test-skip');
  });
});

// ── B · a path with a space ───────────────────────────────────────────────────
describe('B · a test under a directory with a space is seen by every git view', () => {
  it('parseDiff strips the trailing tab git puts after an unquoted path with a space', () => {
    const diff = `diff --git a/my tests/b.test.ts b/my tests/b.test.ts
deleted file mode 100644
index 0f7623e..0000000
--- a/my tests/b.test.ts\t
+++ /dev/null
@@ -1 +0,0 @@
-it('a', () => {});`;
    const [c] = parseDiff(diff) as FileChange[];
    expect(c.op).toBe('delete');
    expect(c.path).toBe('my tests/b.test.ts');

    const mod = `diff --git a/my tests/b.test.ts b/my tests/b.test.ts
index 0f7623e..1111111 100644
--- a/my tests/b.test.ts\t
+++ b/my tests/b.test.ts\t
@@ -1 +1 @@
-it('a', () => {});
+it.skip('a', () => {});`;
    const [m] = parseDiff(mod) as FileChange[];
    expect(m.path).toBe('my tests/b.test.ts');
    expect(m.hunks[0].lines.map((l) => l.type)).toEqual(['del', 'add']);
  });

  it('parseDiff resolves rename and header paths with spaces to the same clean path', () => {
    const diff = `diff --git a/my tests/b.test.ts b/my tests/b.test.bak
similarity index 100%
rename from my tests/b.test.ts
rename to my tests/b.test.bak`;
    const [c] = parseDiff(diff) as FileChange[];
    expect(c.op).toBe('rename');
    expect(c.oldPath).toBe('my tests/b.test.ts');
    expect(c.path).toBe('my tests/b.test.bak');

    // header-only fallback (no ---/+++ and no rename lines): a directory literally
    // named "x b" used to be split at the wrong ` b/`.
    const hdr = `diff --git a/x b/y.test.ts b/x b/y.test.ts
index 1111111..2222222 100644`;
    const [h] = parseDiff(hdr) as FileChange[];
    expect(h.path).toBe('x b/y.test.ts');
  });

  it('parseDiff decodes a quoted (core.quotePath) non-ASCII path on every header line', () => {
    const diff = `diff --git "a/src/caf\\303\\251.spec.ts" "b/src/caf\\303\\251.spec.ts"
index 587be6b..975fbec 100644
--- "a/src/caf\\303\\251.spec.ts"
+++ "b/src/caf\\303\\251.spec.ts"
@@ -1 +1 @@
-it('a', () => {});
+it.skip('a', () => {});`;
    const [c] = parseDiff(diff) as FileChange[];
    expect(c.path).toBe('src/café.spec.ts');
  });

  it('deleting `my tests/b.test.ts` is test-deletion in the staged and range views', () => {
    const { cwd, git } = repo();
    write(cwd, 'my tests/b.test.ts', SPEC1);
    git('add', '-A');
    git('commit', '-qm', 'base');

    rmSync(join(cwd, 'my tests/b.test.ts'));
    const { staged, range, stagedChanges } = stagedThenRange(cwd, git);
    expect(fileChanges(stagedChanges).map((c) => c.path)).toEqual(['my tests/b.test.ts']);
    expect(rules(staged)).toContain('test-deletion');
    expect(rules(range)).toContain('test-deletion');
  });

  it('a .skip edit to `my tests/b.test.ts` is test-skip in the staged and range views', () => {
    const { cwd, git } = repo();
    write(cwd, 'my tests/b.test.ts', SPEC1);
    git('add', '-A');
    git('commit', '-qm', 'base');

    write(cwd, 'my tests/b.test.ts', "it.skip('a', () => {});\n");
    const { staged, range, stagedChanges } = stagedThenRange(cwd, git);
    const c = fileChanges(stagedChanges)[0];
    expect(c.path).toBe('my tests/b.test.ts');
    expect(c.after).toBe("it.skip('a', () => {});\n");
    expect(rules(staged)).toContain('test-skip');
    expect(rules(range)).toContain('test-skip');
  });
});

/** PNG signature followed by pseudo-random bytes: NULs, high bytes, newlines — the shape
 *  git calls binary. Commits one, then stages a re-rendered one plus the source change
 *  that motivates it (the legitimate golden-update workflow). */
function goldenUpdate(cwd: string, git: (...a: string[]) => string) {
  const png = (seed: number) => {
    const b = Buffer.alloc(4096);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
    let s = seed;
    for (let i = 8; i < b.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      b[i] = s & 0xff;
    }
    return b;
  };
  write(cwd, 'golden/render.png', png(1));
  write(cwd, 'src/render.ts', 'export const w = 100;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  write(cwd, 'golden/render.png', png(2));
  write(cwd, 'src/render.ts', 'export const w = 120;\n');
  return stagedThenRange(cwd, git);
}

// ── controls ──────────────────────────────────────────────────────────────────
describe('controls · the honest paths stay exactly as they were', () => {
  it('a plain gut is still caught and a plain honest edit is still clean', () => {
    const { cwd, git } = repo();
    write(cwd, 'src/x.spec.ts', SPEC3);
    write(cwd, 'src/x.ts', 'export const x = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'base');

    write(cwd, 'src/x.spec.ts', SPEC1);
    const gut = stagedThenRange(cwd, git);
    expect(hasBlocking(gut.staged)).toBe(true);
    expect(hasBlocking(gut.range)).toBe(true);

    write(cwd, 'src/x.ts', 'export const x = 2;\n');
    write(cwd, 'src/x.spec.ts', SPEC1 + "it('d', () => {});\n");
    const honest = stagedThenRange(cwd, git);
    expect(honest.staged).toEqual([]);
    expect(honest.range).toEqual([]);
  });

  it('a modified binary golden file produces no blocking finding', () => {
    const { cwd, git } = repo();
    const { staged, range, stagedChanges } = goldenUpdate(cwd, git);
    expect(fileChanges(stagedChanges).some((c) => c.path === 'golden/render.png')).toBe(true);
    expect(hasBlocking(staged)).toBe(false);
    expect(hasBlocking(range)).toBe(false);
    // the snapshot-rewrite warn it always carried is still there — nothing got louder
    expect(rules(staged)).toContain('snapshot-rewrite');
    expect(rules(staged).filter((r) => r !== 'snapshot-rewrite')).toEqual([]);
  });
});
