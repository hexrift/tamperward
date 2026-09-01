#!/usr/bin/env bash
# BEHAVIOURAL selftest for the round-3.1 execution-hygiene deltas
# (ROUND3.1-PLAN + the review corrections on PR #147). Nothing here runs an
# agent or writes to a counted results directory. Each case asserts an
# OBSERVED behaviour, not the presence of a string in a script.
#
#  G  registration gate is fail-closed on ALL THREE registered values
#  N1 upstream rotation is rediscovered AT THE TRAJECTORY-START BOUNDARY,
#     i.e. immediately before the agent's network path is built
#  N2 a dead upstream everywhere fails as PREFLIGHT_NET_FAILED / exit 8
#  N3 the rotation test seam is refused inside a registered run
#  D1 forcing the runner's rc=8 records EXACTLY ONE launch, aborts the sweep,
#     writes a retryable FAILED_LAUNCH, and leaves every later trajectory
#     untouched
#  D2 resuming after that outage re-attempts the SAME trajectory first and
#     then completes the registered order
#  D3 a TERMINAL INFRASTRUCTURE_FAILURE is skipped on resume (the next
#     trajectory in the registered order is attempted instead)
#  N5 no upstream credentials are ever printed (the driver commits its log)
#  N6 cleanup never signals the process group (`kill 0` would kill the driver)
#  D4 a task-repo failure with healthy shared network does NOT halt the sweep
#  D5 a systemic jail failure DOES halt it; a one-off jail failure does not
#  D7 a duplicated (task, arm) verdict fails the completion invariant
#  D8 a second concurrent driver is refused
#  D20 a verdict is derived from artifacts, never substituted after the fact
#  D21 a torn verdict line falls through to re-derivation, not a dead end
#  D17 a killed runner's evidence is preserved by the driver
#  D18 a matching-but-malformed row is never accepted as a verdict
#  D19 results.jsonl is derived from immutable files and is rebuildable
#  D15 failure -> reconstruction -> resume -> no rerun -> valid completion
#  D16 the deviations ledger fails closed on structural corruption
#  D13 a trajectory that RAN is never re-rolled; the sweep halts for adjudication
#  D14 acceptance is an exact (task,arm) match, not line-count growth
#  D9  a persistent checkpoint failure stops the sweep before the next pair
#  D10 the completion invariant is a set identity, not a count
#  D11 a pair cannot be both a verdict and a terminal failure
#  D12 a failed invariant is never logged as a complete sweep
#  M1 a bare invocation refuses; --check creates nothing and runs nothing
#  E1 no TB_* reaches the agent; the withheld oracle is outside its workspace
#  S  the verdict line stamps driver_pass and execution_attempt separately
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TB="$(cd "$HERE/.." && pwd)"
fail() { echo "SELFTEST FAIL: $1"; exit 1; }
DEAD="http://127.0.0.1:1"
TMP=$(mktemp -d /tmp/hyg-selftest-XXXXXX)
# NOTE: no wildcard over /tmp/tb31-driver-*.lock. Unlinking a lock file does not
# release the inode lock a running counted sweep holds, but the next driver then
# creates a new file at that path and acquires it — two concurrent drivers,
# exactly what D8 exists to prevent. Only this process's own paths are removed.
cleanup() {
  rm -rf "$TMP" /tmp/hyg-runs-"$$"-*
  # exact lock paths for THIS process's run dirs, computed the same way the
  # driver does — never a wildcard over /tmp/tb31-driver-*.lock
  local x
  for x in a b c d e f g h i j k l m n o p q r s t; do
    rm -f "/tmp/tb31-driver-$(printf %s "/tmp/hyg-runs-$$-$x" | md5sum | cut -c1-12).lock" \
          "/tmp/tb31-results-$(printf %s "/tmp/hyg-runs-$$-$x" | md5sum | cut -c1-12).lock"
  done
}
trap cleanup EXIT

# ---------------------------------------------------------------- G ----
# The driver is REGISTERED now, so the gate is tested against copies with the
# registered values put back to placeholders — one per value, to prove all
# three are gated and that the refusal names the offender.
mkprobe() {   # <names to blank back to placeholders>
  cp "$HERE/phase3-sweep31.sh" "$HERE/.hyg-gate-probe.sh"
  local k
  for k in $1; do
    sed -i "s|^$k=\".*\"|$k=\"__SET_AT_REGISTRATION__\"|" "$HERE/.hyg-gate-probe.sh"
  done
}
for pair in "REGISTERED_MODEL PAIR_SEED ARM_SEED:REGISTERED_MODEL" \
            "PAIR_SEED:PAIR_SEED" "ARM_SEED:ARM_SEED"; do
  blanked="${pair%%:*}"; want="${pair##*:}"
  mkprobe "$blanked"
  rc=0; ( cd "$TB" && bash runner/.hyg-gate-probe.sh --check >"$TMP/g.out" 2>&1 ) || rc=$?
  rm -f "$HERE/.hyg-gate-probe.sh"
  [ "$rc" -eq 7 ] || fail "G: driver with [$blanked] unfilled did not refuse (rc=$rc)"
  grep -q "$want is empty or still a placeholder" "$TMP/g.out" \
    || fail "G: refusal with [$blanked] unfilled did not name $want"
done
echo "G OK: the gate refuses unless REGISTERED_MODEL, PAIR_SEED and ARM_SEED are all filled"

# ---------------------------------------------------------------- N ----
# The N cases need a live upstream proxy and (for N4) netns support. Where
# there is none — CI — they are skipped and the G/D/S cases still run, which
# is the half most likely to rot. The counted sweep never runs without them:
# its own preflight refuses to start unless the shared network and the
# net-jail selftest are both good.
LIVE="${HTTPS_PROXY:-}"
if [ -z "$LIVE" ]; then
  echo "N SKIP: no live HTTPS_PROXY in this environment (network boundary cases not run)"
else
# N1: inherited upstream points at a dead port; the fresh lookup returns the
# live one. The boundary must rediscover it and then prove the FULL path.
rc=0
out=$(HTTPS_PROXY="$DEAD" https_proxy="$DEAD" TB_FRESH_UPSTREAM="$LIVE" TB_NETJAIL=0 \
        bash "$HERE/run-task31.sh" --netcheck 2>&1) || rc=$?
[ "$rc" -eq 0 ] || fail "N1: boundary failed with a live fresh upstream (rc=$rc): $(echo "$out" | tail -3)"
echo "$out" | grep -q 'upstream proxy rotated' || fail "N1: rotation not detected at the boundary"
echo "$out" | grep -q 'agent network path verified' || fail "N1: full-path probe did not run"
echo "N1 OK: rotation rediscovered at the boundary and the whole chain proven before agent launch"

# N2: dead everywhere -> fail closed
rc=0
out=$(HTTPS_PROXY="$DEAD" https_proxy="$DEAD" TB_FRESH_UPSTREAM="$DEAD" TB_NETJAIL=0 \
        bash "$HERE/run-task31.sh" --netcheck 2>&1) || rc=$?
[ "$rc" -eq 8 ] || fail "N2: dead upstream did not exit 8 (rc=$rc)"
echo "$out" | grep -q 'PREFLIGHT_NET_FAILED' || fail "N2: no PREFLIGHT_NET_FAILED marker"
echo "N2 OK: a dead agent network path is PREFLIGHT_NET_FAILED (exit 8), no verdict possible"

# N3: the seam is refused in a registered run
rc=0
out=$(TB_FRESH_UPSTREAM="$LIVE" TB_REGISTERED_MODEL=some-model TB_NETJAIL=0 \
        bash "$HERE/run-task31.sh" --netcheck 2>&1) || rc=$?
[ "$rc" -eq 7 ] || fail "N3: test seam was accepted inside a registered run (rc=$rc)"
echo "N3 OK: the rotation seam is refused whenever a registered model is pinned"

# N4: the counted configuration — the same boundary INSIDE the network jail,
# where the platform's own direct route to the API does not exist. This is the
# path the counted agent actually gets.
if ip netns list >/dev/null 2>&1; then
  rc=0
  out=$(TB_NETJAIL=1 bash "$HERE/run-task31.sh" --netcheck 2>&1) || rc=$?
  [ "$rc" -eq 0 ] || fail "N4: boundary failed inside the jail (rc=$rc): $(echo "$out" | tail -3)"
  echo "$out" | grep -q 'net-jail: agent confined' || fail "N4: jail was not used"
  echo "$out" | grep -q 'agent network path verified' || fail "N4: jailed full-path probe did not succeed"
  echo "N4 OK: the boundary proves the jailed agent path, not an ambient host route"
else
  echo "N4 SKIP: no netns support here (the counted sweep's own preflight runs net-jail selftest)"
fi
fi

# N5: proxy URLs can carry user:password, and the driver commits its log to a
# public checkpoint branch. Nothing may print the raw upstream.
rc=0
out=$(HTTPS_PROXY="http://tbuser:tbs3cret@127.0.0.1:1" https_proxy="http://tbuser:tbs3cret@127.0.0.1:1" \
      TB_FRESH_UPSTREAM="http://tbuser:tbs3cret@127.0.0.1:1" TB_NETJAIL=0 \
      bash "$HERE/run-task31.sh" --netcheck 2>&1) || rc=$?
[ "$rc" -eq 8 ] || fail "N5: a credentialed upstream was not refused (rc=$rc)"
echo "$out" | grep -q 'tbs3cret' && fail "N5: upstream credentials reached the log: $out"
echo "$out" | grep -q '<redacted>@127.0.0.1:1' || fail "N5: redacted form not printed: $out"
echo "$out" | grep -q 'credentialed upstream proxies are not supported' \
  || fail "N5: the credentialed upstream was not refused by name: $out"
echo "N5 OK: credentialed upstreams are refused, and never printed in the clear"

# N6: cleanup runs on a path where PROXY_PID was never assigned. `kill 0` there
# would signal the whole process group — i.e. the sweep driver itself. Run the
# probe in its own process group with a sentinel sibling and check it survives.
cat > "$TMP/pg-probe.sh" <<'PGEOF'
#!/usr/bin/env bash
sleep 25 & SENT=$!
HTTPS_PROXY= https_proxy= TB_FRESH_UPSTREAM=" " TB_NETJAIL=0 bash "$1" --netcheck >/dev/null 2>&1
kill -0 "$SENT" 2>/dev/null && echo SENTINEL_ALIVE || echo SENTINEL_KILLED
kill "$SENT" 2>/dev/null
PGEOF
res=$(setsid bash "$TMP/pg-probe.sh" "$HERE/run-task31.sh" 2>/dev/null)
[ "$res" = "SENTINEL_ALIVE" ] || fail "N6: cleanup signalled the process group ($res)"
echo "N6 OK: cleanup before the proxy exists does not signal the process group"

# ---------------------------------------------------------------- D ----
# Counts and the registered exclusion come from the driver's own constants, so
# the self-test cannot drift out of step with the registered N.
NTRAJ=$(grep -m1 '^TRAJECTORIES_EXPECTED=' "$HERE/phase3-sweep31.sh" | cut -d= -f2)
NLESS1=$((NTRAJ-1))
EXCL=$(grep -m1 '^EXCLUDED_TASKS=' "$HERE/phase3-sweep31.sh" | cut -d'"' -f2)

# The registered order under the TESTMODE seeds, derived independently here.
read -r P1TASK P1A P1B < <(cd "$TB" && EXCLUDED="$EXCL" node - <<'NODE'
const crypto=require('crypto'), fs=require('fs');
const tasks=fs.readdirSync('round3/tasks').filter(d=>JSON.parse(fs.readFileSync(`round3/tasks/${d}/manifest.json`)).role==='main').sort();
const PAIR='testmode-pair-seed', ARM='testmode-arm-seed';
const excluded=new Set((process.env.EXCLUDED||'').split(/[\s,]+/).filter(Boolean));
const t=tasks.map(t=>[crypto.createHash('sha256').update(`${PAIR}:${t}`).digest('hex'),t])
  .sort().map(x=>x[1]).filter(x=>!excluded.has(x))[0];
const b=crypto.createHash('sha256').update(`${ARM}:${t}`).digest()[0];
console.log(`${t} ${b%2===0?'ungated gated':'gated ungated'}`);
NODE
)
[ -n "$P1TASK" ] || fail "D: could not derive the testmode order"

STUB="$TMP/stub-runner.sh"
cat > "$STUB" <<'STUBEOF'
#!/usr/bin/env bash
echo "$1 $2" >> "$LAUNCHLOG"
mode="${STUB_MODE:-ok}"
# STUB_FAIL_PAIR restricts the failure to one trajectory; every other one succeeds
if [ -n "${STUB_FAIL_PAIR:-}" ] && [ "$1 $2" != "$STUB_FAIL_PAIR" ]; then mode=ok; fi
case "$mode" in
  fail8)  echo "PREFLIGHT_NET_FAILED: stub";   exit 8 ;;
  fail9)  echo "NETJAIL_SETUP_FAILED";         exit 9 ;;
  fail10) echo "TASK_REPO_UNREACHABLE: stub";  exit 10 ;;
  poststart)  # the agent ran, then finalization died before a verdict landed
    KEEP="$TB_RUNS/$1-$2-poststart-workdir"; mkdir -p "$KEEP"
    if [ "${STUB_TORN_LINE:-0}" = "1" ]; then      # a nonempty but INCOMPLETE line
      printf '{"task":"%s","arm":"%s","outco' "$1" "$2" > "$KEEP/verdict-line.json"
      WD=$(mktemp -d "$TB_RUNS/torn-workspace-XXXXXX")
      mkdir -p "$WD/repo" "$WD/venv" "$WD/oracle" "$WD/obs"
      jq -nc --arg t "$1" --arg a "$2" --arg wd "$WD" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{ts:$ts,task:$t,arm:$a,model:"stub-model",driver_pass:1,execution_attempt:1,
          transcript:"stub.jsonl",workdir:$wd,base:"deadbeef",task_dir:"/nonexistent"}' \
        > "$TB_RUNS/$1-$2.started"
      echo "stub: torn verdict line, workspace intact"; exit 1
    fi
    if [ "${STUB_PRESERVE_LINE:-0}" = "1" ]; then   # R1: the verdict line survived
      jq -nc --arg t "$1" --arg a "$2" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)" \
        '{task:$t,arm:$a,outcome:"NOT_FIXED",oracle_strength:"INTEGRITY",visible_suite:"red",
          pristine_suite:"red",model:"stub-model",transcript:"stub.jsonl",ts:$ts,
          driver_pass:1,execution_attempt:1}' > "$KEEP/verdict-line.json"
    fi
    jq -nc --arg t "$1" --arg a "$2" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{ts:$ts,task:$t,arm:$a,model:"stub-model",driver_pass:1,execution_attempt:1,
        transcript:"stub.jsonl",workdir:"/nonexistent",base:"",task_dir:""}' > "$TB_RUNS/$1-$2.started"
    echo "stub: agent ran, finalization died"; exit 1 ;;
  wrongpair)  # a verdict lands, but for a different trajectory
    . "$SELFTEST_RUNNER_DIR/verdict-record.sh"
    T=$(mktemp)
    jq -nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)" \
      '{task:"99-wrong",arm:"ungated",outcome:"STUB",oracle_strength:"INTEGRITY",visible_suite:"red",
        pristine_suite:"red",model:"stub-model",transcript:"stub.jsonl",ts:$ts,driver_pass:1,execution_attempt:1}' > "$T"
    persist_verdict "$TB_RUNS" "99-wrong" "ungated" "$T"; rm -f "$T"; exit 0 ;;
  malformed)  # a row that MATCHES on task and arm but is not a verdict
    printf '{"task":"%s","arm":"%s"}\n' "$1" "$2" >> "$TB_RUNS/results.jsonl"; exit 0 ;;
  killed)     # the outer timeout kills the runner: marker + workspace, no cleanup
    WD=$(mktemp -d "$TB_RUNS/killed-workdir-XXXXXX")   # self-cleaning with the run dir
    mkdir -p "$WD/obs" "$WD/oracle" "$WD/repo"
    echo "observer evidence" > "$WD/obs/tree.log"; echo "x" > "$WD/repo/f.py"
    jq -nc --arg t "$1" --arg a "$2" --arg wd "$WD" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{ts:$ts,task:$t,arm:$a,model:"stub-model",driver_pass:1,execution_attempt:1,
        transcript:"stub.jsonl",workdir:$wd,base:"deadbeef",task_dir:"/nonexistent"}' \
      > "$TB_RUNS/$1-$2.started"
    exit 137 ;;
esac
. "$SELFTEST_RUNNER_DIR/verdict-record.sh"
T=$(mktemp)
jq -nc --arg t "$1" --arg a "$2" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)" \
   --argjson p "${TB_DRIVER_PASS:-1}" --argjson x "${TB_EXEC_ATTEMPT:-1}" \
   '{task:$t,arm:$a,outcome:"STUB",oracle_strength:"INTEGRITY",visible_suite:"red",
     pristine_suite:"red",model:"stub-model",transcript:"stub.jsonl",ts:$ts,
     driver_pass:$p,execution_attempt:$x}' > "$T"
persist_verdict "$TB_RUNS" "$1" "$2" "$T" || { echo "stub: persist failed"; exit 1; }
rm -f "$T"; exit 0
STUBEOF
chmod +x "$STUB"

drive() {  # <runs-dir> <launchlog> <stub-mode> [extra env assignments...]
  local runs="$1" ll="$2" mode="$3"; shift 3
  rc=0
  ( cd "$TB" && env TB_HYGIENE_TEST=1 TB_TEST_RUNS="$runs" TB_TEST_RUNNER="$STUB" \
      SELFTEST_RUNNER_DIR="$HERE" LAUNCHLOG="$ll" STUB_MODE="$mode" "$@" \
      bash runner/phase3-sweep31.sh --execute-counted >>"$TMP/drive.out" 2>&1 ) || rc=$?
  return $rc
}

# D1: force rc=8 on the first trajectory
R1="/tmp/hyg-runs-$$-a"; rm -rf "$R1"; L1="$TMP/launch1.log"; : > "$L1"
drive "$R1" "$L1" fail8; rc=$?
[ "$rc" -eq 4 ] || fail "D1: circuit breaker did not abort with exit 4 (rc=$rc)"
[ "$(wc -l < "$L1")" -eq 1 ] || fail "D1: expected exactly 1 launch, got $(wc -l < "$L1")"
[ "$(head -1 "$L1")" = "$P1TASK $P1A" ] || fail "D1: wrong first launch '$(head -1 "$L1")' (want '$P1TASK $P1A')"
[ "$(wc -l < "$R1/results.jsonl")" -eq 0 ] || fail "D1: a verdict was written during an outage"
[ "$(jq -r 'select(.event=="FAILED_LAUNCH")|.task' "$R1/deviations.jsonl" | wc -l)" -eq 1 ] \
  || fail "D1: expected exactly one FAILED_LAUNCH record"
jq -e 'select(.event=="INFRASTRUCTURE_FAILURE")' "$R1/deviations.jsonl" >/dev/null 2>&1 \
  && fail "D1: an outage burned a retry budget into a terminal INFRASTRUCTURE_FAILURE"
[ "$(wc -l < "$R1/driver-passes.log")" -eq 1 ] || fail "D1: driver pass not counted once"
echo "D1 OK: one launch, sweep aborted, retryable FAILED_LAUNCH, N-1 trajectories left UNATTEMPTED"

# D2: resume — the same trajectory is retried first, then the order completes
: > "$L1"
drive "$R1" "$L1" ok; rc=$?
[ "$rc" -eq 0 ] || fail "D2: resume did not complete (rc=$rc)"
[ "$(head -1 "$L1")" = "$P1TASK $P1A" ] || fail "D2: resume did not retry the failed launch first"
[ "$(wc -l < "$R1/results.jsonl")" -eq "$NTRAJ" ] || fail "D2: expected $NTRAJ verdicts, got $(wc -l < "$R1/results.jsonl")"
[ "$(wc -l < "$R1/driver-passes.log")" -eq 2 ] || fail "D2: driver pass not incremented on resume"
jq -e 'select(.driver_pass==2 and .execution_attempt==1)' "$R1/results.jsonl" >/dev/null \
  || fail "D2: driver_pass/execution_attempt not carried into the verdict"
rm -rf "$R1"
echo "D2 OK: resume retries the aborted trajectory first and finishes the registered order"

# D3: a terminal INFRASTRUCTURE_FAILURE is skipped, the next arm runs instead
R2="/tmp/hyg-runs-$$-b"; rm -rf "$R2"; mkdir -p "$R2"; L2="$TMP/launch2.log"; : > "$L2"
printf '{"ts":"x","task":"%s","arm":"%s","event":"INFRASTRUCTURE_FAILURE","note":"seeded"}\n' \
  "$P1TASK" "$P1A" > "$R2/deviations.jsonl"
drive "$R2" "$L2" ok; rc=$?
[ "$rc" -eq 0 ] || fail "D3: driver did not complete (rc=$rc)"
grep -qx "$P1TASK $P1A" "$L2" && fail "D3: a terminal INFRASTRUCTURE_FAILURE was re-attempted"
[ "$(head -1 "$L2")" = "$P1TASK $P1B" ] || fail "D3: wrong next trajectory '$(head -1 "$L2")'"
[ "$(wc -l < "$R2/results.jsonl")" -eq "$NLESS1" ] || fail "D3: expected $NLESS1 verdicts, got $(wc -l < "$R2/results.jsonl")"
rm -rf "$R2"
echo "D3 OK: terminal infrastructure failures stay excluded across a resume"

# D4: one unreachable TASK REPOSITORY must not halt the sweep. Before the fix
# the runner exited 8 here and the driver aborted on it, so a single deleted or
# private repo would block every resume forever.
R3="/tmp/hyg-runs-$$-c"; rm -rf "$R3"; L3="$TMP/launch3.log"; : > "$L3"
drive "$R3" "$L3" fail10 STUB_FAIL_PAIR="$P1TASK $P1A" TB_TEST_NET_OK=1; rc=$?
[ "$rc" -eq 0 ] || fail "D4: a repo-local failure halted the sweep (rc=$rc)"
[ "$(wc -l < "$R3/results.jsonl")" -eq "$NLESS1" ] || fail "D4: expected $NLESS1 verdicts, got $(wc -l < "$R3/results.jsonl")"
jq -e --arg t "$P1TASK" --arg a "$P1A" \
   'select(.task==$t and .arm==$a and .event=="INFRASTRUCTURE_FAILURE")' "$R3/deviations.jsonl" >/dev/null \
  || fail "D4: the unreachable repo was not recorded as a terminal failure"
jq -e 'select(.event=="FAILED_LAUNCH")' "$R3/deviations.jsonl" >/dev/null 2>&1 \
  && fail "D4: a repo-local failure was misrecorded as a systemic outage"
rm -rf "$R3"
echo "D4 OK: an unreachable task repository is trajectory-local, not a sweep-wide abort"

# D5: a SYSTEMIC jail failure does halt it; a one-off jail failure does not.
R4="/tmp/hyg-runs-$$-d"; rm -rf "$R4"; L4="$TMP/launch4.log"; : > "$L4"
drive "$R4" "$L4" fail9 TB_TEST_JAIL_OK=0; rc=$?
[ "$rc" -eq 4 ] || fail "D5: a systemic jail failure did not trip the breaker (rc=$rc)"
[ "$(wc -l < "$L4")" -eq 1 ] || fail "D5: expected exactly 1 launch, got $(wc -l < "$L4")"
rm -rf "$R4"
R5="/tmp/hyg-runs-$$-e"; rm -rf "$R5"; L5="$TMP/launch5.log"; : > "$L5"
drive "$R5" "$L5" fail9 STUB_FAIL_PAIR="$P1TASK $P1A" TB_TEST_JAIL_OK=1; rc=$?
[ "$rc" -eq 0 ] || fail "D5: a one-off jail failure halted the sweep (rc=$rc)"
[ "$(wc -l < "$R5/results.jsonl")" -eq "$NLESS1" ] || fail "D5: expected $NLESS1 verdicts, got $(wc -l < "$R5/results.jsonl")"
echo "D5 OK: jail failures are adjudicated by the jail self-test, not assumed"

# D7: verdicts are written ONCE. A duplicate (task, arm) is now structurally
# impossible — one immutable file per trajectory — and a poisoned derived
# ledger is repaired from those files rather than accepted.
head -1 "$R5/results.jsonl" > "$TMP/dupe.json"
DT=$(jq -r .task "$TMP/dupe.json"); DA=$(jq -r .arm "$TMP/dupe.json")
( . "$HERE/verdict-record.sh"; persist_verdict "$R5" "$DT" "$DA" "$TMP/dupe.json" ) \
  && fail "D7: a second verdict was written for a trajectory that already had one"
printf '%s\n' "$(cat "$TMP/dupe.json")" >> "$R5/results.jsonl"
: > "$L5"; drive "$R5" "$L5" ok; rc=$?
[ "$rc" -eq 0 ] || fail "D7: a poisoned derived ledger was not repaired (rc=$rc)"
[ "$(wc -l < "$R5/results.jsonl")" -eq "$NLESS1" ] || fail "D7: rebuild did not repair the ledger"
rm -rf "$R5"
echo "D7 OK: verdicts are written once; a poisoned derived ledger is repaired, not trusted"

# D8: exactly one driver per results directory.
R6="/tmp/hyg-runs-$$-f"; rm -rf "$R6"; mkdir -p "$R6"; L6="$TMP/launch6.log"; : > "$L6"
LOCKF="/tmp/tb31-driver-$(printf %s "$R6" | md5sum | cut -c1-12).lock"
( flock 8; sleep 8 ) 8>"$LOCKF" &
HOLDER=$!; sleep 1
drive "$R6" "$L6" ok; rc=$?
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
[ "$rc" -eq 6 ] || fail "D8: a second concurrent driver was allowed to run (rc=$rc)"
[ ! -s "$L6" ] || fail "D8: the refused driver still launched a trajectory"
rm -rf "$R6" "$LOCKF"
echo "D8 OK: a second concurrent driver is refused before it launches anything"

# D9: a persistent checkpoint failure must STOP the sweep. Round 3's lesson was
# hours of results living only on a disposable container; "logged and continued"
# would reproduce it with better logging.
R7="/tmp/hyg-runs-$$-g"; rm -rf "$R7"; L7="$TMP/launch7.log"; : > "$L7"
drive "$R7" "$L7" ok TB_TEST_CKPT_FAIL=1; rc=$?
[ "$rc" -eq 6 ] || fail "D9: a persistent checkpoint failure did not stop the sweep (rc=$rc)"
[ "$(wc -l < "$L7")" -eq 2 ] || fail "D9: expected the sweep to stop after pair 1 (2 launches), got $(wc -l < "$L7")"
rm -rf "$R7"
echo "D9 OK: a persistent checkpoint failure stops the sweep before the next pair"

# D10: the completion invariant is a SET identity over the registered universe,
# not a count. A run with an unregistered pair and a missing registered one
# counts to 34 and is still wrong.
R8="/tmp/hyg-runs-$$-h"; rm -rf "$R8"; L8="$TMP/launch8.log"; : > "$L8"
drive "$R8" "$L8" ok; rc=$?
[ "$rc" -eq 0 ] || fail "D10: baseline sweep did not complete (rc=$rc)"
grep -q 'COMPLETION INVARIANT OK' "$R8/phase3-log.txt" || fail "D10: baseline invariant did not pass"
rm -f "$R8/$P1TASK-$P1A.verdict.json"
jq -nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)" \
  '{task:"99-not-registered",arm:"ungated",outcome:"STUB",oracle_strength:"INTEGRITY",
    visible_suite:"red",pristine_suite:"red",model:"stub-model",transcript:"s.jsonl",
    ts:$ts,driver_pass:1,execution_attempt:1}' > "$R8/99-not-registered-ungated.verdict.json"
: > "$R8/$P1TASK-$P1A.started"   # stop the driver re-running the removed one
: > "$L8"; drive "$R8" "$L8" ok; rc=$?
[ "$rc" -eq 11 ] || [ "$rc" -eq 10 ] || fail "D10: an unregistered pair passed the completion invariant (rc=$rc)"
grep -qE 'not the registered universe|HALT' "$R8/phase3-log.txt" || fail "D10: neither a set mismatch nor a halt was reported"
rm -rf "$R8"
echo "D10 OK: an unregistered pair fails the invariant even when the count is right"

# D11: a pair recorded BOTH as a verdict and as a terminal failure must not
# cancel out — the earlier count-based check silently excluded the overlap.
R9="/tmp/hyg-runs-$$-i"; rm -rf "$R9"; L9="$TMP/launch9.log"; : > "$L9"
drive "$R9" "$L9" ok; rc=$?
[ "$rc" -eq 0 ] || fail "D11: baseline sweep did not complete (rc=$rc)"
printf '{"ts":"x","task":"%s","arm":"%s","event":"INFRASTRUCTURE_FAILURE","note":"seeded overlap"}\n' \
  "$P1TASK" "$P1A" >> "$R9/deviations.jsonl"
: > "$L9"; drive "$R9" "$L9" ok; rc=$?
[ "$rc" -eq 10 ] || fail "D11: a verdict/terminal-failure overlap passed the invariant (rc=$rc)"
grep -q 'BOTH as a verdict' "$R9/phase3-log.txt" || fail "D11: overlap not reported"
rm -rf "$R9"
echo "D11 OK: a pair cannot be both a verdict and a terminal failure"

# D12: "COMPLETE" is a claim about the ledger and must not precede its check.
R10="/tmp/hyg-runs-$$-j"; rm -rf "$R10"; L10="$TMP/launch10.log"; : > "$L10"
drive "$R10" "$L10" ok
jq -nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)" \
  '{task:"99-not-registered",arm:"gated",outcome:"STUB",oracle_strength:"INTEGRITY",
    visible_suite:"red",pristine_suite:"red",model:"stub-model",transcript:"s.jsonl",
    ts:$ts,driver_pass:1,execution_attempt:1}' > "$R10/99-not-registered-gated.verdict.json"
# the log is append-only across driver passes, so assert on THIS pass's lines
mark=$(wc -l < "$R10/phase3-log.txt")
: > "$L10"; drive "$R10" "$L10" ok; rc=$?
[ "$rc" -eq 10 ] || fail "D12: an unregistered verdict did not fail the run (rc=$rc)"
tail -n +$((mark+1)) "$R10/phase3-log.txt" > "$TMP/d12.log"
grep -q 'SWEEP COMPLETE' "$TMP/d12.log" && fail "D12: the run was logged COMPLETE despite a failed invariant"
grep -q 'FAILED COMPLETION INVARIANT' "$TMP/d12.log" || fail "D12: failed-invariant ending not logged"
rm -rf "$R10"
echo "D12 OK: a failed invariant is never logged as a complete sweep"

# D13: THE post-start boundary. Once the agent has run, its outcome exists
# scientifically; a "clean retry" would discard an observed trajectory and
# sample another. The sweep must stop after exactly one execution and must
# never invoke that task-arm again without human adjudication.
R11="/tmp/hyg-runs-$$-k"; rm -rf "$R11"; L11="$TMP/launch11.log"; : > "$L11"
drive "$R11" "$L11" poststart STUB_FAIL_PAIR="$P1TASK $P1A"; rc=$?
[ "$rc" -eq 11 ] || fail "D13: a post-start failure did not halt the sweep (rc=$rc)"
[ "$(wc -l < "$L11")" -eq 1 ] || fail "D13: the trajectory was executed $(wc -l < "$L11") times — it must run exactly once"
[ "$(wc -l < "$R11/results.jsonl")" -eq 0 ] || fail "D13: a verdict was invented for a trajectory that never produced one"
jq -e --arg t "$P1TASK" --arg a "$P1A" \
   'select(.task==$t and .arm==$a and .event=="POST_START_FINALIZATION_FAILURE")' "$R11/deviations.jsonl" >/dev/null \
  || fail "D13: no POST_START_FINALIZATION_FAILURE recorded"
# resuming without adjudication must halt again and launch NOTHING
: > "$L11"; drive "$R11" "$L11" ok; rc=$?
[ "$rc" -eq 11 ] || fail "D13: resume did not halt on the unadjudicated failure (rc=$rc)"
[ ! -s "$L11" ] || fail "D13: resume re-rolled the trajectory ($(cat "$L11"))"
# once adjudicated as an EXCLUSION, the sweep proceeds and the ledger balances
bash "$HERE/adjudicate31.sh" "$R11" "$P1TASK" "$P1A" auto > "$TMP/adj13.out" 2>&1 \
  || fail "D13: the adjudication ladder failed: $(cat "$TMP/adj13.out")"
grep -q 'ladder: R3' "$TMP/adj13.out" || fail "D13: the ladder did not resolve to R3 with no surviving workspace"
: > "$L11"; drive "$R11" "$L11" ok; rc=$?
[ "$rc" -eq 0 ] || fail "D13: adjudicated exclusion did not let the sweep finish (rc=$rc)"
grep -qx "$P1TASK $P1A" "$L11" && fail "D13: an adjudicated exclusion was still re-rolled"
[ "$(wc -l < "$R11/results.jsonl")" -eq "$NLESS1" ] || fail "D13: expected $NLESS1 verdicts, got $(wc -l < "$R11/results.jsonl")"
grep -q 'COMPLETION INVARIANT OK' "$R11/phase3-log.txt" || fail "D13: the invariant did not accept the excluded trajectory"
rm -rf "$R11"
echo "D13 OK: a trajectory that ran is never re-rolled; the sweep halts for adjudication"

# D14: acceptance must be an exact (task, arm) match, not line-count growth.
R12="/tmp/hyg-runs-$$-l"; rm -rf "$R12"; L12="$TMP/launch12.log"; : > "$L12"
drive "$R12" "$L12" wrongpair STUB_FAIL_PAIR="$P1TASK $P1A"; rc=$?
[ "$(wc -l < "$L12")" -ge 2 ] || fail "D14: a line for another trajectory was accepted as this one's verdict"
jq -e --arg t "$P1TASK" --arg a "$P1A" \
   'select(.task==$t and .arm==$a and .event=="INFRASTRUCTURE_FAILURE")' "$R12/deviations.jsonl" >/dev/null \
  || fail "D14: the unmatched trajectory was not recorded as a failure"
[ "$rc" -eq 10 ] || fail "D14: the stray unregistered verdict passed the completion invariant (rc=$rc)"
rm -rf "$R12"
echo "D14 OK: only an exact (task,arm) verdict counts as that trajectory's result"

# D15: THE RECONSTRUCTION ROUTE, driven by the frozen ladder. The failure event
# is append-only; the disposition is separate; a reconstructed verdict is
# counted once, never re-run, and compatible with the completion invariant.
R13="/tmp/hyg-runs-$$-m"; rm -rf "$R13"; L13="$TMP/launch13.log"; : > "$L13"
drive "$R13" "$L13" poststart STUB_FAIL_PAIR="$P1TASK $P1A" STUB_PRESERVE_LINE=1; rc=$?
[ "$rc" -eq 11 ] || fail "D15: setup — post-start failure did not halt (rc=$rc)"
# the ladder must resolve to R1 and reconstruct; exclusion must be REFUSED
bash "$HERE/adjudicate31.sh" "$R13" "$P1TASK" "$P1A" exclusion "I would rather drop this one" >/dev/null 2>&1 \
  && fail "D15: a discretionary exclusion was accepted while the artifacts sufficed"
bash "$HERE/adjudicate31.sh" "$R13" "$P1TASK" "$P1A" auto > "$TMP/adj15.out" 2>&1 \
  || fail "D15: the ladder refused a reconstructible trajectory: $(cat "$TMP/adj15.out")"
grep -q 'ladder: R1' "$TMP/adj15.out" || fail "D15: the ladder did not resolve to R1"
# the disposition is structured: rule, reviewer, timestamp, artifact hashes
jq -e --arg t "$P1TASK" --arg a "$P1A" \
   'select(.task==$t and .arm==$a and .event=="POST_START_ADJUDICATED_VERDICT")
    | (.rule=="R1") and (.adjudicated_by|type=="string") and (.ts|type=="string")
      and (.artifacts.verdict_sha256|length==64)' "$R13/deviations.jsonl" >/dev/null \
  || fail "D15: the disposition record is not structured (rule/reviewer/ts/hashes)"
# dispositions are recorded once
bash "$HERE/adjudicate31.sh" "$R13" "$P1TASK" "$P1A" auto >/dev/null 2>&1 \
  && fail "D15: a second disposition was accepted"
: > "$L13"; drive "$R13" "$L13" ok; rc=$?
[ "$rc" -eq 0 ] || fail "D15: the sweep did not complete after reconstruction (rc=$rc)"
grep -qx "$P1TASK $P1A" "$L13" && fail "D15: the reconstructed trajectory was re-run"
[ "$(wc -l < "$R13/results.jsonl")" -eq "$NTRAJ" ] || fail "D15: expected $NTRAJ verdicts, got $(wc -l < "$R13/results.jsonl")"
grep -q 'COMPLETION INVARIANT OK' "$R13/phase3-log.txt" \
  || fail "D15: the reconstructed verdict is still incompatible with the completion invariant"
rm -rf "$R13"
echo "D15 OK: the ladder reconstructs when artifacts suffice and refuses discretionary exclusion"

# D16: the deviations ledger governs every exceptional case, so it fails closed.
R14="/tmp/hyg-runs-$$-n"; L14="$TMP/launch14.log"
ledger_rejects() {  # <description> <ledger-content>
  rm -rf "$R14"; mkdir -p "$R14"; : > "$L14"
  printf '%s\n' "$2" > "$R14/deviations.jsonl"
  drive "$R14" "$L14" ok; local r=$?
  [ "$r" -eq 12 ] || fail "D16: $1 was accepted (rc=$r)"
  [ ! -s "$L14" ] || fail "D16: $1 still launched a trajectory"
  grep -q 'DEVIATIONS LEDGER INVALID' "$R14/phase3-log.txt" || fail "D16: $1 not reported as invalid"
}
ledger_rejects "malformed JSON" '{"event":"NOTE","note":"unterminated'
ledger_rejects "an unknown event" '{"ts":"x","task":"'"$P1TASK"'","arm":"ungated","event":"MYSTERY_EVENT"}'
ledger_rejects "a trajectory event with no task" '{"ts":"x","arm":"ungated","event":"INFRASTRUCTURE_FAILURE"}'
ledger_rejects "a trajectory event with a bad arm" '{"ts":"x","task":"'"$P1TASK"'","arm":"sideways","event":"INFRASTRUCTURE_FAILURE"}'
ledger_rejects "a duplicate terminal disposition" \
  '{"ts":"x","task":"'"$P1TASK"'","arm":"ungated","event":"INFRASTRUCTURE_FAILURE"}
{"ts":"y","task":"'"$P1TASK"'","arm":"ungated","event":"INFRASTRUCTURE_FAILURE"}'
ledger_rejects "contradictory terminal dispositions" \
  '{"ts":"x","task":"'"$P1TASK"'","arm":"ungated","event":"INFRASTRUCTURE_FAILURE"}
{"ts":"y","task":"'"$P1TASK"'","arm":"ungated","event":"POST_START_ADJUDICATED_EXCLUSION"}'
# repeated non-disposition EVENTS remain legitimate
rm -rf "$R14"; mkdir -p "$R14"; : > "$L14"
printf '%s\n' '{"ts":"x","task":"'"$P1TASK"'","arm":"ungated","event":"FAILED_LAUNCH"}
{"ts":"y","task":"'"$P1TASK"'","arm":"ungated","event":"FAILED_LAUNCH"}
{"ts":"z","event":"NOTE","note":"free-form events need no identity"}' > "$R14/deviations.jsonl"
drive "$R14" "$L14" ok; rc=$?
[ "$rc" -eq 0 ] || fail "D16: repeated non-disposition events were rejected (rc=$rc)"
rm -rf "$R14"
echo "D16 OK: the ledger fails closed on malformed, unknown, unidentified and contradictory records"

# D17: an outer-timeout kill leaves no chance for the runner to preserve its own
# artifacts. The driver must preserve the marker's workspace itself, so the halt
# message points at evidence that actually exists.
R15="/tmp/hyg-runs-$$-o"; rm -rf "$R15"; L15="$TMP/launch15.log"; : > "$L15"
drive "$R15" "$L15" killed STUB_FAIL_PAIR="$P1TASK $P1A"; rc=$?
[ "$rc" -eq 11 ] || fail "D17: a killed runner did not halt the sweep (rc=$rc)"
[ "$(wc -l < "$L15")" -eq 1 ] || fail "D17: the killed trajectory was re-rolled"
KEEP15="$R15/$P1TASK-$P1A-poststart-workdir"
[ -d "$KEEP15" ] || fail "D17: the halt message points at a directory that does not exist"
[ -s "$KEEP15/obs/tree.log" ] || fail "D17: observer evidence was not preserved from the killed workspace"
[ -s "$KEEP15/repo-final-tree.tar" ] || fail "D17: the final repository tree was not preserved"
rm -rf "$R15"
echo "D17 OK: a killed runner's evidence is preserved by the driver, not lost with it"

# D18: a row that MATCHES on task and arm but is not a verdict must never be
# accepted as one — this reported SWEEP COMPLETE with exit 0 before the fix.
R16="/tmp/hyg-runs-$$-p"; rm -rf "$R16"; L16="$TMP/launch16.log"; : > "$L16"
drive "$R16" "$L16" malformed STUB_FAIL_PAIR="$P1TASK $P1A"; rc=$?
[ "$(wc -l < "$L16")" -ge 2 ] || fail "D18: the malformed row was accepted as this trajectory's verdict"
jq -e --arg t "$P1TASK" --arg a "$P1A" \
   'select(.task==$t and .arm==$a and .event=="INFRASTRUCTURE_FAILURE")' "$R16/deviations.jsonl" >/dev/null \
  || fail "D18: the trajectory with only a malformed row was not recorded as unfinished"
[ ! -e "$R16/$P1TASK-$P1A.verdict.json" ] || fail "D18: a malformed row became a verdict file"
jq -e -s 'all((.outcome|type=="string") and ((.outcome|length)>0))' "$R16/results.jsonl" >/dev/null \
  || fail "D18: the malformed row survived into the derived ledger"
rm -rf "$R16"
echo "D18 OK: a matching-but-malformed row is never a verdict, and never survives the ledger"

# D19: results.jsonl is DERIVED from immutable per-trajectory files, so a torn
# or poisoned ledger is always recoverable.
R17="/tmp/hyg-runs-$$-q"; rm -rf "$R17"; L17="$TMP/launch17.log"; : > "$L17"
drive "$R17" "$L17" ok; rc=$?
[ "$rc" -eq 0 ] || fail "D19: baseline sweep did not complete (rc=$rc)"
[ "$(ls "$R17"/*.verdict.json 2>/dev/null | wc -l)" -eq "$NTRAJ" ] || fail "D19: per-trajectory verdict files missing"
printf 'not json at all\n' >> "$R17/results.jsonl"
bash "$HERE/rebuild-results31.sh" "$R17" >/dev/null || fail "D19: the ledger could not be rebuilt"
[ "$(wc -l < "$R17/results.jsonl")" -eq "$NTRAJ" ] || fail "D19: rebuild did not restore exactly $NTRAJ verdicts"
jq -e -s 'all(.outcome=="STUB")' "$R17/results.jsonl" >/dev/null || fail "D19: rebuilt ledger is not clean"
rm -rf "$R17"
echo "D19 OK: the ledger is derived from immutable per-trajectory files and is rebuildable"

# D20: the ladder DETERMINES the verdict; it is never chosen after seeing the
# trajectory. A structurally valid record for the same trajectory but with a
# different outcome is exactly the post-outcome substitution the ladder exists
# to prevent, and `verdict` mode must refuse it.
R18="/tmp/hyg-runs-$$-r"; rm -rf "$R18"; L18="$TMP/launch18.log"; : > "$L18"
drive "$R18" "$L18" poststart STUB_FAIL_PAIR="$P1TASK $P1A" STUB_PRESERVE_LINE=1; rc=$?
[ "$rc" -eq 11 ] || fail "D20: setup — post-start failure did not halt (rc=$rc)"
CANON="$R18/$P1TASK-$P1A-poststart-workdir/verdict-line.json"
jq -c '.outcome="HONEST_FIX"' "$CANON" > "$TMP/substituted.json"
bash "$HERE/adjudicate31.sh" "$R18" "$P1TASK" "$P1A" verdict "$TMP/substituted.json" >/dev/null 2>&1 \
  && fail "D20: a same-trajectory verdict with an altered outcome was accepted"
[ ! -e "$R18/$P1TASK-$P1A.verdict.json" ] || fail "D20: the substituted verdict was persisted anyway"
# the canonical record itself still verifies
bash "$HERE/adjudicate31.sh" "$R18" "$P1TASK" "$P1A" verdict "$CANON" >/dev/null 2>&1 \
  || fail "D20: the ladder's own record failed verification"
jq -e --arg t "$P1TASK" --arg a "$P1A" \
   'select(.task==$t and .arm==$a and .outcome=="NOT_FIXED")' "$R18/$P1TASK-$P1A.verdict.json" >/dev/null \
  || fail "D20: the persisted verdict is not the canonical one"
rm -rf "$R18"
echo "D20 OK: a verdict is derived from the artifacts, never substituted after seeing them"

# D21: R1 means a COMPLETE verdict survived, not merely some bytes. A torn line
# must fall through to R2 rather than dead-end the ladder.
R19="/tmp/hyg-runs-$$-s"; rm -rf "$R19"; L19="$TMP/launch19.log"; : > "$L19"
drive "$R19" "$L19" poststart STUB_FAIL_PAIR="$P1TASK $P1A" STUB_TORN_LINE=1; rc=$?
[ "$rc" -eq 11 ] || fail "D21: setup — post-start failure did not halt (rc=$rc)"
bash "$HERE/adjudicate31.sh" "$R19" "$P1TASK" "$P1A" ladder > "$TMP/adj21.out" 2>&1 \
  || fail "D21: the ladder diagnostic failed: $(cat "$TMP/adj21.out")"
grep -q 'ladder: R2' "$TMP/adj21.out" \
  || fail "D21: a torn verdict line did not fall through to R2: $(cat "$TMP/adj21.out")"
grep -q 'partial verdict line was present and disregarded' "$TMP/adj21.out" \
  || fail "D21: the disregarded partial line was not reported"
rm -rf "$R19"
echo "D21 OK: a torn verdict line falls through to re-derivation instead of dead-ending"

# E1: no harness internal reaches the agent's environment, and the withheld
# oracle is not inside the workspace the agent can reach from its own paths.
# grep -c exits 1 on zero matches, so the count must not be guarded by ||
n=$(TB_RUNS=/x TB_TASKS=/y TB_VENV=/z bash -c '
      SCRUB=(); for _n in $(compgen -e); do case "$_n" in TB_*) SCRUB+=(-u "$_n");; esac; done
      env "${SCRUB[@]}" env | { grep -c "^TB_" || true; }' 2>/dev/null | head -1)
[ "$n" = "0" ] || fail "E1: $n TB_* variable(s) survived the scrub into the agent environment"
[ "$(grep -c 'env "${SCRUB\[@\]}"' "$HERE/run-task31.sh")" -ge 2 ] \
  || fail "E1: the agent invocations do not scrub the harness environment"
grep -q 'ORACLE="$CTRL/oracle"' "$HERE/run-task31.sh" \
  || fail "E1: the withheld oracle is still inside the agent's workspace"
grep -q 'ORACLE="$W/oracle"' "$HERE/run-task31.sh" \
  && fail "E1: the oracle is still assigned inside the workspace"
echo "E1 OK: no TB_* reaches the agent; the withheld oracle is outside its workspace"

# M1: a bare invocation must REFUSE, and --check must create nothing. On
# 2026-09-01 a bare invocation meant to verify the registration gate started the
# real sweep and executed a counted trajectory before the preregistration line.
rc=0; ( cd "$TB" && bash runner/phase3-sweep31.sh >"$TMP/m1.out" 2>&1 ) || rc=$?
[ "$rc" -eq 2 ] || fail "M1: a bare invocation did not refuse (rc=$rc)"
grep -q 'requires an explicit mode' "$TMP/m1.out" || fail "M1: the refusal does not name the missing mode"
grep -q 'never be re-rolled' "$TMP/m1.out" || fail "M1: --execute-counted is not described as creating counted trajectories"
M1R="/tmp/hyg-runs-$$-t"; rm -rf "$M1R"
rc=0; ( cd "$TB" && TB_HYGIENE_TEST=1 TB_TEST_RUNS="$M1R" TB_TEST_RUNNER="$STUB" \
        SELFTEST_RUNNER_DIR="$HERE" LAUNCHLOG="$TMP/m1.log" STUB_MODE=ok \
        bash runner/phase3-sweep31.sh --check >"$TMP/m1c.out" 2>&1 ) || rc=$?
[ "$rc" -eq 0 ] || fail "M1: --check failed (rc=$rc): $(tail -2 "$TMP/m1c.out")"
grep -q 'CHECK OK' "$TMP/m1c.out" || fail "M1: --check did not report OK"
[ ! -e "$M1R" ] || fail "M1: --check created the results directory"
[ ! -s "$TMP/m1.log" ] || fail "M1: --check launched a trajectory"
rm -rf "$M1R"
echo "M1 OK: a bare invocation refuses; --check validates without creating or running anything"

# ---------------------------------------------------------------- S ----
grep -q 'driver_pass:\$pass, execution_attempt:\$xattempt' "$HERE/run-task31.sh" \
  || fail "S: verdict line does not stamp driver_pass and execution_attempt separately"
grep -q 'attempt:\$attempt' "$HERE/run-task31.sh" \
  && fail 'S: the ambiguous single-field attempt stamp is still emitted'
# the boundary must be the LAST thing before the agent invocation
bl=$(grep -n 'start_agent_network; snrc=' "$HERE/run-task31.sh" | cut -d: -f1)
al=$(grep -n '^AGENT_CMD=' "$HERE/run-task31.sh" | cut -d: -f1)
gl=$(grep -n 'PRE_AGENT_GOLD_RED' "$HERE/run-task31.sh" | cut -d: -f1)
{ [ -n "$bl" ] && [ -n "$al" ] && [ -n "$gl" ] && [ "$gl" -lt "$bl" ] && [ "$bl" -lt "$al" ]; } \
  || fail "S: the network boundary is not between gold validation and the agent invocation"
echo "S OK: attempt provenance split; boundary sits immediately before the agent"

echo "hygiene selftest OK"
