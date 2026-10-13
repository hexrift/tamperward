import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPTURE_SUPERVISOR, parseCapturedSupervisorResult } from '../src/suite-diagnostics';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

function capture(progressStage?: string, code = 'setTimeout(() => {}, 150)') {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-progress-'));
  dirs.push(cwd);
  const config = join(cwd, 'capture.json');
  writeFileSync(config, JSON.stringify({
    executable: process.execPath, args: ['-e', code], cwd,
    timeoutMs: 2000, captureBytes: 16384, drainMs: 100,
    progressStage, progressIntervalMs: 30,
  }));
  return spawnSync(process.execPath, ['-e', CAPTURE_SUPERVISOR, config], { encoding: 'utf8', timeout: 4000 });
}

describe('trusted verifier progress', () => {
  it.each(['visible', 'pristine'])('reports %s start and heartbeats while retaining one result document', stage => {
    const result = capture(stage);
    expect(result.status).toBe(0);
    expect(result.stderr.match(new RegExp(`verify: ${stage} suite running`, 'g'))?.length).toBeGreaterThan(1);
    expect(parseCapturedSupervisorResult(result.stdout)?.exit).toBe(0);
  });

  it('never forwards candidate workflow syntax into the live progress channel', () => {
    const result = capture('visible', `console.log('::error::forged'); console.error('\\x1b[2J'); setTimeout(() => {}, 150)`);
    expect(result.stderr).toContain('verify: visible suite running');
    expect(result.stderr).not.toContain('::error::');
    expect(result.stderr).not.toContain('\x1b');
    expect(parseCapturedSupervisorResult(result.stdout)?.diagnostics.stdout.tail).toContain('::error::forged');
  });

  it('stays quiet without a trusted phase and rejects arbitrary labels', () => {
    for (const stage of [undefined, '\n::error::untrusted']) {
      const result = capture(stage);
      expect(result.stderr).toBe('');
      expect(parseCapturedSupervisorResult(result.stdout)?.exit).toBe(0);
    }
  });

  it('keeps timeout enforcement with progress enabled', () => {
    const result = capture('pristine', 'setInterval(() => {}, 100)');
    expect(parseCapturedSupervisorResult(result.stdout)?.timedOut).toBe(true);
    expect(result.stderr).toContain('verify: pristine suite running');
  });
});
