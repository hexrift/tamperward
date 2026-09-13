import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { localVerifierShell, runVerify } from '../src/cli/verify';
import { authoritativeRunLifecyclePlatform, waitForSettleSync } from '../src/cli/run';
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
