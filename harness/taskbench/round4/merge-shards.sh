#!/usr/bin/env bash
# Merge sharded mining back into one pool, preserving the registered walk order.
#
# ITEM 7: the counted pool has strata with registered quotas (55 single-
# distribution + 55 workspace). "First N overall" would let one stratum crowd
# out the other purely by walk position, so each stratum is filled to its own
# quota independently, each in immutable walk order. The pilot has no strata and
# keeps the simple prefix.
#
# ITEM 8: refuses to merge a raced or incomplete set of shards.
#
# Usage: ./merge-shards.sh <pool> <workers> <need>
#        TB_STRATA=1 ./merge-shards.sh counted 3 110
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
POOL="${1:-pilot}"; WORKERS="${2:-4}"; NEED="${3:-10}"
DEST="pools/$POOL"; mkdir -p "$DEST/tasks"

if [ -e "${TB_CLONE_BREAKER:-/tmp/tb-clone-breaker}" ]; then
  echo "REFUSING to merge: the clone breaker is tripped — shards are incomplete." >&2; exit 8
fi
for i in $(seq 0 $((WORKERS-1))); do
  L="/tmp/tb-shard-$POOL-s$i.lock"
  if [ -e "$L" ] && ! flock -n "$L" true 2>/dev/null; then
    echo "REFUSING to merge: shard $i still has a live writer" >&2; exit 7
  fi
done

: > "$DEST/attrition.jsonl"
for i in $(seq 0 $((WORKERS-1))); do
  [ -f "pools/$POOL-s$i/attrition.jsonl" ] && cat "pools/$POOL-s$i/attrition.jsonl" >> "$DEST/attrition.jsonl"
done

TB_POOL_ARG="$POOL" TB_WORKERS_ARG="$WORKERS" TB_NEED_ARG="$NEED" node <<'NODE'
const fs = require("fs");
const pool = process.env.TB_POOL_ARG, workers = +process.env.TB_WORKERS_ARG, need = +process.env.TB_NEED_ARG;
const order = JSON.parse(fs.readFileSync(`pools/${pool}/walk.json`)).order;
const rank = new Map(order.map((r, i) => [r.toLowerCase(), i]));
const found = [];
for (let i = 0; i < workers; i++) {
  const td = `pools/${pool}-s${i}/tasks`;
  if (!fs.existsSync(td)) continue;
  for (const d of fs.readdirSync(td)) {
    try {
      const m = JSON.parse(fs.readFileSync(`${td}/${d}/manifest.json`));
      found.push({ dir: `${td}/${d}`, id: d, repo: m.repo, stratum: m.stratum,
                   rank: rank.has(m.repo.toLowerCase()) ? rank.get(m.repo.toLowerCase()) : 1e9 });
    } catch {}
  }
}
found.sort((a, b) => a.rank - b.rank);

let chosen;
if (process.env.TB_STRATA === "1") {
  const q = { "single-distribution": +(process.env.TB_QUOTA_SINGLE || 55),
              "workspace": +(process.env.TB_QUOTA_WS || 55) };
  const taken = { "single-distribution": 0, "workspace": 0 };
  chosen = [];
  for (const f of found) {
    if (q[f.stratum] === undefined || taken[f.stratum] >= q[f.stratum]) continue;
    taken[f.stratum]++; chosen.push(f);
  }
  console.log(`strata filled: ${JSON.stringify(taken)} against quotas ${JSON.stringify(q)}`);
  for (const s of Object.keys(q)) if (taken[s] < q[s])
    console.log(`WARNING: stratum ${s} short by ${q[s] - taken[s]} — the walk did not yield its registered quota`);
} else {
  chosen = found.slice(0, need);
}

for (const c of chosen) {
  const dst = `pools/${pool}/tasks/${c.id}`;
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(c.dir)) fs.copyFileSync(`${c.dir}/${f}`, `${dst}/${f}`);
}
console.log(`validated across shards: ${found.length}; selected ${chosen.length}`);
for (const c of chosen) console.log(`  rank ${String(c.rank).padStart(4)}  ${c.stratum || "-"}  ${c.repo}`);
if (found.length > chosen.length)
  console.log(`NOTE: ${found.length - chosen.length} validated beyond the selection were NOT chosen; they were examined during mining and are pool_dedup either way.`);
NODE
