import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GENERATED_CI_MIN_OVERHEAD_RESERVE_SECS,
  GENERATED_CI_TIMEOUT_MINUTES,
  VERIFIER_STAGE_COUNT,
  maxStageBudgetForOuterTimeout,
  requiredVerifierAuthoritySeconds,
} from '../src/verifier-limits';
import { runDoctor } from '../src/cli/doctor';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(budget: number): string {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-doctor-ci-'));
  dirs.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  writeFileSync(
    join(cwd, '.tamperward.yml'),
    `version: 1\nverify:\n  command: npm test\n  budget: ${budget}\n`,
  );
  git('add', '.tamperward.yml');
  git('commit', '-qm', 'trusted policy');
  return cwd;
}

function workflow(cwd: string, timeout: string | number | undefined, job = 'ci'): void {
  mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true });
  const timeoutLine = timeout === undefined ? '' : `    timeout-minutes: ${timeout}\n`;
  writeFileSync(
    join(cwd, '.github', 'workflows', 'tamperward.yml'),
    `name: ci\non: pull_request\njobs:\n  ${job}:\n    runs-on: ubuntu-latest\n${timeoutLine}    steps:\n      - run: tamperward verify --base main\n`,
  );
}

function capture(fn: () => number): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string | Uint8Array) => {
    out += String(s); return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((s: string | Uint8Array) => {
    err += String(s); return true;
  }) as typeof process.stderr.write);
  const code = fn();
  return { code, out, err };
}

describe('CI verifier envelope arithmetic (#331)', () => {
  it('derives the supported stage budget from stage count + reserve, not independent literals', () => {
    expect(VERIFIER_STAGE_COUNT).toBe(2);
    expect(GENERATED_CI_MIN_OVERHEAD_RESERVE_SECS).toBe(3_600);
    expect(GENERATED_CI_TIMEOUT_MINUTES).toBe(360);
    expect(maxStageBudgetForOuterTimeout(GENERATED_CI_TIMEOUT_MINUTES)).toBe(9_000);
    expect(requiredVerifierAuthoritySeconds(9_000)).toBe(18_000 + 3_600);
    expect(requiredVerifierAuthoritySeconds(9_000)).toBeLessThanOrEqual(GENERATED_CI_TIMEOUT_MINUTES * 60);
    expect(requiredVerifierAuthoritySeconds(9_001)).toBeGreaterThan(GENERATED_CI_TIMEOUT_MINUTES * 60);
  });
});

describe('tamperward doctor CI envelope (#331)', () => {
  it('accepts a custom job whose numeric outer timeout covers the trusted two-stage budget + reserve', () => {
    const cwd = repo(9_000);
    workflow(cwd, 360, 'security');
    expect(runDoctor({ cwd, base: 'HEAD' })).toBe(0);
  });

  it('refuses an outer timeout that cannot cover the trusted policy budget', () => {
    const cwd = repo(300);
    workflow(cwd, 10);
    const r = capture(() => runDoctor({ cwd, base: 'HEAD' }));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/timeout-minutes.*10.*requires at least 70/i);
  });

  it.each([
    [undefined, /timeout-minutes is missing/i],
    ['nope', /timeout-minutes.*numeric/i],
    ['${{ vars.TIMEOUT }}', /timeout-minutes.*static numeric/i],
    [0, /timeout-minutes.*positive/i],
  ])('refuses missing/malformed timeout %j', (timeout, reason) => {
    const cwd = repo(300);
    workflow(cwd, timeout as string | number | undefined);
    const r = capture(() => runDoctor({ cwd, base: 'HEAD' }));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(reason);
  });

  it('uses the trusted base policy rather than a candidate-edited working policy', () => {
    const cwd = repo(9_000);
    workflow(cwd, 360);
    writeFileSync(
      join(cwd, '.tamperward.yml'),
      'version: 1\nverify:\n  command: npm test\n  budget: 1\n',
    );
    expect(runDoctor({ cwd, base: 'HEAD' })).toBe(0);

    workflow(cwd, 100);
    const r = capture(() => runDoctor({ cwd, base: 'HEAD' }));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/requires at least 360/i);
  });
});
