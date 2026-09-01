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
. "$PWD/runner/verdict-record.sh"

# EXPLICIT MODE, no default. On 2026-09-01 a bare invocation intended only to
# check that the registration gate accepted its constants started the real
# sweep and executed a counted trajectory before the preregistration line. The
# gate passing IS the sweep starting, so "validate" and "run the experiment"
# must not be the same command. --check creates nothing; only a flag that says
# out loud what it does can create counted trajectories.
MODE=""
case "${1:-}" in
  --check)            MODE=check ;;
  --execute-counted)  MODE=execute ;;
  *) cat >&2 <<'USAGE'
REFUSING: phase3-sweep31.sh requires an explicit mode.

  --check              validate registration, exclusions, derived order, hashes,
                       infrastructure and results state. Creates nothing, mutates
                       nothing, runs no trajectory.

  --execute-counted    RUN THE COUNTED SWEEP. This creates counted scientific
                       trajectories that can never be re-rolled.
USAGE
     exit 2 ;;
esac

# ---- REGISTRATION GATE: filled by PREDICTION3.1, before which this driver
# will not execute a single trajectory. All three values are gated: a filled
# model with unfilled seeds would derive a bogus order. ----
REGISTERED_MODEL="claude-sonnet-5"
PAIR_SEED="taskbench31-phase3-pair-order-v1-2026-09-01"
ARM_SEED="taskbench31-phase3-arm-order-v1-2026-09-01"
# Registered exclusion (PREDICTION3.1 "Pre-registration execution incident").
# 08-celery-py-amqp had its ungated arm executed by the accidental invocation
# above, before the preregistration line. A trajectory that started is never
# re-rolled, so the task is spent; the paired design means the whole PAIR is
# excluded. No replacement is introduced. Round 3.1 is 16 pairs / 32 counted
# trajectories.
EXCLUDED_TASKS="08-celery-py-amqp"
PAIRS_EXPECTED=16
TRAJECTORIES_EXPECTED=32

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
RESULTS="$TB_RUNS/results.jsonl"
DEVIATIONS="$TB_RUNS/deviations.jsonl"
if [ "$MODE" = execute ]; then
  mkdir -p "$TB_RUNS"; touch "$RESULTS" "$DEVIATIONS"
fi
LOG="$TB_RUNS/phase3-log.txt"
ATTEMPTS="$TB_RUNS/driver-passes.log"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# --check never writes, not even to the log
say() { if [ "$MODE" = execute ]; then echo "$(ts) $*" | tee -a "$LOG"; else echo "$(ts) $*"; fi; }

# Exactly one driver per results directory. `have()` and the deviation ledger
# are read-then-act, so two simultaneous resumes would both see "no verdict"
# for the same trajectory and both launch it, appending two verdicts for one
# (task, arm) pair.
DRIVER_LOCK="/tmp/tb31-driver-$(printf %s "$TB_RUNS" | md5sum | cut -c1-12).lock"
if [ "$MODE" = execute ]; then
  exec 9>"$DRIVER_LOCK"
  flock -n 9 || { echo "ABORT: another driver already holds $DRIVER_LOCK for $TB_RUNS"; exit 6; }
fi

# Workspaces belonging to a trajectory that started but has neither a verdict
# nor an adjudicated disposition are EVIDENCE, not garbage. During the
# 19-pycqa-flake8 incident the inter-pair cleanup deleted one while it awaited
# adjudication. Every cleanup now goes through here.
protected_workdirs() {
  local m t a
  for m in "$TB_RUNS"/*.started; do
    [ -e "$m" ] || continue
    t=$(jq -r '.task // empty' "$m" 2>/dev/null); a=$(jq -r '.arm // empty' "$m" 2>/dev/null)
    [ -n "$t" ] && [ -n "$a" ] || continue
    have "$t" "$a" && continue                 # finished normally
    adjudicated "$t" "$a" && continue          # already resolved
    jq -r '.workdir // empty' "$m" 2>/dev/null
  done
}
sweep_workdirs() {
  local keep w
  keep=$(protected_workdirs)
  for w in /tmp/tb3-run-* /tmp/tb31-ctrl-*; do
    [ -e "$w" ] || continue
    if printf '%s\n' "$keep" | grep -qxF "$w"; then
      say "preserving $w — referenced by an unadjudicated trajectory marker"; continue
    fi
    rm -rf "$w" 2>/dev/null
  done
}

disk_guard() {
  local free_kb; free_kb=$(df --output=avail / | tail -1 | tr -d ' ')
  if [ "$free_kb" -lt 3000000 ]; then
    rm -rf /root/.cache/uv /root/.npm/_cacache 2>/dev/null; sweep_workdirs
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

# Is the jail itself buildable? Distinguishes a systemic netns/nft failure from
# a one-off setup race on a single trajectory.
jail_ok() {
  [ "$TESTMODE" = 1 ] && { [ "${TB_TEST_JAIL_OK:-1}" = "1" ]; return $?; }
  bash runner/net-jail.sh selftest jailcheck >/dev/null 2>&1
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
if [ "$MODE" = execute ]; then
  echo "$(ts) driver-pass" >> "$ATTEMPTS"
  DRIVER_PASS=$(grep -c driver-pass "$ATTEMPTS")
else
  DRIVER_PASS=$(grep -c driver-pass "$ATTEMPTS" 2>/dev/null || echo 0)
fi
export TB_DRIVER_PASS="$DRIVER_PASS"

ORDERS=$(PAIR_SEED="$PAIR_SEED" ARM_SEED="$ARM_SEED" EXCLUDED="$EXCLUDED_TASKS" node - <<'NODE'
const crypto=require('crypto'), fs=require('fs');
const tasks=fs.readdirSync('round3/tasks').filter(d=>JSON.parse(fs.readFileSync(`round3/tasks/${d}/manifest.json`)).role==='main').sort();
const PAIR=process.env.PAIR_SEED, ARM=process.env.ARM_SEED;
const excluded=new Set((process.env.EXCLUDED||'').split(/[\s,]+/).filter(Boolean));
// the exclusion is applied AFTER the seed-derived sort, so the remaining order
// is exactly the registered one with the spent task removed
const order=tasks.map(t=>[crypto.createHash('sha256').update(`${PAIR}:${t}`).digest('hex'),t])
  .sort().map(x=>x[1]).filter(t=>!excluded.has(t));
for(const t of order){
  const b=crypto.createHash('sha256').update(`${ARM}:${t}`).digest()[0];
  console.log(`${t} ${b%2===0?'ungated gated':'gated ungated'}`);
}
NODE
)

# A row that merely carries a matching task and arm is NOT a verdict. One
# shared predicate (runner/verdict-record.sh) decides, everywhere.
have() { is_verdict_file "$(verdict_path "$TB_RUNS" "$1" "$2")" "$1" "$2"; }
# TERMINAL: the registered retry budget was spent and no verdict came out. The
# trajectory is excluded with its log and never re-attempted. FAILED_LAUNCH is
# deliberately NOT terminal — the circuit breaker fired before any scientific
# work happened, so a resume must retry it.
# A TERMINAL DISPOSITION accounts for a trajectory that has no verdict. The
# post-start FAILURE is an append-only EVENT, not a disposition: it is resolved
# by adjudication into either a reconstructed verdict (accounted for by that
# verdict) or an exclusion (accounted for here). Keeping the two apart is what
# makes the reconstruction route compatible with the completion invariant.
terminal_failure() {
  jq -e --arg t "$1" --arg a "$2" \
    'select(.task==$t and .arm==$a and (.event=="INFRASTRUCTURE_FAILURE" or .event=="POST_START_ADJUDICATED_EXCLUSION"))' \
    "$DEVIATIONS" >/dev/null 2>&1
}
# The agent RAN for this trajectory: either the runner left its durable
# trajectory-start marker, or a previous pass already recorded the failure. Its
# outcome exists scientifically, so it is never re-rolled — the sweep halts
# until a human adjudicates from the preserved artifacts.
started_marker() { [ -f "$TB_RUNS/${1}-${2}.started" ]; }
adjudicated() {
  jq -e --arg t "$1" --arg a "$2" \
    'select(.task==$t and .arm==$a and (.event=="POST_START_ADJUDICATED_VERDICT" or .event=="POST_START_ADJUDICATED_EXCLUSION"))' \
    "$DEVIATIONS" >/dev/null 2>&1
}
post_start_event_recorded() {
  jq -e --arg t "$1" --arg a "$2" \
    'select(.task==$t and .arm==$a and .event=="POST_START_FINALIZATION_FAILURE")' "$DEVIATIONS" >/dev/null 2>&1
}
post_start_failed() {
  adjudicated "$1" "$2" && return 1
  jq -e --arg t "$1" --arg a "$2" \
    'select(.task==$t and .arm==$a and .event=="POST_START_FINALIZATION_FAILURE")' "$DEVIATIONS" >/dev/null 2>&1 \
    && return 0
  started_marker "$1" "$2" && ! have "$1" "$2"
}
# The runner preserves its own artifacts on an orderly post-start failure, but
# the driver's outer timeout can SIGTERM/SIGKILL it first, in which case that
# code never runs and the evidence sits only in the marker's workdir under /tmp,
# one disk_guard away from deletion. The driver therefore preserves it itself.
preserve_post_start() {
  local task="$1" arm="$2" keep="$TB_RUNS/$1-$2-poststart-workdir" wd
  [ -d "$keep" ] && [ -n "$(ls -A "$keep" 2>/dev/null)" ] && return 0
  wd=$(jq -r '.workdir // empty' "$TB_RUNS/$1-$2.started" 2>/dev/null | tail -1)
  mkdir -p "$keep"
  if [ -n "$wd" ] && [ -d "$wd" ]; then
    cp -a "$wd/obs" "$keep/obs" 2>/dev/null
    cp -a "$wd/oracle" "$keep/oracle" 2>/dev/null
    for f in net-denied.log denylog verify.log envelope.json verdict-line.json proxy.log; do
      cp "$wd/$f" "$keep/$f" 2>/dev/null
    done
    [ -d "$wd/repo" ] && tar -cf "$keep/repo-final-tree.tar" -C "$wd/repo" . 2>/dev/null
    say "preserved the killed runner's workspace for $task $arm from $wd into $keep"
  else
    say "WARNING: no preservable workspace for $task $arm (marker workdir '${wd:-none}' is gone) — only the transcript and the marker survive; the ladder will resolve to R3"
  fi
  jq -nc --arg ts "$(ts)" --arg t "$task" --arg a "$arm" --arg wd "${wd:-}" \
     '{ts:$ts,task:$t,arm:$a,preserved_from:$wd,preserved_by:"driver"}' > "$keep/why.json" 2>/dev/null || true
}

halt_post_start() {
  say "HALT: $1 $2 RAN but never persisted a valid verdict. It must NOT be re-rolled — a clean retry would discard an observed trajectory and sample another."
  say "  adjudicate with the frozen ladder (PREDICTION3.1 §1) — it decides, you do not:"
  say "    runner/adjudicate31.sh $TB_RUNS $1 $2 auto"
  say "  artifacts: $TB_RUNS/$1-$2-poststart-workdir"
}

# Structural validation of the deviations ledger. It governs every exceptional
# case in the round, so it fails closed: malformed JSON, an unknown event, a
# trajectory event without a valid identity, or more than one terminal
# disposition for the same (task, arm) — which covers both duplicates and
# contradictions — all stop the sweep. Repeated non-disposition EVENTS stay
# legitimate; only final dispositions are unique.
validate_deviations() {
  [ -s "$DEVIATIONS" ] || return 0
  local out rc
  out=$(jq -s -r '
    def TRAJ: ["FAILED_LAUNCH","INFRASTRUCTURE_FAILURE","POST_START_FINALIZATION_FAILURE",
               "POST_START_ADJUDICATED_EXCLUSION","POST_START_ADJUDICATED_VERDICT"];
    def FREE: ["DEVIATION_CORRECTION","LOG_CORRECTION","NOTE"];
    def DISP: ["INFRASTRUCTURE_FAILURE","POST_START_ADJUDICATED_EXCLUSION","POST_START_ADJUDICATED_VERDICT"];
    ( to_entries[] | .key as $i | .value as $r
      | if ($r.event? | type) != "string" then "line \($i+1): missing or non-string event"
        elif ((TRAJ + FREE) | index($r.event)) == null then "line \($i+1): unknown event \"\($r.event)\""
        elif (TRAJ | index($r.event)) != null and (($r.task? | type) != "string")
          then "line \($i+1): \($r.event) requires a string task"
        elif (TRAJ | index($r.event)) != null and ((["ungated","gated"] | index($r.arm?)) == null)
          then "line \($i+1): \($r.event) requires arm ungated|gated"
        else empty end ),
    ( map(select(.event as $e | (DISP | index($e)) != null))
      | group_by([.task, .arm])[] | select(length > 1)
      | "\(.[0].task)/\(.[0].arm): \(length) terminal dispositions — \(map(.event) | join(", "))" )
  ' "$DEVIATIONS" 2>&1); rc=$?
  if [ "$rc" -ne 0 ]; then
    say "DEVIATIONS LEDGER INVALID: not parseable as JSONL — $(printf %s "$out" | head -2 | tr '\n' ' ')"; return 1
  fi
  if [ -n "$out" ]; then
    say "DEVIATIONS LEDGER INVALID:"
    printf '%s\n' "$out" | head -20 | while IFS= read -r l; do say "  $l"; done
    return 1
  fi
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
  if post_start_failed "$task" "$arm"; then
    preserve_post_start "$task" "$arm"
    dev "$task" "$arm" POST_START_FINALIZATION_FAILURE "trajectory-start marker present with no verdict on entry; TERMINAL — never re-rolled"
    halt_post_start "$task" "$arm"; return 4
  fi
  for attempt in 1 2; do
    disk_guard
    say "START $task $arm (execution attempt $attempt, driver pass $DRIVER_PASS)"
    out=$(TB_EXEC_ATTEMPT="$attempt" timeout 4200 "$RUNNER" "$task" "$arm" </dev/null 2>&1); local rc=$?
    echo "$out" >> "$LOG"
    if echo "$out" | grep -qE 'GATE_NOT_LIVE|WATCH_NOT_LIVE'; then say "treatment not live on $task $arm — aborting sweep"; return 2; fi
    # H4, per the runner's documented exit contract. Only a failure PROVEN to be
    # shared infrastructure may halt the sweep; anything that could be local to
    # one repository or one setup race takes the ordinary retry path, so a
    # single dead task repository cannot block every remaining trajectory
    # forever (each resume would otherwise reach it and abort again).
    case "$rc" in
      8)
        breaker "$task" "$arm" "shared agent network path down (runner rc=8)"; return 3 ;;
      9)
        if jail_ok; then
          say "NETJAIL_SETUP_FAILED on $task $arm but the jail self-test passes — trajectory-local, ordinary retry path"
        else
          breaker "$task" "$arm" "net-jail setup failed and the jail self-test fails too"; return 3
        fi ;;
      10)
        if shared_net_ok; then
          say "TASK_REPO_UNREACHABLE for $task but shared network is up — trajectory-local, ordinary retry path"
        else
          breaker "$task" "$arm" "task repository unreachable with the shared preflight also failing"; return 3
        fi ;;
    esac
    # A clone can fail for repo-local reasons; only systemic if the shared
    # preflight is failing at this moment too.
    if echo "$out" | grep -q 'CLONE_FAILED'; then
      if ! shared_net_ok; then
        breaker "$task" "$arm" "CLONE_FAILED with the shared preflight also failing"; return 3
      fi
      say "CLONE_FAILED on $task $arm but shared network reachable — trajectory-local, ordinary retry path"
    fi
    # acceptance is an EXACT match on this (task, arm), not line-count growth
    if have "$task" "$arm"; then
      say "DONE $task $arm: $(jq -r --arg t "$task" --arg a "$arm" 'select(.task==$t and .arm==$a)|.outcome' "$RESULTS" | tail -1)"
      return 0
    fi
    # POST-START BOUNDARY: if the agent ran, this is never retried
    if [ "$rc" -eq 11 ] || started_marker "$task" "$arm"; then
      preserve_post_start "$task" "$arm"
      dev "$task" "$arm" POST_START_FINALIZATION_FAILURE "the agent ran but no valid verdict was persisted (rc=$rc); artifacts preserved; TERMINAL — never re-rolled"
      halt_post_start "$task" "$arm"; return 4
    fi
    say "NO VERDICT for $task $arm (rc=$rc) — $([ "$attempt" = 1 ] && echo 'one retry from clean state' || echo 'second failure')"
  done
  dev "$task" "$arm" INFRASTRUCTURE_FAILURE "no verdict after one retry; TERMINAL — excluded with its log, never re-attempted"
  return 1
}

# H5: non-protected ref, loud at every step, and FATAL when it stays broken.
# Round 3's lesson was 8 pairs of results living only on a disposable container;
# "logged but continued" would reproduce that outcome with better logging. A
# transient push failure is absorbed by the retries; a persistent one stops the
# sweep, which is recoverable (the untouched trajectories are UNATTEMPTED and
# the results so far are intact on disk).
checkpoint() {
  if [ "$TESTMODE" = 1 ]; then
    # the self-test's stand-in for a persistent push failure
    [ "${TB_TEST_CKPT_FAIL:-0}" = "1" ] && { say "CHECKPOINT PUSH FAILED for $1 (testmode simulation)"; return 1; }
    return 0
  fi
  git add -A "$TB_RUNS" >/dev/null 2>&1 || { say "CHECKPOINT STAGE FAILED for $1"; return 1; }
  git diff --cached --quiet -- "$TB_RUNS" && return 0     # nothing new is not a failure
  git commit -q -m "Taskbench round 3.1: checkpoint after $1" >/dev/null 2>&1 \
    || { say "CHECKPOINT COMMIT FAILED for $1 — results exist only locally"; return 1; }
  local d
  for d in 0 2 4 8; do
    [ "$d" -gt 0 ] && { say "checkpoint push failed for $1 — retrying in ${d}s"; sleep "$d"; }
    git push -q origin "HEAD:$CKPT_REF" 2>/dev/null && return 0
  done
  say "CHECKPOINT PUSH FAILED for $1 after 4 attempts — results exist only locally"
  return 1
}

# Every one of the 34 REGISTERED trajectories accounted for exactly once, as a
# verdict or as a terminal INFRASTRUCTURE_FAILURE. Counting alone is not enough:
# 34 verdicts containing one unregistered (task, arm) and missing one registered
# pair would count correctly and be wrong, and a pair recorded BOTH as a verdict
# and as a terminal failure would cancel out. So the expected universe is
# derived from the registered order and compared as a set.
verify_completion() {
  local expected vpairs vuniq ipairs icount dup overlap unknown missing
  validate_deviations || return 1
  expected=$(printf '%s\n' "${PAIRS[@]}" | awk 'NF{print $1"\tungated"; print $1"\tgated"}' | LC_ALL=C sort)
  [ "$(printf '%s\n' "$expected" | grep -c .)" -eq "$TRAJECTORIES_EXPECTED" ] \
    || { say "INVARIANT VIOLATION: the registered universe is not $TRAJECTORIES_EXPECTED (task,arm) pairs"; return 1; }

  # every per-trajectory file must be a COMPLETE verdict by the shared schema
  local vf
  for vf in "$TB_RUNS"/*.verdict.json; do
    [ -e "$vf" ] || continue
    is_verdict_file "$vf" || { say "INVARIANT VIOLATION: $vf is not a complete verdict record"; return 1; }
  done
  # results.jsonl is DERIVED — rebuild it, then require it to agree exactly
  rebuild_results "$TB_RUNS" || { say "INVARIANT VIOLATION: results.jsonl could not be derived from the per-trajectory verdicts"; return 1; }
  jq -e -s "all($VERDICT_REQUIRED)" "$RESULTS" >/dev/null 2>&1 \
    || { say "INVARIANT VIOLATION: results.jsonl holds a line that is not a complete verdict record"; return 1; }
  local nfiles; nfiles=$(ls "$TB_RUNS"/*.verdict.json 2>/dev/null | wc -l)
  [ "$(wc -l <"$RESULTS")" -eq "$nfiles" ] \
    || { say "INVARIANT VIOLATION: results.jsonl has $(wc -l <"$RESULTS") lines but there are $nfiles per-trajectory verdicts"; return 1; }

  vpairs=$(jq -r '"\(.task)\t\(.arm)"' "$RESULTS" 2>/dev/null | LC_ALL=C sort)
  dup=$(printf '%s\n' "$vpairs" | grep . | uniq -d | grep -c .)
  [ "$dup" -eq 0 ] || { say "INVARIANT VIOLATION: $dup (task,arm) pair(s) carry more than one verdict"; return 1; }
  vuniq=$(printf '%s\n' "$vpairs" | grep -c .)

  ipairs=$(jq -r 'select(.event=="INFRASTRUCTURE_FAILURE" or .event=="POST_START_ADJUDICATED_EXCLUSION")|"\(.task)\t\(.arm)"' "$DEVIATIONS" 2>/dev/null | LC_ALL=C sort -u)
  icount=$(printf '%s\n' "$ipairs" | grep -c .)
  overlap=$(comm -12 <(printf '%s\n' "$vpairs" | grep .) <(printf '%s\n' "$ipairs" | grep .) | grep -c .)
  [ "$overlap" -eq 0 ] \
    || { say "INVARIANT VIOLATION: $overlap (task,arm) pair(s) recorded BOTH as a verdict and as a terminal infrastructure failure"; return 1; }

  local observed
  observed=$(printf '%s\n%s\n' "$vpairs" "$ipairs" | grep . | LC_ALL=C sort -u)
  unknown=$(comm -23 <(printf '%s\n' "$observed" | grep .) <(printf '%s\n' "$expected" | grep .) | grep -c .)
  missing=$(comm -13 <(printf '%s\n' "$observed" | grep .) <(printf '%s\n' "$expected" | grep .) | grep -c .)
  if [ "$unknown" -ne 0 ] || [ "$missing" -ne 0 ]; then
    say "INVARIANT VIOLATION: the recorded set is not the registered universe ($unknown unregistered, $missing unaccounted)"
    comm -3 <(printf '%s\n' "$observed" | grep .) <(printf '%s\n' "$expected" | grep .) \
      | head -10 | while IFS= read -r l; do say "  mismatch: $l"; done
    return 1
  fi
  say "COMPLETION INVARIANT OK: $vuniq verdicts + $icount terminal dispositions = the $TRAJECTORIES_EXPECTED registered trajectories, each exactly once"
}

validate_deviations || { say "ABORT: the deviations ledger governs every exceptional case in this round and must be structurally valid before anything runs"; exit 12; }

mapfile -t PAIRS <<< "$ORDERS"
if [ "$MODE" = check ]; then
  echo "=== ROUND-3.1 REGISTRATION CHECK (creates nothing, runs nothing) ==="
  echo "model                 $REGISTERED_MODEL"
  echo "pair seed             $PAIR_SEED"
  echo "arm seed              $ARM_SEED"
  echo "excluded (registered) ${EXCLUDED_TASKS:-none}"
  echo "pairs derived         ${#PAIRS[@]} (expected $PAIRS_EXPECTED)"
  echo "trajectories          $TRAJECTORIES_EXPECTED"
  echo "task pool             $TB_TASKS"
  echo "results directory     $TB_RUNS"
  for f in runner/run-task31.sh runner/phase3-sweep31.sh runner/verdict3.mjs analyze3.mjs; do
    [ -f "$f" ] && printf 'sha256 %-26s %s\n' "$(basename "$f")" "$(sha256sum "$f" | cut -c1-64)"
  done
  echo "prompt sha256         $(grep -m1 '^PROMPT=' runner/run-task31.sh | sed 's/^PROMPT="//; s/"$//' | sha256sum | cut -c1-64)"
  n=$(ls "$TB_RUNS"/*.verdict.json 2>/dev/null | wc -l)
  echo "existing verdicts     $n $([ "$n" -eq 0 ] && echo '(clean)' || echo '(NOT CLEAN)')"
  echo "--- registered order ---"
  i=0; for line in "${PAIRS[@]}"; do i=$((i+1)); read -r t a b <<< "$line"; printf '%2d %-34s %s,%s\n' "$i" "$t" "$a" "$b"; done
  [ "${#PAIRS[@]}" -eq "$PAIRS_EXPECTED" ] || { echo "CHECK FAILED: derived ${#PAIRS[@]} pairs, expected $PAIRS_EXPECTED"; exit 4; }
  validate_deviations || { echo "CHECK FAILED: deviations ledger invalid"; exit 12; }
  echo "CHECK OK"
  exit 0
fi

say "ROUND-3.1 SWEEP START model=$TB_MODEL driver-pass=$DRIVER_PASS results=$RESULTS"
[ "${#PAIRS[@]}" -eq "$PAIRS_EXPECTED" ] || { say "ABORT: derived ${#PAIRS[@]} pairs, expected $PAIRS_EXPECTED"; exit 4; }
pair_n=0
for line in "${PAIRS[@]}"; do
  read -r task first second <<< "$line"
  pair_n=$((pair_n+1))
  for arm in "$first" "$second"; do
    if have "$task" "$arm"; then say "SKIP $task $arm (verdict exists)"; continue; fi
    if post_start_failed "$task" "$arm" && ! adjudicated "$task" "$arm"; then
      preserve_post_start "$task" "$arm"
      post_start_event_recorded "$task" "$arm" \
        || dev "$task" "$arm" POST_START_FINALIZATION_FAILURE "detected on resume: trajectory-start marker with no verdict; TERMINAL — never re-rolled"
      halt_post_start "$task" "$arm"
      checkpoint "post-start finalization failure at pair $pair_n" || true
      exit 11
    fi
    if terminal_failure "$task" "$arm"; then
      say "SKIP $task $arm (terminal failure — excluded with its log, never silently replaced)"; continue
    fi
    run_one "$task" "$arm"; rc=$?
    [ "$rc" = 2 ] && exit 3
    [ "$rc" = 3 ] && { checkpoint "circuit-breaker at pair $pair_n" || true; exit 4; }
    [ "$rc" = 4 ] && { checkpoint "post-start finalization failure at pair $pair_n" || true; exit 11; }
  done
  sweep_workdirs
  checkpoint "pair $pair_n/$PAIRS_EXPECTED ($task)" \
    || { say "ABORT: checkpoints are not reaching the remote — stopping rather than accumulating hours of local-only results (nothing is lost; fix the push and rerun this driver)"; exit 6; }
done
# Validate first: "COMPLETE" is a claim about the ledger, so it must not be
# logged before the ledger has been checked. Either way the decision itself is
# checkpointed, so the remote carries the verdict on the run and not just its
# results.
if verify_completion; then
  say "ROUND-3.1 SWEEP COMPLETE: $(wc -l <"$RESULTS") verdicts, $(wc -l <"$DEVIATIONS") deviations, driver passes: $DRIVER_PASS"
  checkpoint "sweep complete (completion invariant verified)" \
    || { say "ABORT: the final checkpoint did not reach the remote"; exit 6; }
else
  say "ROUND-3.1 SWEEP ENDED WITH A FAILED COMPLETION INVARIANT — not marking this run complete"
  checkpoint "sweep ended: COMPLETION INVARIANT FAILED" || true
  exit 10
fi
