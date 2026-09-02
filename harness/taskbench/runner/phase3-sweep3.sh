#!/usr/bin/env bash
# FROZEN ROUND-3 ARTIFACT — the driver the round-3 sweep ran under; behaviour
# is not changed here. KNOWN DEFECT: the inter-pair cleanup is
# `rm -rf /tmp/tb3-run-*`, a host-wide wildcard that deletes EVERY such
# workspace on the machine, including a concurrent run's or an unadjudicated
# trajectory's evidence (the 19-pycqa-flake8 incident). Superseded by
# phase3-sweep31.sh (sweep_workdirs: only workspaces this sweep's own ledger
# references, never a wildcard; hygiene-selftest A4 proves it).
#
# Taskbench ROUND-3 sweep driver (DESIGN §8; PREDICTION3-taskbench.md §3).
# Runs the 17 counted pairs in the registered pair order, each pair's arms
# consecutively in the registered arm order, fresh session per trajectory.
# Orders re-derived from the published v3 seeds at runtime so the executed
# order is provably the registered one. Treatment: the frozen v1.14.0
# platform (gate + watch + sweep-then-verify Stop + `tamperward run`
# envelope), model claude-haiku-4-5-20251001 on Claude Code (FRAME3 correction 1).
#
# Infrastructure rules (frozen, round-1 verbatim): no verdict → ONE retry
# from clean state; second failure → INFRASTRUCTURE_FAILURE in
# deviations.jsonl, sweep continues. GATE_NOT_LIVE or WATCH_NOT_LIVE aborts
# the whole sweep (systematic treatment failure). Results in round3/runs-phase3.
set -uo pipefail
cd "$(dirname "$0")/.."
# REGISTERED model, fail-closed (PREDICTION3 §1 + Amendment 2): an inherited
# TB_MODEL naming anything else aborts before a single trajectory
REGISTERED_MODEL="claude-haiku-4-5-20251001"
if [ -n "${TB_MODEL:-}" ] && [ "$TB_MODEL" != "$REGISTERED_MODEL" ]; then
  echo "ABORT: TB_MODEL='$TB_MODEL' differs from registered '$REGISTERED_MODEL'"; exit 7
fi
export TB_MODEL="$REGISTERED_MODEL"
export TB_REGISTERED_MODEL="$REGISTERED_MODEL"
export TB_AGENT_SECS=3000   # registered arm-neutral inner budget, pinned explicitly
export TB_NETJAIL=1         # Amendment 3: OS-level egress enforcement, fail-closed
export TB_TASKS="$PWD/round3/tasks"
export TB_RUNS="$PWD/round3/runs-phase3"
mkdir -p "$TB_RUNS"
RESULTS="$TB_RUNS/results.jsonl"; touch "$RESULTS"
DEVIATIONS="$TB_RUNS/deviations.jsonl"
LOG="$TB_RUNS/phase3-log.txt"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { echo "$(ts) $*" | tee -a "$LOG"; }

disk_guard() {
  local free_kb; free_kb=$(df --output=avail / | tail -1 | tr -d ' ')
  if [ "$free_kb" -lt 3000000 ]; then
    # the known regrowing eaters first (this round's ENOSPC correction), then re-check
    rm -rf /root/.cache/uv /root/.npm/_cacache /tmp/tb3-run-* 2>/dev/null
    free_kb=$(df --output=avail / | tail -1 | tr -d ' ')
    [ "$free_kb" -lt 3000000 ] && { say "ABORT: disk below 3GB after sweep"; exit 5; }
  fi
}

# Registered orders, re-derived from the published seeds (PREDICTION3 §3).
ORDERS=$(node - <<'EOF'
const crypto=require('crypto'), fs=require('fs');
const tasks=fs.readdirSync('round3/tasks').filter(d=>JSON.parse(fs.readFileSync(`round3/tasks/${d}/manifest.json`)).role==='main').sort();
const PAIR='taskbench3-phase3-pair-order-v1-2026-08-31';
const ARM='taskbench3-phase3-arm-order-v1-2026-08-31';
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
    out=$(timeout 4200 "./runner/run-task3.sh" "$task" "$arm" </dev/null 2>&1); local rc=$?
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
  git commit -q -m "Taskbench round 3 Phase 3: checkpoint after $1" >/dev/null 2>&1 || return 0
  git push -q origin HEAD 2>/dev/null || say "checkpoint push failed for $1 (will retry next pair)"
}

say "ROUND-3 SWEEP START model=$TB_MODEL results=$RESULTS"
mapfile -t PAIRS <<< "$ORDERS"
[ "${#PAIRS[@]}" -eq 17 ] || { say "ABORT: derived ${#PAIRS[@]} pairs, expected 17"; exit 4; }
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
  rm -rf /tmp/tb3-run-* 2>/dev/null
  checkpoint "pair $pair_n/17 ($task)"
done
say "ROUND-3 SWEEP COMPLETE: $(wc -l <"$RESULTS") verdicts, $( [ -f "$DEVIATIONS" ] && wc -l <"$DEVIATIONS" || echo 0) deviations"
