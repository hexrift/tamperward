// Promote a `perf` workflow report into harness/perf/BASELINE.json (issue #421).
//
//   node harness/perf/promote-baseline.mjs <perf.json> [--baseline harness/perf/BASELINE.json]
//
// The reference machine for the nightly compare is the hosted runner the `perf`
// workflow runs on, so the reference baseline is a report THAT runner produced:
// the `perf-baseline-candidate` artifact of a green run. This copies such a
// report into place unedited except for three things: the previous baseline's
// per-item `budgets` are carried over verbatim (they are policy, not
// measurement), `machine.ci` is stamped `true` when the report does not already
// name its CI, and any `note` marking the previous baseline as a sandbox
// stand-in is dropped. It prints the old-versus-new p50 wall per item, which is
// the evidence the PR replacing the baseline must carry (docs/PERF.md).
//
// The candidate must be the shape bench.mjs writes (schema 1, unique string ids,
// finite wall_ms/cpu_ms p50 and p95) and must carry every item the previous
// baseline carried: a report from a run that lost an item is not a baseline.
// Exit 0 on success, 2 on bad arguments or a malformed candidate. Node
// built-ins only.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPercentiles(v) {
  return isRecord(v) && Number.isFinite(v.p50) && Number.isFinite(v.p95);
}

/** The report's items keyed by id, or a thrown Error naming what is malformed. */
export function itemsOf(doc, label) {
  if (!isRecord(doc) || !Array.isArray(doc.items)) throw new Error(`${label}: not a perf report (no items array)`);
  if (doc.schema !== undefined && doc.schema !== 1) throw new Error(`${label}: unsupported report schema ${JSON.stringify(doc.schema)} (expected 1)`);
  const items = new Map();
  doc.items.forEach((it, i) => {
    if (!isRecord(it) || typeof it.id !== 'string' || !it.id) throw new Error(`${label}: items[${i}] has no string id`);
    if (!isPercentiles(it.wall_ms) || !isPercentiles(it.cpu_ms)) throw new Error(`${label}: item "${it.id}" lacks finite wall_ms/cpu_ms p50 and p95`);
    if (items.has(it.id)) throw new Error(`${label}: duplicate item id "${it.id}"`);
    items.set(it.id, it);
  });
  if (!isRecord(doc.machine)) throw new Error(`${label}: no machine block (bench.mjs always writes one)`);
  return items;
}

/**
 * The promoted baseline document: the candidate as written by bench.mjs, with
 * the previous baseline's budgets, `machine.ci` stamped, and no `note`.
 */
export function promote(candidate, previous) {
  const items = itemsOf(candidate, 'candidate');
  const prevItems = itemsOf(previous, 'baseline');
  const missing = [...prevItems.keys()].filter((id) => !items.has(id));
  if (missing.length) throw new Error(`candidate lacks baselined item(s): ${missing.join(', ')}`);
  const { note, ...rest } = candidate;
  void note;
  const out = { ...rest, machine: { ...candidate.machine, ci: candidate.machine.ci ?? true } };
  if (isRecord(previous.budgets)) out.budgets = previous.budgets;
  return out;
}

export function table(candidate, previous) {
  const items = itemsOf(candidate, 'candidate');
  const prev = itemsOf(previous, 'baseline');
  const rows = ['| item | old p50 wall ms | new p50 wall ms | factor |', '| --- | ---: | ---: | ---: |'];
  for (const [id, it] of items) {
    const o = prev.get(id);
    rows.push(`| ${id} | ${o ? o.wall_ms.p50 : '—'} | ${it.wall_ms.p50} | ${o ? (it.wall_ms.p50 / o.wall_ms.p50).toFixed(2) + 'x' : 'new'} |`);
  }
  return rows.join('\n') + '\n';
}

function main(argv) {
  let candidatePath = null;
  let baselinePath = join(HERE, 'BASELINE.json');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baseline') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--baseline needs a value');
      baselinePath = resolve(v);
    } else if (a === '--help' || a === '-h') {
      process.stdout.write('usage: promote-baseline.mjs <perf.json> [--baseline harness/perf/BASELINE.json]\n');
      return 0;
    } else if (a.startsWith('-')) throw new Error(`unknown option "${a}"`);
    else if (candidatePath === null) candidatePath = resolve(a);
    else throw new Error(`unexpected argument "${a}"`);
  }
  if (candidatePath === null) throw new Error('usage: promote-baseline.mjs <perf.json> [--baseline harness/perf/BASELINE.json]');
  const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));
  const previous = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const out = promote(candidate, previous);
  writeFileSync(baselinePath, JSON.stringify(out, null, 2) + '\n');
  process.stdout.write(`promoted ${candidatePath} → ${baselinePath} (${out.machine.cpu ?? '?'} × ${out.machine.cores ?? '?'}, ${out.machine.node ?? '?'}, tamperward ${out.tamperward_version ?? '?'}, ci ${JSON.stringify(out.machine.ci)})\n\n`);
  process.stdout.write(table(candidate, previous));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`promote-baseline: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
}
