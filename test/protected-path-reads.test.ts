// Pass 3c, P0-1: a protected path that is a symbolic link to a device that never
// reaches EOF (`/dev/zero`), or to a FIFO nobody writes, held every layer that
// read the working tree — the untracked and ignored adds, the worktree diff's
// enrichment, the drift check's hash — for as long as the device kept answering.
// `git ls-files --others` lists a link as an ordinary entry, and every read
// followed it with readFileSync: no lstat, no cap. The Stop sweep never
// returned its verdict, and the tracked typechange (a spec replaced by such a
// link) hung the very next PreToolUse.
//
// Now every read of a repository path is git's own view of it (src/disk.ts): a
// regular file is its bytes up to a cap, a link is a blob holding its target
// text and is never followed, and anything else is not content. A protected path
// the gate cannot judge by content is blocked BY NAME as `hidden-drift`. The hook
// cases below run the BUILT CLI in a child process under a hard timeout, so a
// regression to the hang fails the assertion instead of hanging the runner.

import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from 'vitest';
import { buildSync } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectPath, inspectResolved, READ_CAP, unjudgeableFinding } from '../src/disk';
import { untrackedAdds } from '../src/git/build';
import { snapshotProtected } from '../src/effect';
import { runCheck } from '../src/cli/check';
import { defaultPolicy } from '../src/policy';

vi.setConfig({ testTimeout: 30_000 });

const ROOT = join(__dirname, '..');
const posix = process.platform !== 'win32';
let cliDir = '';
let CLI = '';
const dirs: string[] = [];

beforeAll(() => {
  cliDir = mkdtempSync(join(tmpdir(), 'tw-cli-'));
  symlinkSync(join(ROOT, 'node_modules'), join(cliDir, 'node_modules'), 'dir');
  CLI = join(cliDir, 'index.js');
  buildSync({ entryPoints: [join(ROOT, 'src/cli/index.ts')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: CLI, logLevel: 'silent' });
}, 60_000);

afterAll(() => {
  if (cliDir) rmSync(cliDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-reads-'));
  dirs.push(d);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: d });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'test', 'test_a.py'), 'def test_a():\n    assert 1 == 1\n');
  writeFileSync(join(d, 'README.md'), 'hello\n');
  writeFileSync(join(d, '.gitignore'), 'node_modules/\ndist/\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return d;
}

/** The built CLI on a hook payload, killed after `timeout` ms. A hang shows as a
 *  signal, never as a runner that waits forever. */
function cli(sub: 'hook' | 'sweep', payload: object, timeout = 15_000): { stdout: string; signal: string | null; status: number | null } {
  const r = spawnSync(process.execPath, [CLI, sub, 'claude'], { input: JSON.stringify(payload), encoding: 'utf8', timeout });
  return { stdout: r.stdout, signal: r.signal, status: r.status };
}
const pre = (cwd: string, sid = 's1') => cli('hook', { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'echo ok' }, hook_event_name: 'PreToolUse' });
const stop = (cwd: string, sid = 's1') => cli('sweep', { session_id: sid, cwd, hook_event_name: 'Stop', stop_hook_active: false });
const denial = (r: { stdout: string }): string => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason : '');
const reason = (r: { stdout: string }): string => (r.stdout ? JSON.parse(r.stdout).reason : '');

function hasMkfifo(): boolean {
  try {
    execFileSync('mkfifo', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!posix)('P0-1: a protected path linked to a device that never ends returns a verdict, and it is a block', () => {
  it('untracked symlink test/conftest.py -> /dev/zero: Stop blocks it by name within the timeout', () => {
    const cwd = repo();
    expect(pre(cwd).stdout).toBe('');
    symlinkSync('/dev/zero', join(cwd, 'test', 'conftest.py'));
    const started = Date.now();
    const r = stop(cwd);
    expect(r.signal).toBeNull(); // not killed: the sweep returned
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(reason(r)).toContain('hidden-drift (test/conftest.py)');
    expect(reason(r)).toContain('symbolic link to /dev/zero');
  });

  it('the same link ignored through .git/info/exclude: Stop still blocks it', () => {
    const cwd = repo();
    expect(pre(cwd).stdout).toBe('');
    symlinkSync('/dev/zero', join(cwd, 'test', 'conftest.py'));
    appendFileSync(join(cwd, '.git', 'info', 'exclude'), 'test/conftest.py\n');
    const r = stop(cwd);
    expect(r.signal).toBeNull();
    expect(reason(r)).toContain('hidden-drift (test/conftest.py)');
  });

  it('a tracked spec replaced by the link (typechange): the NEXT PreToolUse denies, and keeps denying', () => {
    const cwd = repo();
    expect(pre(cwd).stdout).toBe('');
    unlinkSync(join(cwd, 'test', 'test_a.py'));
    symlinkSync('/dev/zero', join(cwd, 'test', 'test_a.py'));
    const r = pre(cwd);
    expect(r.signal).toBeNull();
    expect(denial(r)).toContain('test-deletion (test/test_a.py)'); // git's view: the spec is gone, a blob "/dev/zero" stands there
    expect(denial(r)).toContain('hidden-drift (test/test_a.py)');
    const again = pre(cwd);
    expect(again.signal).toBeNull();
    expect(denial(again)).toContain('hidden-drift (test/test_a.py)'); // not absorbed
  });

  it('a symlink to a FIFO with no writer (the open that never returns): Stop blocks, no hang', () => {
    if (!hasMkfifo()) return;
    const cwd = repo();
    expect(pre(cwd).stdout).toBe('');
    const outside = mkdtempSync(join(tmpdir(), 'tw-fifo-'));
    dirs.push(outside);
    execFileSync('mkfifo', [join(outside, 'pipe')]);
    symlinkSync(join(outside, 'pipe'), join(cwd, 'test', 'conftest.py'));
    const r = stop(cwd);
    expect(r.signal).toBeNull();
    expect(reason(r)).toContain('hidden-drift (test/conftest.py)');
    expect(reason(r)).toContain('symbolic link');
  });

  it('a FIFO itself at a protected path (git lists nothing; the snapshot sees it): Stop blocks by name', () => {
    if (!hasMkfifo()) return;
    const cwd = repo();
    expect(pre(cwd).stdout).toBe('');
    execFileSync('mkfifo', [join(cwd, 'test', 'conftest.py')]);
    const r = stop(cwd);
    expect(r.signal).toBeNull();
    expect(reason(r)).toContain('hidden-drift (test/conftest.py)');
    expect(reason(r)).toContain('is a fifo');
  });

  it('a protected file above the read cap is judged by name', () => {
    const cwd = repo();
    expect(pre(cwd).stdout).toBe('');
    const big = join(cwd, 'test', 'test_big.py');
    const fd = openSync(big, 'w');
    ftruncateSync(fd, READ_CAP + 1); // sparse: no bytes are written
    closeSync(fd);
    const r = stop(cwd);
    expect(r.signal).toBeNull();
    expect(reason(r)).toContain('hidden-drift (test/test_big.py)');
    expect(reason(r)).toContain('above the 64 MiB');
  });

  it('a link that already stood there when the session began is not re-litigated (no false positive)', () => {
    const cwd = repo();
    symlinkSync('../README.md', join(cwd, 'test', 'conftest.py')); // pre-existing, untracked
    expect(pre(cwd).stdout).toBe('');
    expect(stop(cwd).stdout).toBe('');
    expect(pre(cwd).stdout).toBe('');
  });

  it('check --worktree with untracked files blocks the link as hidden-drift too', () => {
    const cwd = repo();
    symlinkSync('/dev/zero', join(cwd, 'test', 'conftest.py'));
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      expect(runCheck({ worktree: true, includeUntracked: true, cwd, json: true })).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(out.join('')) as { findings: { rule: string; file?: string }[] };
    expect(parsed.findings.some((f) => f.rule === 'hidden-drift' && f.file === 'test/conftest.py')).toBe(true);
  });
});

describe.skipIf(!posix)('the disk reader: git\'s view of a path, never a follow, never past the cap', () => {
  it('a symlink is a blob holding its target text; the target is not opened', () => {
    const d = mkdtempSync(join(tmpdir(), 'tw-disk-'));
    dirs.push(d);
    symlinkSync('/dev/zero', join(d, 'link'));
    const e = inspectPath(join(d, 'link'));
    expect(e.kind).toBe('symlink');
    expect(e.content?.toString()).toBe('/dev/zero');
    expect(e.detail).toBe('/dev/zero');
  });

  it('a FIFO, a directory, a missing path, and an oversize file are not content', () => {
    const d = mkdtempSync(join(tmpdir(), 'tw-disk-'));
    dirs.push(d);
    mkdirSync(join(d, 'dir'));
    expect(inspectPath(join(d, 'dir')).kind).toBe('directory');
    expect(inspectPath(join(d, 'nope')).kind).toBe('absent');
    expect(inspectPath(join(d, 'nope', 'deeper')).kind).toBe('absent');
    const fd = openSync(join(d, 'big'), 'w');
    ftruncateSync(fd, READ_CAP + 1);
    closeSync(fd);
    const big = inspectPath(join(d, 'big'));
    expect(big.kind).toBe('oversize');
    expect(big.content).toBeNull();
    if (hasMkfifo()) {
      execFileSync('mkfifo', [join(d, 'pipe')]);
      const p = inspectPath(join(d, 'pipe'));
      expect(p.kind).toBe('irregular');
      expect(p.detail).toBe('fifo');
      expect(p.content).toBeNull();
    }
  });

  it('a regular file is its bytes, exactly', () => {
    const d = mkdtempSync(join(tmpdir(), 'tw-disk-'));
    dirs.push(d);
    writeFileSync(join(d, 'f'), 'héllo\n');
    const e = inspectPath(join(d, 'f'));
    expect(e.kind).toBe('file');
    expect(e.content?.toString('utf8')).toBe('héllo\n');
    expect(e.size).toBe(Buffer.byteLength('héllo\n'));
  });

  it('inspectResolved follows the chain by name but reads the end under the same guards', () => {
    const d = mkdtempSync(join(tmpdir(), 'tw-disk-'));
    dirs.push(d);
    writeFileSync(join(d, 'real'), 'content\n');
    symlinkSync(join(d, 'real'), join(d, 'to-real'));
    symlinkSync('/dev/zero', join(d, 'to-zero'));
    symlinkSync(join(d, 'gone'), join(d, 'dangling'));
    expect(inspectResolved(join(d, 'to-real')).content?.toString()).toBe('content\n');
    expect(inspectResolved(join(d, 'to-zero')).kind).toBe('irregular');
    expect(inspectResolved(join(d, 'dangling')).kind).toBe('absent');
  });

  it('untrackedAdds carries the link as the add git would record, and the snapshot records its shape', () => {
    const cwd = repo();
    symlinkSync('/dev/zero', join(cwd, 'test', 'conftest.py'));
    const adds = untrackedAdds({ cwd });
    const link = adds.find((c) => c.kind === 'file' && c.path === 'test/conftest.py');
    expect(link && link.kind === 'file' ? link.after : null).toBe('/dev/zero');
    const tree = snapshotProtected(cwd, defaultPolicy());
    expect(tree['test/conftest.py']).toBeDefined();
    expect(tree['test/conftest.py'].mode & 0o170000).toBe(0o120000); // lstat's mode: a link, not the device
    const f = unjudgeableFinding(cwd, 'test/conftest.py');
    expect(f?.rule).toBe('hidden-drift');
    expect(unjudgeableFinding(cwd, 'test/test_a.py')).toBeNull();
    expect(unjudgeableFinding(cwd, 'test/absent.py')).toBeNull();
  });
});
