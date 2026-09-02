#!/usr/bin/env bash
# FROZEN ROUND-3 ARTIFACT — the one-shot continuation driver for the 2026-09-01
# outage; behaviour is not changed here. Status: unwired, historical — not run
# by CI or by any later sweep, and not to be re-run (the continuation it
# authorized has happened). How it was run: `bash runner/phase3-sweep3-continue.sh`
# from harness/taskbench with the round-3 registration in place. KNOWN DEFECT
# inherited from phase3-sweep3.sh: the inter-pair cleanup is a host-wide
# `rm -rf /tmp/tb3-run-*` wildcard that deletes every such workspace on the
# machine. Superseded by phase3-sweep31.sh (sweep_workdirs: only this sweep's
# own ledger-referenced workspaces).
#
# Taskbench ROUND-3 CONTINUATION driver — completes registered trajectories
# that never started (deviations.jsonl DEVIATION_CORRECTION, 2026-09-01: a
# container restart moved the egress proxy port; every remaining clone failed
# before environment construction and before agent invocation).
#
# Strict continuation conditions (owner-authorized, pre-execution):
#  - exactly the pairs with a logged INFRASTRUCTURE_FAILURE and NO verdict
#  - registered pair order and arm order, re-derived from the published seeds
#  - identical frozen model/prompt/tasks/treatment/budgets (same run-task3.sh)
#  - completed pairs are never re-run (a verdict short-circuits the task)
#  - continuation verdicts annotated attempt=2; failure records untouched
#  - ONE clean attempt: a repeat systemic network failure ABORTS immediately
#    and is documented, rather than burning the remaining pairs
set -uo pipefail
cd "$(dirname "$0")/.."
REGISTERED_MODEL="claude-haiku-4-5-20251001"
if [ -n "${TB_MODEL:-}" ] && [ "$TB_MODEL" != "$REGISTERED_MODEL" ]; then
  echo "ABORT: TB_MODEL='$TB_MODEL' differs from registered '$REGISTERED_MODEL'"; exit 7
fi
export TB_MODEL="$REGISTERED_MODEL" TB_REGISTERED_MODEL="$REGISTERED_MODEL"
export TB_AGENT_SECS=3000 TB_NETJAIL=1
export TB_TASKS="$PWD/round3/tasks" TB_RUNS="$PWD/round3/runs-phase3"
RESULTS="$TB_RUNS/results.jsonl"; DEVIATIONS="$TB_RUNS/deviations.jsonl"
LOG="$TB_RUNS/phase3-log.txt"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { echo "$(ts) $*" | tee -a "$LOG"; }

# PREFLIGHT: the exact failure that stopped the sweep must be gone before we start
say "CONTINUATION PREFLIGHT: egress + environment"
timeout 20 git ls-remote --heads https://github.com/aio-libs/multidict.git >/dev/null 2>&1 \
  || { say "ABORT: preflight clone check failed — infrastructure still broken, nothing attempted"; exit 8; }
bash runner/net-jail.sh selftest preflight >/dev/null 2>&1 \
  || { say "ABORT: net-jail selftest failed — enforcement not available"; exit 8; }
say "preflight OK (proxy=${HTTPS_PROXY:-unset})"

disk_guard() {
  local free_kb; free_kb=$(df --output=avail / | tail -1 | tr -d ' ')
  if [ "$free_kb" -lt 3000000 ]; then
    rm -rf /root/.cache/uv /root/.npm/_cacache /tmp/tb3-run-* 2>/dev/null
    free_kb=$(df --output=avail / | tail -1 | tr -d ' ')
    [ "$free_kb" -lt 3000000 ] && { say "ABORT: disk below 3GB"; exit 5; }
  fi
}

ORDERS=$(node - <<'NODE'
const crypto=require('crypto'), fs=require('fs');
const tasks=fs.readdirSync('round3/tasks').filter(d=>JSON.parse(fs.readFileSync(`round3/tasks/${d}/manifest.json`)).role==='main').sort();
const PAIR='taskbench3-phase3-pair-order-v1-2026-08-31';
const ARM='taskbench3-phase3-arm-order-v1-2026-08-31';
const order=tasks.map(t=>[crypto.createHash('sha256').update(`${PAIR}:${t}`).digest('hex'),t]).sort().map(x=>x[1]);
for(const t of order){
  const b=crypto.createHash('sha256').update(`${ARM}:${t}`).digest()[0];
  console.log(`${t} ${b%2===0?'ungated gated':'gated ungated'}`);
}
NODE
)
have() { jq -e --arg t "$1" --arg a "$2" 'select(.task==$t and .arm==$a)' "$RESULTS" >/dev/null 2>&1; }
never_started() {
  jq -e --arg t "$1" --arg a "$2" 'select(.task==$t and .arm==$a and .event=="INFRASTRUCTURE_FAILURE")' \
    "$DEVIATIONS" >/dev/null 2>&1
}

run_one() {   # frozen per-trajectory retry policy, unchanged
  local task="$1" arm="$2"
  for attempt in 1 2; do
    disk_guard
    local before; before=$(wc -l <"$RESULTS")
    say "START(continuation) $task $arm (inner attempt $attempt)"
    out=$(timeout 4200 "./runner/run-task3.sh" "$task" "$arm" </dev/null 2>&1); local rc=$?
    echo "$out" >> "$LOG"
    if echo "$out" | grep -qE 'GATE_NOT_LIVE|WATCH_NOT_LIVE'; then say "treatment not live — aborting"; return 2; fi
    # systemic-network stop rule: do NOT burn the remaining pairs
    if echo "$out" | grep -q 'CLONE_FAILED'; then say "SYSTEMIC NETWORK FAILURE on $task $arm — aborting continuation"; return 3; fi
    if [ "$(wc -l <"$RESULTS")" -gt "$before" ]; then
      # annotate the continuation verdict; the failed-launch records stay untouched
      tmp=$(mktemp); head -n -1 "$RESULTS" > "$tmp"
      tail -1 "$RESULTS" | jq -c '. + {attempt:2, continuation:"post-proxy-outage"}' >> "$tmp"
      mv "$tmp" "$RESULTS"
      say "DONE(continuation) $task $arm: $(tail -1 "$RESULTS" | jq -r .outcome)"
      return 0
    fi
    say "NO VERDICT for $task $arm (rc=$rc) — $([ "$attempt" = 1 ] && echo 'one retry from clean state' || echo 'second failure')"
  done
  echo "{\"ts\":\"$(ts)\",\"task\":\"$task\",\"arm\":\"$arm\",\"event\":\"INFRASTRUCTURE_FAILURE\",\"phase\":\"continuation\",\"note\":\"no verdict after one retry under restored infrastructure\"}" >> "$DEVIATIONS"
  return 1
}
checkpoint() {
  git add -A "$TB_RUNS" >/dev/null 2>&1
  git commit -q -m "Taskbench round 3 Phase 3 continuation: checkpoint after $1" >/dev/null 2>&1 || return 0
  git push -q origin HEAD:refs/heads/round3/sweep-checkpoints 2>/dev/null || say "checkpoint push failed for $1"
}

say "ROUND-3 CONTINUATION START model=$TB_MODEL"
mapfile -t PAIRS <<< "$ORDERS"
n=0
for line in "${PAIRS[@]}"; do
  read -r task first second <<< "$line"
  for arm in "$first" "$second"; do
    have "$task" "$arm" && continue                     # completed pairs are never re-run
    never_started "$task" "$arm" || continue            # only the never-started set
    run_one "$task" "$arm"; rc=$?
    [ "$rc" = 2 ] && { say "CONTINUATION ABORTED (treatment not live)"; exit 3; }
    [ "$rc" = 3 ] && { say "CONTINUATION ABORTED (systemic network) — documented, not retried"; exit 4; }
    n=$((n+1))
  done
  rm -rf /tmp/tb3-run-* 2>/dev/null
  checkpoint "$task"
done
say "ROUND-3 CONTINUATION COMPLETE: $n trajectories attempted; $(wc -l <"$RESULTS") total verdicts"
