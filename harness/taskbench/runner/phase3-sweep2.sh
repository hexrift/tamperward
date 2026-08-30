#!/usr/bin/env bash
# Taskbench ROUND-2 sweep driver (DESIGN §8, PREDICTION2-taskbench.md §3).
# Runs the 22 counted pairs in the registered pair order, each pair's arms
# consecutively in the registered arm order, fresh session per trajectory.
# Orders re-derived from the published v2 seeds at runtime so the executed
# order is provably the registered one. Treatment: the full 1.9.0 stack
# (TB_STACK=full → gate + watch daemon + sweep-then-verify Stop wrapper).
#
# Infrastructure rules (frozen, round-1 verbatim): no verdict → ONE retry
# from clean state; second failure → INFRASTRUCTURE_FAILURE in
# deviations.jsonl, sweep continues. GATE_NOT_LIVE or WATCH_NOT_LIVE aborts
# the whole sweep (systematic treatment failure). Results in round2/runs-phase3.
set -uo pipefail
cd "$(dirname "$0")/.."
export TB_MODEL="claude-haiku-4-5-20251001"
export TB_TASKS="$PWD/round2/tasks"
export TB_RUNS="$PWD/round2/runs-phase3"
export TB_STACK="full"
mkdir -p "$TB_RUNS"
RESULTS="$TB_RUNS/results.jsonl"; touch "$RESULTS"
DEVIATIONS="$TB_RUNS/deviations.jsonl"
LOG="$TB_RUNS/phase3-log.txt"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { echo "$(ts) $*" | tee -a "$LOG"; }

disk_guard() {
  local free_kb; free_kb=$(df --output=avail / | tail -1 | tr -d ' ')
  if [ "$free_kb" -lt 3000000 ]; then
    # the known regrowing eater first, then re-check
    rm -rf /root/.local/share/pnpm/store /root/.npm/_cacache /tmp/tb-run-* 2>/dev/null
    free_kb=$(df --output=avail / | tail -1 | tr -d ' ')
    [ "$free_kb" -lt 3000000 ] && { say "ABORT: disk below 3GB after sweep"; exit 5; }
  fi
}

# Registered orders, re-derived from the published seeds (PREDICTION2 §3).
ORDERS=$(node - <<'EOF'
const crypto=require('crypto'), fs=require('fs');
const tasks=fs.readdirSync('round2/tasks').filter(d=>JSON.parse(fs.readFileSync(`round2/tasks/${d}/manifest.json`)).role==='main').sort();
const PAIR='taskbench2-phase3-pair-order-v1-2026-08-30';
const ARM='taskbench2-phase3-arm-order-v1-2026-08-30';
const order=tasks.map(t=>[crypto.createHash('sha256').update(`${PAIR}:${t}`).digest('hex'),t]).sort().map(x=>x[1]);
for(const t of order){
  const b=crypto.createHash('sha256').update(`${ARM}:${t}`).digest()[0];
  console.log(`${t} ${b%2===0?'ungated gated':'gated ungated'}`);
}
EOF
)

have() { jq -e --arg t "$1" --arg a "$2" 'select(.task==$t and .arm==$a)' "$RESULTS" >/dev/null 2>&1; }
infra_failed() {
  [ -f "$DEVIATIONS" ] && jq -e --arg t "$1" --arg a "$2" \
    'select(.task==$t and .arm==$a and .event=="INFRASTRUCTURE_FAILURE")' "$DEVIATIONS" >/dev/null 2>&1
}

run_one() {
  local task="$1" arm="$2"
  for attempt in 1 2; do
    disk_guard
    local before; before=$(wc -l <"$RESULTS")
    say "START $task $arm (attempt $attempt)"
    out=$(timeout 3600 "./runner/run-task.sh" "$task" "$arm" </dev/null 2>&1); local rc=$?
    echo "$out" >> "$LOG"
    if echo "$out" | grep -qE 'GATE_NOT_LIVE|WATCH_NOT_LIVE'; then say "treatment not live on $task $arm — aborting sweep"; return 2; fi
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
  git commit -q -m "Taskbench round 2 Phase 3: checkpoint after $1" >/dev/null 2>&1 || return 0
  git push -q origin HEAD 2>/dev/null || say "checkpoint push failed for $1 (will retry next pair)"
}

say "ROUND-2 SWEEP START model=$TB_MODEL stack=$TB_STACK results=$RESULTS"
mapfile -t PAIRS <<< "$ORDERS"
[ "${#PAIRS[@]}" -eq 22 ] || { say "ABORT: derived ${#PAIRS[@]} pairs, expected 22"; exit 4; }
pair_n=0
for line in "${PAIRS[@]}"; do
  read -r task first second <<< "$line"
  pair_n=$((pair_n+1))
  for arm in "$first" "$second"; do
    if have "$task" "$arm"; then say "SKIP $task $arm (verdict exists)"; continue; fi
    if infra_failed "$task" "$arm"; then say "SKIP $task $arm (logged INFRASTRUCTURE_FAILURE — excluded with its log, never silently replaced)"; continue; fi
    run_one "$task" "$arm"; rc=$?
    [ "$rc" = 2 ] && exit 3
  done
  rm -rf /tmp/tb-run-* /tmp/tb-gold-* 2>/dev/null
  checkpoint "pair $pair_n/22 ($task)"
done
say "ROUND-2 SWEEP COMPLETE: $(wc -l <"$RESULTS") verdicts, $( [ -f "$DEVIATIONS" ] && wc -l <"$DEVIATIONS" || echo 0) deviations"
