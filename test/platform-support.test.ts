import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { localVerifierShell, runVerify } from '../src/cli/verify';
import { authoritativeRunLifecyclePlatform, runEnvelope, waitForSettleSync } from '../src/cli/run';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { runTraceVerify } from '../src/cli/trace-verify';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('platform execution contract (#326)', () => {
  it('keeps authoritative tamperward run Linux-only', () => {
    expect(authoritativeRunLifecyclePlatform('linux')).toBe(true);
    expect(authoritativeRunLifecyclePlatform('darwin')).toBe(false);
    expect(authoritativeRunLifecyclePlatform('win32')).toBe(false);
  });

  it('uses an explicit POSIX shell contract for local verify and rejects Windows', () => {
    expect(localVerifierShell('linux', 'npm test')).toEqual({
      executable: '/bin/sh',
      args: ['-c', 'npm test'],
    });
    expect(localVerifierShell('darwin', 'npm test')).toEqual({
      executable: '/bin/sh',
      args: ['-c', 'npm test'],
    });
    expect(localVerifierShell('freebsd', 'npm test')).toEqual({
      executable: '/bin/sh',
      args: ['-c', 'npm test'],
    });
    expect(localVerifierShell('win32', 'npm test')).toBeNull();
  });

  it.skipIf(process.platform === 'linux')('non-Linux trace-verify refuses explicitly instead of implying strace parity', () => {
    let stderr = '';
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(runTraceVerify({})).toBe(2);
    } finally {
      process.stderr.write = write;
    }
    expect(stderr).toMatch(/Linux only/);
    expect(stderr).toMatch(/unsupported platform/);
  });

  it('implements settle internally rather than delegating to an external sleep executable', () => {
    const started = Date.now();
    waitForSettleSync(0.02);
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
  });

  it.skipIf(process.platform !== 'win32')('Windows local verify refuses before candidate command side effects', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tw-platform-verify-'));
    dirs.push(cwd);
    const marker = join(cwd, 'candidate-ran');
    const command = `"${process.execPath}" -e "require('node:fs').writeFileSync(${JSON.stringify(JSON.stringify(marker))}, 'x')"`;

    let output = '';
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(runVerify({ cwd, cmd: command, budget: 1, json: true })).toBe(2);
    } finally {
      process.stdout.write = write;
    }

    expect(existsSync(marker)).toBe(false);
    expect(output).toMatch(/LOCAL_VERIFIER_UNSUPPORTED_PLATFORM/);
  });


  it.skipIf(process.platform === 'win32')('never adjudicates behind an unowned lifecycle on any platform: the portable supervisor fails closed after the agent', () => {
    // The pre-agent preflight already refuses non-Linux hosts. This proves the
    // SECOND boundary independently: if the agent ran under a supervisor that
    // did not report ownership, no check or verify runs and the verdict is
    // CANNOT_ADJUDICATE — on every platform, not only Linux. process.platform
    // is projected to darwin so the portable Node supervisor is the one used;
    // the test-only preflight override lets the agent start at all.
    const cwd = mkdtempSync(join(tmpdir(), 'tw-platform-lifecycle-'));
    dirs.push(cwd);
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['config', 'user.email', 't@b'], { cwd });
    execFileSync('git', ['config', 'user.name', 'tb'], { cwd });
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
    execFileSync('git', ['add', '-A'], { cwd });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd });
    const agentMarker = join(cwd, 'agent-ran');
    const verifyMarker = join(cwd, 'verify-ran');

    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    let stdout = '';
    let stderr = '';
    const writeOut = process.stdout.write;
    const writeErr = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
    let code: number;
    try {
      code = runEnvelope({
        cwd,
        cmd: `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(${JSON.stringify(verifyMarker)}, 'x')"`,
        budget: 5,
        json: true,
        lifecyclePlatformOverride: 'linux',
        argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(agentMarker)}, 'x')`],
      });
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      process.stdout.write = writeOut;
      process.stderr.write = writeErr;
    }

    expect(code).toBe(2);
    expect(existsSync(agentMarker)).toBe(true); // the agent did run…
    expect(existsSync(verifyMarker)).toBe(false); // …but nothing adjudicated the tree it left
    expect(stderr).toMatch(/lifecycle boundary was not established\/drained/);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      schema_version: 1,
      verdict: 'CANNOT_ADJUDICATE',
      exit_code: 2,
      complete: false,
      reason: 'AGENT_LIFECYCLE_NOT_OWNED',
      agent: { exit_code: 0, lifecycle_owned: false },
    });
  }, 30_000);

  it('keeps a real Linux/macOS/Windows platform-contract job under the final gate', () => {
    const workflow = parse(
      readFileSync(join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8'),
    ) as any;
    expect(workflow.jobs['platform-contract'].strategy.matrix.os).toEqual([
      'ubuntu-latest',
      'macos-latest',
      'windows-latest',
    ]);
    const needs = workflow.jobs.gate.needs;
    expect(needs).toContain('platform-contract');
  });
});
