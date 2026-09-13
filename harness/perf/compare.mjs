// Compare a harness/perf/bench.mjs report against a baseline and fail when any
// item exceeds its budget.
//
//   node harness/perf/compare.mjs --baseline harness/perf/BASELINE.json \
//        --current perf.json [--ratio 2] [--metric wall_ms.p50] [--allow-missing]
//
// The budget is a RATIO to the baseline (default 2x: a doubling of a gate's
// latency is the regression the issue asks to make visible; ordinary machine
// variance on a shared runner is well inside that). A baseline may pin a
// tighter or looser ratio per item under `budgets: { "<item id>": <ratio> }`.
// An item the baseline carries and the current report does not is a failure
// unless --allow-missing is given: a benchmark that silently stopped running is
// the regression nobody sees. Both reports must be the shape bench.mjs writes
// (schema 1, unique string ids, finite wall_ms/cpu_ms percentiles) and the
// selected metric must exist on every baselined item; otherwise the input is
// malformed and the comparison refuses rather than comparing against nothing.
//
// Exit 0 when every item is within budget, 1 when any is over (or missing), 2
// on bad arguments, unreadable or malformed input. Node built-ins only.

import { readFileSync } from 'node:fs';

function parseArgs(argv) {
  const o = { ratio: 2, metric: 'wall_ms.p50', allowMissing: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baseline') o.baseline = argv[++i];
    else if (a === '--current') o.current = argv[++i];
    else if (a === '--ratio') o.ratio = Number(argv[++i]);
    else if (a === '--metric') o.metric = argv[++i];
    else if (a === '--allow-missing') o.allowMissing = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown option "${a}"`);
  }
  return o;
}

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPercentiles(v) {
  return isRecord(v) && Number.isFinite(v.p50) && Number.isFinite(v.p95);
}

/**
 * A report is believed only in the shape bench.mjs writes: schema 1, an items
 * array of records each carrying a string id, `wall_ms` and `cpu_ms` with finite
 * p50/p95, and no id twice. Anything else is a malformed input and the
 * comparison refuses (exit 2) — a baseline that silently lost an item, or a
 * duplicated id whose second entry overwrote the first, would make a regression
 * compare against the wrong number.
 */
function loadItems(path) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(doc) || !Array.isArray(doc.items)) throw new Error(`${path}: not a perf report (no items array)`);
  if (doc.schema !== undefined && doc.schema !== 1) throw new Error(`${path}: unsupported report schema ${JSON.stringify(doc.schema)} (expected 1)`);
  const items = new Map();
  doc.items.forEach((it, i) => {
    if (!isRecord(it) || typeof it.id !== 'string' || !it.id) throw new Error(`${path}: items[${i}] has no string id`);
    if (!isPercentiles(it.wall_ms) || !isPercentiles(it.cpu_ms)) {
      throw new Error(`${path}: item "${it.id}" lacks finite wall_ms/cpu_ms p50 and p95`);
    }
    if (items.has(it.id)) throw new Error(`${path}: duplicate item id "${it.id}"`);
    items.set(it.id, it);
  });
  if (doc.budgets !== undefined && !isRecord(doc.budgets)) throw new Error(`${path}: budgets must be a map of item id to ratio`);
  const budgets = isRecord(doc.budgets) ? doc.budgets : {};
  for (const [id, ratio] of Object.entries(budgets)) {
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) throw new Error(`${path}: budgets["${id}"] must be a positive number`);
  }
  return { items, budgets };
}

function metricOf(item, metric) {
  let v = item;
  for (const key of metric.split('.')) {
    if (!isRecord(v)) return null;
    v = v[key];
  }
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function fmt(n) {
  return n == null ? '—' : n.toFixed(1);
}

function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`compare: ${e.message}\n`);
    return 2;
  }
  if (o.help || !o.baseline || !o.current) {
    process.stderr.write('usage: compare.mjs --baseline <json> --current <json> [--ratio 2] [--metric wall_ms.p50] [--allow-missing]\n');
    return o.help ? 0 : 2;
  }
  if (!Number.isFinite(o.ratio) || o.ratio <= 0) {
    process.stderr.write(`compare: --ratio must be a positive number (got ${o.ratio})\n`);
    return 2;
  }
  let base;
  let cur;
  try {
    base = loadItems(o.baseline);
    cur = loadItems(o.current);
  } catch (e) {
    process.stderr.write(`compare: ${e.message}\n`);
    return 2;
  }

  // The selected metric must exist on every baselined item: a baseline that
  // cannot answer for an item is malformed, never "nothing to compare".
  for (const [id, b] of base.items) {
    if (metricOf(b, o.metric) == null) {
      process.stderr.write(`compare: ${o.baseline}: baseline item "${id}" has no finite metric ${o.metric}\n`);
      return 2;
    }
  }

  const rows = [];
  let failures = 0;
  for (const [id, b] of base.items) {
    const budgetRatio = typeof base.budgets[id] === 'number' ? base.budgets[id] : o.ratio;
    const bv = metricOf(b, o.metric);
    const c = cur.items.get(id);
    const cv = c ? metricOf(c, o.metric) : null;
    if (cv == null) {
      const status = o.allowMissing ? 'missing (allowed)' : 'MISSING';
      if (!o.allowMissing) failures++;
      rows.push({ id, base: bv, cur: cv, ratio: null, budget: budgetRatio, status });
      continue;
    }
    const ratio = bv > 0 ? cv / bv : cv > 0 ? Infinity : 1;
    const over = ratio > budgetRatio;
    if (over) failures++;
    rows.push({ id, base: bv, cur: cv, ratio, budget: budgetRatio, status: over ? `OVER BUDGET (${ratio.toFixed(2)}x > ${budgetRatio}x)` : 'ok' });
  }
  for (const id of cur.items.keys()) {
    if (!base.items.has(id)) rows.push({ id, base: null, cur: metricOf(cur.items.get(id), o.metric), ratio: null, budget: o.ratio, status: 'new (no baseline)' });
  }

  const out = [];
  out.push(`perf compare — metric ${o.metric}, default budget ${o.ratio}x`);
  out.push('');
  out.push('| item | baseline | current | ratio | budget | status |');
  out.push('| --- | ---: | ---: | ---: | ---: | --- |');
  for (const r of rows) {
    out.push(`| ${r.id} | ${fmt(r.base)} | ${fmt(r.cur)} | ${r.ratio == null ? '—' : r.ratio.toFixed(2) + 'x'} | ${r.budget}x | ${r.status} |`);
  }
  out.push('');
  out.push(failures === 0 ? 'perf compare: every item within budget' : `perf compare: ${failures} item(s) over budget or missing`);
  process.stdout.write(out.join('\n') + '\n');
  return failures === 0 ? 0 : 1;
}

process.exit(main());
