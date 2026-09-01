#!/usr/bin/env bash
# Taskbench ROUND-3.1 sweep driver — protocol identical to the frozen round-3
# driver plus the ROUND3.1-PLAN execution-hygiene items. REFUSES TO RUN until
# the registration step fills the model pin AND both seeds: hygiene work cannot
# start a counted trajectory by accident.
#   H4 circuit breaker in the MAIN driver (promoted from the round-3
#      continuation driver): a shared-infrastructure preflight failure (the
#      runner's rc=8) aborts the sweep immediately with untouched trajectories
#      left UNATTEMPTED — never burned through their retry budgets into
#      INFRASTRUCTURE_FAILURE. A CLONE_FAILED is only treated as systemic when
#      the shared preflight ALSO fails at that moment; otherwise it is a
#      trajectory-local failure and takes the ordinary retry path.
#      Resume = rerun this driver. On resume it skips (a) trajectories with a
#      verdict and (b) trajectories with a TERMINAL INFRASTRUCTURE_FAILURE —
#      those are excluded with their log, never silently replaced. Circuit-
#      breaker records are FAILED_LAUNCH: permanent, append-only, and
#      explicitly retryable, because nothing was ever attempted scientifically.
#   H5 checkpoints push to a NON-PROTECTED checkpoint branch and FAIL LOUDLY at
#      both the commit and the push step (round 3's pushes to protected main
#      failed silently for 8 pairs).
#   H3 driver_pass (this invocation) and execution_attempt (the try within it)
#      are exported separately and stamped natively by the runner.
set -uo pipefail
cd "$(dirname "$0")/.."

# ---- REGISTRATION GATE: filled by PREDICTION3.1, before which this driver
# will not execute a single trajectory. All three values are gated: a filled
# model with unfilled seeds would derive a bogus order. ----
REGISTERED_MODEL="__SET_AT_REGISTRATION__"
PAIR_SEED="__SET_AT_REGISTRATION__"
ARM_SEED="__SET_AT_REGISTRATION__"

# ---- self-test mode (hygiene-selftest.sh only) ----
# Loudly named; supplies its OWN model/seeds and its OWN runner, refuses to
# write anywhere but /tmp, never pushes. The counted sweep never sets it.
TESTMODE=0
if [ "${TB_HYGIENE_TEST:-0}" = "1" ]; then
  TESTMODE=1
  case "${TB_TEST_RUNS:-}" in
    /tmp/*) : ;;
    *) echo "ABORT: TB_HYGIENE_TEST requires TB_TEST_RUNS under /tmp"; exit 6 ;;
  esac
  REGISTERED_MODEL="${TB_TEST_MODEL:-testmode-model}"
  PAIR_SEED="${TB_TEST_PAIR_SEED:-testmode-pair-seed}"
  ARM_SEED="${TB_TEST_ARM_SEED:-testmode-arm-seed}"
fi

for v in REGISTERED_MODEL PAIR_SEED ARM_SEED; do
  case "${!v}" in
    ""|__SET_AT_REGISTRATION__*)
      echo "ABORT: round-3.1 is not registered — $v is empty or still a placeholder (PREDICTION3.1 fills REGISTERED_MODEL, PAIR_SEED and ARM_SEED together)"
      exit 7 ;;
  esac
done
if [ -n "${TB_MODEL:-}" ] && [ "$TB_MODEL" != "$REGISTERED_MODEL" ]; then
  echo "ABORT: TB_MODEL='$TB_MODEL' differs from registered '$REGISTERED_MODEL'"; exit 7
fi
export TB_MODEL="$REGISTERED_MODEL" TB_REGISTERED_MODEL="$REGISTERED_MODEL"
export TB_AGENT_SECS=3000 TB_NETJAIL=1
export TB_TASKS="$PWD/round3/tasks"           # the frozen round-3 pool, verbatim
RUNNER="./runner/run-task31.sh"
TB_RUNS="$PWD/round3.1/runs-phase3"
if [ "$TESTMODE" = 1 ]; then
  TB_RUNS="$TB_TEST_RUNS"
  RUNNER="${TB_TEST_RUNNER:?TB_HYGIENE_TEST requires TB_TEST_RUNNER}"
  export TB_NETJAIL=0
fi
export TB_RUNS
CKPT_REF="refs/heads/round3.1/sweep-checkpoints"   # H5: non-protected
mkdir -p "$TB_RUNS"
RESULTS="$TB_RUNS/results.jsonl"; touch "$RESULTS"
DEVIATIONS="$TB_RUNS/deviations.jsonl"; touch "$DEVIATIONS"
LOG="$TB_RUNS/phase3-log.txt"
ATTEMPTS="$TB_RUNS/driver-passes.log"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { echo "$(ts) $*" | tee -a "$LOG"; }

disk_guard() {
  local free_kb; free_kb=$(df --output=avail / | tail -1 | tr -d ' ')
  if [ "$free_kb" -lt 3000000 ]; then
    rm -rf /root/.cache/uv /root/.npm/_cacache /tmp/tb3-run-* 2>/dev/null
    free_kb=$(df --output=avail / | tail -1 | tr -d ' ')
    [ "$free_kb" -lt 3000000 ] && { say "ABORT: disk below 3GB"; exit 5; }
  fi
}

# The shared-infrastructure reachability check, used both at sweep start and to
# adjudicate whether a CLONE_FAILED is systemic or trajectory-local.
shared_net_ok() {
  [ "$TESTMODE" = 1 ] && { [ "${TB_TEST_NET_OK:-1}" = "1" ]; return $?; }
  timeout 20 git ls-remote --heads https://github.com/aio-libs/multidict.git >/dev/null 2>&1
}

if [ "$TESTMODE" = 1 ]; then
  say "TESTMODE: sweep preflight skipped (the preflight itself is covered by the hygiene-selftest netcheck cases)"
else
  say "SWEEP PREFLIGHT"
  shared_net_ok || { say "ABORT: sweep preflight failed — nothing attempted, this driver pass is NOT counted"; exit 8; }
  bash runner/net-jail.sh selftest preflight >/dev/null 2>&1 \
    || { say "ABORT: net-jail selftest failed — nothing attempted, this driver pass is NOT counted"; exit 8; }
  say "preflight OK"
fi

# A driver pass is counted only once the shared preflight has passed, so a
# sweep that never attempted anything does not inflate the pass number.
echo "$(ts) driver-pass" >> "$ATTEMPTS"
DRIVER_PASS=$(grep -c driver-pass "$ATTEMPTS")
export TB_DRIVER_PASS="$DRIVER_PASS"

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
# TERMINAL: the registered retry budget was spent and no verdict came out. The
# trajectory is excluded with its log and never re-attempted. FAILED_LAUNCH is
# deliberately NOT terminal — the circuit breaker fired before any scientific
# work happened, so a resume must retry it.
terminal_failure() {
  jq -e --arg t "$1" --arg a "$2" \
    'select(.task==$t and .arm==$a and .event=="INFRASTRUCTURE_FAILURE")' "$DEVIATIONS" >/dev/null 2>&1
}

dev() {
  jq -nc --arg ts "$(ts)" --arg t "$1" --arg a "$2" --arg e "$3" --arg n "$4" \
     --argjson p "$DRIVER_PASS" --argjson tm "$([ "$TESTMODE" = 1 ] && echo true || echo false)" \
     '{ts:$ts,task:$t,arm:$a,event:$e,driver_pass:$p,note:$n,testmode:$tm}' >> "$DEVIATIONS"
}

breaker() {
  dev "$1" "$2" FAILED_LAUNCH "$3 — circuit breaker; nothing was attempted scientifically, retryable on resume"
  say "SYSTEMIC NETWORK FAILURE on $1 $2: $3 — aborting sweep, remaining trajectories left UNATTEMPTED (resume by rerunning this driver)"
}

run_one() {
  local task="$1" arm="$2"
  for attempt in 1 2; do
    disk_guard
    local before; before=$(wc -l <"$RESULTS")
    say "START $task $arm (execution attempt $attempt, driver pass $DRIVER_PASS)"
    out=$(TB_EXEC_ATTEMPT="$attempt" timeout 4200 "$RUNNER" "$task" "$arm" </dev/null 2>&1); local rc=$?
    echo "$out" >> "$LOG"
    if echo "$out" | grep -qE 'GATE_NOT_LIVE|WATCH_NOT_LIVE'; then say "treatment not live on $task $arm — aborting sweep"; return 2; fi
    # H4: the runner's rc=8 IS the dedicated shared-infrastructure preflight —
    # break immediately, it says the agent network path is down for everyone.
    if [ "$rc" -eq 8 ]; then
      breaker "$task" "$arm" "runner preflight failed (rc=8)"; return 3
    fi
    # A clone can fail for repo-local reasons; only systemic if the shared
    # preflight is failing at this moment too.
    if echo "$out" | grep -q 'CLONE_FAILED'; then
      if ! shared_net_ok; then
        breaker "$task" "$arm" "CLONE_FAILED with the shared preflight also failing"; return 3
      fi
      say "CLONE_FAILED on $task $arm but shared network reachable — trajectory-local, ordinary retry path"
    fi
    if [ "$(wc -l <"$RESULTS")" -gt "$before" ]; then
      say "DONE $task $arm: $(tail -1 "$RESULTS" | jq -r .outcome)"
      return 0
    fi
    say "NO VERDICT for $task $arm (rc=$rc) — $([ "$attempt" = 1 ] && echo 'one retry from clean state' || echo 'second failure')"
  done
  dev "$task" "$arm" INFRASTRUCTURE_FAILURE "no verdict after one retry; TERMINAL — excluded with its log, never re-attempted"
  return 1
}

checkpoint() {   # H5: non-protected ref, loud at every step
  [ "$TESTMODE" = 1 ] && return 0
  git add -A "$TB_RUNS" >/dev/null 2>&1 || { say "CHECKPOINT STAGE FAILED for $1 — results exist only locally"; return 0; }
  git diff --cached --quiet -- "$TB_RUNS" && return 0     # nothing new is not a failure
  git commit -q -m "Taskbench round 3.1: checkpoint after $1" >/dev/null 2>&1 \
    || { say "CHECKPOINT COMMIT FAILED for $1 — results exist only locally until a commit succeeds"; return 0; }
  git push -q origin "HEAD:$CKPT_REF" 2>/dev/null \
    || say "CHECKPOINT PUSH FAILED for $1 — results exist only locally until a push succeeds"
}

say "ROUND-3.1 SWEEP START model=$TB_MODEL driver-pass=$DRIVER_PASS results=$RESULTS"
mapfile -t PAIRS <<< "$ORDERS"
[ "${#PAIRS[@]}" -eq 17 ] || { say "ABORT: derived ${#PAIRS[@]} pairs, expected 17"; exit 4; }
pair_n=0
for line in "${PAIRS[@]}"; do
  read -r task first second <<< "$line"
  pair_n=$((pair_n+1))
  for arm in "$first" "$second"; do
    if have "$task" "$arm"; then say "SKIP $task $arm (verdict exists)"; continue; fi
    if terminal_failure "$task" "$arm"; then
      say "SKIP $task $arm (terminal INFRASTRUCTURE_FAILURE — excluded with its log, never silently replaced)"; continue
    fi
    run_one "$task" "$arm"; rc=$?
    [ "$rc" = 2 ] && exit 3
    [ "$rc" = 3 ] && { checkpoint "circuit-breaker at pair $pair_n"; exit 4; }
  done
  rm -rf /tmp/tb3-run-* 2>/dev/null
  checkpoint "pair $pair_n/17 ($task)"
done
say "ROUND-3.1 SWEEP COMPLETE: $(wc -l <"$RESULTS") verdicts, $(wc -l <"$DEVIATIONS") deviations, driver passes: $DRIVER_PASS"
