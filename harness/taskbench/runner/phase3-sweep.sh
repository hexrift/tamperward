#!/usr/bin/env bash
# Taskbench Phase-3 sweep driver (DESIGN §8, PREDICTION-taskbench.md §3).
# Runs the 27 counted pairs in the registered pair order, each pair's arms
# consecutively in the registered arm order, fresh session per trajectory.
# Pair and arm orders are re-derived from the published seeds at runtime so
# the executed order is provably the registered one.
#
# Infrastructure rules (frozen): a trajectory that produces no verdict line
# gets ONE retry from a clean state; a second failure is logged as
# INFRASTRUCTURE_FAILURE in deviations.jsonl and the sweep continues. A
# GATE_NOT_LIVE result aborts the whole sweep (systematic treatment failure,
# not a task problem). Results go to runs-phase3/ (TB_RUNS), never mixed
# with pilot artifacts in runs/.
set -uo pipefail
cd "$(dirname "$0")/.."
export TB_MODEL="claude-haiku-4-5-20251001"
export TB_RUNS="$PWD/runs-phase3"
mkdir -p "$TB_RUNS"
RESULTS="$TB_RUNS/results.jsonl"; touch "$RESULTS"
DEVIATIONS="$TB_RUNS/deviations.jsonl"
LOG="$TB_RUNS/phase3-log.txt"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { echo "$(ts) $*" | tee -a "$LOG"; }

# Registered orders, re-derived from the published seeds (PREDICTION §3).
ORDERS=$(node - <<'EOF'
const crypto=require('crypto'), fs=require('fs');
const tasks=fs.readdirSync('tasks').filter(d=>JSON.parse(fs.readFileSync(`tasks/${d}/manifest.json`)).role==='main').sort();
const PAIR='taskbench-phase3-pair-order-v1-2026-08-29';
const ARM='taskbench-phase3-arm-order-v1-2026-08-29';
const order=tasks.map(t=>[crypto.createHash('sha256').update(`${PAIR}:${t}`).digest('hex'),t]).sort().map(x=>x[1]);
for(const t of order){
  const b=crypto.createHash('sha256').update(`${ARM}:${t}`).digest()[0];
  console.log(`${t} ${b%2===0?'ungated gated':'gated ungated'}`);
}
EOF
)

have() { # have <task> <arm> -> 0 if a verdict line already exists
  jq -e --arg t "$1" --arg a "$2" 'select(.task==$t and .arm==$a)' "$RESULTS" >/dev/null 2>&1
}

disk_guard() {
  local free
  free=$(df --output=avail -B1G /tmp | tail -1 | tr -d ' ')
  if [ "${free:-0}" -lt 3 ]; then
    say "disk low (${free}G) — cleaning stale /tmp/tb-run-* dirs"
    find /tmp -maxdepth 1 -name 'tb-run-*' -mmin +5 -exec rm -rf {} + 2>/dev/null
    free=$(df --output=avail -B1G /tmp | tail -1 | tr -d ' ')
    if [ "${free:-0}" -lt 3 ]; then say "ABORT: disk still low (${free}G)"; exit 2; fi
  fi
}

run_one() { # run_one <task> <arm> -> 0 verdict landed, 1 infra-failed, 2 gate-not-live
  local task="$1" arm="$2" attempt out
  for attempt in 1 2; do
    disk_guard
    local before; before=$(wc -l <"$RESULTS")
    say "START $task $arm (attempt $attempt)"
    out=$(timeout 2400 "./runner/run-task.sh" "$task" "$arm" </dev/null 2>&1); local rc=$?
    echo "$out" >> "$LOG"
    if echo "$out" | grep -q 'GATE_NOT_LIVE'; then say "GATE_NOT_LIVE on $task $arm — aborting sweep"; return 2; fi
    if [ "$(wc -l <"$RESULTS")" -gt "$before" ]; then
      say "DONE $task $arm: $(tail -1 "$RESULTS" | jq -r .outcome)"
      return 0
    fi
    say "NO VERDICT for $task $arm (rc=$rc) — $([ "$attempt" = 1 ] && echo 'one retry from clean state' || echo 'second failure')"
  done
  echo "{\"ts\":\"$(ts)\",\"task\":\"$task\",\"arm\":\"$arm\",\"event\":\"INFRASTRUCTURE_FAILURE\",\"note\":\"no verdict after one retry; log in phase3-log.txt\"}" >> "$DEVIATIONS"
  return 1
}

checkpoint() {
  git add -A "$TB_RUNS" >/dev/null 2>&1
  git commit -q -m "Taskbench Phase 3: checkpoint after $1" >/dev/null 2>&1 || return 0
  git -C . push -q origin HEAD 2>/dev/null || say "checkpoint push failed for $1 (will retry next pair)"
}

say "PHASE 3 SWEEP START model=$TB_MODEL results=$RESULTS"
# The pair loop reads from fd 3, never stdin: loop-body children (npm, the
# agent CLI, git) must not be able to consume the remaining order lines — the
# first sweep launch died after pair 1 exactly this way.
pair_n=0
while read -r -u 3 task first second; do
  pair_n=$((pair_n+1))
  for arm in "$first" "$second"; do
    if have "$task" "$arm"; then say "SKIP $task $arm (verdict exists)"; continue; fi
    run_one "$task" "$arm"; rc=$?
    [ "$rc" = 2 ] && exit 3
  done
  rm -rf /tmp/tb-run-* 2>/dev/null
  checkpoint "pair $pair_n/27 ($task)"
done 3<<< "$ORDERS"
say "PHASE 3 SWEEP COMPLETE: $(wc -l <"$RESULTS") verdicts, $( [ -f "$DEVIATIONS" ] && wc -l <"$DEVIATIONS" || echo 0) deviations"
