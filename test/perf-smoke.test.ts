// Performance smoke: the cheapest items of the harness/perf suite, judged as
// RATIOS between items measured in the same run, never as absolute wall-clock
// budgets — a shared runner's clock is not a stable reference, and a smoke that
// flakes on a slow runner is a smoke nobody trusts. `cli.noop` (process start +
// module load, no evaluation) is the in-run yardstick: a hook call, a Stop sweep
// or a small `check --diff` costing many multiples of it is the regression this
// catches — the per-tool-call latency multiplied by work that used to be cheap —
// whatever the machine. This is not the regression gate; that is the nightly /
// manual `perf` workflow and `harness/perf/compare.mjs` against the committed
// baseline. Here the suite is proved to run end to end on every Node the package
// supports, and the ratios are loose enough that ordinary PR CI stays quiet.

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

/** The in-run yardstick every ratio is taken against. */
const YARDSTICK = 'cli.noop';

/** The smoke subset: p50 wall budgets as a RATIO to the yardstick's p50 wall in
 *  the same run. Measured on the baseline machine these sit at 1.2–1.4x; 4x is
 *  loose enough for a loaded runner and tight enough that an order-of-magnitude
 *  regression cannot hide behind it. */
const SMOKE_BUDGET_RATIOS: Record<string, number> = {
  'hook.warm.100': 4,
  'snapshot.100': 4,
  'check.diff.small': 4,
};

const SMOKE_ITEMS = [YARDSTICK, ...Object.keys(SMOKE_BUDGET_RATIOS)];

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
  it('runs the smoke profile and every item stays within its ratio to the in-run yardstick', () => {
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
    for (const id of SMOKE_ITEMS) expect(ids).toContain(id);

    const yardstick = items.find((i) => i.id === YARDSTICK);
    expect(yardstick).toBeDefined();
    const unit = yardstick ? yardstick.wall_ms.p50 : NaN;
    expect(unit).toBeGreaterThan(0);

    for (const item of items) {
      expect(item.runs).toBe(3);
      expect(item.wall_ms.p95).toBeGreaterThanOrEqual(item.wall_ms.p50);
      expect(item.cpu_ms.p50).toBeGreaterThan(0);
      const ratio = SMOKE_BUDGET_RATIOS[item.id];
      if (ratio !== undefined) {
        expect(item.wall_ms.p50 / unit, `${item.id} p50 wall ${item.wall_ms.p50} ms vs ${YARDSTICK} ${unit} ms`).toBeLessThan(ratio);
      }
    }

    const table = readFileSync(md, 'utf8');
    for (const id of SMOKE_ITEMS) expect(table).toContain(`| ${id} |`);
  }, 300_000);

  it('the committed baseline carries every item the full profile measures', () => {
    const baseline: unknown = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const ids = itemsOf(baseline).map((i) => i.id);
    for (const id of SMOKE_ITEMS) expect(ids).toContain(id);
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

  it('refuses a baseline whose selected metric is missing or invalid for a baselined item', () => {
    const cur = report({ 'hook.warm.100': 100, 'check.diff.small': 200 });
    const missing = join(work, 'missing-metric.json');
    writeFileSync(
      missing,
      JSON.stringify({
        schema: 1,
        items: [
          { id: 'hook.warm.100', runs: 3, wall_ms: { p50: 100, p95: 120 }, cpu_ms: { p50: 50, p95: 60 } },
          { id: 'check.diff.small', runs: 3, wall_ms: { p95: 240 }, cpu_ms: { p50: 100, p95: 110 } },
        ],
      }),
    );
    const r = compare(['--baseline', missing, '--current', cur]);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('check.diff.small');

    const invalid = join(work, 'invalid-metric.json');
    writeFileSync(
      invalid,
      JSON.stringify({
        schema: 1,
        items: [{ id: 'hook.warm.100', runs: 3, wall_ms: { p50: 'fast', p95: 120 }, cpu_ms: { p50: 50, p95: 60 } }],
      }),
    );
    expect(compare(['--baseline', invalid, '--current', cur]).status).not.toBe(0);
  });

  it('refuses duplicate item ids and a report that is not a perf report', () => {
    const cur = report({ 'hook.warm.100': 100 });
    const dup = join(work, 'dup.json');
    writeFileSync(
      dup,
      JSON.stringify({
        schema: 1,
        items: [
          { id: 'hook.warm.100', runs: 3, wall_ms: { p50: 100, p95: 120 }, cpu_ms: { p50: 50, p95: 60 } },
          { id: 'hook.warm.100', runs: 3, wall_ms: { p50: 900, p95: 950 }, cpu_ms: { p50: 50, p95: 60 } },
        ],
      }),
    );
    let r = compare(['--baseline', dup, '--current', cur]);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/duplicate/i);
    r = compare(['--baseline', cur, '--current', dup]);
    expect(r.status).not.toBe(0);

    const notReport = join(work, 'not-a-report.json');
    writeFileSync(notReport, JSON.stringify({ schema: 1, items: [{ runs: 3 }] }));
    expect(compare(['--baseline', notReport, '--current', cur]).status).not.toBe(0);
    writeFileSync(notReport, JSON.stringify({ schema: 2, items: [] }));
    expect(compare(['--baseline', notReport, '--current', cur]).status).not.toBe(0);
  });

  it('fails closed when the current report lacks a baselined item', () => {
    const base = report({ 'hook.warm.100': 100, 'check.diff.small': 200 });
    const cur = report({ 'hook.warm.100': 100 });
    expect(compare(['--baseline', base, '--current', cur]).status).toBe(1);
    expect(compare(['--baseline', base, '--current', cur, '--allow-missing']).status).toBe(0);
  });
});
