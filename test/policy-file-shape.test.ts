// #713: the working-tree policy is read as a REGULAR FILE at the repository root, or
// not at all. `loadPolicy` used `existsSync` + `readFileSync`, and both follow whatever
// stands at `.tamperward.yml`:
//   - a FIFO there blocked the read until a writer opened the pipe, so every local
//     layer (PreToolUse, Stop, check, doctor, verify, status) hung until the runtime's
//     hook timeout cut the gate off — a gate that never answers;
//   - a symbolic link there was followed, so the local layers were governed by the
//     link's target: not the policy file (an edit to it is an ordinary edit), and
//     possibly outside the repository; the CI layer refused the same link;
//   - a broken link read as "no policy": the baseline governed silently, and every
//     protection the author had written was gone with no finding.
// The loader now inspects the path the way the effect layer reads every protected
// file (src/disk.ts): absent is the baseline, a regular file is parsed, anything else
// is a PolicyError naming what stands there. `loadPolicyAt` (trusted revision) is
// unchanged.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy, loadPolicyAt, PolicyError } from '../src/policy-load';
import { defaultPolicy, isProtected } from '../src/policy';
import { preToolUseVerdict, stopVerdict } from '../src/cli/hook';

const CLI = join(__dirname, '..', 'dist', 'cli', 'index.js');
const posix = process.platform !== 'win32';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix = 'tw-pshape-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A repository with one committed test and a STRICTER-than-baseline policy on disk. */
function repo(policyYaml = 'protected:\n  tests:\n    - "spec/**"\n'): string {
  const d = tmp();
  const g = (args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: d, stdio: 'pipe' });
  g(['init', '-q', '-b', 'main']);
  mkdirSync(join(d, 'test'));
  mkdirSync(join(d, 'spec'));
  writeFileSync(join(d, 'test', 'a.test.js'), 'it("a", () => {});\n');
  writeFileSync(join(d, 'spec', 's.js'), 'it("s", () => {});\n');
  writeFileSync(join(d, '.tamperward.yml'), policyYaml);
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

function check(cwd: string, ...args: string[]): { status: number | null; signal: string | null; stderr: string; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, 'check', ...args], { cwd, encoding: 'utf8', timeout: 20_000 });
  return { status: r.status, signal: r.signal, stderr: r.stderr, stdout: r.stdout };
}

const denial = (r: { stdout: string }): string => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason : '');
const stopReason = (r: { stdout: string }): string => (r.stdout ? JSON.parse(r.stdout).reason : '');

describe.skipIf(!posix)('#713 loadPolicy reads a regular file at the repository root, or nothing', () => {
  it('control: absent is the baseline, a regular file is parsed', () => {
    const d = tmp();
    expect(loadPolicy(d)).toEqual(defaultPolicy());
    writeFileSync(join(d, '.tamperward.yml'), 'protected:\n  tests:\n    - "spec/**"\n');
    expect(isProtected('spec/s.js', loadPolicy(d))).toBe(true);
  });

  it('a link to a regular file elsewhere in the repository is refused, naming the link and its target', () => {
    const d = tmp();
    mkdirSync(join(d, 'policy'));
    writeFileSync(join(d, 'policy', 'real.yml'), 'rules:\n  test-deletion:\n    enabled: false\n');
    symlinkSync('policy/real.yml', join(d, '.tamperward.yml'));
    let err: unknown;
    try {
      loadPolicy(d);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PolicyError);
    const msg = (err as Error).message;
    expect(msg).toContain('.tamperward.yml is a symbolic link to policy/real.yml');
    expect(msg).toMatch(/regular file/);
  });

  it('a link outside the repository is refused the same way; the target never governs', () => {
    const d = tmp();
    const outside = tmp('tw-pshape-out-');
    writeFileSync(join(outside, 'weak.yml'), 'rules:\n  test-deletion:\n    enabled: false\n');
    symlinkSync(join(outside, 'weak.yml'), join(d, '.tamperward.yml'));
    expect(() => loadPolicy(d)).toThrow(PolicyError);
    expect(() => loadPolicy(d)).toThrow(/symbolic link/);
  });

  it('a BROKEN link is not "no policy": it is refused, never the baseline', () => {
    const d = tmp();
    symlinkSync('/nonexistent/policy.yml', join(d, '.tamperward.yml'));
    expect(() => loadPolicy(d)).toThrow(PolicyError);
    expect(() => loadPolicy(d)).toThrow(/symbolic link to \/nonexistent\/policy\.yml/);
  });

  it('a directory at the path is a PolicyError, not a raw EISDIR', () => {
    const d = tmp();
    mkdirSync(join(d, '.tamperward.yml'));
    let err: unknown;
    try {
      loadPolicy(d);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PolicyError);
    expect((err as Error).message).toContain('.tamperward.yml is a directory');
    expect((err as Error).message).not.toMatch(/EISDIR/);
  });

  it('a FIFO with no writer at the path: the loader returns at once with a PolicyError (no hang)', () => {
    if (!hasMkfifo()) return;
    const d = tmp();
    execFileSync('mkfifo', [join(d, '.tamperward.yml')]);
    const started = Date.now();
    let err: unknown;
    try {
      loadPolicy(d);
    } catch (e) {
      err = e;
    }
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(err).toBeInstanceOf(PolicyError);
    expect((err as Error).message).toContain('.tamperward.yml is a fifo');
  });
});

describe.skipIf(!posix)('#713 the local layers deny at once instead of following or hanging', () => {
  it('PreToolUse and Stop with a FIFO at .tamperward.yml: both deny promptly, naming the pipe', () => {
    if (!hasMkfifo()) return;
    const cwd = repo();
    // First sight of the session pins the baseline while the policy is still a file.
    expect(preToolUseVerdict({ session_id: 's1', cwd, tool_name: 'Bash', tool_input: { command: 'echo ok' } }).stdout).toBe('');
    unlinkSync(join(cwd, '.tamperward.yml'));
    execFileSync('mkfifo', [join(cwd, '.tamperward.yml')]);
    const started = Date.now();
    const pre = preToolUseVerdict({ session_id: 's1', cwd, tool_name: 'Bash', tool_input: { command: 'echo ok' } });
    const stop = stopVerdict({ session_id: 's1', cwd, stop_hook_active: false });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(pre.exitCode).toBe(0);
    expect(denial(pre)).toContain('tamperward-unavailable');
    expect(denial(pre)).toContain('.tamperward.yml is a fifo');
    expect(stop.exitCode).toBe(0);
    expect(stopReason(stop)).toContain('tamperward-unavailable');
    expect(stopReason(stop)).toContain('.tamperward.yml is a fifo');
  });

  it('a committed link: an edit to its target plus a test deletion no longer passes check --staged / --worktree', () => {
    const d = tmp();
    const g = (args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: d, stdio: 'pipe' });
    g(['init', '-q', '-b', 'main']);
    mkdirSync(join(d, 'test'));
    mkdirSync(join(d, 'policy'));
    writeFileSync(join(d, 'test', 'a.test.js'), 'it("a", () => {});\n');
    writeFileSync(join(d, 'policy', 'real.yml'), 'version: 1\n');
    symlinkSync('policy/real.yml', join(d, '.tamperward.yml'));
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'init']);
    writeFileSync(join(d, 'policy', 'real.yml'), 'rules:\n  test-deletion:\n    enabled: false\n');
    g(['rm', '-q', 'test/a.test.js']);
    for (const view of ['--staged', '--worktree']) {
      const r = check(d, view);
      expect(r.signal).toBeNull();
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('.tamperward.yml is a symbolic link to policy/real.yml');
    }
    // The CI layer already refused the link at the trusted revision; still does.
    expect(() => loadPolicyAt('HEAD', d)).toThrow(PolicyError);
  });

  it('a broken committed link: the author\'s protection is not silently replaced by the baseline', () => {
    const d = tmp();
    const g = (args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: d, stdio: 'pipe' });
    g(['init', '-q', '-b', 'main']);
    mkdirSync(join(d, 'spec'));
    writeFileSync(join(d, 'spec', 's.js'), 'it("s", () => {});\n');
    symlinkSync('/nonexistent/policy.yml', join(d, '.tamperward.yml'));
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'init']);
    g(['rm', '-q', 'spec/s.js']);
    const r = check(d, '--staged');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('.tamperward.yml is a symbolic link to /nonexistent/policy.yml');
  });
});
