// #705: every git view reads content through one reader, and that reader used to map ANY
// `git show` failure to null — the value it returns for a path that does not exist at that
// revision. `loadPolicyAt(base) ?? defaultPolicy()` then ran the BASELINE in place of a
// committed policy it could not read, and a changed file whose blob could not be read was
// judged as empty content. Absence is now established by the tree (ls-tree / ls-files),
// and a listed blob that cannot be read fails closed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffRange, diffStaged, fileAt } from '../src/git/build';
import { loadPolicyAt } from '../src/policy-load';
import { runCheck } from '../src/cli/check';
import { guardedMain } from '../src/cli/main';

const git = (cwd: string, args: string[], input?: string): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', input }).trim();

/** Remove the loose object behind `spec` (e.g. `<sha>:path`), so the tree still lists the
 *  entry but `git show` can no longer read it. Returns the object id, for restoring. */
function removeObject(repo: string, spec: string): string {
  const sha = git(repo, ['rev-parse', spec]);
  const path = join(repo, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
  chmodSync(path, 0o644);
  rmSync(path);
  return sha;
}
/** Write `content` back as a loose blob; it hashes to the object that was removed. */
function restoreBlob(repo: string, content: string, expectedSha: string): void {
  expect(git(repo, ['hash-object', '-w', '--stdin'], content)).toBe(expectedSha);
}

const STRICT_POLICY = 'version: 1\nrules:\n  snapshot-rewrite:\n    severity: block\n';
const SRC_BEFORE = 'export const a = 1;\n';

describe('#705 a blob the gate cannot read is never taken for an absent one', () => {
  let repo = '';
  let base = '';
  let head = '';
  const stderrOf = (argv: string[]): { code: number; text: string } => {
    let text = '';
    const code = guardedMain(argv, { write: (s: string) => { text += s; return true; } });
    if (typeof code !== 'number') throw new Error('check is synchronous');
    return { code, text };
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'tw-blob-read-'));
    git(repo, ['init', '-q']);
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, '__snapshots__'));
    writeFileSync(join(repo, '.tamperward.yml'), STRICT_POLICY);
    writeFileSync(join(repo, 'src', 'a.ts'), SRC_BEFORE);
    writeFileSync(join(repo, '__snapshots__', 'a.snap'), 'exports[`a`] = `1`;\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base']);
    base = git(repo, ['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(repo, '__snapshots__', 'a.snap'), 'exports[`a`] = `2`;\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'rewrite the snapshot and change the source']);
    head = git(repo, ['rev-parse', 'HEAD']);
  });
  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('the readable strict base policy blocks the snapshot rewrite (exit 1)', () => {
    expect(runCheck({ diff: `${base}...${head}`, cwd: repo, silent: true })).toBe(1);
  });

  it('RED: with the base policy object unreadable, check refuses (exit 2, the object named) instead of running the baseline (exit 0)', () => {
    const sha = removeObject(repo, `${base}:.tamperward.yml`);
    try {
      expect(() => git(repo, ['show', `${base}:.tamperward.yml`])).toThrow(); // git itself cannot read it
      expect(git(repo, ['ls-tree', base, '--', '.tamperward.yml'])).toContain('blob'); // but the tree lists it
      expect(() => loadPolicyAt(base, repo)).toThrow(/cannot read .*:\.tamperward\.yml although the tree lists it as a blob/);
      expect(() => runCheck({ diff: `${base}...${head}`, cwd: repo, silent: true })).toThrow(/refusing to judge it as absent/);
      const r = stderrOf(['check', '--diff', `${base}...${head}`, '--cwd', repo]);
      expect(r.code).toBe(2);
      expect(r.text).toMatch(/^tamperward: cannot read .*\.tamperward\.yml although the tree lists it as a blob/);
    } finally {
      restoreBlob(repo, STRICT_POLICY, sha);
    }
    expect(runCheck({ diff: `${base}...${head}`, cwd: repo, silent: true })).toBe(1); // restored: back to the strict verdict
  });

  it('a changed file whose blob is unreadable already fails closed at `git diff`, which reads it to print the patch', () => {
    const sha = removeObject(repo, `${base}:src/a.ts`);
    try {
      expect(() => diffRange(base, head, { cwd: repo })).toThrow(/unable to read|refusing to judge it as absent/);
      expect(stderrOf(['check', '--diff', `${base}...${head}`, '--cwd', repo]).code).toBe(2);
    } finally {
      restoreBlob(repo, SRC_BEFORE, sha);
    }
    expect(diffRange(base, head, { cwd: repo }).some((c) => c.kind === 'file' && c.path === 'src/a.ts' && c.before === SRC_BEFORE)).toBe(true);
  });

  it('RED: a hidden tracked path (skip-worktree) whose HEAD blob is unreadable is refused by the worktree view, not reconstructed from an absent baseline', () => {
    // The worktree view reconstructs skip-worktree / assume-unchanged paths by hand from
    // fileAt('HEAD', rel) and the disk: with the HEAD blob read as absent, a gutted test file
    // was synthesized as an ADD of the gutted content, and the gutting went unjudged.
    const spec = 'export const t = 1;\ntest("keeps working", () => { expect(t).toBe(1); });\ntest("also this", () => { expect(t).toBe(1); });\n';
    writeFileSync(join(repo, 'src', 'hidden.test.ts'), spec);
    git(repo, ['add', 'src/hidden.test.ts']);
    git(repo, ['commit', '-q', '-m', 'a protected spec']);
    git(repo, ['update-index', '--skip-worktree', 'src/hidden.test.ts']);
    writeFileSync(join(repo, 'src', 'hidden.test.ts'), 'export const t = 1;\n'); // gutted on disk, hidden from git diff
    const readable = runCheck({ worktree: true, cwd: repo, silent: true });
    expect(readable).toBe(1); // with HEAD readable the reconstruction judges the gutting: blocked
    const sha = removeObject(repo, 'HEAD:src/hidden.test.ts');
    try {
      expect(() => runCheck({ worktree: true, cwd: repo, silent: true })).toThrow(/cannot read HEAD:src\/hidden\.test\.ts although the tree lists it as a blob/);
      expect(stderrOf(['check', '--worktree', '--cwd', repo]).code).toBe(2);
    } finally {
      restoreBlob(repo, spec, sha);
      git(repo, ['update-index', '--no-skip-worktree', 'src/hidden.test.ts']);
      git(repo, ['checkout', '-q', '--', 'src/hidden.test.ts']);
    }
  });

  it('a path absent at a revision, or in the index, still reads null', () => {
    expect(fileAt(head, 'src/nope.ts', { cwd: repo })).toBeNull();
    expect(fileAt('', 'src/nope.ts', { cwd: repo })).toBeNull();
    expect(fileAt(head, 'src', { cwd: repo })).not.toBeNull(); // a tree shows as a listing today; unchanged
  });

  it('a policy genuinely absent at the base still loads the baseline: null, not a throw', () => {
    const bare = mkdtempSync(join(tmpdir(), 'tw-blob-nopolicy-'));
    try {
      git(bare, ['init', '-q']);
      writeFileSync(join(bare, 'a.txt'), 'a\n');
      git(bare, ['add', '-A']);
      git(bare, ['commit', '-q', '-m', 'no policy here']);
      const rev = git(bare, ['rev-parse', 'HEAD']);
      expect(fileAt(rev, '.tamperward.yml', { cwd: bare })).toBeNull();
      expect(loadPolicyAt(rev, bare)).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('a gitlink whose commit is not in this object store reads null (a submodule pointer is not content)', () => {
    git(repo, ['update-index', '--add', '--cacheinfo', '160000,0123456789abcdef0123456789abcdef01234567,vendor/sub']);
    git(repo, ['commit', '-q', '-m', 'point at a submodule commit this store does not have']);
    const rev = git(repo, ['rev-parse', 'HEAD']);
    expect(() => git(repo, ['show', `${rev}:vendor/sub`])).toThrow(); // git show fails on the missing commit
    expect(fileAt(rev, 'vendor/sub', { cwd: repo })).toBeNull();
    expect(fileAt('', 'vendor/sub', { cwd: repo })).toBeNull();
  });

  it('a path with glob characters is matched literally: its listed blob is read, and refused when unreadable', () => {
    writeFileSync(join(repo, 'src', 'weird[1].ts'), 'export const w = 1;\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'a file whose name looks like a glob']);
    const rev = git(repo, ['rev-parse', 'HEAD']);
    expect(fileAt(rev, 'src/weird[1].ts', { cwd: repo })).toBe('export const w = 1;\n');
    const sha = removeObject(repo, `${rev}:src/weird[1].ts`);
    try {
      expect(() => fileAt(rev, 'src/weird[1].ts', { cwd: repo })).toThrow(/weird\[1\]\.ts although the tree lists it as a blob/);
    } finally {
      restoreBlob(repo, 'export const w = 1;\n', sha);
    }
  });

  it('the index: a staged blob that cannot be read is refused', () => {
    writeFileSync(join(repo, 'src', 'staged.ts'), 'export const s = 1;\n');
    git(repo, ['add', 'src/staged.ts']);
    expect(fileAt('', 'src/staged.ts', { cwd: repo })).toBe('export const s = 1;\n');
    const sha = removeObject(repo, ':src/staged.ts');
    try {
      expect(() => fileAt('', 'src/staged.ts', { cwd: repo })).toThrow(/cannot read the index entry src\/staged\.ts although the tree lists it as a blob/);
      expect(() => diffStaged({ cwd: repo })).toThrow(/unable to read|refusing to judge it as absent/); // git diff --cached reads it first
    } finally {
      restoreBlob(repo, 'export const s = 1;\n', sha);
      git(repo, ['reset', '-q', '--', 'src/staged.ts']);
      rmSync(join(repo, 'src', 'staged.ts'));
    }
  });
});
