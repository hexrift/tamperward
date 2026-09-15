import { describe, it, expect } from 'vitest';
import { runCapturedProcessSync } from '../src/suite-diagnostics';

// #539: a suite that exits but leaves a descendant holding its stdout pipe open
// must not hang the capture supervisor. Completion is keyed off the main child's
// exit with a bounded post-exit drain window; the supervisor returns the real
// exit code and flags the leaked pipe instead of failing closed with the opaque
// "suite capture supervisor did not produce a result" after the outer backstop.
//
// On Linux the group kill + /proc descendant tracking normally reaps an escaped
// background child, so the pipe closes and the ordinary `close` path finishes.
// That reaping is unavailable on macOS, which is where the hang was reported.
// To exercise the new drain path deterministically on any platform, these cases
// leave the pipe-holder unreaped (killGroupOnFinish: false) — the drain logic is
// independent of how the descendant is (or is not) terminated.

const leakOpts = {
  cwd: process.cwd(),
  env: { ...process.env } as NodeJS.ProcessEnv,
  timeoutMs: 20_000,
  detached: true,
  killGroupOnFinish: false,
  drainMs: 300,
};

describe('capture supervisor: leaked descendant holding stdout (#539)', () => {
  it('finishes off the main child exit and reports the real exit code', () => {
    const t0 = Date.now();
    // The shell exits 0 immediately; the backgrounded process inherits and holds
    // the stdout pipe past the drain window, so `close` cannot fire in time.
    const r = runCapturedProcessSync(
      '/bin/sh',
      ['-c', 'sleep 5 & echo suite-done; exit 0'],
      leakOpts,
    );
    const elapsed = Date.now() - t0;

    expect(r.exit).toBe(0);
    expect(r.pipeHeldOpen).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.error).toBeUndefined();
    // Completed on exit + drain (~0.3s), not on the 20s budget or the outer
    // backstop.
    expect(elapsed).toBeLessThan(4_000);
  });

  it('propagates a non-zero exit through the leaked-pipe path', () => {
    const r = runCapturedProcessSync(
      '/bin/sh',
      ['-c', 'sleep 5 & echo failing; exit 3'],
      leakOpts,
    );
    expect(r.exit).toBe(3);
    expect(r.pipeHeldOpen).toBe(true);
  });

  it('does not flag a leak for an ordinary suite that closes its pipes', () => {
    const r = runCapturedProcessSync('/bin/sh', ['-c', 'echo ok; exit 0'], {
      ...leakOpts,
      killGroupOnFinish: true,
    });
    expect(r.exit).toBe(0);
    expect(r.pipeHeldOpen).toBeUndefined();
    expect(r.diagnostics.stdout.captured_bytes).toBeGreaterThan(0);
  });
});
