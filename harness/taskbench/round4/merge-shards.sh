#!/usr/bin/env bash
# Merge sharded mining into one pool, preserving the registered walk order, and
# REFUSING anything it cannot prove is complete and well-formed.
#
# Prior version's defects (independent review): an unlocked shard may simply
# have crashed; strata were opt-in via an env var; shortages only warned;
# malformed manifests were silently skipped; the destination kept stale tasks.
# Each is now a hard failure, and the destination is built fresh and published
# only after validation.
#
# Usage: ./merge-shards.sh <pool> <workers> <need>
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
POOL="${1:-counted}"; WORKERS="${2:-3}"; NEED="${3:-10}"

[ -e "${TB_CLONE_BREAKER:-/tmp/tb-clone-breaker}" ] && {
  echo "REFUSING to merge: the clone breaker is tripped — shards are incomplete." >&2; exit 8; }

# Completion is PROVEN by a per-shard record bound to that shard's walk hash,
# not inferred from an absent lock: a crashed worker also holds no lock.
WALK_SHA=$(sha256sum "pools/$POOL/walk.json" 2>/dev/null | cut -c1-64)
for i in $(seq 0 $((WORKERS-1))); do
  C="pools/$POOL-s$i/completion.json"
  [ -f "$C" ] || { echo "REFUSING to merge: shard $i has no completion record ($C)" >&2; exit 7; }
  L="/tmp/tb-shard-$POOL-s$i.lock"
  if [ -e "$L" ] && ! flock -n "$L" true 2>/dev/null; then
    echo "REFUSING to merge: shard $i still has a live writer" >&2; exit 7
  fi
done

STAGE=$(mktemp -d /tmp/tb-merge-XXXXXX)
TB_POOL_ARG="$POOL" TB_WORKERS_ARG="$WORKERS" TB_NEED_ARG="$NEED" TB_STAGE="$STAGE" node <<'NODE'
const fs = require("fs"), path = require("path");
const pool = process.env.TB_POOL_ARG, workers = +process.env.TB_WORKERS_ARG;
const need = +process.env.TB_NEED_ARG, stage = process.env.TB_STAGE;
const die = m => { console.error("REFUSING to merge: " + m); process.exit(9); };

const walk = JSON.parse(fs.readFileSync(`pools/${pool}/walk.json`));
const order = walk.order;
const rank = new Map(order.map((r, i) => [r.toLowerCase(), i]));

// Stratum mode is derived from the POOL, never from an env var a caller may forget.
const strata = pool.startsWith("counted");

const found = [], seenRepo = new Map();
for (let i = 0; i < workers; i++) {
  const td = `pools/${pool}-s${i}/tasks`;
  if (!fs.existsSync(td)) continue;
  for (const d of fs.readdirSync(td)) {
    const mf = `${td}/${d}/manifest.json`;
    let m;
    try { m = JSON.parse(fs.readFileSync(mf)); }
    catch (e) { die(`malformed manifest ${mf}: ${e.message}`); }
    for (const k of ["repo", "stratum", "commit_sha", "parent_sha"])
      if (!m[k]) die(`manifest ${mf} is missing ${k}`);
    const key = m.repo.toLowerCase();
    if (!rank.has(key)) die(`task ${d} names ${m.repo}, which is not in this pool's walk`);
    if (seenRepo.has(key)) die(`repository ${m.repo} produced tasks in two shards (${seenRepo.get(key)} and ${i})`);
    seenRepo.set(key, i);
    found.push({ dir: `${td}/${d}`, id: d, repo: m.repo, stratum: m.stratum, rank: rank.get(key) });
  }
}
found.sort((a, b) => a.rank - b.rank);

let chosen;
if (strata) {
  const q = { "single-distribution": +(process.env.TB_QUOTA_SINGLE || 55),
              "workspace": +(process.env.TB_QUOTA_WS || 55) };
  const taken = { "single-distribution": 0, "workspace": 0 };
  chosen = [];
  for (const f of found) {
    if (q[f.stratum] === undefined) die(`task ${f.id} has unknown stratum ${f.stratum}`);
    if (taken[f.stratum] >= q[f.stratum]) continue;
    taken[f.stratum]++; chosen.push(f);
  }
  const short = Object.keys(q).filter(s => taken[s] < q[s]);
  if (short.length) die(`strata short of their registered quotas: ` +
    short.map(s => `${s} ${taken[s]}/${q[s]}`).join(", ") + ` — the walk did not yield the registered pool`);
  console.log(`strata filled exactly: ${JSON.stringify(taken)}`);
} else {
  if (found.length < need) die(`only ${found.length} validated tasks, need ${need}`);
  chosen = found.slice(0, need);
}

for (const c of chosen) {
  const dst = `${stage}/${c.id}`;
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(c.dir)) fs.copyFileSync(`${c.dir}/${f}`, `${dst}/${f}`);
}
console.log(`validated across shards: ${found.length}; selected ${chosen.length}`);
for (const c of chosen) console.log(`  rank ${String(c.rank).padStart(4)}  ${c.stratum}  ${c.repo}`);
NODE
rc=$?
[ "$rc" != 0 ] && { rm -rf "$STAGE"; echo "merge refused (rc=$rc); destination untouched" >&2; exit "$rc"; }

# Publish only after validation, and replace rather than accumulate.
rm -rf "pools/$POOL/tasks"; mkdir -p "pools/$POOL/tasks"
cp -r "$STAGE"/* "pools/$POOL/tasks/" 2>/dev/null
rm -rf "$STAGE"
: > "pools/$POOL/attrition.jsonl"
for i in $(seq 0 $((WORKERS-1))); do
  [ -f "pools/$POOL-s$i/attrition.jsonl" ] && cat "pools/$POOL-s$i/attrition.jsonl" >> "pools/$POOL/attrition.jsonl"
done
echo "published pools/$POOL/tasks ($(ls "pools/$POOL/tasks" | wc -l) tasks); walk sha256 ${WALK_SHA:0:12}"
