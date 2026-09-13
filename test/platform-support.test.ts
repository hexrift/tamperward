import { describe, expect, it } from 'vitest';
import { localVerifierShell } from '../src/cli/verify';
import { authoritativeRunLifecyclePlatform, waitForSettleSync } from '../src/cli/run';

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

  it('implements settle internally rather than delegating to an external sleep executable', () => {
    const started = Date.now();
    waitForSettleSync(0.02);
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
  });
});
