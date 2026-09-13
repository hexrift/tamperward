// Performance smoke: the cheapest items of the harness/perf suite, under LOOSE
// absolute budgets. This is not the regression gate — that is the nightly/manual
// `perf` workflow and `harness/perf/compare.mjs` against the committed baseline —
// it only proves the suite still runs end to end on every Node the package
// supports and that no ordinary PR multiplies the per-tool-call hook latency by
// an order of magnitude without CI noticing. Budgets are wide enough that a busy
// shared runner stays quiet; a hook call that takes seconds is the signal.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isRecord } from '../src/narrow';

const ROOT = join(__dirname, '..');
const BENCH = join(ROOT, 'harness', 'perf', 'bench.mjs');
const COMPARE = join(ROOT, 'harness', 'perf', 'compare.mjs');
const BASELINE = join(ROOT, 'harness', 'perf', 'BASELINE.json');

/** The smoke subset and its absolute p50 wall budgets, in milliseconds. */
const SMOKE_BUDGETS_MS: Record<string, number> = {
  'hook.warm.100': 4000,
  'snapshot.100': 4000,
  'check.diff.small': 4000,
};

interface Percentiles {
  p50: number;
  p95: number;
}
interface Item {
  id: string;
  runs: number;
  wall_ms: Percentiles;
  cpu_ms: Percentiles;
}

function percentiles(v: unknown): Percentiles | null {
  if (!isRecord(v)) return null;
  const { p50, p95 } = v;
  if (typeof p50 !== 'number' || typeof p95 !== 'number') return null;
  return { p50, p95 };
}

function itemFrom(v: unknown): Item | null {
  if (!isRecord(v)) return null;
  const { id, runs } = v;
  const wall = percentiles(v.wall_ms);
  const cpu = percentiles(v.cpu_ms);
  if (typeof id !== 'string' || typeof runs !== 'number' || !wall || !cpu) return null;
  return { id, runs, wall_ms: wall, cpu_ms: cpu };
}

function itemsOf(report: unknown): Item[] {
  if (!isRecord(report) || !Array.isArray(report.items)) return [];
  return report.items.map(itemFrom).filter((x): x is Item => x !== null);
}

let work = '';
let cli = '';

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'tw-perf-smoke-'));
  // An isolated build of the CLI, so the smoke does not depend on `npm run build`
  // having run first (the CI test job does not build).
  const d = join(work, 'cli');
  mkdirSync(d);
  symlinkSync(join(ROOT, 'node_modules'), join(d, 'node_modules'), 'dir');
  cli = join(d, 'index.js');
  buildSync({
    entryPoints: [join(ROOT, 'src/cli/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: cli,
    logLevel: 'silent',
  });
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe('harness/perf smoke subset', () => {
  it('runs the smoke profile and every item stays under its loose absolute budget', () => {
    const out = join(work, 'perf.json');
    const md = join(work, 'perf.md');
    const r = spawnSync(
      process.execPath,
      [BENCH, '--profile', 'smoke', '--runs', '3', '--cli', cli, '--work', join(work, 'fixtures'), '--out', out, '--md', md],
      { encoding: 'utf8', timeout: 240_000 },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(md)).toBe(true);

    const report: unknown = JSON.parse(readFileSync(out, 'utf8'));
    const items = itemsOf(report);
    const ids = items.map((i) => i.id);
    for (const id of Object.keys(SMOKE_BUDGETS_MS)) expect(ids).toContain(id);

    for (const item of items) {
      expect(item.runs).toBe(3);
      expect(item.wall_ms.p95).toBeGreaterThanOrEqual(item.wall_ms.p50);
      expect(item.cpu_ms.p50).toBeGreaterThan(0);
      const budget = SMOKE_BUDGETS_MS[item.id];
      if (budget !== undefined) expect(item.wall_ms.p50, `${item.id} p50 wall`).toBeLessThan(budget);
    }

    const table = readFileSync(md, 'utf8');
    for (const id of Object.keys(SMOKE_BUDGETS_MS)) expect(table).toContain(`| ${id} |`);
  }, 300_000);

  it('the committed baseline carries every item the full profile measures', () => {
    const baseline: unknown = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const ids = itemsOf(baseline).map((i) => i.id);
    for (const id of Object.keys(SMOKE_BUDGETS_MS)) expect(ids).toContain(id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'hook.cold.1k',
        'hook.warm.1k',
        'snapshot.1k',
        'snapshot.10k',
        'check.diff.large',
        'hook.ignored',
        'sweep.ignored',
        'deps.fingerprint',
        'verify.materialize',
        'run.envelope',
        'sweep.longlog',
      ]),
    );
    expect(isRecord(baseline) && isRecord(baseline.machine)).toBe(true);
  });
});

describe('harness/perf/compare.mjs', () => {
  function report(wallP50: Record<string, number>): string {
    const p = join(work, `cmp-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(
      p,
      JSON.stringify({
        schema: 1,
        items: Object.entries(wallP50).map(([id, p50]) => ({
          id,
          runs: 3,
          wall_ms: { p50, p95: p50 * 1.2 },
          cpu_ms: { p50: p50 / 2, p95: p50 / 2 },
        })),
      }),
    );
    return p;
  }

  function compare(args: string[]) {
    return spawnSync(process.execPath, [COMPARE, ...args], { encoding: 'utf8' });
  }

  it('passes when every item is within the default 2x ratio', () => {
    const base = report({ 'hook.warm.100': 100, 'check.diff.small': 200 });
    const cur = report({ 'hook.warm.100': 150, 'check.diff.small': 390 });
    const r = compare(['--baseline', base, '--current', cur]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('hook.warm.100');
  });

  it('fails when an item exceeds its budget ratio, and names it', () => {
    const base = report({ 'hook.warm.100': 100, 'check.diff.small': 200 });
    const cur = report({ 'hook.warm.100': 250, 'check.diff.small': 210 });
    const r = compare(['--baseline', base, '--current', cur]);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/hook\.warm\.100.*(over|exceed)/i);
  });

  it('honours a configurable ratio and a per-item budget in the baseline', () => {
    const base = report({ 'hook.warm.100': 100, 'check.diff.small': 200 });
    const cur = report({ 'hook.warm.100': 250, 'check.diff.small': 210 });
    expect(compare(['--baseline', base, '--current', cur, '--ratio', '3']).status).toBe(0);

    const strict = join(work, 'strict.json');
    const doc: unknown = JSON.parse(readFileSync(base, 'utf8'));
    writeFileSync(strict, JSON.stringify({ ...(isRecord(doc) ? doc : {}), budgets: { 'check.diff.small': 1.01 } }));
    const r = compare(['--baseline', strict, '--current', cur, '--ratio', '3']);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('check.diff.small');
  });

  it('fails closed when the current report lacks a baselined item', () => {
    const base = report({ 'hook.warm.100': 100, 'check.diff.small': 200 });
    const cur = report({ 'hook.warm.100': 100 });
    expect(compare(['--baseline', base, '--current', cur]).status).toBe(1);
    expect(compare(['--baseline', base, '--current', cur, '--allow-missing']).status).toBe(0);
  });
});
