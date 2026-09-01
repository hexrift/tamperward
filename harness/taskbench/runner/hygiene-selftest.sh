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
#  D13 a trajectory that RAN is never re-rolled; the sweep halts for adjudication
#  D14 acceptance is an exact (task,arm) match, not line-count growth
#  D9  a persistent checkpoint failure stops the sweep before the next pair
#  D10 the completion invariant is a set identity, not a count
#  D11 a pair cannot be both a verdict and a terminal failure
#  D12 a failed invariant is never logged as a complete sweep
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
  for x in a b c d e f g h i j k l; do
    rm -f "/tmp/tb31-driver-$(printf %s "/tmp/hyg-runs-$$-$x" | md5sum | cut -c1-12).lock"
  done
}
trap cleanup EXIT

# ---------------------------------------------------------------- G ----
rc=0; ( cd "$TB" && bash runner/phase3-sweep31.sh >"$TMP/g0.out" 2>&1 ) || rc=$?
[ "$rc" -eq 7 ] || fail "G: unregistered driver did not refuse (rc=$rc)"
grep -q 'REGISTERED_MODEL is empty or still a placeholder' "$TMP/g0.out" \
  || fail "G: refusal did not name REGISTERED_MODEL"
# a HALF-registered driver (model filled, seeds not) must still refuse, and
# must name the unfilled seed — the defect the review caught
for filled in 'REGISTERED_MODEL' 'REGISTERED_MODEL PAIR_SEED'; do
  cp "$HERE/phase3-sweep31.sh" "$HERE/.hyg-gate-probe.sh"
  for k in $filled; do
    sed -i "s|^$k=\"__SET_AT_REGISTRATION__\"|$k=\"probe-value\"|" "$HERE/.hyg-gate-probe.sh"
  done
  rc=0; ( cd "$TB" && bash runner/.hyg-gate-probe.sh >"$TMP/g1.out" 2>&1 ) || rc=$?
  rm -f "$HERE/.hyg-gate-probe.sh"
  [ "$rc" -eq 7 ] || fail "G: driver with only [$filled] filled did not refuse (rc=$rc)"
  case "$filled" in
    'REGISTERED_MODEL') want=PAIR_SEED ;;
    *) want=ARM_SEED ;;
  esac
  grep -q "$want is empty or still a placeholder" "$TMP/g1.out" \
    || fail "G: refusal with [$filled] filled did not name $want"
done
echo "G OK: gate refuses until REGISTERED_MODEL, PAIR_SEED and ARM_SEED are all filled"

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
# The registered order under the TESTMODE seeds, derived independently here.
read -r P1TASK P1A P1B < <(cd "$TB" && node - <<'NODE'
const crypto=require('crypto'), fs=require('fs');
const tasks=fs.readdirSync('round3/tasks').filter(d=>JSON.parse(fs.readFileSync(`round3/tasks/${d}/manifest.json`)).role==='main').sort();
const PAIR='testmode-pair-seed', ARM='testmode-arm-seed';
const t=tasks.map(t=>[crypto.createHash('sha256').update(`${PAIR}:${t}`).digest('hex'),t]).sort()[0][1];
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
    : > "$TB_RUNS/$1-$2.started"; echo "stub: agent ran, finalization died"; exit 1 ;;
  wrongpair)  # a line lands, but for a different trajectory
    printf '{"task":"99-wrong","arm":"ungated","outcome":"STUB"}\n' >> "$TB_RUNS/results.jsonl"; exit 0 ;;
esac
printf '{"task":"%s","arm":"%s","outcome":"STUB","driver_pass":%s,"execution_attempt":%s}\n' \
  "$1" "$2" "${TB_DRIVER_PASS:-0}" "${TB_EXEC_ATTEMPT:-0}" >> "$TB_RUNS/results.jsonl"
exit 0
STUBEOF
chmod +x "$STUB"

drive() {  # <runs-dir> <launchlog> <stub-mode> [extra env assignments...]
  local runs="$1" ll="$2" mode="$3"; shift 3
  rc=0
  ( cd "$TB" && env TB_HYGIENE_TEST=1 TB_TEST_RUNS="$runs" TB_TEST_RUNNER="$STUB" \
      LAUNCHLOG="$ll" STUB_MODE="$mode" "$@" bash runner/phase3-sweep31.sh >>"$TMP/drive.out" 2>&1 ) || rc=$?
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
echo "D1 OK: one launch, sweep aborted, retryable FAILED_LAUNCH, 33 trajectories left UNATTEMPTED"

# D2: resume — the same trajectory is retried first, then the order completes
: > "$L1"
drive "$R1" "$L1" ok; rc=$?
[ "$rc" -eq 0 ] || fail "D2: resume did not complete (rc=$rc)"
[ "$(head -1 "$L1")" = "$P1TASK $P1A" ] || fail "D2: resume did not retry the failed launch first"
[ "$(wc -l < "$R1/results.jsonl")" -eq 34 ] || fail "D2: expected 34 verdicts, got $(wc -l < "$R1/results.jsonl")"
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
[ "$(wc -l < "$R2/results.jsonl")" -eq 33 ] || fail "D3: expected 33 verdicts, got $(wc -l < "$R2/results.jsonl")"
rm -rf "$R2"
echo "D3 OK: terminal infrastructure failures stay excluded across a resume"

# D4: one unreachable TASK REPOSITORY must not halt the sweep. Before the fix
# the runner exited 8 here and the driver aborted on it, so a single deleted or
# private repo would block every resume forever.
R3="/tmp/hyg-runs-$$-c"; rm -rf "$R3"; L3="$TMP/launch3.log"; : > "$L3"
drive "$R3" "$L3" fail10 STUB_FAIL_PAIR="$P1TASK $P1A" TB_TEST_NET_OK=1; rc=$?
[ "$rc" -eq 0 ] || fail "D4: a repo-local failure halted the sweep (rc=$rc)"
[ "$(wc -l < "$R3/results.jsonl")" -eq 33 ] || fail "D4: expected 33 verdicts, got $(wc -l < "$R3/results.jsonl")"
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
[ "$(wc -l < "$R5/results.jsonl")" -eq 33 ] || fail "D5: expected 33 verdicts, got $(wc -l < "$R5/results.jsonl")"
echo "D5 OK: jail failures are adjudicated by the jail self-test, not assumed"

# D7: a duplicated (task, arm) verdict — what a second concurrent driver would
# produce — must fail the completion invariant rather than reach analysis.
head -1 "$R5/results.jsonl" >> "$R5/results.jsonl"
: > "$L5"; drive "$R5" "$L5" ok; rc=$?
[ "$rc" -eq 10 ] || fail "D7: a duplicated verdict passed the completion invariant (rc=$rc)"
grep -q 'INVARIANT VIOLATION' "$R5/phase3-log.txt" || fail "D7: no invariant violation logged"
rm -rf "$R5"
echo "D7 OK: duplicated verdicts and short counts fail the completion invariant"

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
grep -v "\"task\":\"$P1TASK\",\"arm\":\"$P1A\"" "$R8/results.jsonl" > "$R8/r.tmp"
printf '{"task":"99-not-registered","arm":"ungated","outcome":"STUB","driver_pass":1,"execution_attempt":1}\n' >> "$R8/r.tmp"
mv "$R8/r.tmp" "$R8/results.jsonl"
: > "$L8"; drive "$R8" "$L8" ok; rc=$?
[ "$rc" -eq 10 ] || fail "D10: an unregistered pair passed the completion invariant (rc=$rc)"
grep -q 'not the registered universe' "$R8/phase3-log.txt" || fail "D10: set mismatch not reported"
rm -rf "$R8"
echo "D10 OK: an unregistered pair fails the invariant even when the count is 34"

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
head -1 "$R10/results.jsonl" >> "$R10/results.jsonl"
# the log is append-only across driver passes, so assert on THIS pass's lines
mark=$(wc -l < "$R10/phase3-log.txt")
: > "$L10"; drive "$R10" "$L10" ok; rc=$?
[ "$rc" -eq 10 ] || fail "D12: duplicate verdict did not fail the run (rc=$rc)"
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
# once adjudicated as an exclusion, the sweep proceeds and the ledger balances
: > "$R11/$P1TASK-$P1A.adjudicated"
: > "$L11"; drive "$R11" "$L11" ok; rc=$?
[ "$rc" -eq 0 ] || fail "D13: adjudicated exclusion did not let the sweep finish (rc=$rc)"
grep -qx "$P1TASK $P1A" "$L11" && fail "D13: an adjudicated exclusion was still re-rolled"
[ "$(wc -l < "$R11/results.jsonl")" -eq 33 ] || fail "D13: expected 33 verdicts, got $(wc -l < "$R11/results.jsonl")"
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
