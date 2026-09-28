// #716: the per-session state the hook path keeps for itself — the turn-baseline
// marker (src/session.ts), the effect ptree and turn tree (src/effect.ts), the
// fs-event cursor and the watcher health record (src/cli/hook.ts, src/cli/watch.ts)
// — was read with existsSync + readFileSync, which follow whatever stands at the
// path. A FIFO there (one allowed Bash command away: `.git/` is not a protected
// path) blocked the read, so every later PreToolUse and Stop in the session hung
// until the runtime's hook timeout cut the gate off; a link to /dev/zero was a
// read that never ended. Each state file is now read through src/disk.ts
// readStateFile: absent is exactly the old behaviour, a regular file is read, and
// anything else fails the verdict CLOSED at once, naming the file — never
// re-established, re-snapshotted or reset around.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preToolUseVerdict, stopVerdict } from '../src/cli/hook';
import { readStateFile, StateFileError } from '../src/disk';
import { ptreePath, turnTreePath } from '../src/effect';
import { defaultEventLog, watcherHealthPath, watcherTelemetry } from '../src/cli/watch';

const posix = process.platform !== 'win32';
const SID = 's1';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-state-'));
  dirs.push(d);
  const g = (args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: d, stdio: 'pipe' });
  g(['init', '-q', '-b', 'main']);
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'test', 'a.test.js'), 'it("a", () => {});\n');
  writeFileSync(join(d, '.tamperward.yml'), 'version: 1\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'init']);
  return d;
}

function hasMkfifo(): boolean {
  try {
    execFileSync('mkfifo', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const pre = (cwd: string) => preToolUseVerdict({ session_id: SID, cwd, tool_name: 'Bash', tool_input: { command: 'echo ok' } });
const stop = (cwd: string) => stopVerdict({ session_id: SID, cwd, stop_hook_active: false });
const denial = (r: { stdout: string }): string => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason : '');
const stopReason = (r: { stdout: string }): string => (r.stdout ? JSON.parse(r.stdout).reason : '');
const marker = (cwd: string) => join(cwd, '.git', 'tamperward', `session-${SID}`);

/** Replace the regular file at `p` with a FIFO. */
function fifoAt(p: string): void {
  rmSync(p, { force: true });
  execFileSync('mkfifo', [p]);
}

describe.skipIf(!posix)('#716 readStateFile', () => {
  it('absent is null, a regular file is its text', () => {
    const d = mkdtempSync(join(tmpdir(), 'tw-state-unit-'));
    dirs.push(d);
    expect(readStateFile(join(d, 'missing'))).toBeNull();
    writeFileSync(join(d, 'marker'), 'abc\n');
    expect(readStateFile(join(d, 'marker'))).toBe('abc\n');
  });

  it('a directory, a link or a FIFO at the path is a StateFileError naming what stands there', () => {
    const d = mkdtempSync(join(tmpdir(), 'tw-state-unit-'));
    dirs.push(d);
    mkdirSync(join(d, 'dir'));
    expect(() => readStateFile(join(d, 'dir'))).toThrow(StateFileError);
    expect(() => readStateFile(join(d, 'dir'))).toThrow(/is a directory/);
    symlinkSync('/nonexistent', join(d, 'link'));
    expect(() => readStateFile(join(d, 'link'))).toThrow(/is a symbolic link to \/nonexistent/);
    if (!hasMkfifo()) return;
    execFileSync('mkfifo', [join(d, 'pipe')]);
    const started = Date.now();
    expect(() => readStateFile(join(d, 'pipe'))).toThrow(/is a fifo/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe.skipIf(!posix)('#716 a FIFO or a device link at the session state fails the verdict closed, at once', () => {
  it('control: a fresh session and regular state files allow', () => {
    const cwd = repo();
    expect(pre(cwd).stdout).toBe('');
    expect(pre(cwd).stdout).toBe('');
    expect(stop(cwd).stdout).toBe('');
  });

  it('a FIFO at the turn-baseline marker: PreToolUse and Stop deny, naming the marker', () => {
    if (!hasMkfifo()) return;
    const cwd = repo();
    expect(pre(cwd).stdout).toBe('');
    fifoAt(marker(cwd));
    const started = Date.now();
    const p = pre(cwd);
    const s = stop(cwd);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(denial(p)).toContain('tamperward-unavailable');
    expect(denial(p)).toContain(`session-${SID} is a fifo`);
    expect(stopReason(s)).toContain('tamperward-unavailable');
    expect(stopReason(s)).toContain(`session-${SID} is a fifo`);
  });

  it('a link to /dev/zero at the marker: PreToolUse denies instead of reading forever', () => {
    const cwd = repo();
    expect(pre(cwd).stdout).toBe('');
    unlinkSync(marker(cwd));
    symlinkSync('/dev/zero', marker(cwd));
    const started = Date.now();
    const p = pre(cwd);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(denial(p)).toContain(`session-${SID} is a symbolic link to /dev/zero`);
  });

  it('a FIFO at the ptree: PreToolUse denies, naming the tree, and does not take it for a first sight', () => {
    if (!hasMkfifo()) return;
    const cwd = repo();
    expect(pre(cwd).stdout).toBe('');
    const p = ptreePath(cwd, SID)!;
    fifoAt(p);
    const r = pre(cwd);
    expect(denial(r)).toContain('tamperward-unavailable');
    expect(denial(r)).toContain(`ptree-${SID}.json is a fifo`);
    // not absorbed: the deny repeats until the entry is gone
    expect(denial(pre(cwd))).toContain(`ptree-${SID}.json is a fifo`);
  });

  it('a FIFO at the turn tree: Stop denies, naming the tree', () => {
    if (!hasMkfifo()) return;
    const cwd = repo();
    expect(pre(cwd).stdout).toBe('');
    fifoAt(turnTreePath(cwd, SID)!);
    const s = stop(cwd);
    expect(stopReason(s)).toContain('tamperward-unavailable');
    expect(stopReason(s)).toContain(`turntree-${SID}.json is a fifo`);
  });

  it('a FIFO at the observer cursor: Stop denies, naming the cursor', () => {
    if (!hasMkfifo()) return;
    const cwd = repo();
    expect(pre(cwd).stdout).toBe('');
    writeFileSync(defaultEventLog(cwd), '');
    const cursor = ptreePath(cwd, SID)!.replace(/ptree-/, 'fscursor-'); // how the sweep derives it
    execFileSync('mkfifo', [cursor]);
    const started = Date.now();
    const s = stop(cwd);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(stopReason(s)).toContain('tamperward-unavailable');
    expect(stopReason(s)).toContain(`fscursor-${SID}.json is a fifo`);
  });

  it('a FIFO at the watcher health record (advisory): Stop returns at once with the observer unavailable, naming the entry', () => {
    if (!hasMkfifo()) return;
    const cwd = repo();
    expect(pre(cwd).stdout).toBe('');
    const log = defaultEventLog(cwd);
    writeFileSync(log, '');
    execFileSync('mkfifo', [watcherHealthPath(log)]);
    expect(watcherTelemetry(log).state).toBe('unavailable');
    expect(watcherTelemetry(log).reason).toContain('fsevents.jsonl.health.json is a fifo');
    const denylog = join(cwd, 'deny.log');
    const prev = process.env.TAMPERWARD_DENYLOG;
    process.env.TAMPERWARD_DENYLOG = denylog;
    try {
      const started = Date.now();
      const s = stop(cwd);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(s.stdout).toBe(''); // the record is advisory: the sweep is not certified by it
    } finally {
      if (prev === undefined) delete process.env.TAMPERWARD_DENYLOG;
      else process.env.TAMPERWARD_DENYLOG = prev;
    }
    expect(readFileSync(denylog, 'utf8')).toMatch(/warn:transient-observer:unavailable:.*fsevents\.jsonl\.health\.json is a fifo/);
  });
});
