// Pass 3c, P2-4: snapshotProtected walked every directory that was not one of
// four names (.git, node_modules, .hg, .svn), so a 50k-file ignored `dist/` was
// stat'ed file by file on EVERY PreToolUse and Stop — ~1.2 s per hook call for a
// tree no protected file lives in. The walk now prunes the directories git
// reports as wholly ignored (the `--directory` collapse the ignored-adds listing
// already runs), and snapshots the protected files git lists under them from
// that listing, so they stay sanctioned and excused exactly as before. Only
// git's word prunes: an ignored directory that also holds a tracked file is not
// collapsed and is walked; outside a repository nothing is pruned.
//
// The assertion is on the directories READ, not on time: readdirSync is spied.

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotProtected } from '../src/effect';
import { defaultPolicy } from '../src/policy';
import { preToolUseVerdict, stopVerdict } from '../src/cli/hook';

vi.mock('node:fs', async (importOriginal) => {
  const m = await importOriginal<typeof import('node:fs')>();
  return { ...m, readdirSync: vi.fn(m.readdirSync) };
});

const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = fs;
const readdir = vi.mocked(fs.readdirSync);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  readdir.mockClear();
});

const policy = defaultPolicy();
const OK = "it('adds', () => { expect(1).toBe(1); });\n";
const SKIPPED = "it.skip('adds', () => { expect(1).toBe(1); });\n";

/** dist/ wholly ignored (two levels, a protected file at each), build/ ignored but
 *  holding one tracked file, test/ tracked. */
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-prune-'));
  dirs.push(d);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: d });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'test', 'a.test.js'), OK);
  writeFileSync(join(d, '.gitignore'), 'dist/\nbuild/\n');
  mkdirSync(join(d, 'build'));
  writeFileSync(join(d, 'build', 'keep.txt'), 'kept\n');
  git('add', '-A');
  git('add', '-f', 'build/keep.txt');
  git('commit', '-qm', 'base');
  mkdirSync(join(d, 'dist', 'sub'), { recursive: true });
  for (let i = 0; i < 20; i++) writeFileSync(join(d, 'dist', `f${i}.js`), 'x');
  writeFileSync(join(d, 'dist', 'x.test.js'), OK);
  writeFileSync(join(d, 'dist', 'sub', 'deep.test.js'), OK);
  writeFileSync(join(d, 'build', 'y.test.js'), OK);
  return d;
}

const readDirs = (cwd: string): string[] => readdir.mock.calls.map((c) => String(c[0])).filter((p) => p.startsWith(cwd)).map((p) => p.slice(cwd.length + 1));
const bash = (cwd: string) => ({ tool_name: 'Bash', tool_input: { command: 'echo ok' }, cwd, session_id: 's1' });
const reason = (r: { stdout: string }): string => (r.stdout ? JSON.parse(r.stdout).reason : '');

describe('P2-4: the snapshot walk does not enter a directory git reports as wholly ignored', () => {
  it('dist/ is not read; its protected files come from the listing; build/ (holds a tracked file) is walked', () => {
    const cwd = repo();
    readdir.mockClear();
    const tree = snapshotProtected(cwd, policy);
    const read = readDirs(cwd);
    expect(read).toContain('test');
    expect(read).toContain('build');
    expect(read.some((p) => p === 'dist' || p.startsWith('dist/'))).toBe(false);
    expect(Object.keys(tree).sort()).toEqual(['build/y.test.js', 'dist/sub/deep.test.js', 'dist/x.test.js', 'test/a.test.js']);
    expect(tree['dist/x.test.js'].hash).toBe(tree['test/a.test.js'].hash); // hashed from disk, same bytes
  });

  it('outside a repository nothing is pruned', () => {
    const d = mkdtempSync(join(tmpdir(), 'tw-prune-plain-'));
    dirs.push(d);
    mkdirSync(join(d, 'dist'));
    writeFileSync(join(d, 'dist', 'x.test.js'), OK);
    expect(Object.keys(snapshotProtected(d, policy))).toEqual(['dist/x.test.js']);
  });

  it("a `.gitignore` of `*`: a new directory's protected file is still snapshotted", () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.gitignore'), '*\n');
    mkdirSync(join(cwd, 'newt'));
    writeFileSync(join(cwd, 'newt', 'z.test.js'), OK);
    readdir.mockClear();
    const tree = snapshotProtected(cwd, policy);
    expect(tree['newt/z.test.js']).toBeDefined();
    expect(readDirs(cwd)).not.toContain('newt');
  });

  it('a protected file under the pruned directory is judged by the ignored-adds path, and a pre-existing one is not re-litigated', () => {
    const cwd = repo();
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe(''); // first sight: dist/x.test.js sanctioned from the listing
    expect(stopVerdict({ cwd, session_id: 's1' }).stdout).toBe(''); // nothing new: not re-litigated
    writeFileSync(join(cwd, 'dist', 'new.test.js'), SKIPPED);
    expect(reason(stopVerdict({ cwd, session_id: 's1' }))).toContain('test-skip (dist/new.test.js');
  });

  it('drift on a sanctioned file under the pruned directory is still seen at the next call', () => {
    const cwd = repo();
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
    writeFileSync(join(cwd, 'dist', 'sub', 'deep.test.js'), SKIPPED);
    expect(preToolUseVerdict(bash(cwd)).stdout).toContain('dist/sub/deep.test.js');
  });
});
