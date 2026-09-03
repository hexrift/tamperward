#!/usr/bin/env bash
# Round-4 parallel mining driver.
#
# The miner is sequential and each repository costs a clone, an install and a
# pytest run — round 3 spent 5.5 hours emitting 20 tasks that way. Every
# repository's verdict is independent of every other, so the walk shards
# cleanly; the ONLY order-dependent thing is the quota short-circuit, and that
# is recovered by selecting the first N validated tasks in ORIGINAL walk order
# after the shards merge. The selection is therefore identical to what a
# sequential walk would have produced.
#
# This changes how the walk is EXECUTED, not what any gate decides. It is
# logged in DEVIATIONS.md as required.
#
# Usage: TB_POOL=pilot ./mine-parallel.sh [workers]     (default 4)
#        TB_POOL=counted ./mine-parallel.sh 4
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
POOL="${TB_POOL:-pilot}"
WORKERS="${1:-4}"
SRC="pools/$POOL/walk.json"
[ -f "$SRC" ] || { echo "no walk for pool $POOL" >&2; exit 2; }

# Scientific packages spawn their own thread pools; four concurrent pytest runs
# each grabbing every core thrash. One thread per worker, parallelism at the
# repository level where it is free.
export OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1

# Shard the walk round-robin so each worker sees a comparable mix of heavy and
# light repositories rather than one worker inheriting all the monorepos.
node -e '
const fs=require("fs");
const order=JSON.parse(fs.readFileSync(process.argv[1])).order;
const w=+process.argv[2], pool=process.argv[3];
for(let i=0;i<w;i++){
  const dir=`pools/${pool}-s${i}`;
  fs.mkdirSync(dir,{recursive:true});
  if(!fs.existsSync(`${dir}/frame`)) fs.symlinkSync("../../frame",`${dir}/frame`);
  fs.writeFileSync(`${dir}/walk.json`,JSON.stringify({shard:i,of:w,order:order.filter((_,j)=>j%w===i)}));
}
console.log(`sharded ${order.length} repos across ${w} workers`);
' "$SRC" "$WORKERS" "$POOL" || exit 1

pids=()
for i in $(seq 0 $((WORKERS-1))); do
  ( TB_POOL="$POOL-s$i" TB_WORK="/tmp/tb-mine5-$POOL-s$i" \
    TB_PILOT_NEED="${TB_PILOT_NEED:-99}" TB_QUOTA_SINGLE=0 TB_QUOTA_WS=0 \
    ./mine5.sh >> "/tmp/mine-$POOL-s$i.log" 2>&1 ) &
  pids+=($!)
  echo "worker $i -> pid ${pids[-1]}  log /tmp/mine-$POOL-s$i.log"
done
echo "waiting on ${#pids[@]} workers..."
for p in "${pids[@]}"; do wait "$p"; done
echo "all workers finished; merge with: ./merge-shards.sh $POOL $WORKERS"
