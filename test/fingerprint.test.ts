import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treeFingerprint } from '../src/fingerprint';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-fingerprint-'));
  dirs.push(cwd);
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.name', 'test');
  git(cwd, 'config', 'user.email', 'test@example.invalid');
  git(cwd, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(cwd, 'tracked.txt'), 'original\n');
  writeFileSync(join(cwd, '.gitignore'), 'private/\n*.log\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'base');
  return cwd;
}

// The pre-#752 byte framing, independent of the production enumerator and disk
// reader. Only fixture regular files and symlinks are passed to this oracle.
function legacyDigest(cwd: string, paths: string[]): string {
  const hash = createHash('sha256');
  for (const rel of [...paths].sort()) {
    const path = join(cwd, rel);
    const stat = lstatSync(path);
    hash.update(rel);
    hash.update('\0');
    hash.update(stat.isSymbolicLink() ? 'symlink' : 'file');
    hash.update('\0');
    hash.update(String(stat.mode));
    hash.update('\0');
    hash.update(stat.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

const keep = (rel: string): boolean => rel.endsWith('.test.js');

describe('working-tree fingerprint compatibility (#752)', () => {
  it('preserves the legacy digest for tracked, untracked, binary and ignored protected bytes', () => {
    const cwd = repo();
    mkdirSync(join(cwd, 'private'));
    writeFileSync(join(cwd, 'private', 'local.test.js'), 'test();\n');
    writeFileSync(join(cwd, 'private', 'unrelated.txt'), 'not protected');
    writeFileSync(join(cwd, 'build.log'), 'not protected');
    writeFileSync(join(cwd, 'new.bin'), Buffer.from([0, 255, 128, 0, 13, 10]));
    writeFileSync(join(cwd, 'unicode-😀-é.txt'), '');
    const paths = ['.gitignore', 'tracked.txt', 'new.bin', 'unicode-😀-é.txt'];
    expect(treeFingerprint(cwd)).toBe(legacyDigest(cwd, paths));
    expect(treeFingerprint(cwd, keep)).toBe(legacyDigest(cwd, [...paths, 'private/local.test.js']));
    expect(treeFingerprint(cwd, keep)).toBe(treeFingerprint(cwd, keep));
  });

  it.skipIf(process.platform === 'win32')('preserves symlink target and full filesystem mode framing', () => {
    const cwd = repo();
    symlinkSync('tracked.txt', join(cwd, 'link'));
    chmodSync(join(cwd, 'tracked.txt'), 0o751);
    expect(treeFingerprint(cwd)).toBe(legacyDigest(cwd, ['.gitignore', 'tracked.txt', 'link']));
  });

  it('hashes raw working-tree bytes rather than normalized Git blobs', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.gitattributes'), '*.txt text eol=lf\n');
    writeFileSync(join(cwd, 'tracked.txt'), 'original\r\n');
    git(cwd, 'add', '.gitattributes', 'tracked.txt');
    expect(git(cwd, 'show', ':tracked.txt')).toBe('original\n');
    expect(treeFingerprint(cwd)).toBe(legacyDigest(cwd, ['.gitattributes', '.gitignore', 'tracked.txt']));
    const before = treeFingerprint(cwd);
    writeFileSync(join(cwd, 'tracked.txt'), 'original\n');
    expect(treeFingerprint(cwd)).not.toBe(before);
  });
});

describe('a clean index or unchanged stat never substitutes for content (#752)', () => {
  it.each(['--assume-unchanged', '--skip-worktree'])('detects an equal-size edit hidden by %s with restored timestamps', (flag) => {
    const cwd = repo();
    const path = join(cwd, 'tracked.txt');
    const stat = lstatSync(path);
    git(cwd, 'update-index', flag, 'tracked.txt');
    const before = treeFingerprint(cwd, keep);
    writeFileSync(path, 'tampered\n');
    utimesSync(path, stat.atime, stat.mtime);
    expect(lstatSync(path).size).toBe(stat.size);
    expect(git(cwd, 'status', '--porcelain')).toBe('');
    expect(treeFingerprint(cwd, keep)).not.toBe(before);
  });

  it('detects unstaged bytes after staging a different version', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'tracked.txt'), 'staged\n');
    git(cwd, 'add', 'tracked.txt');
    const before = treeFingerprint(cwd, keep);
    writeFileSync(join(cwd, 'tracked.txt'), 'unstaged\n');
    expect(treeFingerprint(cwd, keep)).not.toBe(before);
  });

  it('detects ignored protected edits, additions and deletions on successive calls', () => {
    const cwd = repo();
    mkdirSync(join(cwd, 'private'));
    const path = join(cwd, 'private', 'local.test.js');
    writeFileSync(path, 'test();\n');
    const before = treeFingerprint(cwd, keep);
    writeFileSync(path, 'evil();\n');
    expect(git(cwd, 'status', '--porcelain')).toBe('');
    const edited = treeFingerprint(cwd, keep);
    expect(edited).not.toBe(before);
    writeFileSync(join(cwd, 'new.txt'), 'new\n');
    const added = treeFingerprint(cwd, keep);
    expect(added).not.toBe(edited);
    rmSync(join(cwd, 'tracked.txt'));
    expect(treeFingerprint(cwd, keep)).not.toBe(added);
  });
});
