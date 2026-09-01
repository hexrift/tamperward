#!/usr/bin/env bash
# Taskbench ROUND-3.1 sweep driver — protocol identical to the frozen round-3
# driver plus the ROUND3.1-PLAN execution-hygiene items. REFUSES TO RUN until
# the registration step fills the model pin: hygiene work cannot start a
# counted trajectory by accident.
#   H4 circuit breaker in the MAIN driver (promoted from the round-3
#      continuation driver): a PREFLIGHT_NET_FAILED or CLONE_FAILED aborts
#      the sweep immediately with untouched trajectories left UNATTEMPTED —
#      never burned through their retry budgets into INFRASTRUCTURE_FAILURE.
#      Resume = rerun this driver; it skips existing verdicts and re-attempts
#      only what never produced one. Failed-launch records, when they do
#      occur, are permanent (append-only) and never overwritten.
#   H5 checkpoints push to a NON-PROTECTED checkpoint branch and FAIL LOUDLY
#      (round 3's pushes to protected main failed silently for 8 pairs).
#   TB_ATTEMPT increments per driver invocation via the attempts ledger, so
#      continuation runs are natively attempt-stamped (H3 in the runner).
set -uo pipefail
cd "$(dirname "$0")/.."

# ---- REGISTRATION GATE: filled by PREDICTION3.1, before which this driver
# will not execute a single trajectory ----
REGISTERED_MODEL="__SET_AT_REGISTRATION__"
PAIR_SEED="__SET_AT_REGISTRATION__"
ARM_SEED="__SET_AT_REGISTRATION__"
case "$REGISTERED_MODEL" in __SET_AT_REGISTRATION__*)
  echo "ABORT: round-3.1 is not registered — REGISTERED_MODEL/seeds unset (PREDICTION3.1 fills them)"; exit 7 ;;
esac
if [ -n "${TB_MODEL:-}" ] && [ "$TB_MODEL" != "$REGISTERED_MODEL" ]; then
  echo "ABORT: TB_MODEL='$TB_MODEL' differs from registered '$REGISTERED_MODEL'"; exit 7
fi
export TB_MODEL="$REGISTERED_MODEL" TB_REGISTERED_MODEL="$REGISTERED_MODEL"
export TB_AGENT_SECS=3000 TB_NETJAIL=1
export TB_TASKS="$PWD/round3/tasks"           # the frozen round-3 pool, verbatim
export TB_RUNS="$PWD/round3.1/runs-phase3"
CKPT_REF="refs/heads/round3.1/sweep-checkpoints"   # H5: non-protected
mkdir -p "$TB_RUNS"
RESULTS="$TB_RUNS/results.jsonl"; touch "$RESULTS"
DEVIATIONS="$TB_RUNS/deviations.jsonl"
LOG="$TB_RUNS/phase3-log.txt"
ATTEMPTS="$TB_RUNS/driver-attempts.log"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { echo "$(ts) $*" | tee -a "$LOG"; }

# attempt number = 1 + completed prior driver invocations (H3/H4 resumability)
echo "$(ts) driver-start" >> "$ATTEMPTS"
export TB_ATTEMPT=$(grep -c driver-start "$ATTEMPTS")

disk_guard() {
  local free_kb; free_kb=$(df --output=avail / | tail -1 | tr -d ' ')
  if [ "$free_kb" -lt 3000000 ]; then
    rm -rf /root/.cache/uv /root/.npm/_cacache /tmp/tb3-run-* 2>/dev/null
    free_kb=$(df --output=avail / | tail -1 | tr -d ' ')
    [ "$free_kb" -lt 3000000 ] && { say "ABORT: disk below 3GB"; exit 5; }
  fi
}

# sweep-level preflight (in addition to the runner's per-trajectory H2)
say "SWEEP PREFLIGHT"
timeout 20 git ls-remote --heads https://github.com/aio-libs/multidict.git >/dev/null 2>&1 \
  || { say "ABORT: sweep preflight failed — nothing attempted"; exit 8; }
bash runner/net-jail.sh selftest preflight >/dev/null 2>&1 \
  || { say "ABORT: net-jail selftest failed"; exit 8; }
say "preflight OK"

ORDERS=$(PAIR_SEED="$PAIR_SEED" ARM_SEED="$ARM_SEED" node - <<'NODE'
const crypto=require('crypto'), fs=require('fs');
const tasks=fs.readdirSync('round3/tasks').filter(d=>JSON.parse(fs.readFileSync(`round3/tasks/${d}/manifest.json`)).role==='main').sort();
const PAIR=process.env.PAIR_SEED, ARM=process.env.ARM_SEED;
const order=tasks.map(t=>[crypto.createHash('sha256').update(`${PAIR}:${t}`).digest('hex'),t]).sort().map(x=>x[1]);
for(const t of order){
  const b=crypto.createHash('sha256').update(`${ARM}:${t}`).digest()[0];
  console.log(`${t} ${b%2===0?'ungated gated':'gated ungated'}`);
}
NODE
)
have() { jq -e --arg t "$1" --arg a "$2" 'select(.task==$t and .arm==$a)' "$RESULTS" >/dev/null 2>&1; }

run_one() {
  local task="$1" arm="$2"
  for attempt in 1 2; do
    disk_guard
    local before; before=$(wc -l <"$RESULTS")
    say "START $task $arm (attempt $attempt, driver pass $TB_ATTEMPT)"
    out=$(timeout 4200 "./runner/run-task31.sh" "$task" "$arm" </dev/null 2>&1); local rc=$?
    echo "$out" >> "$LOG"
    if echo "$out" | grep -qE 'GATE_NOT_LIVE|WATCH_NOT_LIVE'; then say "treatment not live — aborting sweep"; return 2; fi
    # H4 circuit breaker: systemic network failure aborts, leaving the rest UNATTEMPTED
    if [ "$rc" -eq 8 ] || echo "$out" | grep -q 'CLONE_FAILED'; then
      say "SYSTEMIC NETWORK FAILURE on $task $arm — circuit breaker: aborting sweep, remaining trajectories left unattempted (resume by rerunning this driver)"
      return 3
    fi
    if [ "$(wc -l <"$RESULTS")" -gt "$before" ]; then
      say "DONE $task $arm: $(tail -1 "$RESULTS" | jq -r .outcome)"
      return 0
    fi
    say "NO VERDICT for $task $arm (rc=$rc) — $([ "$attempt" = 1 ] && echo 'one retry from clean state' || echo 'second failure')"
  done
  echo "{\"ts\":\"$(ts)\",\"task\":\"$task\",\"arm\":\"$arm\",\"event\":\"INFRASTRUCTURE_FAILURE\",\"driver_pass\":$TB_ATTEMPT,\"note\":\"no verdict after one retry; log in phase3-log.txt\"}" >> "$DEVIATIONS"
  return 1
}

checkpoint() {   # H5: non-protected ref, loud on failure
  git add -A "$TB_RUNS" >/dev/null 2>&1
  git commit -q -m "Taskbench round 3.1: checkpoint after $1" >/dev/null 2>&1 || return 0
  git push -q origin "HEAD:$CKPT_REF" 2>/dev/null \
    || say "CHECKPOINT PUSH FAILED for $1 — results exist only locally until a push succeeds"
}

say "ROUND-3.1 SWEEP START model=$TB_MODEL driver-pass=$TB_ATTEMPT results=$RESULTS"
mapfile -t PAIRS <<< "$ORDERS"
[ "${#PAIRS[@]}" -eq 17 ] || { say "ABORT: derived ${#PAIRS[@]} pairs, expected 17"; exit 4; }
pair_n=0
for line in "${PAIRS[@]}"; do
  read -r task first second <<< "$line"
  pair_n=$((pair_n+1))
  for arm in "$first" "$second"; do
    if have "$task" "$arm"; then say "SKIP $task $arm (verdict exists)"; continue; fi
    run_one "$task" "$arm"; rc=$?
    [ "$rc" = 2 ] && exit 3
    [ "$rc" = 3 ] && { checkpoint "circuit-breaker at pair $pair_n"; exit 4; }
  done
  rm -rf /tmp/tb3-run-* 2>/dev/null
  checkpoint "pair $pair_n/17 ($task)"
done
say "ROUND-3.1 SWEEP COMPLETE: $(wc -l <"$RESULTS") verdicts, $( [ -f "$DEVIATIONS" ] && wc -l <"$DEVIATIONS" || echo 0) deviations, driver passes: $TB_ATTEMPT"
