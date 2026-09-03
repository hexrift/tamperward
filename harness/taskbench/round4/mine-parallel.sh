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
# All runtime state lives under one directory so a separate process — another
# terminal, or `docker compose exec` into the running container — can read it.
# Defaults to /tmp, which is what every path here was hardcoded to.
TB_RUNTIME_DIR="${TB_RUNTIME_DIR:-/tmp}"; mkdir -p "$TB_RUNTIME_DIR"
POOL="${TB_POOL:-pilot}"
WORKERS="${1:-4}"

# ITEM 6 / D4: sharding the PILOT across the frame is a protocol violation, not
# just a performance choice. FRAME5.md makes a repository development data the
# moment the pilot draws it, so every speculative repository a shard touches is
# BURNT. The first parallel pilot run burned 254 of 500 while producing five
# tasks. The pilot therefore runs with ONE worker; concurrency is available to
# the counted pool, where the walk is not sacrificial.
if [ "$POOL" = pilot ] && [ "$WORKERS" != 1 ]; then
  echo "REFUSING: the pilot pool must be mined sequentially (workers=1)." >&2
  echo "  Every repository a pilot worker touches is burnt (FRAME5.md provenance)," >&2
  echo "  so speculative sharding spends the frame. Re-run with: $0 1" >&2
  exit 3
fi
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

# A shard mines its slice EXHAUSTIVELY (the sentinel need below): no shard can
# see the aggregate task count, so stopping early is merge-shards.sh's job — it
# takes the first N validated tasks in frozen walk order across all shards.
#
# Cloning is serialised across workers by a git shim (see shim/git and
# DEVIATIONS.md D3): concurrent clones aborted and were recorded as terminal
# CLONE_FAILED verdicts. Install and pytest, which dominate the cost, stay
# parallel.
export PATH="$HERE/shim:$PATH"

# ITEM 8: one lock per shard so a relaunch can never leave two processes
# writing the same ledger — the race that produced 123 repositories with
# duplicate terminal verdicts.
if [ -e "${TB_CLONE_BREAKER:-$TB_RUNTIME_DIR/tb-clone-breaker}" ]; then
  echo "REFUSING to launch: the clone breaker is tripped. Clear it only after a" >&2
  echo "  clone stress test on already-spent repositories passes." >&2
  exit 8
fi

pids=(); rc_any=0
for i in $(seq 0 $((WORKERS-1))); do
  ( exec 9>"$TB_RUNTIME_DIR/tb-shard-$POOL-s$i.lock"
    flock -n 9 || { echo "REFUSING shard $i: another worker holds its lock" >&2; exit 7; }
    TB_POOL="$POOL-s$i" TB_WORK="$TB_RUNTIME_DIR/tb-mine5-$POOL-s$i" \
    TB_TASK_NEED="${TB_TASK_NEED:-999999}" \
    ./mine5.sh >> "$TB_RUNTIME_DIR/mine-$POOL-s$i.log" 2>&1 ) &
  pids+=($!)
  echo "worker $i -> pid ${pids[-1]}  log $TB_RUNTIME_DIR/mine-$POOL-s$i.log"
done
echo "waiting on ${#pids[@]} workers..."
# ITEM 8: a non-zero worker status must propagate, not be swallowed.
# `if ! wait "$p"; then rc=$?` captures the status of the NEGATION, which is
# always 0 — the bug that let failed workers look clean. Capture in the else.
for idx in "${!pids[@]}"; do
  if wait "${pids[$idx]}"; then :; else
    rc=$?; rc_any=$rc; echo "worker $idx exited non-zero (rc=$rc)" >&2
    # First failure stops the rest: a walk continuing past an infrastructure
    # failure poisons repositories it will never be able to re-walk.
    for other in "${pids[@]}"; do kill -TERM "$other" 2>/dev/null; done
  fi
done
if [ -e "${TB_CLONE_BREAKER:-$TB_RUNTIME_DIR/tb-clone-breaker}" ]; then
  echo "INFRASTRUCTURE_FAILURE: the clone breaker tripped; shards are incomplete." >&2
  echo "  Clear ${TB_CLONE_BREAKER:-$TB_RUNTIME_DIR/tb-clone-breaker} only after a clone stress test passes." >&2
  exit 8
fi
[ "$rc_any" != 0 ] && { echo "a worker failed (rc=$rc_any); NOT safe to merge" >&2; exit "$rc_any"; }
echo "all workers finished cleanly; merge with: ./merge-shards.sh $POOL $WORKERS"
