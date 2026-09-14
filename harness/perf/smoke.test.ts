// Performance smoke: the cheapest items of the harness/perf suite, judged as
// RATIOS between items measured in the same run, never as absolute wall-clock
// budgets — a shared runner's clock is not a stable reference, and a smoke that
// flakes on a slow runner is a smoke nobody trusts.
//
// The in-run yardstick is `cli.parse`: a `hook claude` PreToolUse Edit of a
// TypeScript source with no session, which is process start + module load +
// the lazily loaded 9 MB parser (src/ts-lazy.ts) + one file's evaluation, and
// nothing else. `cli.noop` (empty stdin) stopped being that yardstick when the
// parser went lazy (#407): it no longer loads the parser, but every smoke item
// that touches a `.ts` file does, so its ratio measured "parser load versus
// process start" and the budget headroom was spent on the parser, not on
// regressions (#421). The ratio is taken on CPU time (`cpu_ms.p50`, user + sys
// of the process and its children), not wall: a sibling test file or a noisy
// neighbour inflates wall for the whole run but leaves CPU nearly alone, so a
// CPU ratio on a loaded runner still says what it says on an idle one.
//
// This file lives under harness/perf/ and runs OUTSIDE `npm test` (vitest.config.ts
// excludes `**/harness/**`), alone and serially, from `npm run test:perf-smoke`
// with vitest.perf-smoke.config.ts — the `perf-smoke` job of ci.yml. Sharing a
// runner with the parallel suite was the other half of #421: the remaining
// headroom went to sibling files, not regressions.
//
// This is not the regression gate; that is the nightly / manual `perf` workflow
// and `harness/perf/compare.mjs` against the committed baseline. Here the suite
// is proved to run end to end on every Node the package supports, and the
// ratios are loose enough that ordinary PR CI stays quiet — and tight enough
// that a 3× slowdown of `check.diff.small` fails (the injected regression below
// pins that).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { isRecord } from '../../src/narrow';

const ROOT = join(__dirname, '..', '..');
const BENCH = join(ROOT, 'harness', 'perf', 'bench.mjs');
const COMPARE = join(ROOT, 'harness', 'perf', 'compare.mjs');
const BASELINE = join(ROOT, 'harness', 'perf', 'BASELINE.json');

/** The in-run yardstick every ratio is taken against: process start + module
 *  load + parser load + one file's evaluation. */
const YARDSTICK = 'cli.parse';

/** The smoke subset: p50 CPU budgets as a RATIO to the yardstick's p50 CPU in
 *  the same run. Measured on an idle 4-core box (Node 22) these sit at
 *  hook.warm.100 0.44×, snapshot.100 0.48×, check.diff.small 1.46×: the hook and
 *  the sweep do not load the parser at all on a Bash call, and the diff parses
 *  three files. 1.25× / 3× leave 2–3× of headroom for a Node version or a
 *  slower runner and still fail a 3× regression of any item. */
const SMOKE_BUDGET_RATIOS: Record<string, number> = {
  'hook.warm.100': 1.25,
  'snapshot.100': 1.25,
  'check.diff.small': 3,
};

/** `cli.noop` stays in the smoke profile as the process-start floor the table
 *  reports (the parser's cost is the difference to the yardstick), unbudgeted. */
const SMOKE_ITEMS = ['cli.noop', YARDSTICK, ...Object.keys(SMOKE_BUDGET_RATIOS)];

/** The hook items the committed baseline must budget tighter than compare.mjs's
 *  2× default: a per-tool-call gate that takes half again as long is the
 *  regression the nightly compare exists to show (docs/PERF.md). */
const HOOK_ITEMS = ['hook.warm.100', 'hook.cold.1k', 'hook.warm.1k', 'hook.ignored'];
const HOOK_BUDGET_MAX = 1.5;

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

/**
 * The smoke verdict: one line per budgeted item over its CPU ratio to the
 * yardstick, plus one for a yardstick that is missing or measured at zero.
 * Empty means the run passed. Shared by the real run and the injected
 * regression so the two cannot drift apart.
 */
function judge(items: Item[]): string[] {
  const yardstick = items.find((i) => i.id === YARDSTICK);
  if (!yardstick) return [`${YARDSTICK} is missing from the report`];
  const unit = yardstick.cpu_ms.p50;
  if (!(unit > 0)) return [`${YARDSTICK} p50 cpu is ${unit} ms`];
  const out: string[] = [];
  for (const item of items) {
    const budget = SMOKE_BUDGET_RATIOS[item.id];
    if (budget === undefined) continue;
    const ratio = item.cpu_ms.p50 / unit;
    if (!(ratio < budget)) out.push(`${item.id} p50 cpu ${item.cpu_ms.p50} ms is ${ratio.toFixed(2)}x ${YARDSTICK} ${unit} ms (budget ${budget}x)`);
  }
  return out;
}

/** The same report with one item slowed `factor`× (wall and CPU alike): the
 *  regression a smoke must fail, without making the CLI sleep. */
function slowed(items: Item[], id: string, factor: number): Item[] {
  const scale = (p: Percentiles): Percentiles => ({ p50: p.p50 * factor, p95: p.p95 * factor });
  return items.map((i) => (i.id === id ? { ...i, wall_ms: scale(i.wall_ms), cpu_ms: scale(i.cpu_ms) } : i));
}

let work = '';
let cli = '';
/** The items the real smoke run measured; the injected regression reuses them. */
let measured: Item[] | null = null;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'tw-perf-smoke-'));
  // An isolated build of the CLI, so the smoke does not depend on `npm run build`
  // having run first (the CI perf-smoke job does not build).
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
  it('runs the smoke profile and every item stays within its CPU ratio to the in-run yardstick', () => {
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
    // The smoke profile is exactly the smoke subset: an item added to the
    // profile without a budget here is measured and judged by nobody.
    expect([...ids].sort()).toEqual([...SMOKE_ITEMS].sort());

    for (const item of items) {
      expect(item.runs).toBe(3);
      expect(item.wall_ms.p95).toBeGreaterThanOrEqual(item.wall_ms.p50);
      expect(item.cpu_ms.p50).toBeGreaterThan(0);
    }

    // The yardstick loads the parser and cli.noop does not: the yardstick must
    // cost materially more CPU, or it is not measuring the parser.
    const noop = items.find((i) => i.id === 'cli.noop');
    const yardstick = items.find((i) => i.id === YARDSTICK);
    expect(noop && yardstick && yardstick.cpu_ms.p50 > noop.cpu_ms.p50 * 1.5, 'cli.parse must load the parser cli.noop skips').toBe(true);

    expect(judge(items)).toEqual([]);
    measured = items;

    const table = readFileSync(md, 'utf8');
    for (const id of SMOKE_ITEMS) expect(table).toContain(`| ${id} |`);
  }, 300_000);

  it('an injected 3x regression of check.diff.small fails the smoke and names the item', () => {
    expect(measured, 'the smoke run must have produced a report').not.toBeNull();
    const items = measured ?? [];
    const verdict = judge(slowed(items, 'check.diff.small', 3));
    expect(verdict).toHaveLength(1);
    expect(verdict[0]).toMatch(/^check\.diff\.small .*budget 3x/);
    // The other budgeted items are not slack either: 3x on any of them fails.
    for (const id of ['hook.warm.100', 'snapshot.100']) {
      expect(judge(slowed(items, id, 3)).join('\n')).toContain(id);
    }
    // And a slowdown of the yardstick itself is not a way to pass: it makes
    // every ratio smaller, so the assertion above on the yardstick versus
    // cli.noop is what pins its identity. A missing yardstick is a failure.
    expect(judge(items.filter((i) => i.id !== YARDSTICK))).toEqual([`${YARDSTICK} is missing from the report`]);
  });

  it('the committed baseline carries every item the full profile measures, where it was taken, and tight hook budgets', () => {
    const baseline: unknown = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const ids = itemsOf(baseline).map((i) => i.id);
    for (const id of SMOKE_ITEMS) if (id !== YARDSTICK) expect(ids).toContain(id);
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
    expect(isRecord(baseline)).toBe(true);
    const doc = isRecord(baseline) ? baseline : {};
    expect(isRecord(doc.machine)).toBe(true);
    const machine = isRecord(doc.machine) ? doc.machine : {};
    for (const key of ['platform', 'arch', 'cpu', 'cores', 'mem_gb', 'node', 'git']) expect(machine, key).toHaveProperty(key);
    expect(typeof doc.tamperward_version, 'the baseline names the version it measured').toBe('string');
    // Two honest states, nothing in between. A REFERENCE baseline (machine.ci
    // set: promoted from a green `perf` run with promote-baseline.mjs) carries
    // every item, cli.parse included, and was taken after the parser went lazy
    // (#407), so its cli.noop no longer loads the parser and sits clearly below
    // cli.parse. A SANDBOX stand-in (machine.ci false) must say so in `note`,
    // naming what replaces it, so nobody reads its numbers as the runner's.
    if (machine.ci) {
      expect(ids).toContain(YARDSTICK);
      const base = itemsOf(baseline);
      const noop = base.find((i) => i.id === 'cli.noop');
      const parse = base.find((i) => i.id === YARDSTICK);
      expect(noop && parse && parse.cpu_ms.p50 > noop.cpu_ms.p50 * 1.5, 'baseline cli.parse must cost more CPU than cli.noop').toBe(true);
      expect(doc.note).toBeUndefined();
    } else {
      expect(doc.note).toMatch(/sandbox.*pending.*perf workflow/);
      expect(doc.note).toContain('promote-baseline.mjs');
    }
    // Hook items are budgeted tighter than the 2x default: a per-tool-call gate
    // that doubles is far past what the nightly compare should tolerate.
    expect(isRecord(doc.budgets)).toBe(true);
    const budgets = isRecord(doc.budgets) ? doc.budgets : {};
    for (const id of HOOK_ITEMS) {
      const b = budgets[id];
      expect(typeof b === 'number' && b > 1 && b <= HOOK_BUDGET_MAX, `budgets[${id}] = ${String(b)}`).toBe(true);
    }
  });

  it('compare.mjs fails an injected 2x regression of hook.warm.100 against the committed baseline', () => {
    const baseline: unknown = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const doc = isRecord(baseline) ? baseline : {};
    const items = Array.isArray(doc.items) ? doc.items : [];
    // The baseline's own numbers as the current report — a no-op run — with one
    // item doubled. No budgets on the current side: compare.mjs reads them from
    // the baseline only.
    const twice = (v: unknown): unknown =>
      isRecord(v) && v.id === 'hook.warm.100'
        ? { ...v, wall_ms: scaled(v.wall_ms, 2), cpu_ms: scaled(v.cpu_ms, 2) }
        : v;
    const cur = join(work, 'baseline-hook-warm-2x.json');
    writeFileSync(cur, JSON.stringify({ schema: 1, items: items.map(twice) }));
    const r = spawnSync(process.execPath, [COMPARE, '--baseline', BASELINE, '--current', cur], { encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/\| hook\.warm\.100 \|.*OVER BUDGET/);
    expect(r.stdout).toMatch(/1 item\(s\) over budget/);

    // Unchanged, the baseline compares clean against itself.
    const same = join(work, 'baseline-same.json');
    writeFileSync(same, JSON.stringify({ schema: 1, items }));
    expect(spawnSync(process.execPath, [COMPARE, '--baseline', BASELINE, '--current', same], { encoding: 'utf8' }).status).toBe(0);
  });
});

function scaled(v: unknown, factor: number): unknown {
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, n] of Object.entries(v)) out[k] = typeof n === 'number' ? n * factor : n;
  return out;
}

describe('harness/perf/promote-baseline.mjs', () => {
  const PROMOTE = join(ROOT, 'harness', 'perf', 'promote-baseline.mjs');
  const item = (id: string, p50: number) => ({ id, runs: 7, wall_ms: { p50, p95: p50 * 1.2 }, cpu_ms: { p50: p50 / 2, p95: p50 / 2 } });
  const machine = { platform: 'linux', arch: 'x64', cpu: 'x', cores: 4, mem_gb: 16, node: 'v22.0.0', git: 'git version 2.43.0' };

  function promote(args: string[]) {
    return spawnSync(process.execPath, [PROMOTE, ...args], { encoding: 'utf8' });
  }

  it('copies a green report into place, carries the budgets over, stamps machine.ci and drops the sandbox note', () => {
    const base = join(work, 'promote-base.json');
    const cand = join(work, 'promote-cand.json');
    writeFileSync(
      base,
      JSON.stringify({
        schema: 1,
        note: 'captured in a loaded sandbox; reference baseline pending',
        machine: { ...machine, ci: false },
        budgets: { 'hook.warm.100': 1.5 },
        items: [item('cli.noop', 1700), item('hook.warm.100', 2200)],
      }),
    );
    writeFileSync(cand, JSON.stringify({ schema: 1, tamperward_version: '2.23.12', machine, items: [item('cli.noop', 120), item('cli.parse', 370), item('hook.warm.100', 160)] }));
    const r = promote([cand, '--baseline', base]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const doc: unknown = JSON.parse(readFileSync(base, 'utf8'));
    const out = isRecord(doc) ? doc : {};
    expect(out.note).toBeUndefined();
    expect(out.budgets).toEqual({ 'hook.warm.100': 1.5 });
    expect(isRecord(out.machine) ? out.machine.ci : null).toBe(true);
    expect(itemsOf(doc).map((i) => i.id)).toEqual(['cli.noop', 'cli.parse', 'hook.warm.100']);
    expect(itemsOf(doc).find((i) => i.id === 'hook.warm.100')?.wall_ms.p50).toBe(160);
    // The old-versus-new table is the evidence the replacing PR carries.
    expect(r.stdout).toMatch(/\| hook\.warm\.100 \| 2200 \| 160 \| 0\.07x \|/);
    expect(r.stdout).toMatch(/\| cli\.parse \| — \| 370 \| new \|/);

    // A runner report already names its CI: kept as is.
    writeFileSync(cand, JSON.stringify({ schema: 1, machine: { ...machine, ci: 'github-actions' }, items: [item('cli.noop', 120), item('cli.parse', 370), item('hook.warm.100', 160)] }));
    expect(promote([cand, '--baseline', base]).status).toBe(0);
    const again: unknown = JSON.parse(readFileSync(base, 'utf8'));
    expect(isRecord(again) && isRecord(again.machine) ? again.machine.ci : null).toBe('github-actions');
  });

  it('refuses a candidate that lost a baselined item, is malformed, or has no machine block', () => {
    const base = join(work, 'promote-base2.json');
    const before = JSON.stringify({ schema: 1, machine, items: [item('cli.noop', 1700), item('hook.warm.100', 2200)] });
    writeFileSync(base, before);
    const cand = join(work, 'promote-cand2.json');
    writeFileSync(cand, JSON.stringify({ schema: 1, machine, items: [item('cli.noop', 120)] }));
    let r = promote([cand, '--baseline', base]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('hook.warm.100');
    writeFileSync(cand, JSON.stringify({ schema: 1, machine, items: [item('cli.noop', 120), { id: 'hook.warm.100', wall_ms: { p50: 'fast' } }] }));
    expect(promote([cand, '--baseline', base]).status).toBe(2);
    writeFileSync(cand, JSON.stringify({ schema: 1, items: [item('cli.noop', 120), item('hook.warm.100', 160)] }));
    r = promote([cand, '--baseline', base]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/machine/);
    expect(promote(['--baseline', base]).status).toBe(2);
    // Nothing was written by any refusal.
    expect(readFileSync(base, 'utf8')).toBe(before);
  });
});

describe('the smoke runs alone, serially, outside npm test', () => {
  const pkg: unknown = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const scripts = isRecord(pkg) && isRecord(pkg.scripts) ? pkg.scripts : {};

  it('npm test excludes harness/ and a dedicated script runs this file with --no-file-parallelism', () => {
    const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
    expect(config).toMatch(/exclude:\s*\[[^\]]*'\*\*\/harness\/\*\*'/);
    expect(scripts.test).toBe('vitest run');
    const smoke = scripts['test:perf-smoke'];
    expect(typeof smoke).toBe('string');
    expect(smoke).toMatch(/vitest run\b/);
    expect(smoke).toMatch(/--config vitest\.perf-smoke\.config\.ts/);
    expect(smoke).toMatch(/--no-file-parallelism/);
    const smokeConfig = readFileSync(join(ROOT, 'vitest.perf-smoke.config.ts'), 'utf8');
    expect(smokeConfig).toContain('harness/perf/smoke.test.ts');
    expect(smokeConfig).toMatch(/fileParallelism:\s*false/);
  });

  it('ci.yml runs it as its own perf-smoke job and the gate requires that job', () => {
    const doc: unknown = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'));
    const jobs = isRecord(doc) && isRecord(doc.jobs) ? doc.jobs : {};
    const smoke = isRecord(jobs['perf-smoke']) ? jobs['perf-smoke'] : null;
    expect(smoke, 'a perf-smoke job').not.toBeNull();
    const steps = smoke && Array.isArray(smoke.steps) ? smoke.steps : [];
    const runs = steps.map((s: unknown) => (isRecord(s) && typeof s.run === 'string' ? s.run : ''));
    expect(runs.some((r: string) => /\bnpm run test:perf-smoke\b/.test(r))).toBe(true);
    // The parallel suite's job must not run the smoke as well.
    const test = isRecord(jobs.test) ? jobs.test : {};
    const testRuns = (Array.isArray(test.steps) ? test.steps : []).map((s: unknown) => (isRecord(s) && typeof s.run === 'string' ? s.run : ''));
    expect(testRuns.join('\n')).not.toMatch(/perf-smoke/);

    const gate = isRecord(jobs.gate) ? jobs.gate : {};
    expect(Array.isArray(gate.needs) ? gate.needs : []).toContain('perf-smoke');
    const gateSteps = Array.isArray(gate.steps) ? gate.steps : [];
    const results = gateSteps.map((s: unknown) => (isRecord(s) && isRecord(s.env) && typeof s.env.RESULTS === 'string' ? s.env.RESULTS : '')).join('\n');
    expect(results).toContain('perf-smoke=${{ needs.perf-smoke.result }}');
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
