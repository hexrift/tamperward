#!/usr/bin/env bash
# Round-4 orchestration self-test. Every case is a defect that actually occurred
# in the D3 incident or its first recovery; each asserts the correction holds.
# No repository is cloned and no frame is touched: these exercise the
# orchestration, not the walk.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
pass=0; fail=0
ok(){ echo "  ok   $1"; pass=$((pass+1)); }
no(){ echo "  FAIL $1"; fail=$((fail+1)); }
try(){ desc="$1"; shift; if "$@" >/dev/null 2>&1; then no "$desc (expected non-zero)"; else ok "$desc"; fi; }

echo "== P0: wait status propagation"
r=$(bash -c 'f(){ return 3; }; f & p=$!; if wait $p; then echo 0; else echo $?; fi')
[ "$r" = 3 ] && ok "wait status captured in else-branch (got 3)" || no "wait status: got '$r', want 3"
r=$(bash -c 'f(){ return 3; }; f & p=$!; if ! wait $p; then echo $?; fi')
[ "$r" = 0 ] && ok "the buggy negated form is still 0 — regression sentinel" || no "negated form: got '$r'"

echo "== P0: a pilot pool cannot be given an unbounded need"
out=$(TB_POOL=pilot TB_PILOT_NEED=99 ./mine5.sh 2>&1); echo "$out" | grep -q 'REFUSING: TB_PILOT_NEED=99' \
  && ok "TB_PILOT_NEED=99 refused on pilot" || no "unbounded pilot need not refused"
out=$(TB_POOL=pilot-s0 TB_PILOT_NEED=99 ./mine5.sh 2>&1); echo "$out" | grep -q 'REFUSING: TB_PILOT_NEED=99' \
  && ok "refusal keys off BASE_POOL, so a shard name cannot dodge it" || no "shard name dodged the pilot refusal"

echo "== P0: configuration derives from the base pool"
grep -q 'if \[ "\$BASE_POOL" = pilot \]' mine5.sh && ok "mine5.sh selects defaults on BASE_POOL" || no "mine5.sh still selects on POOL"

echo "== D4: the pilot is never sharded"
try "mine-parallel refuses a sharded pilot"  env TB_POOL=pilot ./mine-parallel.sh 3
try "launch-mine refuses a sharded pilot"    ./launch-mine.sh pilot 3

echo "== P0: a tripped breaker stops everything"
B=/tmp/tb-selftest-breaker; : > "$B"
try "mine-parallel refuses to launch into a tripped breaker" env TB_CLONE_BREAKER="$B" TB_POOL=counted ./mine-parallel.sh 1
try "launch-mine refuses to launch into a tripped breaker"   env TB_CLONE_BREAKER="$B" ./launch-mine.sh counted 1
out=$(TB_CLONE_BREAKER="$B" PATH="$HERE/shim:$PATH" timeout 30 git clone https://example.invalid/x /tmp/tb-st-$$ 2>&1); rc=$?
[ "$rc" = 90 ] && ok "shim exits 90 (infra) when the breaker is already tripped" || no "shim exit was $rc, want 90"
try "merge refuses while the breaker is tripped"             env TB_CLONE_BREAKER="$B" ./merge-shards.sh counted 1 1
out=$(TB_CLONE_BREAKER="$B" PATH="$HERE/shim:$PATH" git clone https://example.invalid/x /tmp/tb-st-$$ 2>&1)
echo "$out" | grep -q 'INFRASTRUCTURE_FAILURE' && ok "shim raises INFRASTRUCTURE_FAILURE, not a clone failure" || no "shim did not raise an infra failure"
rm -f "$B"

echo "== P1: the merger proves completion and rejects malformed input"
T=$(mktemp -d); mkdir -p "$T/pools/counted-s0/tasks" "$T/pools/counted/"
printf '{"order":["a/b"]}' > "$T/pools/counted/walk.json"
cp merge-shards.sh mine5.sh "$T/" 2>/dev/null
( cd "$T" && ./merge-shards.sh counted 1 1 >/dev/null 2>&1 ) && no "merged without a completion record" || ok "merge refused: no completion record"
printf '{"pool":"counted-s0"}' > "$T/pools/counted-s0/completion.json"
mkdir -p "$T/pools/counted-s0/tasks/01-x"; printf '{"repo":"zzz/not-in-walk","stratum":"workspace","commit_sha":"a","parent_sha":"b"}' > "$T/pools/counted-s0/tasks/01-x/manifest.json"
( cd "$T" && ./merge-shards.sh counted 1 1 >/dev/null 2>&1 ) && no "merged a task outside the walk" || ok "merge refused: task outside the walk"
printf 'not json' > "$T/pools/counted-s0/tasks/01-x/manifest.json"
( cd "$T" && ./merge-shards.sh counted 1 1 >/dev/null 2>&1 ) && no "merged a malformed manifest" || ok "merge refused: malformed manifest"
rm -rf "$T"

echo "== P1: selection is frozen walk order; strata describe, never select"
# The removed defect: the merger filled a 55 single-distribution / 55 workspace
# quota that PREDICTION4 registers nowhere, and that round 3's yield (18 single,
# 2 workspace from 500 repos) shows no frame of this size can meet. A quota the
# population cannot satisfy fails the merge on a property of the population.
T=$(mktemp -d); cp merge-shards.sh "$T/"; mkdir -p "$T/pools/counted"
printf '{"order":["r/first","r/second","r/third"]}' > "$T/pools/counted/walk.json"
mk(){ mkdir -p "$T/pools/counted-s0/tasks/$1"; printf '{"repo":"%s","stratum":"%s","commit_sha":"a","parent_sha":"b"}' \
        "$2" "$3" > "$T/pools/counted-s0/tasks/$1/manifest.json"; }
mkdir -p "$T/pools/counted-s0"; printf '{"pool":"counted-s0"}' > "$T/pools/counted-s0/completion.json"
# every task workspace-free: under the old quota this could never fill 55 workspace
mk 03-c r/third  single-distribution
mk 01-a r/first  single-distribution
mk 02-b r/second single-distribution
out=$(cd "$T" && TB_CLONE_BREAKER="$T/nobreaker" ./merge-shards.sh counted 1 2 2>&1)
if [ -d "$T/pools/counted/tasks/01-a" ] && [ -d "$T/pools/counted/tasks/02-b" ] && [ ! -d "$T/pools/counted/tasks/03-c" ]; then
  ok "the first N validated tasks in walk order are selected"
else
  no "selection did not follow walk order: $(ls "$T/pools/counted/tasks" 2>/dev/null | tr '\n' ' ')"
fi
node -p "JSON.parse(require('fs').readFileSync('$T/pools/counted/selection.json')).stratum_mix['single-distribution']" 2>/dev/null \
  | grep -qx 2 && ok "the stratum mix is recorded descriptively beside tasks/" || no "no descriptive stratum record"
[ -e "$T/pools/counted/tasks/selection.json" ] && no "the selection record was published INSIDE tasks/" \
  || ok "the selection record is not itself a task"
grep -q 'TB_QUOTA_SINGLE\|TB_QUOTA_WS' merge-shards.sh mine5.sh mine-parallel.sh \
  && no "a stratum quota survives in the miner or merger" || ok "no stratum quota remains anywhere"
rm -rf "$T"

echo "== P0: the clone shim reaches EVERY entry point, or the miner refuses"
# The pilot runs mine5.sh directly (launch-mine.sh), and only mine-parallel.sh
# installed the shim — so the sequential pilot mined with the real git: no
# serialisation, no retries, no breaker, and a failed clone free to become a
# terminal CLONE_FAILED. These two cases are functional, not textual: they run
# the miner and look at what it wrote.
sandbox() { # -> path of a self-contained mine5.sh sandbox with one unreachable repo
  local d; d=$(mktemp -d)
  cp mine5.sh "$d/"; cp -R shim "$d/"
  mkdir -p "$d/pools/counted"
  printf '{"order":["tb-selftest/unreachable"]}' > "$d/pools/counted/walk.json"
  echo "$d"
}
D=$(sandbox)
out=$(cd "$D" && env TB_POOL=counted TB_CLONE_BASE="file:///nonexistent-tb-selftest" \
        TB_CLONE_MAX_CONSEC=1 TB_CLONE_LOCK="$D/clone.lock" TB_CLONE_BREAKER="$D/breaker" \
        TB_CLONE_FAILS="$D/fails" TB_INFRA_LOG="$D/infra.jsonl" TB_POOL_LOCK="$D/pool.lock" \
        timeout 120 ./mine5.sh 2>&1)
grep -q CLONE_FAILED "$D/pools/counted/attrition.jsonl" 2>/dev/null \
  && no "a failed clone STILL became a terminal CLONE_FAILED verdict" \
  || ok "a failed clone writes no terminal verdict when mine5.sh is run directly"
[ -e "$D/breaker" ] && ok "the breaker trips for a directly-invoked miner (it could not before)" \
  || no "the breaker never tripped — the shim is not on the direct path"
grep -q INFRASTRUCTURE_FAILURE "$D/infra.jsonl" 2>/dev/null \
  && ok "the failure is raised as INFRASTRUCTURE_FAILURE" || no "no INFRASTRUCTURE_FAILURE recorded"
rm -rf "$D"
D=$(sandbox); rm -rf "$D/shim"
out=$(cd "$D" && env TB_POOL=counted TB_POOL_LOCK="$D/pool.lock" ./mine5.sh 2>&1); rc=$?
[ "$rc" = 9 ] && echo "$out" | grep -q 'not the clone shim' \
  && ok "with no shim reachable the miner REFUSES rather than mining unprotected" \
  || no "miner ran without the shim (rc=$rc)"
rm -rf "$D"

echo "== P0: one miner per pool, enforced for the miner's whole lifetime"
# Session counting in status.sh sees accumulation after the fact; only a lock
# prevents a second launch. mine-parallel locked each shard, so the sequential
# pilot — the one mode that skips it — had no lock at all.
locked() { ( flock -n 6 ) 6>"$1" 2>/dev/null && return 1 || return 0; }
D=$(sandbox)
( flock 7; sleep 90 ) 7>"$D/clone.lock" &   # hold the shim's clone lock: miner 1 blocks mid-clone
holder=$!; disown "$holder" 2>/dev/null || true
# Own session, so the test can stop the miner the way the runbook stops one.
setsid env TB_POOL=counted TB_CLONE_BASE="file:///nonexistent-tb-selftest" \
    TB_CLONE_LOCK="$D/clone.lock" TB_CLONE_BREAKER="$D/breaker" TB_CLONE_FAILS="$D/fails" \
    TB_INFRA_LOG="$D/infra.jsonl" TB_POOL_LOCK="$D/pool.lock" \
    bash -c 'cd "$1" && ./mine5.sh' _ "$D" >/dev/null 2>&1 &
first=$!; disown "$first" 2>/dev/null || true
held=0; for _ in $(seq 1 60); do locked "$D/pool.lock" && { held=1; break; }; sleep 0.25; done
[ "$held" = 1 ] && ok "miner 1 holds the pool lock while it runs" || no "miner 1 never took the pool lock"
out=$(cd "$D" && env TB_POOL=counted TB_POOL_LOCK="$D/pool.lock" ./mine5.sh 2>&1); rc=$?
[ "$rc" = 7 ] && echo "$out" | grep -q 'another miner already holds the lock' \
  && ok "a second miner on the same pool is REFUSED (exit 7)" \
  || no "a second miner was allowed to start (rc=$rc)"
# The lock is held by a flock GUARDIAN, not by a descriptor of the miner shell.
# The earlier design held it on fd 8 of the miner, which children inherit — so a
# descendant outliving the miner could keep the pool locked. Assert directly that
# NO process in the miner's tree has the lock file open; only the guardian does.
if [ -d /proc ]; then
  holders=0
  for pp in $(pgrep -x -f 'bash ./mine5.sh' 2>/dev/null); do
    ls -l /proc/"$pp"/fd 2>/dev/null | grep -q "$D/pool.lock" && holders=$((holders+1))
  done
  [ "$holders" = 0 ] && ok "no miner process holds the lock fd — the guardian does" \
    || no "$holders miner process(es) still hold the lock descriptor, which children inherit"
else
  ok "fd-inheritance check skipped (no /proc)"
fi
kill -KILL "$holder" 2>/dev/null
pkill -KILL -s "$first" 2>/dev/null; kill -KILL "$first" 2>/dev/null
free=0; for _ in $(seq 1 60); do locked "$D/pool.lock" || { free=1; break; }; sleep 0.25; done
[ "$free" = 1 ] && ok "stopping the miner frees the pool — no stranded lock" \
  || no "the pool stayed locked after the miner was stopped"
rm -rf "$D"

echo "== P1: monitoring must not manufacture false alarms"
# The removed defect: a `status` compose service ran in a SEPARATE container, so
# it shared files but not the PID namespace, and would have reported 0 sessions
# and "killed outright" while mining was healthy. Two things pin the correction:
# status.sh distinguishes foreground supervision from a dead launcher, and the
# compose file no longer offers a service that cannot see the miner.
R=$(mktemp -d)
out=$(TB_RUNTIME_DIR="$R" ./status.sh pilot 2>&1)
echo "$out" | grep -q 'killed outright' \
  && no "status.sh cries 'killed outright' with no launcher — the false alarm" \
  || ok "no launcher is reported as foreground supervision, not as a death"
echo "$out" | grep -q 'foreground (no launcher)' \
  && ok "status.sh names the supervision mode instead of guessing" || no "supervision mode not reported"
rm -rf "$R"
grep -qE '^\s+status:' docker/docker-compose.yml \
  && no "a separate status service is back; it cannot see the miner's processes" \
  || ok "compose offers no separate status service"
grep -q 'exec mine ./status.sh' docker/docker-compose.yml \
  && ok "compose documents `exec` into the running container" || no "compose does not document exec"
grep -q 'platform: linux/amd64' docker/docker-compose.yml \
  && ok "the mining platform is pinned, not inherited from the host" || no "platform not pinned"
grep -q 'UV_VERSION=0.8.17' docker/Dockerfile \
  && ok "uv is pinned to the protocol version" || no "uv is not pinned"

echo "== P1: runtime state is relocatable, so a second process can read it"
for f in mine5.sh status.sh launch-mine.sh mine-parallel.sh merge-shards.sh shim/git; do
  bad=$(grep -nE '"/tmp/|=/tmp/' "$f" | grep -v 'TB_RUNTIME_DIR:-/tmp\|RT:-/tmp' || true)
  [ -n "$bad" ] && { no "$f still hardcodes a /tmp path: ${bad%%$'\n'*}"; break; }
done
[ -z "$bad" ] && ok "no script hardcodes a /tmp runtime path"

echo "== P0/D6: clone classification — REPO_UNAVAILABLE vs infrastructure halt"
# The pilot found a dead/private frame repo (PrefectHQ/burner-redis) halt the
# whole walk. The fix: the shim classifies an exhausted clone into an EXIT CODE
# (never a ledger write) — 91 REPO_UNAVAILABLE only on a CONFIRMED target 404
# with a healthy public control 200; 90 (breaker + halt) for everything else.
# These drive the classifier with a failing fake git and faked API statuses, so
# no network is touched.
mkfailgit() { printf '#!/usr/bin/env bash\nexit 1\n' > "$1/fakegit"; chmod +x "$1/fakegit"; }
mkhanggit() { printf '#!/usr/bin/env bash\nsleep 5\n' > "$1/fakegit"; chmod +x "$1/fakegit"; }
# shimclone <dir> <target-status> <control-status> -> prints the shim's exit code
shimclone() {
  local d=$1 tgt=$2 ctl=$3
  ( PATH="$HERE/shim:$PATH" TB_REAL_GIT="$d/fakegit" TB_RUNTIME_DIR="$d" \
    TB_CLONE_SLEEP_BASE=0 TB_FAKE_TARGET_STATUS="$tgt" TB_FAKE_CONTROL_STATUS="$ctl" \
    git clone https://github.com/acme/widget.git "$d/out" >/dev/null 2>&1 )
  echo $?
}
D=$(mktemp -d); mkfailgit "$D"
rc=$(shimclone "$D" 404 200)
{ [ "$rc" = 91 ] && [ ! -e "$D/tb-clone-breaker" ]; } \
  && ok "target 404 + control 200 -> REPO_UNAVAILABLE (91), no breaker" \
  || no "confirmed-unavailable case: rc=$rc breaker=$([ -e "$D/tb-clone-breaker" ] && echo tripped || echo clear)"
rm -rf "$D"
D=$(mktemp -d); mkfailgit "$D"
rc=$(shimclone "$D" 403 200)
{ [ "$rc" = 90 ] && [ -e "$D/tb-clone-breaker" ]; } \
  && ok "clone fails but target is not a confirmed 404 (403) -> halt (90) + breaker" \
  || no "non-404 target should halt: rc=$rc"
rm -rf "$D"
D=$(mktemp -d); mkfailgit "$D"
rc=$(shimclone "$D" 404 500)
{ [ "$rc" = 90 ] && [ -e "$D/tb-clone-breaker" ]; } \
  && ok "target 404 but control not healthy (500) -> halt (90) + breaker" \
  || no "404 with failed control should halt: rc=$rc"
rm -rf "$D"
D=$(mktemp -d); mkfailgit "$D"
rc=$(shimclone "$D" 200 200)
{ [ "$rc" = 90 ] && [ -e "$D/tb-clone-breaker" ]; } \
  && ok "public repo (target 200) whose clone fails -> halt (90), never a skip" \
  || no "available-but-clone-failed should halt: rc=$rc"
rm -rf "$D"

echo "== P0/D6: the miner writes REPO_UNAVAILABLE, halts on infra, and never writes CLONE_FAILED"
# Full miner runs over a tiny walk, driven by fakes. mine5.sh is the sole ledger
# writer; the shim only returns codes.
minesandbox() { # -> dir with mine5.sh, shim, and a pilot pool holding the given walk repos (json array body)
  local d; d=$(mktemp -d); cp mine5.sh "$d/"; cp -R shim "$d/"; mkfailgit "$d"
  mkdir -p "$d/pools/counted"; printf '{"order":[%s]}' "$1" > "$d/pools/counted/walk.json"; echo "$d"
}
# unavailable repo is a terminal skip AND the walk RESUMES to the next repo
D=$(minesandbox '"acme/gone-one","acme/gone-two"')
( cd "$D" && env TB_POOL=counted TB_RUNTIME_DIR="$D" TB_POOL_LOCK="$D/pool.lock" \
    TB_REAL_GIT="$D/fakegit" TB_CLONE_SLEEP_BASE=0 TB_CLONE_BASE=https://github.com \
    TB_FAKE_TARGET_STATUS=404 TB_FAKE_CONTROL_STATUS=200 TB_TASK_NEED=999 \
    ./mine5.sh >/dev/null 2>&1 ); mrc=$?
u=$(grep -c REPO_UNAVAILABLE "$D/pools/counted/attrition.jsonl" 2>/dev/null || echo 0)
{ [ "$u" = 2 ] && [ "$mrc" = 0 ] && [ ! -e "$D/tb-clone-breaker" ]; } \
  && ok "two unavailable repos -> two REPO_UNAVAILABLE, walk completes, no breaker" \
  || no "resume-past-unavailable: unavailable=$u miner_rc=$mrc breaker=$([ -e "$D/tb-clone-breaker" ] && echo tripped)"
grep -q CLONE_FAILED "$D/pools/counted/attrition.jsonl" 2>/dev/null \
  && no "a REPO_UNAVAILABLE run still wrote CLONE_FAILED" || ok "no CLONE_FAILED written on the unavailable path"
rm -rf "$D"
# infrastructure failure (non-404) HALTS the miner with no verdict, no CLONE_FAILED
D=$(minesandbox '"acme/flaky"')
( cd "$D" && env TB_POOL=counted TB_RUNTIME_DIR="$D" TB_POOL_LOCK="$D/pool.lock" \
    TB_REAL_GIT="$D/fakegit" TB_CLONE_SLEEP_BASE=0 TB_CLONE_BASE=https://github.com \
    TB_FAKE_TARGET_STATUS=403 TB_FAKE_CONTROL_STATUS=200 TB_TASK_NEED=999 \
    ./mine5.sh >/dev/null 2>&1 ); mrc=$?
n=$(grep -c '"gate"' "$D/pools/counted/attrition.jsonl" 2>/dev/null || true); n=${n:-0}
{ [ "$mrc" != 0 ] && [ -e "$D/tb-clone-breaker" ] && [ "$n" = 0 ]; } \
  && ok "infra failure halts the miner (rc!=0), breaker tripped, NO verdict written" \
  || no "infra-halt: miner_rc=$mrc breaker=$([ -e "$D/tb-clone-breaker" ] && echo tripped || echo clear) verdicts=$n"
grep -q CLONE_FAILED "$D/pools/counted/attrition.jsonl" 2>/dev/null && no "infra halt wrote CLONE_FAILED" || ok "infra halt writes no CLONE_FAILED"
rm -rf "$D"
# outer clone timeout (shim killed before it can classify) -> infra halt, no CLONE_FAILED
D=$(minesandbox '"acme/slow"'); mkhanggit "$D"
( cd "$D" && env TB_POOL=counted TB_RUNTIME_DIR="$D" TB_POOL_LOCK="$D/pool.lock" \
    TB_REAL_GIT="$D/fakegit" TB_CLONE_SLEEP_BASE=0 TB_CLONE_TIMEOUT=1 TB_CLONE_BASE=https://github.com \
    TB_FAKE_TARGET_STATUS=404 TB_FAKE_CONTROL_STATUS=200 TB_TASK_NEED=999 \
    ./mine5.sh >/dev/null 2>&1 ); mrc=$?
n=$(grep -c '"gate"' "$D/pools/counted/attrition.jsonl" 2>/dev/null || true); n=${n:-0}
{ [ "$mrc" != 0 ] && [ "$n" = 0 ]; } \
  && ok "outer clone timeout halts with no verdict (rc=$mrc), never CLONE_FAILED" \
  || no "outer-timeout: miner_rc=$mrc verdicts=$n"
grep -q CLONE_FAILED "$D/pools/counted/attrition.jsonl" 2>/dev/null && no "outer timeout wrote CLONE_FAILED" || ok "outer timeout writes no CLONE_FAILED"
rm -rf "$D"
# static: the CLONE_FAILED emission is gone from mine5.sh (it survives only in the
# resume/completeness regex, for backward-compatible skipping of any legacy line)
grep -q 'jlog "\$repo" "CLONE_FAILED"' mine5.sh \
  && no "mine5.sh can still emit CLONE_FAILED" || ok "mine5.sh has no CLONE_FAILED emission left"

echo "== P1: the frozen walk artefact is a real file, never a symlink"
[ -L pools/pilot/walk.json ] && no "pools/pilot/walk.json is a SYMLINK — writes reach the frozen frame" || ok "pools/pilot/walk.json is a real file"
n=$(node -p "JSON.parse(require('fs').readFileSync('frame/pilot-walk-order.json')).order.length")
[ "$n" = 500 ] && ok "frame/pilot-walk-order.json still holds the frozen 500" || no "frozen walk has $n entries, want 500"

echo "== P1: the burn set — frozen history, and a set that only grows"
python3 incident-D3/build-burn-list.py --check >/dev/null 2>&1 \
  && ok "D3 incident set regenerates; nothing has been un-burnt" || no "burn check failed"
# The defect this replaced: --check asserted the CUMULATIVE set was constant, so
# the resumed pilot legitimately burning 12 more repositories read as a failure.
# Growth must pass; losing a repository, and losing incident evidence, must not.
B=$(mktemp -d); mkdir -p "$B/frame" "$B/pools/pilot" "$B/incident-D3"
cp -R incident-D3/. "$B/incident-D3/"
cp frame/pilot-walk-order.json frame/pilot-dedup.json "$B/frame/"
cp pools/pilot/attrition.jsonl "$B/pools/pilot/"
echo '{"repo":"selftest/never-in-any-frame","gate":"CLONE_FAILED"}' >> "$B/pools/pilot/attrition.jsonl"
python3 "$B/incident-D3/build-burn-list.py" --check >/dev/null 2>&1 \
  && ok "a newly drawn repository is growth, not a failure — regression sentinel" \
  || no "burn check still treats a growing cumulative set as a failure"
rm -f "$B"/incident-D3/mine-pilot-s0.log
python3 "$B/incident-D3/build-burn-list.py" --check >/dev/null 2>&1 \
  && no "burn check passed with a shard log deleted" || ok "lost incident evidence fails the check"
rm -rf "$B"

echo; echo "passed $pass, failed $fail"; [ "$fail" = 0 ]
