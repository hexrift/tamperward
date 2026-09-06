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
out=$(TB_POOL=pilot TB_PILOT_NEED=99 TB_POOL_LOCK="$(mktemp -u)" ./mine5.sh 2>&1); echo "$out" | grep -q 'REFUSING: TB_PILOT_NEED=99' \
  && ok "TB_PILOT_NEED=99 refused on pilot" || no "unbounded pilot need not refused"
out=$(TB_POOL=pilot-s0 TB_PILOT_NEED=99 TB_POOL_LOCK="$(mktemp -u)" ./mine5.sh 2>&1); echo "$out" | grep -q 'REFUSING: TB_PILOT_NEED=99' \
  && ok "refusal keys off BASE_POOL, so a shard name cannot dodge it" || no "shard name dodged the pilot refusal"
# An ITERATION pool ("pilot-i<n>", a repeated pilot after a forced new candidate)
# must carry pilot semantics too, not the counted defaults — otherwise iteration 2
# would mine 110 tasks against a sacrificial pool.
out=$(TB_POOL=pilot-i2 TB_PILOT_NEED=99 TB_POOL_LOCK="$(mktemp -u)" ./mine5.sh 2>&1); echo "$out" | grep -q 'REFUSING: TB_PILOT_NEED=99' \
  && ok "an -i<n> iteration pool is a pilot (BASE_POOL strips the iteration suffix)" || no "iteration pool did not get pilot semantics"

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
# The miner reports its OWN pid. `$!` is the process this shell forked, and setsid
# forks again when it is already a process-group leader — so `$!` was often neither
# the miner nor its session leader, and the `pkill -s "$first"` below then signalled
# the wrong session (or none). The miner survived, the pool stayed locked, and the
# last case failed intermittently: 71/1 depending on the machine. `exec` keeps the
# pid, and a setsid child is its own session leader, so pid == sid here.
setsid env TB_POOL=counted TB_CLONE_BASE="file:///nonexistent-tb-selftest" \
    TB_CLONE_LOCK="$D/clone.lock" TB_CLONE_BREAKER="$D/breaker" TB_CLONE_FAILS="$D/fails" \
    TB_INFRA_LOG="$D/infra.jsonl" TB_POOL_LOCK="$D/pool.lock" \
    bash -c 'echo $$ > "$1/miner.pid"; cd "$1" && exec ./mine5.sh' _ "$D" >/dev/null 2>&1 &
disown 2>/dev/null || true
for _ in $(seq 1 40); do [ -s "$D/miner.pid" ] && break; sleep 0.25; done
first=$(cat "$D/miner.pid" 2>/dev/null)
[ -n "$first" ] && ok "the miner reported its own pid ($first), not \$!" \
                || no "the miner never reported a pid — the stop case below would be meaningless"
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
[ -n "$first" ] && { pkill -KILL -s "$first" 2>/dev/null; kill -KILL "$first" 2>/dev/null; }
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
# A dead/private frame repo (PrefectHQ/burner-redis) once halted the whole walk.
# REPO_UNAVAILABLE now means "persistently inaccessible through the miner's frozen
# unauthenticated git transport at draw time" — NOT proven deleted/private — and
# is emitted (exit 91) ONLY when, after the clone exhausts: a control ls-remote
# succeeds, the target ls-remote fails the auth/unavailable signature on every one
# of PROBE_REPEAT probes, and a SECOND control ls-remote succeeds. Any timeout,
# different error, control failure, or target success is infrastructure (exit 90,
# breaker + halt). Probes use /usr/bin/git directly, never the shim. These drive
# the classifier with faked probe outcomes so no network is touched.
mkfailgit() { printf '#!/usr/bin/env bash\nexit 1\n' > "$1/fakegit"; chmod +x "$1/fakegit"; }
mkhanggit() { printf '#!/usr/bin/env bash\nsleep 5\n' > "$1/fakegit"; chmod +x "$1/fakegit"; }
# shimx <dir> <control1-rc> <target-kind-list> <control2-rc> -> shim exit code.
# target-kind-list is space-separated, one kind consumed per probe (last repeats):
# unavailable | reachable | timeout | othererror.
shimx() {
  local d=$1 c1=$2 tk=$3 c2=$4
  ( PATH="$HERE/shim:$PATH" TB_REAL_GIT="$d/fakegit" TB_RUNTIME_DIR="$d" \
    TB_CLONE_SLEEP_BASE=0 TB_PROBE_GAP=0 \
    TB_FAKE_CONTROL1="$c1" TB_FAKE_TARGET_KIND="$tk" TB_FAKE_CONTROL2="$c2" \
    git clone https://github.com/acme/widget.git "$d/out" >/dev/null 2>&1 )
  echo $?
}
# (a) unavailable target BETWEEN TWO SUCCESSFUL CONTROLS -> REPO_UNAVAILABLE
D=$(mktemp -d); mkfailgit "$D"
rc=$(shimx "$D" 0 "unavailable" 0)
{ [ "$rc" = 91 ] && [ ! -e "$D/tb-clone-breaker" ]; } \
  && ok "unavailable target between two healthy controls -> REPO_UNAVAILABLE (91), no breaker" \
  || no "sandwich-unavailable: rc=$rc breaker=$([ -e "$D/tb-clone-breaker" ] && echo tripped || echo clear)"
rm -rf "$D"
# (b) matching target error with control #1 failing -> halt
D=$(mktemp -d); mkfailgit "$D"
rc=$(shimx "$D" 1 "unavailable" 0)
{ [ "$rc" = 90 ] && [ -e "$D/tb-clone-breaker" ]; } \
  && ok "control #1 fails (transport unhealthy) -> halt (90) + breaker" || no "control#1-fail should halt: rc=$rc"
rm -rf "$D"
# (b') matching target error with control #2 failing -> halt
D=$(mktemp -d); mkfailgit "$D"
rc=$(shimx "$D" 0 "unavailable" 1)
{ [ "$rc" = 90 ] && [ -e "$D/tb-clone-breaker" ]; } \
  && ok "control #2 fails after the target check -> halt (90) + breaker" || no "control#2-fail should halt: rc=$rc"
rm -rf "$D"
# (c) target-specific timeout -> halt
D=$(mktemp -d); mkfailgit "$D"
rc=$(shimx "$D" 0 "timeout" 0)
{ [ "$rc" = 90 ] && [ -e "$D/tb-clone-breaker" ]; } \
  && ok "target probe times out -> halt (90), not unavailability" || no "target-timeout should halt: rc=$rc"
rm -rf "$D"
# (c') target different (non-auth) error -> halt
D=$(mktemp -d); mkfailgit "$D"
rc=$(shimx "$D" 0 "othererror" 0)
{ [ "$rc" = 90 ] && [ -e "$D/tb-clone-breaker" ]; } \
  && ok "target fails with a non-auth error -> halt (90), not unavailability" || no "target-othererror should halt: rc=$rc"
rm -rf "$D"
# (d) target becomes reachable on a later probe -> halt
D=$(mktemp -d); mkfailgit "$D"
rc=$(shimx "$D" 0 "unavailable unavailable reachable" 0)
{ [ "$rc" = 90 ] && [ -e "$D/tb-clone-breaker" ]; } \
  && ok "target reachable on a later probe -> halt (90), not persistently unavailable" || no "target-recovers should halt: rc=$rc"
rm -rf "$D"

echo "== P0/D6: the miner writes REPO_UNAVAILABLE, halts on infra, and never writes CLONE_FAILED"
# Full miner runs over a tiny walk, driven by fakes. mine5.sh is the sole ledger
# writer; the shim only returns codes.
minesandbox() { # -> dir with mine5.sh, shim, and a pilot pool holding the given walk repos
  local d; d=$(mktemp -d); cp mine5.sh "$d/"; cp -R shim "$d/"; mkfailgit "$d"
  mkdir -p "$d/pools/counted"; printf '{"order":[%s]}' "$1" > "$d/pools/counted/walk.json"; echo "$d"
}
# (e) unavailable repo is a terminal skip AND the walk RESUMES to the next repo
D=$(minesandbox '"acme/gone-one","acme/gone-two"')
( cd "$D" && env TB_POOL=counted TB_RUNTIME_DIR="$D" TB_POOL_LOCK="$D/pool.lock" \
    TB_REAL_GIT="$D/fakegit" TB_CLONE_SLEEP_BASE=0 TB_PROBE_GAP=0 TB_CLONE_BASE=https://github.com \
    TB_FAKE_CONTROL1=0 TB_FAKE_TARGET_KIND=unavailable TB_FAKE_CONTROL2=0 TB_TASK_NEED=999 \
    ./mine5.sh >/dev/null 2>&1 ); mrc=$?
u=$(grep -c REPO_UNAVAILABLE "$D/pools/counted/attrition.jsonl" 2>/dev/null || true); u=${u:-0}
{ [ "$u" = 2 ] && [ "$mrc" = 0 ] && [ ! -e "$D/tb-clone-breaker" ]; } \
  && ok "two unavailable repos -> two REPO_UNAVAILABLE, walk completes, no breaker" \
  || no "resume-past-unavailable: unavailable=$u miner_rc=$mrc breaker=$([ -e "$D/tb-clone-breaker" ] && echo tripped)"
grep -q CLONE_FAILED "$D/pools/counted/attrition.jsonl" 2>/dev/null \
  && no "a REPO_UNAVAILABLE run still wrote CLONE_FAILED" || ok "no CLONE_FAILED written on the unavailable path"
rm -rf "$D"
# (f) infrastructure failure (target still reachable) HALTS with no verdict, no CLONE_FAILED
D=$(minesandbox '"acme/flaky"')
( cd "$D" && env TB_POOL=counted TB_RUNTIME_DIR="$D" TB_POOL_LOCK="$D/pool.lock" \
    TB_REAL_GIT="$D/fakegit" TB_CLONE_SLEEP_BASE=0 TB_PROBE_GAP=0 TB_CLONE_BASE=https://github.com \
    TB_FAKE_CONTROL1=0 TB_FAKE_TARGET_KIND=reachable TB_FAKE_CONTROL2=0 TB_TASK_NEED=999 \
    ./mine5.sh >/dev/null 2>&1 ); mrc=$?
n=$(grep -c '"gate"' "$D/pools/counted/attrition.jsonl" 2>/dev/null || true); n=${n:-0}
{ [ "$mrc" != 0 ] && [ -e "$D/tb-clone-breaker" ] && [ "$n" = 0 ]; } \
  && ok "infra failure halts the miner (rc!=0), breaker tripped, NO verdict written" \
  || no "infra-halt: miner_rc=$mrc breaker=$([ -e "$D/tb-clone-breaker" ] && echo tripped || echo clear) verdicts=$n"
grep -q CLONE_FAILED "$D/pools/counted/attrition.jsonl" 2>/dev/null && no "infra halt wrote CLONE_FAILED" || ok "infra halt writes no CLONE_FAILED"
rm -rf "$D"
# (g) outer clone timeout (shim killed before it can classify) -> infra halt, no CLONE_FAILED
D=$(minesandbox '"acme/slow"'); mkhanggit "$D"
( cd "$D" && env TB_POOL=counted TB_RUNTIME_DIR="$D" TB_POOL_LOCK="$D/pool.lock" \
    TB_REAL_GIT="$D/fakegit" TB_CLONE_SLEEP_BASE=0 TB_CLONE_TIMEOUT=1 TB_CLONE_BASE=https://github.com \
    TB_FAKE_CONTROL1=0 TB_FAKE_TARGET_KIND=unavailable TB_FAKE_CONTROL2=0 TB_TASK_NEED=999 \
    ./mine5.sh >/dev/null 2>&1 ); mrc=$?
n=$(grep -c '"gate"' "$D/pools/counted/attrition.jsonl" 2>/dev/null || true); n=${n:-0}
{ [ "$mrc" != 0 ] && [ "$n" = 0 ]; } \
  && ok "outer clone timeout halts with no verdict (rc=$mrc), never CLONE_FAILED" \
  || no "outer-timeout: miner_rc=$mrc verdicts=$n"
grep -q CLONE_FAILED "$D/pools/counted/attrition.jsonl" 2>/dev/null && no "outer timeout wrote CLONE_FAILED" || ok "outer timeout writes no CLONE_FAILED"
rm -rf "$D"
# static: no nonzero clone result can write CLONE_FAILED (the emission is gone;
# the token survives only in the resume/completeness regex for any legacy line)
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

# ─────────────────────────────────────────────────────────────────────────────
echo
echo "== verify-pilot-tasks: the four defects review found, pinned"
# These were all corrected after the fact and NONE of them had a test. The
# verifier gates whether a mined task is usable, so a silent regression in it
# would let an unusable task into the pilot.

# (a) the exit-code classifier, now the SHARED one (runner/suite-status.mjs) that
# the adjudicator, miner and validator all use. Only PASS (0) and FAIL (1) are
# measurements; everything else is a suite that did not answer. This corrects the
# earlier local copy, which read exit 2 as RED — but pytest exit 2 is INTERRUPTED
# (a collection error, e.g. a plugin that pip-installs at collect time failing),
# NOT a test failure (which is 1). Treating a collection error as a regression is
# exactly the collapse this fix removes; it is now EXEC_FAILED.
( TB_VERIFY_LIB=1 . ./verify-pilot-tasks.sh
  bad=0
  for pair in "0:PASS" "1:FAIL" "5:NO_TESTS" "124:TIMEOUT"; do
    rc=${pair%%:*}; want=${pair##*:}
    [ "$(classify "$rc")" = "$want" ] || { echo "classify($rc)=$(classify "$rc") want $want"; bad=1; }
  done
  # The whole point: none of these is a test result (FAIL). Exit 2 joins them.
  for rc in 2 3 4 126 127 137; do
    case "$(classify "$rc")" in PASS|FAIL) echo "classify($rc)=$(classify "$rc") — a non-measurement must not be PASS/FAIL"; bad=1;; esac
  done
  exit $bad ) >/dev/null 2>&1 \
  && ok "shared classifier: only 0/1 are PASS/FAIL; 2/3/4/126/127/137 are non-measurements, never RED" \
  || no "shared classifier diverges from the canonical semantics"

# (a2) NO RESIDUAL non-measurement->red path. The shared classifier is the ONLY
# interpretation of a suite's termination; each consumer that scores a suite must
# route through it, and none may keep the old {1,2}->red / nonzero->red collapse
# that let a 126 or a collection error (exit 2) manufacture a MASKED_FAILURE. This
# is the structural guard behind the behavioural proofs in verdict4-selftest.sh.
resid=0
for f in mine5.sh verify-pilot-tasks.sh ../runner/verdict4.mjs checkdocs-adjudication-diag.sh; do
  grep -q "suite-status" "$f" || { echo "  $f does not route through suite-status.mjs"; resid=1; }
done
# the exact collapses the fix removed must not reappear
grep -qE '\[ "\$rc" -eq 1 \] \|\| \[ "\$rc" -eq 2 \]' mine5.sh && { echo "  mine5.sh still maps {1,2}->red"; resid=1; }
grep -qE '1\|2\)[[:space:]]*(echo[[:space:]]+red|class=red)' verify-pilot-tasks.sh checkdocs-adjudication-diag.sh && { echo "  a consumer still maps 1|2->red"; resid=1; }
# verdict4 must not classify a suite by a bare exit-code branch any more
grep -qE "r\.status === 0.*return 'green'" ../runner/verdict4.mjs && { echo "  verdict4.mjs still classifies inline"; resid=1; }
[ "$resid" = 0 ] \
  && ok "no residual non-measurement->red path: miner, validator, adjudicator and the diag all route through the shared classifier" \
  || no "a residual nonzero->red scoring path remains"

# (a3) The re-roll / retry decision is ARM-BLIND. run-task4's post-start policy is
# a single exit 11 (preserve artifacts, never re-roll) with no branch on the arm or
# the outcome; the arm appears only as recorded metadata. An INVALID_MEASUREMENT is
# a valid verdict (recorded as attrition), also produced without reference to the
# arm. Guard: post_start_failure must not condition on $ARM/outcome, and the
# re-roll refusal must be unconditional.
rt=../runner/run-task4.sh
if grep -nE 'post_start_failure|must NOT be re-rolled|exit 11' "$rt" | grep -qiE '\bif\b.*(ARM|arm==|outcome)'; then
  no "the re-roll decision branches on the arm or outcome"
else
  ok "the re-roll / retry decision is arm-blind and outcome-blind (a non-measurement is recorded, never re-rolled)"
fi

# (b) a run that examines NOTHING must not pass. With an empty pool every counter
# stays 0 and a naive "no failures" test reports success.
TB_POOL_DIR=$(mktemp -d) ./verify-pilot-tasks.sh >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "no tasks examined refuses with EXACTLY exit 2" \
              || no "no tasks examined gave exit $rc, want exactly 2"

# (c) NOT VERIFIED must fail the run. The exit test was once `fail == 0` alone, so
# twenty clone failures would have exited 0. Fixture: a task whose repository
# cannot be cloned, with otherwise valid hashes.
VP=$(mktemp -d); mkdir -p "$VP/tasks/99-unclonable"
printf 'x\n' > "$VP/tasks/99-unclonable/test.patch"; printf 'y\n' > "$VP/tasks/99-unclonable/gold.patch"
node -e '
 const fs=require("fs"),c=require("crypto"),d=process.argv[1];
 const h=f=>c.createHash("sha256").update(fs.readFileSync(d+"/tasks/99-unclonable/"+f)).digest("hex");
 fs.writeFileSync(d+"/tasks/99-unclonable/manifest.json", JSON.stringify({
   id:"99-unclonable", repo:"tamperward-selftest/definitely-not-a-real-repo",
   parent_sha:"0000000000000000000000000000000000000000",
   test_patch_sha256:h("test.patch"), gold_patch_sha256:h("gold.patch")}));' "$VP"
out=$(TB_POOL_DIR="$VP" ./verify-pilot-tasks.sh 2>&1); rc=$?
[ "$rc" != 0 ] && printf '%s' "$out" | grep -q 'NOT VERIFIED 1' \
  && ok "an unclonable task is NOT VERIFIED and fails the run" \
  || no "unclonable task did not fail the run (exit $rc)"

# (d) a hash mismatch must be a FAILURE, not a pass. Corrupt one patch after the
# manifest was written.
printf 'tampered\n' >> "$VP/tasks/99-unclonable/test.patch"
out=$(TB_POOL_DIR="$VP" ./verify-pilot-tasks.sh 2>&1); rc=$?
[ "$rc" != 0 ] && printf '%s' "$out" | grep -q 'FAIL.*H test.patch sha' \
  && ok "a patch that does not match its recorded sha256 fails" \
  || no "hash mismatch did not fail (exit $rc)"
rm -rf "$VP"

# (e) the PARENT-GREEN control must actually FAIL a task whose parent is already
# red — and the counterfactual must be exact: with P removed, H/R/G ACCEPT the same
# task and the verifier exits 0. Without that pairing, P could be decorative and
# every other assertion would still pass.
#
# The fixture is a real task, not a stub: parent already RED, a test patch that
# applies and stays RED, a gold patch that applies and turns it GREEN. Only the
# already-red parent distinguishes it from a valid task, so P is the only thing that
# can reject it.
PF=$(mktemp -d); mkdir -p "$PF/remotes/fixture"
PR="$PF/remotes/fixture/redparent"; mkdir -p "$PR/tests"
( cd "$PR" && git init -q && git config user.email t@b && git config user.name t
  printf '[project]\nname="pfix"\nversion="0.0.1"\n' > pyproject.toml
  printf 'def add(a, b):\n    return a - b\n' > calc.py
  # The parent is ALREADY RED: an existing test already exercises the same bug. That
  # is what makes the counterfactual exact — the gold patch repairs this test too, so
  # with P removed the task looks perfectly valid (R red, G green) and is accepted.
  # A parent red for an UNRELATED reason could never satisfy G, and would prove only
  # that G works, not that P is what rejects the task.
  printf 'from calc import add\n\ndef test_existing():\n    assert add(2, 2) == 4\n' > tests/test_existing.py
  # conftest: force `calc` to load from THIS working tree, defeating an editable
  # install whose finder points at a static copy. On the setuptools versions where
  # `-e .` produces a copying finder rather than a live one, the gold patch edits
  # $D/calc.py but the import still sees the parent copy, so G stays RED (rc=1) even
  # though the task is solvable — the fixture flaked exactly this way on CI. sys.modules
  # is consulted before any finder, so pre-loading the tree module wins on every
  # setuptools/pytest version. Regression-tested below with an injected shadow finder.
  cat > conftest.py <<'CONFTEST'
import importlib.util, os, sys
_here = os.path.dirname(os.path.abspath(__file__))
_p = os.path.join(_here, "calc.py")
if os.path.exists(_p):
    _spec = importlib.util.spec_from_file_location("calc", _p)
    _mod = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)
    sys.modules["calc"] = _mod
CONFTEST
  git add -A && git commit -qm parent --no-verify ) >/dev/null 2>&1
PSHA=$( cd "$PR" && git rev-parse HEAD )
mkdir -p "$PF/pool/tasks/98-red-parent"
cat > "$PF/pool/tasks/98-red-parent/test.patch" <<'PATCH'
diff --git a/tests/test_add.py b/tests/test_add.py
new file mode 100644
--- /dev/null
+++ b/tests/test_add.py
@@ -0,0 +1,4 @@
+from calc import add
+
+def test_add():
+    assert add(1, 2) == 3
PATCH
cat > "$PF/pool/tasks/98-red-parent/gold.patch" <<'PATCH'
diff --git a/calc.py b/calc.py
--- a/calc.py
+++ b/calc.py
@@ -1,2 +1,2 @@
 def add(a, b):
-    return a - b
+    return a + b
PATCH
node -e '
 const fs=require("fs"),c=require("crypto"),d=process.argv[1],sha=process.argv[2];
 const h=f=>c.createHash("sha256").update(fs.readFileSync(d+"/tasks/98-red-parent/"+f)).digest("hex");
 fs.writeFileSync(d+"/tasks/98-red-parent/manifest.json", JSON.stringify({
   id:"98-red-parent", repo:"fixture/redparent", parent_sha:sha,
   test_patch_sha256:h("test.patch"), gold_patch_sha256:h("gold.patch")}));' "$PF/pool" "$PSHA"

# TB_SUITE_STATUS points the (possibly copied) verifier at the real shared
# classifier; without it the counterfactual's temp-dir copy cannot resolve it.
vrun() { TB_VERIFY_REPO_BASE="$PF/remotes" TB_VERIFY_TEST_MODE=1 TB_POOL_DIR="$PF/pool" TB_SUITE_STATUS="$(cd "$HERE/../runner" && pwd)/suite-status.mjs" "$@"; }
out=$(vrun ./verify-pilot-tasks.sh 2>&1); rc=$?
[ "$rc" != 0 ] && printf '%s' "$out" | grep -qi 'FAIL.*P untouched parent is red' \
  && ok "P rejects a task whose parent is ALREADY RED" \
  || no "P did not reject a red parent (exit $rc): $(printf '%s' "$out" | grep -E 'P |FAIL' | head -1)"

# the counterfactual, precisely: strip P and the SAME task is accepted, exit 0
cp verify-pilot-tasks.sh "$PF/noP.sh"
python3 - "$PF/noP.sh" <<'STRIP'
import sys
p=sys.argv[1]; s=open(p).read()
i=s.index('  # P — the control'); j=s.index('  git -C "$D" apply --whitespace=nowarn "$POOL/tasks/$T/test.patch"')
open(p,'w').write(s[:i]+s[j:])
STRIP
out=$(vrun bash "$PF/noP.sh" 2>&1); rc=$?
[ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'R parent + tests is RED' && printf '%s' "$out" | grep -q 'G parent + tests + gold is GREEN' \
  && ok "counterfactual: with P removed, H/R/G ACCEPT the same task (exit 0) — P is what rejects it" \
  || no "counterfactual inconclusive (rc=$rc): $(printf '%s' "$out" | grep -E 'FAIL|NOT VERIFIED' | head -1)"

# Regression: the counterfactual G went RED on CI because an editable install's
# finder pointed `calc` at a static copy, so the gold patch's edit to the tree was
# invisible to the import. Reproduced DETERMINISTICALLY here — independent of which
# editable mode a given setuptools happens to pick — by injecting a meta_path finder
# that shadows `calc` with a stale copy, then proving the fixture conftest defeats it.
SHD=$(mktemp -d); mkdir -p "$SHD/repo/tests"
( cd "$SHD/repo"
  printf '[project]\nname="pfix"\nversion="0.0.1"\n' > pyproject.toml
  printf 'def add(a, b):\n    return a + b\n' > calc.py              # tree at GOLD state
  printf 'from calc import add\n\ndef test_e():\n    assert add(2,2)==4\n' > tests/test_e.py
  printf 'from calc import add\n\ndef test_a():\n    assert add(1,2)==3\n' > tests/test_a.py )
if uv venv -q -p python3.11 "$SHD/venv" 2>/dev/null && uv pip install -q -p "$SHD/venv/bin/python" pytest 2>/dev/null; then
  SPK=$("$SHD/venv/bin/python" -c 'import site;print(site.getsitepackages()[0])')
  printf 'def add(a, b):\n    return a - b\n' > "$SPK/_stale_calc.py"   # a stale copy, parent state
  cat > "$SPK/_shadow_finder.py" <<PYF
import sys, os, importlib.util
_S = os.path.join(os.path.dirname(__file__), "_stale_calc.py")
class _F:
    def find_spec(self, name, path=None, target=None):
        return importlib.util.spec_from_file_location("calc", _S) if name == "calc" else None
sys.meta_path.insert(0, _F())
PYF
  echo "import _shadow_finder" > "$SPK/shadow.pth"
  pyt() { ( cd "$SHD/repo" && "$SHD/venv/bin/python" -m pytest -q -p no:cacheprovider >/dev/null 2>&1; echo $? ); }
  [ "$(pyt)" = 1 ] && ok "shadow reproduced: a stale editable finder makes the solvable task read RED (the CI symptom)" \
    || no "the shadow did not reproduce the failure — the regression guard is vacuous"
  cat > "$SHD/repo/conftest.py" <<'CONF'
import importlib.util, os, sys
_p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "calc.py")
if os.path.exists(_p):
    _s = importlib.util.spec_from_file_location("calc", _p)
    _m = importlib.util.module_from_spec(_s); _s.loader.exec_module(_m); sys.modules["calc"] = _m
CONF
  [ "$(pyt)" = 0 ] && ok "the fixture conftest force-loads the tree module and defeats the shadow (GREEN)" \
    || no "the conftest did not defeat the shadow finder"
else
  no "shadow regression: could not build a venv/install pytest (uv unavailable?)"
fi
rm -rf "$SHD"

# and the production claim: a non-GitHub base is refused without the test flag
out=$(TB_VERIFY_REPO_BASE="$PF/remotes" TB_POOL_DIR="$PF/pool" ./verify-pilot-tasks.sh 2>&1); rc=$?
[ "$rc" != 0 ] && printf '%s' "$out" | grep -q 'without TB_VERIFY_TEST_MODE=1' \
  && ok "a non-GitHub repo base is REFUSED without TB_VERIFY_TEST_MODE" \
  || no "a non-GitHub base was accepted without the test flag (exit $rc)"
# a manifest may never name a path
mkdir -p "$PF/pool2/tasks/97-pathy"; cp "$PF/pool/tasks/98-red-parent/"*.patch "$PF/pool2/tasks/97-pathy/"
node -e 'const fs=require("fs"),c=require("crypto"),d=process.argv[1];const h=f=>c.createHash("sha256").update(fs.readFileSync(d+"/tasks/97-pathy/"+f)).digest("hex");fs.writeFileSync(d+"/tasks/97-pathy/manifest.json",JSON.stringify({id:"97-pathy",repo:"/tmp/somewhere",parent_sha:"0".repeat(40),test_patch_sha256:h("test.patch"),gold_patch_sha256:h("gold.patch")}));' "$PF/pool2"
# every malformed shape, not just the obvious one. `*/*` accepts most of these.
mkrepo_manifest() { # <dir> <repo string>
  mkdir -p "$1/tasks/97-pathy"; cp "$PF/pool/tasks/98-red-parent/"*.patch "$1/tasks/97-pathy/"
  node -e 'const fs=require("fs"),c=require("crypto"),d=process.argv[1],r=process.argv[2];
    const h=f=>c.createHash("sha256").update(fs.readFileSync(d+"/tasks/97-pathy/"+f)).digest("hex");
    fs.writeFileSync(d+"/tasks/97-pathy/manifest.json",JSON.stringify({id:"97-pathy",repo:r,
      parent_sha:"0".repeat(40),test_patch_sha256:h("test.patch"),gold_patch_sha256:h("gold.patch")}));' "$1" "$2"
}
n=0
for bad in "/tmp/somewhere" "../repo" "owner/.." "owner/" "own er/repo" "owner/re po" "a/b/c" "owner" "owner/name:x"; do
  n=$((n+1)); BD="$PF/bad$n"; mkrepo_manifest "$BD" "$bad"
  out=$(TB_VERIFY_TEST_MODE=1 TB_POOL_DIR="$BD" ./verify-pilot-tasks.sh 2>&1); rc=$?
  [ "$rc" != 0 ] && printf '%s' "$out" | grep -q 'not owner/name' \
    || { no "a malformed manifest repo was ACCEPTED: '$bad' (exit $rc)"; continue; }
done
ok "every malformed manifest repo is refused (path, .., trailing slash, whitespace, extra segment, bare name, colon)"
# and a well-formed one is NOT refused by the same check
mkrepo_manifest "$PF/good" "owner/na.me_-1"
out=$(TB_VERIFY_TEST_MODE=1 TB_POOL_DIR="$PF/good" ./verify-pilot-tasks.sh 2>&1)
printf '%s' "$out" | grep -q 'not owner/name' \
  && no "a VALID owner/name was rejected — the validation is too strict" \
  || ok "a valid owner/name passes the shape check (dots, dashes, underscores, digits)"
rm -rf "$PF"

echo "== launch-mine.sh: hermetic — private runtime dir, stub miner, no global state"
# Every case below runs against a COPIED launcher beside a sleeping stub mine5.sh,
# in a private TB_RUNTIME_DIR. The earlier version started a REAL miner on the REAL
# pool and asserted with `pgrep -f`, which reaches across the whole machine: it could
# have killed a genuine walk, and it made the result depend on live machine state,
# so it passed here and failed under review.
lab() {                       # -> prints a fresh, isolated launcher lab
  local L; L=$(mktemp -d)
  cp launch-mine.sh "$L/"
  cat > "$L/mine5.sh" <<'STUB'
#!/usr/bin/env bash
# stub miner: leaves a START MARKER, then holds the pool lock like the real one.
# The marker is what proves a failed launch did not quietly start a miner anyway.
touch "${STUB_MARKER:?}"
exec 8>"${TB_POOL_LOCK:?}"; flock -n 8 || exit 7
sleep "${STUB_SLEEP:-30}"
STUB
  chmod +x "$L/mine5.sh"; mkdir -p "$L/rt"
  printf '%s' "$L"
}
lrun() {                      # <lab> <extra env...> -- runs the copied launcher
  local L="$1"; shift
  ( cd "$L" && env TB_RUNTIME_DIR="$L/rt" TB_POOL_LOCK="$L/rt/pool.lock" STUB_MARKER="$L/started" "$@" ./launch-mine.sh pilot 2>&1 )
}
pool_free() { [ -e "$1" ] || return 0; ( flock -n 7 ) 7<"$1" 2>/dev/null; }
stop_lab() { local L="$1"; local pid; pid=$(tr -dc '0-9' < "$L/rt/tb-mine-pilot.pid" 2>/dev/null)
  [ -n "$pid" ] && { pkill -KILL -s "$pid" 2>/dev/null; kill -KILL "$pid" 2>/dev/null; }; rm -rf "$L"; }

# A dry run, and a refused argument, must leave NO runtime artefact — including the
# runtime DIRECTORY itself. `lab()` pre-creates it, so asserting the directory is
# merely EMPTY proved nothing: a launcher that ran `mkdir -p` before its exits would
# have passed. Remove it first and assert it does not come back.
for case in "TB_DRY_RUN=1" "TB_DRY_RUN=1 TB_PILOT_NEED=21"; do
  L=$(lab); rm -rf "$L/rt"
  lrun "$L" $case >/dev/null 2>&1
  [ ! -e "$L/rt" ] && ok "\`$case\` creates no runtime directory at all" \
    || no "\`$case\` created $L/rt$( [ -n "$(ls -A "$L/rt" 2>/dev/null)" ] && echo " containing: $(ls -A "$L/rt" | tr '\n' ' ')")"
  rm -rf "$L"
done

# the bound, without launching anything
for bad in 21 0 abc; do
  L=$(lab); out=$(lrun "$L" TB_DRY_RUN=1 TB_PILOT_NEED="$bad")
  printf '%s' "$out" | grep -q REFUSING && ok "launcher refuses TB_PILOT_NEED=$bad" \
                                        || no "launcher accepted TB_PILOT_NEED=$bad"
  rm -rf "$L"
done
L=$(lab); printf '%s' "$(lrun "$L" TB_DRY_RUN=1)" | grep -q 'need=10' \
  && ok "unset TB_PILOT_NEED resolves to the default 10" || no "unset did not resolve to 10"; rm -rf "$L"
L=$(lab); printf '%s' "$(lrun "$L" TB_DRY_RUN=1 TB_PILOT_NEED=20)" | grep -q 'need=20' \
  && ok "TB_PILOT_NEED=20 is accepted (the second sacrificial ten)" || no "20 was rejected"; rm -rf "$L"

# a real (stubbed) launch: the published pid must BE the worker's session leader
L=$(lab); out=$(lrun "$L" STUB_SLEEP=30); rc=$?
pid=$(tr -dc '0-9' < "$L/rt/tb-mine-pilot.pid" 2>/dev/null)
sid=$(ps -o sid= -p "${pid:-0}" 2>/dev/null | tr -d ' ')
[ "$rc" = 0 ] && [ -n "$pid" ] && [ "$sid" = "$pid" ] \
  && ok "the published pid is the worker's own session leader (pid=$pid sid=$sid)" \
  || no "published pid is not a session leader (rc=$rc pid=${pid:-none} sid=${sid:-none})"
# a second launch is refused while that one holds the pool lock
out2=$(lrun "$L" STUB_SLEEP=30); rc2=$?
# It must be refused BY THE POOL LOCK. If the worker inherits the launcher lock the
# refusal still happens, but from the wrong authority — right by accident — and the
# pool-lock check is never reached.
[ "$rc2" = 6 ] && printf '%s' "$out2" | grep -q 'the pool lock is held' \
  && ok "a second launch is refused BY THE POOL LOCK (exit 6)" \
  || no "second launch refused for the wrong reason (rc=$rc2): $(printf '%s' "$out2" | head -1)"
lp=$(tr -dc '0-9' < "$L/rt/tb-mine-pilot.pid" 2>/dev/null)
inh=$(ls -l /proc/"${lp:-0}"/fd 2>/dev/null | grep -c 'tb-launch' || true)
[ "${inh:-0}" = 0 ] && ok "the worker does not inherit the launcher lock" \
                    || no "the worker inherited the launcher lock ($inh fd) — it would hold it for its whole life"
stop_lab "$L"

# a STALE pid file is replaced, not reported
L=$(lab); echo 99999999 > "$L/rt/tb-mine-pilot.pid"
out=$(lrun "$L" STUB_SLEEP=20); pid=$(tr -dc '0-9' < "$L/rt/tb-mine-pilot.pid" 2>/dev/null)
[ -n "$pid" ] && [ "$pid" != 99999999 ] \
  && ok "a stale pid file is replaced by the real worker's pid" \
  || no "the stale pid survived as the reported launch (got ${pid:-none})"
stop_lab "$L"

# A launch that cannot publish a pid must fail AND must not start the miner.
# Exit code alone was not enough: with a DIRECTORY at the pid path, `rm -f` failed
# (ignored), the child's plain `mv` moved its temp file INSIDE that directory and so
# reported success, the child went on to run the miner, and the launcher exited 5 —
# leaving an UNTRACKED miner holding the pool lock while reporting a failed launch.
# `chmod -w` cannot express this at all as root, which ignores the write bits.
L=$(lab); mkdir -p "$L/rt/tb-mine-pilot.pid"
out=$(lrun "$L" STUB_SLEEP=25); rc=$?
sleep 1
[ "$rc" != 0 ] && ! printf '%s' "$out" | grep -q 'pid unknown' \
  && ok "an unpublishable pid fails the launch (exit $rc), never 'pid unknown'" \
  || no "an unconfirmed launch did not fail closed (rc=$rc)"
[ ! -f "$L/started" ] && ok "a failed publication did NOT start the miner (no start marker)" \
                      || no "the miner STARTED despite a failed publication — untracked"
pool_free "$L/rt/pool.lock" && ok "no untracked miner holds the pool lock after a failed launch" \
                            || no "the pool lock is held after a launch that reported failure"
rm -rf "$L"

# and the mechanism directly: `mv` onto a directory must not be treated as success
L=$(lab); mkdir -p "$L/dir"; : > "$L/f"
if mv -T -- "$L/f" "$L/dir" 2>/dev/null; then no "mv -T onto a directory succeeded — publication could silently 'work'"
else ok "mv -T refuses a directory target (plain mv would move the file inside it)"; fi
rm -rf "$L"

echo "== build-burn-list.py: informational flags cannot write state"
# An unrecognised --help once fell through to the default branch and REPUBLISHED
# the burn set. Deterministic and harmless that time; a defect regardless.
# BOTH registered artefacts: the cumulative set the default branch rewrites, and the
# FROZEN incident file --write-incident would rewrite. Hashing only the first would
# miss a stray --write-incident entirely.
BL=frame/pilot-dedup.json; BI=incident-D3/burnt-254.json
BEFORE=$(sha256sum "$BL" "$BI" | cut -d' ' -f1 | tr '\n' ' ')
python3 incident-D3/build-burn-list.py --help >/dev/null 2>&1 \
  && ok "--help exits 0" || no "--help did not exit 0"
# exact codes, not merely non-zero: a refusal that exited 1 would be
# indistinguishable from the script crashing.
for c in "--help --bogus" "--bogus" "--check --write-incident"; do
  python3 incident-D3/build-burn-list.py $c >/dev/null 2>&1; rc=$?
  [ "$rc" = 2 ] && ok "\`$c\` refuses with EXACTLY exit 2" || no "\`$c\` gave exit $rc, want exactly 2"
done
python3 incident-D3/build-burn-list.py --check >/dev/null 2>&1 \
  && ok "--check still passes" || no "--check regressed"
[ "$(sha256sum "$BL" "$BI" | cut -d' ' -f1 | tr '\n' ' ')" = "$BEFORE" ] \
  && ok "both burn artefacts are byte-identical after every informational/rejected invocation" \
  || no "an informational or rejected invocation MUTATED a burn artefact"


echo "== pilot execution manifest: the freeze is derived and checkable, not typed"
FZ=./freeze-pilot-manifest.mjs
FM=./PILOT-EXECUTION-MANIFEST.json
# Every --check below fixes BOTH host-dependent axes, so the same assertion holds
# on the freeze host and on a CI runner with no artefact deployed. The artefact
# and environment paths get their own dedicated cases underneath.
# A registration seam for the whole freeze/driver section. These cases ask "given
# a REGISTERED iteration, does the checker classify drift and does the driver
# refuse to run against it?" — questions that presuppose a registration. The real
# record says no iteration is active (iteration 1 closed, D10), which is a
# different property with its own self-test (pilot-lifecycle-selftest.sh); left in
# place it would make every case below exit at that state and assert nothing.
FROZEN_REG="$(mktemp -d)/registration.json"
printf '{"active_iteration":1,"iterations":[{"iteration":1,"lifecycle":"frozen"}]}\n' > "$FROZEN_REG"
CK="TB_PILOT_CHECK_NO_ARTEFACT=1 TB_PILOT_CHECK_BINDING_ONLY=1 TB_PILOT_REGISTRATION=$FROZEN_REG"

# ONE rule, encoded once (#223): a CLOSED historical registration is not the
# current candidate registration. A self-test whose SUBJECT is the CURRENT
# implementation — freeze forgery detection, driver behaviour — must bind to the
# current tree, ALL binding hashes as they are now, not to iteration 1's frozen
# pins. The moment a binding file legitimately changes between iterations (which
# that state exists to allow), the committed manifest carries stale pins and every
# derived case would show incidental binding drift, masking the property under
# test. This produces a current-tree manifest for such cases.
#
# It is a TEST FIXTURE mechanism, NOT a runtime escape hatch: production
# pilot-drive.sh still consumes the real registered manifest, and --derive remains
# the only path back to a frozen, runnable state. Tests may manufacture a valid
# fixture; a real pilot may not derive itself a convenient one.
derive_current_tree_test_registration() {
  local out; out="$(mktemp -d)/PILOT-EXECUTION-MANIFEST.json"
  node "$FZ" --print > "$out" || return 1
  TB_PILOT_MANIFEST="$out" node "$FZ" --render > "${out%.json}.md" 2>/dev/null
  echo "$out"
}

# ---- structure: the pool is the FRESH ten, both arms, nothing else
node "$FZ" --print > /tmp/tb-fz-print.json 2>/dev/null
node -e '
const m=require("/tmp/tb-fz-print.json"), a=[];
const ok=(c,d)=>a.push((c?"ok   ":"FAIL ")+d);
const ids=m.pool.tasks.map(t=>t.id);
ok(ids.length===10,"the pool is exactly 10 tasks");
// The frozen pool must be EXACTLY the finalized ten on disk — no substitution,
// no extra, no spent/disclosed id. The active pool tracks the frozen iteration
// (iteration 2: pools/pilot-i2); update the path when a new iteration is frozen.
{ const fs=require("fs"), poolDir="pools/pilot-i2/tasks";
  const onDisk=fs.readdirSync(poolDir).filter(d=>/^[0-9][0-9]-/.test(d)).sort();
  ok(JSON.stringify(ids.slice().sort())===JSON.stringify(onDisk),
     "the frozen pool is exactly the finalized ten in "+poolDir); }
ok([...new Set(m.execution.task_order)].length===10 &&
   m.execution.task_order.every(t=>ids.includes(t)),"the order is a permutation of the pool: none dropped, none repeated");
ok(m.execution.trajectory_count===20 && m.execution.trajectories.length===20,"both arms: exactly 20 trajectories");
const per={}; for(const r of m.execution.trajectories) (per[r.task]=per[r.task]||[]).push(r.arm);
ok(Object.values(per).every(v=>v.length===2 && v.includes("gated") && v.includes("ungated")),
   "every task runs once gated and once ungated");
ok(m.execution.trajectories.every((r,i)=>r.seq===i+1),"seq is dense and 1-based, so no trajectory can be skipped unnoticed");
ok(m.execution.trajectories.every((r,i)=>i%2===1?r.task===m.execution.trajectories[i-1].task:true),
   "a task pair is adjacent: both arms run back to back");
console.log(a.join("\n"));
' | while read -r v d; do [ "$v" = ok ] && ok "$d" || no "$d"; done

# ---- the order FOLLOWS FROM the seeds: a hand-edited order cannot survive
same=$(node "$FZ" --print | sha256sum; node "$FZ" --print | sha256sum)
[ "$(echo "$same" | sort -u | wc -l)" = 1 ] && ok "derivation is deterministic across runs" || no "derivation is not deterministic"
ord(){ node "$FZ" --print | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).execution.task_order.join(",")))'; }
arms(){ node "$FZ" --print | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).execution.trajectories.filter(r=>r.seq%2===1).map(r=>r.arm).join(",")))'; }
BASE_ORD=$(ord); BASE_ARMS=$(arms)
ALT_ORD=$(TB_PILOT_FREEZE_TEST='{"trajectory_order_seed":"selftest-other-order-seed"}' ord)
ALT_ARMS=$(TB_PILOT_FREEZE_TEST='{"arm_order_seed":"selftest-other-arm-seed"}' arms)
[ "$BASE_ORD" != "$ALT_ORD" ] && ok "a different trajectory seed yields a different order — the seed is load-bearing" || no "the trajectory seed does not affect the order"
[ "$BASE_ARMS" != "$ALT_ARMS" ] && ok "a different arm seed yields a different arm assignment" || no "the arm seed does not affect the arms"
SAME_ORD=$(TB_PILOT_FREEZE_TEST='{"arm_order_seed":"selftest-other-arm-seed"}' ord)
[ "$BASE_ORD" = "$SAME_ORD" ] && ok "the arm seed does NOT perturb the task order — the two seeds are independent" || no "the arm seed leaked into the task order"
FROZEN_ORD=$(node -e 'console.log(require("'"$PWD"'/PILOT-EXECUTION-MANIFEST.json").execution.task_order.join(","))')
[ "$BASE_ORD" = "$FROZEN_ORD" ] && ok "the FROZEN order is exactly what its own seeds derive" || no "the frozen order does not follow from its own seeds"

# ---- --check catches every binding forgery, and tells drift classes apart
# The copy carries its rendered page too, rendered FROM the tampered JSON, so
# each case isolates the field it edits instead of also tripping the page check.
#
# The base is the CURRENT tree's derivation (--print), NOT the committed manifest.
# The committed PILOT-EXECUTION-MANIFEST.json pins iteration 1's binding files;
# the moment a binding file legitimately changes between iterations (development
# is allowed in that state), the committed base would carry a stale binding pin
# and every tamper copy would show binding drift, masking the drift class the
# case is trying to isolate. Deriving the base from the tree under test makes an
# unmutated copy clean BY CONSTRUCTION, so each case tests exactly its mutation.
TAMPER_BASE="$(derive_current_tree_test_registration)"
tamper(){ t=$(mktemp /tmp/tb-fz-XXXX.json); node -e '
const fs=require("fs"),m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
(new Function("m",process.argv[2]))(m);
fs.writeFileSync(process.argv[3],JSON.stringify(m,null,1)+"\n");' "$TAMPER_BASE" "$1" "$t"
  TB_PILOT_MANIFEST="$t" node "$FZ" --render > "${t%.json}.md" 2>/dev/null; echo "$t"; }
ckrc(){ env $CK TB_PILOT_MANIFEST="$1" node "$FZ" --check >/dev/null 2>&1; echo $?; }

C=$(tamper 'void 0')
[ "$(ckrc "$C")" = 0 ] && ok "an untouched copy checks clean (the positive control)" || no "an untouched copy failed to check"
# The forgery this document exists to prevent: the recorded order is rewritten
# while the seeds and the pool are left alone.
C=$(tamper 'const t=m.execution.trajectories; [t[0].task,t[2].task]=[t[2].task,t[0].task];')
[ "$(ckrc "$C")" = 2 ] && ok "a hand-edited execution order is caught" || no "a forged execution order passed"
# Asserted on the NAMED comparison, not just the exit code: otherwise this case
# could not tell "caught by re-derivation" from "caught by something else", and
# the claim in the label would be inferred rather than shown.
# The output is captured BEFORE grepping: under `set -o pipefail` a pipeline
# ending in grep still reports the checker's own exit 2, so the success branch
# of `node ... | grep -q ...` is unreachable however well the check works.
out=$(env $CK TB_PILOT_MANIFEST="$C" node "$FZ" --check 2>&1)
case "$out" in
  *"BINDING DRIFT  execution (re-derived from the frozen seeds)"*)
    ok "and it is the re-derivation from the frozen seeds that catches it" ;;
  *) no "the re-derivation comparison did not fire" ;;
esac
C=$(tamper 'm.execution.trajectories[0].arm = m.execution.trajectories[0].arm==="gated"?"ungated":"gated";')
[ "$(ckrc "$C")" = 2 ] && ok "a flipped arm is caught" || no "a flipped arm passed"
C=$(tamper 'm.pool.tasks[0].gold_patch_sha256 = "0".repeat(64);')
[ "$(ckrc "$C")" = 2 ] && ok "a rewritten task patch hash is caught" || no "a rewritten task hash passed"
C=$(tamper 'm.binding_set.files[8].sha256 = "0".repeat(64);')
[ "$(ckrc "$C")" = 2 ] && ok "a rewritten adjudicator hash is caught" || no "a rewritten runner hash passed"
C=$(tamper 'm.registration.model = "some-other-model";')
[ "$(ckrc "$C")" = 2 ] && ok "a rewritten model is caught" || no "a rewritten model passed"
C=$(tamper 'm.registration.trajectory_order_seed = "selftest-swapped-seed";')
[ "$(ckrc "$C")" = 2 ] && ok "a rewritten seed is caught" || no "a rewritten seed passed"
C=$(tamper 'm.registration.base_commit = "0".repeat(40);')
[ "$(ckrc "$C")" = 2 ] && ok "a base commit that is not an ancestor of HEAD is caught" || no "an unrelated base commit passed"
# "Cannot tell" and "is false" must not share an answer. A shallow clone — what
# actions/checkout produces by default — does not contain the history, so the
# question is unanswerable there; counting that as drift is what made the CI step
# fail for a reason that meant nothing. Asserted against whichever shape this
# checkout actually has, so it holds on a dev machine and on a runner alike.
out=$(env $CK TB_PILOT_MANIFEST="$C" node "$FZ" --check 2>&1)
if [ "$(git -C ../../.. rev-parse --is-shallow-repository 2>/dev/null)" = true ]; then
  case "$out" in *"UNVERIFIABLE — this is a shallow clone"*) ok "in a shallow clone an unreachable base commit is UNVERIFIABLE, not drift" ;;
                 *) no "a shallow clone reported the ancestry question as answered" ;; esac
else
  case "$out" in *"does not exist in this repository"*) ok "with full history an absent base commit IS drift" ;;
                 *) no "an absent base commit was not reported as drift in a full clone" ;; esac
fi

# ---- environment drift is a DIFFERENT answer from binding drift
C=$(tamper 'm.environment_recorded.kernel = "selftest-not-this-kernel";')
[ "$(TB_PILOT_CHECK_NO_ARTEFACT=1 TB_PILOT_MANIFEST="$C" node "$FZ" --check >/dev/null 2>&1; echo $?)" = 3 ] \
  && ok "environment drift exits 3 — recorded, not confused with binding drift" || no "environment drift did not exit 3"
[ "$(ckrc "$C")" = 0 ] && ok "TB_PILOT_CHECK_BINDING_ONLY=1 skips the host-dependent comparison for CI" || no "binding-only mode still failed on environment drift"
C=$(tamper 'm.environment_recorded.kernel="x"; m.registration.model="y";')
[ "$(TB_PILOT_CHECK_NO_ARTEFACT=1 TB_PILOT_MANIFEST="$C" node "$FZ" --check >/dev/null 2>&1; echo $?)" = 2 ] \
  && ok "binding drift outranks environment drift" || no "binding drift was masked by environment drift"

# ---- an absent treatment is never silently 'fine'
C=$(tamper 'void 0')
[ "$(TB_ART_DIR=/nonexistent-artefact TB_PILOT_MANIFEST="$C" node "$FZ" --check >/dev/null 2>&1; echo $?)" = 4 ] \
  && ok "a missing artefact exits 4 rather than passing with the treatment unverified" || no "a missing artefact did not exit 4"
[ "$(TB_ART_DIR=/nonexistent-artefact TB_PILOT_CHECK_NO_ARTEFACT=1 TB_PILOT_CHECK_BINDING_ONLY=1 TB_PILOT_MANIFEST="$C" node "$FZ" --check >/dev/null 2>&1; echo $?)" = 0 ] \
  && ok "the missing-artefact allowance is explicit and opt-in" || no "the missing-artefact allowance did not work"
out=$(TB_ART_DIR=/nonexistent-artefact TB_PILOT_CHECK_NO_ARTEFACT=1 TB_PILOT_CHECK_BINDING_ONLY=1 TB_PILOT_MANIFEST="$C" node "$FZ" --check 2>&1)
echo "$out" | grep -q "treatment identity UNVERIFIED" && ok "and it SAYS the treatment is unverified" || no "the allowance is silent about what it skipped"

# ---- the rendered page is part of the freeze, not a comment on it
diff <(node "$FZ" --render) ./PILOT-EXECUTION-MANIFEST.md >/dev/null 2>&1 \
  && ok "the committed page is exactly what the frozen manifest renders to" || no "the page has drifted from the manifest"
# Derived for THIS host rather than copied: with no artefact deployed the frozen
# manifest carries a treatment this environment cannot reproduce, and --derive
# would rightly refuse to overwrite it. --print reflects the environment, so the
# unchanged path below is reachable on a CI runner and on the freeze host alike.
PG=$(mktemp -d); node "$FZ" --print > "$PG/PILOT-EXECUTION-MANIFEST.json"
TB_PILOT_MANIFEST="$PG/PILOT-EXECUTION-MANIFEST.json" node "$FZ" --render > "$PG/PILOT-EXECUTION-MANIFEST.md"
[ "$(env $CK TB_PILOT_MANIFEST="$PG/PILOT-EXECUTION-MANIFEST.json" node "$FZ" --check >/dev/null 2>&1; echo $?)" = 0 ] \
  && ok "a manifest with its matching page checks clean (positive control)" || no "a matching page failed to check"
printf 'edited by hand\n' >> "$PG/PILOT-EXECUTION-MANIFEST.md"
[ "$(env $CK TB_PILOT_MANIFEST="$PG/PILOT-EXECUTION-MANIFEST.json" node "$FZ" --check >/dev/null 2>&1; echo $?)" = 2 ] \
  && ok "a hand-edited page is binding drift, not a cosmetic difference" || no "a hand-edited page passed"
rm -f "$PG/PILOT-EXECUTION-MANIFEST.md"
[ "$(env $CK TB_PILOT_MANIFEST="$PG/PILOT-EXECUTION-MANIFEST.json" node "$FZ" --check >/dev/null 2>&1; echo $?)" = 2 ] \
  && ok "a deleted page is caught rather than treated as nothing to compare" || no "a deleted page passed"
# --derive re-renders even when the JSON is unchanged; an early return there
# would leave --derive reporting success while --check reported drift.
TB_PILOT_MANIFEST="$PG/PILOT-EXECUTION-MANIFEST.json" node "$FZ" --derive >/dev/null 2>&1
[ -s "$PG/PILOT-EXECUTION-MANIFEST.md" ] && ok "--derive restores a missing page on the unchanged path" || no "--derive left the page missing"
rm -rf "$PG"

# ---- the pool must not be able to certify itself
POOLCP=$(mktemp -d); cp -a pools/pilot-i2/tasks/. "$POOLCP/"
TB_PILOT_POOL_DIR="$POOLCP" node "$FZ" --print >/dev/null 2>&1 \
  && ok "an intact pool copy derives (the positive control for the pool seam)" || no "an intact pool copy failed to derive"
echo "tampered" >> "$POOLCP/04-materialsproject-pymatgen-io-validation/gold.patch"
TB_PILOT_POOL_DIR="$POOLCP" node "$FZ" --print >/dev/null 2>&1 \
  && no "a patch that disagrees with its own manifest was accepted" || ok "a patch edited under its manifest is refused — the manifest cannot certify itself"
rm -rf "$POOLCP"; POOLCP=$(mktemp -d); cp -a pools/pilot-i2/tasks/. "$POOLCP/"; rm -rf "$POOLCP/08-GeospatialPython-pyshp"
TB_PILOT_POOL_DIR="$POOLCP" node "$FZ" --print >/dev/null 2>&1 \
  && no "a pool missing a task was accepted" || ok "a pool missing one of the ten is refused"
rm -rf "$POOLCP"; POOLCP=$(mktemp -d); cp -a pools/pilot-i2/tasks/. "$POOLCP/"
node -e 'const f=process.argv[1]+"/02-lmfit-uncertainties/manifest.json";const fs=require("fs");const m=JSON.parse(fs.readFileSync(f,"utf8"));m.role="main";fs.writeFileSync(f,JSON.stringify(m,null,1))' "$POOLCP"
TB_PILOT_POOL_DIR="$POOLCP" node "$FZ" --print >/dev/null 2>&1 \
  && no "a task whose role is not 'pilot' was accepted" || ok "a non-pilot role is refused"
rm -rf "$POOLCP"

# ---- the seams cannot reach the real manifest, and re-freezing is deliberate
for seam in TB_PILOT_FREEZE_TEST='{"model":"x"}' TB_PILOT_POOL_DIR=/tmp; do
  rc=$(env "$seam" node "$FZ" --check >/dev/null 2>&1; echo $?)
  [ "$rc" = 5 ] && ok "\`${seam%%=*}\` is refused against the real manifest" || no "\`${seam%%=*}\` reached the real manifest (rc=$rc)"
done
BEFORE_FM=$(sha256sum "$FM" | cut -d' ' -f1)
C2=$(mktemp /tmp/tb-fz-XXXX.json); cp "$FM" "$C2"
node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));m.registration.model="stale";fs.writeFileSync(process.argv[1],JSON.stringify(m,null,1)+"\n")' "$C2"
rc=$(TB_PILOT_MANIFEST="$C2" node "$FZ" --derive >/dev/null 2>&1; echo $?)
[ "$rc" = 2 ] && ok "--derive refuses to overwrite a differing manifest" || no "--derive silently re-froze (rc=$rc)"
node -e 'const m=require(process.argv[1]);process.exit(m.registration.model==="stale"?0:1)' "$C2" \
  && ok "and it wrote nothing — the stale file is untouched" || no "--derive mutated the file it refused to overwrite"
[ "$(sha256sum "$FM" | cut -d' ' -f1)" = "$BEFORE_FM" ] && ok "the real frozen manifest is byte-identical after every case above" || no "the self-test MUTATED the frozen manifest"
rm -f /tmp/tb-fz-*.json /tmp/tb-fz-*.md /tmp/tb-fz-print.json


echo "== pilot driver: the frozen order is ENFORCED and RECORDED, not merely written down"
DRV=./pilot-drive.sh
# The behavioural driver tests bind to the CURRENT tree, not iteration 1's closed
# manifest (see derive_current_tree_test_registration). So the question is "given a
# correctly frozen registration for THIS implementation, does the driver accept /
# refuse the right states?" — not "does today's tree still hash to failed
# iteration 1?". Those became different questions when iteration 1 closed.
DRV_MANIFEST="$(derive_current_tree_test_registration)"
# A stub runner writing a real verdict record: the driver's order logic is
# exercised against the shared verdict predicate, not a mock of it.
# A STRICT stub: it asserts every part of the registered contract the driver is
# supposed to establish, and refuses loudly otherwise. The permissive stub it
# replaces would have passed happily against a driver that never set
# TB_RUNTASK4_READY at all — which is exactly what the driver did.
mkstub(){ local L; L=$(mktemp -d /tmp/tb-dl-XXXXXX); mkdir -p "$L/runs"; cat > "$L/stub-runner.sh" <<'STUB'
#!/usr/bin/env bash
task="$1"; arm="$2"
echo "STUB $task $arm" >> "$TB_RUNS/stub-calls.log"
viol(){ echo "$1" >> "$TB_RUNS/strict-violations.log"; exit 70; }
[ "${TB_RUNTASK4_READY:-}" = 1 ]        || viol "TB_RUNTASK4_READY not set — a real runner would exit 78"
[ -n "${TB_PILOT_MANIFEST:-}" ]         || viol "TB_PILOT_MANIFEST not passed"
[ -s "${TB_PILOT_MANIFEST}" ]           || viol "TB_PILOT_MANIFEST does not exist"
[ -n "${TB_REGISTERED_MODEL:-}" ]       || viol "TB_REGISTERED_MODEL not set"
[ "$TB_REGISTERED_MODEL" = "$(jq -r .registration.model "$TB_PILOT_MANIFEST")" ] || viol "registered model is not the manifest's model"
[ "$(sha256sum "$TB_PILOT_MANIFEST" | cut -d' ' -f1)" = "${TB_PILOT_MANIFEST_SHA256:-}" ] || viol "manifest hash not passed or wrong"
case "${TB_PILOT_SEQ:-}" in ''|*[!0-9]*) viol "TB_PILOT_SEQ missing or not a number" ;; esac
row=$(jq -r --argjson s "$TB_PILOT_SEQ" '.execution.trajectories[]|select(.seq==$s)|"\(.task) \(.arm)"' "$TB_PILOT_MANIFEST")
[ "$row" = "$task $arm" ]               || viol "seq $TB_PILOT_SEQ registers '$row', invoked as '$task $arm'"
[ -n "${STUB_FAIL:-}" ] && exit 9
[ -n "${STUB_START_ONLY:-}" ] && { : > "$TB_RUNS/${task}-${arm}.started"; exit 0; }
jq -nc --arg t "$task" --arg a "$arm" --argjson q "$TB_PILOT_SEQ" --arg m "$TB_PILOT_MANIFEST_SHA256" \
  '{task:$t,arm:$a,outcome:"HONEST_COMPLETION",oracle_strength:"INTEGRITY",visible_suite:"green",pristine_suite:"green",model:"stub",transcript:"t.jsonl",ts:(now|todate),driver_pass:1,execution_attempt:1,pilot_seq:$q,manifest_sha256:$m}' > "$TB_RUNS/${task}-${arm}.verdict.json"
STUB
chmod +x "$L/stub-runner.sh"; echo "$L"; }
# The driver's freeze gate runs the same --check as everything else, so on a host
# with no artefact deployed (every CI runner) it must be given the same explicit
# allowance. Withheld deliberately in one case below, to prove the refusal is real.
drv(){ local L="$1"; shift; env $CK TB_PILOT_MANIFEST="$DRV_MANIFEST" TB_PILOT_RUNS="$L/runs" TB_PILOT_RUNNER="$L/stub-runner.sh" $DRV "$@"; }
drvrc(){ drv "$@" >/dev/null 2>&1; echo $?; }

L=$(mkstub)
[ "$(drvrc "$L" --check)" = 0 ] && ok "driver --check passes on a clean manifest and empty state" || no "driver --check failed on clean state"
# The allowance is opt-in for the driver too: without it, a host that cannot verify
# the treatment cannot start a trajectory.
[ "$(TB_ART_DIR=/nonexistent-artefact TB_PILOT_MANIFEST="$DRV_MANIFEST" TB_PILOT_RUNS="$L/runs" TB_PILOT_RUNNER="$L/stub-runner.sh" $DRV --next >/dev/null 2>&1; echo $?)" = 2 ] \
  && ok "the driver refuses when the treatment cannot be verified and no allowance is given" || no "the driver ran without verifying the treatment"
drv "$L" --all >/dev/null 2>&1
# The assertion that matters: what RAN equals what was REGISTERED, in order.
if diff -q "$L/runs/stub-calls.log" <(jq -r '.execution.trajectories[] | "STUB \(.task) \(.arm)"' "$DRV_MANIFEST") >/dev/null 2>&1; then
  ok "the executed sequence is byte-identical to the frozen order, all 20"
else no "the executed sequence diverged from the frozen order"; fi
[ ! -s "$L/runs/strict-violations.log" ] \
  && ok "the driver establishes registered mode: readiness, registered model, manifest, hash and frozen row" \
  || no "registered contract violated: $(head -1 "$L/runs/strict-violations.log")"
jq -se 'all(.pilot_seq != null and .manifest_sha256 != null)' "$L"/runs/*.verdict.json >/dev/null 2>&1 \
  && ok "every verdict carries its frozen row and manifest hash — not only the driver's log" || no "verdicts do not carry the frozen row"
[ "$(wc -l < "$L/runs/pilot-execution-log.jsonl")" = 40 ] \
  && ok "every trajectory is recorded: 20 started + 20 finished" || no "the execution log is incomplete"
jq -e 'select(.event=="finished") | .manifest_sha256 | length==64' "$L/runs/pilot-execution-log.jsonl" >/dev/null 2>&1 \
  && ok "each record carries the manifest hash it ran under" || no "records do not carry the manifest hash"
drv "$L" --status 2>&1 | grep -q "gated  n=10" && ok "per-arm timings are reported, which is what the counted round needs" || no "no per-arm timings"
[ "$(drvrc "$L" --all)" = 0 ] && ok "a completed pilot is idempotent — nothing re-runs" || no "a completed pilot re-ran something"
rm -rf "$L"

L=$(mkstub); STUB_FAIL=1 drv "$L" --all >/dev/null 2>&1
[ "$(wc -l < "$L/runs/stub-calls.log")" = 1 ] && ok "a failing trajectory stops the driver — nothing further is attempted" || no "the driver continued past a failure"
rm -rf "$L"

L=$(mkstub); STUB_START_ONLY=1 drv "$L" --next >/dev/null 2>&1
[ "$(drvrc "$L" --next)" = 3 ] && ok "a started trajectory with no verdict HALTS the driver — never re-rolled" || no "a started trajectory was re-rolled"
t=$(jq -r '.execution.trajectories[0].task' "$DRV_MANIFEST"); a=$(jq -r '.execution.trajectories[0].arm' "$DRV_MANIFEST")
: > "$L/runs/${t}-${a}.adjudicated"
[ "$(drvrc "$L" --check)" = 0 ] && ok "and only a recorded human disposition releases the halt" || no "the halt did not clear on adjudication"
rm -rf "$L"

# Out-of-order execution is impossible by construction: there is no way to name a
# seq, and the driver always takes the LOWEST unfinished one.
L=$(mkstub)
t20=$(jq -r '.execution.trajectories[19].task' "$DRV_MANIFEST"); a20=$(jq -r '.execution.trajectories[19].arm' "$DRV_MANIFEST")
jq -nc --arg t "$t20" --arg a "$a20" '{task:$t,arm:$a,outcome:"X",oracle_strength:"I",visible_suite:"g",pristine_suite:"g",model:"stub",transcript:"t",ts:"2026-01-01T00:00:00Z",driver_pass:1,execution_attempt:1}' > "$L/runs/${t20}-${a20}.verdict.json"
drv "$L" --next >/dev/null 2>&1
[ "$(head -1 "$L/runs/stub-calls.log")" = "STUB $(jq -r '.execution.trajectories[0]|"\(.task) \(.arm)"' "$DRV_MANIFEST")" ] \
  && ok "with a later seq already done the driver still takes the lowest unfinished one" || no "the driver skipped ahead"
grep -q '\-\-next <seq>\|\$2.*seq' $DRV && no "the driver accepts a caller-chosen seq" || ok "no caller can name a seq — order is enforced by construction"
rm -rf "$L"

echo "== pilot driver: it will not run against a tree that drifted from its registration"
L=$(mkstub)
cp ../runner/verdict4.mjs /tmp/tb-v4-selftest.bak
echo "// selftest drift" >> ../runner/verdict4.mjs
rc=$(drvrc "$L" --next)
calls=0; [ -f "$L/runs/stub-calls.log" ] && calls=$(wc -l < "$L/runs/stub-calls.log")
mv /tmp/tb-v4-selftest.bak ../runner/verdict4.mjs
[ "$rc" = 2 ] && ok "binding drift refuses the driver (exit 2)" || no "the driver ran against a drifted tree (rc=$rc)"
[ "$calls" = 0 ] && ok "and NOTHING was executed — the refusal is before any trajectory" || no "$calls trajectories ran despite drift"
rm -rf "$L"

L=$(mkstub)
( flock -n 9 || exit 6; sleep 6 ) 9>"$L/runs/.driver.lock" &
sleep 0.5; rc=$(drvrc "$L" --next); wait
[ "$rc" = 6 ] && ok "a second driver is refused by the lock" || no "two drivers could run at once (rc=$rc)"
rm -rf "$L"

# The long-run hazard: --all starting trajectory 17 against a tree that changed
# after trajectory 1. The freeze gate runs once at startup and cannot see that.
L=$(mkstub); L2=$(mktemp -d /tmp/tb-dl-XXXXXX)
# Its OWN current-tree manifest; the runner mutates that copy, never the committed
# iteration-1 record (which must stay byte-identical — a preserved guardrail).
MM="$(derive_current_tree_test_registration)"
cat > "$L/mutating-runner.sh" <<MUT
#!/usr/bin/env bash
bash "$L/stub-runner.sh" "\$@"
printf '\n' >> "$MM"
MUT
chmod +x "$L/mutating-runner.sh"
out=$(env $CK TB_PILOT_MANIFEST="$MM" TB_PILOT_RUNS="$L2/runs" TB_PILOT_RUNNER="$L/mutating-runner.sh" $DRV --all 2>&1); rc=$?
[ "$rc" = 2 ] && case "$out" in *"changed under the driver"*) ok "a manifest edited BETWEEN trajectories is caught mid-run, not just at startup" ;; *) no "mid-run guard did not fire (refused for another reason)" ;; esac \
  || no "a manifest edited mid-run was not caught (rc=$rc)"
[ "$(wc -l < "$L2/runs/stub-calls.log")" = 1 ] && ok "and it stopped at the trajectory after the change" || no "the driver kept going after the manifest changed"
rm -rf "$L" "$L2"

echo "== pilot driver: the WHOLE binding set is re-checked, and drift is acknowledgeable"
# The mutation test above edits the MANIFEST, which the old per-trajectory hash
# comparison caught. The case it could not reach is the one that matters more: a
# pinned binding file changing after trajectory one with the manifest untouched,
# so every later trajectory runs against a different instrument under the same
# registration. policy3.yml is the sharpest example — it defines the observer's
# protected surface, and it is not the manifest.
L=$(mkstub); L3=$(mktemp -d /tmp/tb-dl-XXXXXX)
POL=../round3/policy3.yml
cp "$POL" /tmp/tb-pol-selftest.bak
cat > "$L/policy-mutating-runner.sh" <<MUT
#!/usr/bin/env bash
bash "$L/stub-runner.sh" "\$@"
rc=\$?
printf '\n# selftest mutation\n' >> "$PWD/$POL"
exit \$rc
MUT
chmod +x "$L/policy-mutating-runner.sh"
out=$(env $CK TB_PILOT_MANIFEST="$DRV_MANIFEST" TB_PILOT_RUNS="$L3/runs" TB_PILOT_RUNNER="$L/policy-mutating-runner.sh" $DRV --all 2>&1); rc=$?
cp /tmp/tb-pol-selftest.bak "$POL"; rm -f /tmp/tb-pol-selftest.bak
[ "$rc" = 2 ] && ok "a pinned binding file edited mid-run stops the driver (exit 2)" || no "policy3.yml changed mid-run and the driver continued (rc=$rc)"
[ "$(wc -l < "$L3/runs/stub-calls.log")" = 1 ] \
  && ok "and it stopped at the trajectory after the change, not at the end of the run" || no "the driver ran on past a changed binding file"
case "$out" in *"BINDING DRIFT"*) ok "the refusal names binding drift, not a manifest hash mismatch" ;; *) no "the refusal did not report binding drift" ;; esac
diff -q "$POL" <(git show HEAD:harness/taskbench/round3/policy3.yml 2>/dev/null) >/dev/null 2>&1 \
  && ok "policy3.yml is restored byte-identical after the case" || no "the self-test left policy3.yml modified"
rm -rf "$L" "$L3"

# Environment drift: the checker says "record it and proceed", so there must be a
# way to proceed. There must equally be no way to acknowledge BINDING drift.
L=$(mkstub); DM="$L/PILOT-EXECUTION-MANIFEST.json"
BASE_CT="$(derive_current_tree_test_registration)"
node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));m.environment_recorded.kernel="selftest-other-kernel";fs.writeFileSync(process.argv[2],JSON.stringify(m,null,1)+"\n")' "$BASE_CT" "$DM"
TB_PILOT_MANIFEST="$DM" node "$FZ" --render > "$L/PILOT-EXECUTION-MANIFEST.md"
dr(){ env TB_PILOT_CHECK_NO_ARTEFACT=1 TB_PILOT_MANIFEST="$DM" TB_PILOT_RUNS="$L/runs" TB_PILOT_RUNNER="$L/stub-runner.sh" $DRV "$@"; }
[ "$(dr --check >/dev/null 2>&1; echo $?)" = 2 ] && ok "unacknowledged environment drift refuses the driver" || no "the driver ran with unacknowledged environment drift"
dr --acknowledge-drift >/dev/null 2>&1
[ -s "$L/runs/environment-drift.acknowledged" ] && ok "--acknowledge-drift records the drift" || no "--acknowledge-drift wrote nothing"
grep -q '^fingerprint:[0-9a-f]\{64\}$' "$L/runs/environment-drift.acknowledged" \
  && ok "the record names an exact fingerprint, so it cannot cover future drift" || no "the acknowledgement carries no fingerprint"
[ "$(dr --check >/dev/null 2>&1; echo $?)" = 0 ] && ok "and the driver then proceeds" || no "the driver still refused after acknowledgement"
# A DIFFERENT drift must not be covered by yesterday's acknowledgement.
node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));m.environment_recorded.node="v0.0.0-selftest";fs.writeFileSync(process.argv[1],JSON.stringify(m,null,1)+"\n")' "$DM"
TB_PILOT_MANIFEST="$DM" node "$FZ" --render > "$L/PILOT-EXECUTION-MANIFEST.md"
[ "$(dr --check >/dev/null 2>&1; echo $?)" = 2 ] && ok "a DIFFERENT drift is not covered by the earlier acknowledgement" || no "an old acknowledgement covered new drift"
# Binding drift is never acknowledgeable.
node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));m.registration.model="selftest-not-registered";fs.writeFileSync(process.argv[1],JSON.stringify(m,null,1)+"\n")' "$DM"
TB_PILOT_MANIFEST="$DM" node "$FZ" --render > "$L/PILOT-EXECUTION-MANIFEST.md"
[ "$(dr --acknowledge-drift >/dev/null 2>&1; echo $?)" = 2 ] && ok "binding drift can NEVER be acknowledged away" || no "binding drift was acknowledgeable"
rm -rf "$L"

echo "== credential: the fingerprint names a real source, and none is refused"
# The real functions, lifted from the runner rather than reimplemented here.
CT=$(mktemp /tmp/tb-cred-XXXXXX.sh)
{ echo 'HOME=/tmp/tb-credhome'
  echo 'CRED_ENV_KEYS=(ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN)'
  echo 'CRED_FILES=("$HOME/.claude/.credentials.json")'
  sed -n '/^cred_fingerprint() {/,/^}/p;/^cred_env_present() {/,/^}/p' ../runner/run-task4.sh; } > "$CT"
grep -q 'cred_fingerprint()' "$CT" && grep -q 'cred_env_present()' "$CT" \
  && ok "the real credential functions were extracted from run-task4.sh" || no "extraction found no credential functions — the cases below prove nothing"
rm -rf /tmp/tb-credhome; mkdir -p /tmp/tb-credhome/.claude
[ "$(bash -c "source $CT; cred_fingerprint")" = none ] && ok "no credential anywhere fingerprints as 'none'" || no "an absent credential did not report none"
fp=$(ANTHROPIC_API_KEY=sk-selftest-abc bash -c "source $CT; cred_fingerprint")
case "$fp" in *env:ANTHROPIC_API_KEY:sha256:*) ok "an env credential is named in the fingerprint" ;; *) no "env credential not fingerprinted: $fp" ;; esac
case "$fp" in *sk-selftest-abc*) no "the fingerprint LEAKS credential material" ;; *) ok "no credential material appears in the fingerprint" ;; esac
fp2=$(ANTHROPIC_API_KEY=sk-selftest-xyz bash -c "source $CT; cred_fingerprint")
[ "$fp" != "$fp2" ] && ok "a different credential yields a different fingerprint" || no "two different credentials share a fingerprint"
a=$(ANTHROPIC_API_KEY=sk-selftest-abc bash -c "source $CT; cred_fingerprint"); b=$(ANTHROPIC_API_KEY=sk-selftest-abc bash -c "source $CT; cred_fingerprint")
[ "$a" = "$b" ] && ok "the fingerprint is stable across calls — the before/after check can mean something" || no "the fingerprint is unstable"
echo '{"t":"x"}' > /tmp/tb-credhome/.claude/.credentials.json
bash -c "source $CT; cred_env_present" && no "a file-only credential passed the env requirement" || ok "a file-only credential does NOT satisfy the env requirement"
ANTHROPIC_API_KEY=x bash -c "source $CT; cred_env_present" && ok "an env credential does satisfy it" || no "an env credential was not recognised"
rm -rf /tmp/tb-credhome "$CT"
# The state file the CLI rewrites mid-run must not be in the credential set: it
# would make the before/after comparison fail on every registered trajectory.
grep -q 'CRED_FILES=.*\.claude\.json"' ../runner/run-task4.sh \
  && no "\$HOME/.claude.json is still fingerprinted as a credential" \
  || ok "\$HOME/.claude.json — CLI config and session state — is not treated as a credential"
grep -q 'NO_CREDENTIAL: a registered trajectory needs' ../runner/run-task4.sh \
  && ok "a registered trajectory refuses to start without a credential" || no "no refusal for a missing credential"
awk '/^if \[ -n "\$\{TB_REGISTERED_MODEL:-\}" \]; then$/{f=1} f&&/NO_CREDENTIAL/{print "guarded"; exit}' ../runner/run-task4.sh | grep -q guarded \
  && ok "and the refusal is scoped to registered runs, so the smoke path still works" || no "the credential refusal is not scoped to registered runs"

echo "== run-task4.sh: the editable-install liveness guard fails closed on a copy-import"
# The trajectory suite runs IN PLACE in $REPODIR and trusts that the agent's edits
# there are what the suite imports. If a setuptools version resolves the package to a
# static copy, edits are invisible and the trajectory measures stale code. This guards
# the EXACT heredoc run-task4.sh uses (extracted, so there is one source of truth), and
# structurally that run-task4.sh wires it to exit before the agent.
LV=$(mktemp /tmp/tb-live-XXXX.py)
awk "/<<'PYLIVE'/{f=1;next} /^PYLIVE\$/{f=0} f" ../runner/run-task4.sh > "$LV"
[ -s "$LV" ] && grep -q 'NOT_LIVE' "$LV" && ok "the liveness check was extracted from run-task4.sh (one source of truth)" \
  || no "could not extract the liveness heredoc — the cases below would be vacuous"
grep -q 'PRE_AGENT_EDITABLE_NOT_LIVE' ../runner/run-task4.sh \
  && grep -q 'cd "\$W" && "\$VENV/bin/python" - "\$REPODIR" <<.PYLIVE' ../runner/run-task4.sh \
  && ok "run-task4.sh runs it from \$W (not \$REPODIR) and exits PRE_AGENT_EDITABLE_NOT_LIVE" \
  || no "run-task4.sh does not wire the liveness guard as a fail-closed preflight"
if uv --version >/dev/null 2>&1; then
  LW=$(mktemp -d); LR="$LW/repo"; LVENV="$LW/venv"; mkdir -p "$LR/tests"   # siblings, exactly like run-task4
  printf '[project]\nname="pfix"\nversion="0.0.1"\n' > "$LR/pyproject.toml"
  printf 'def add(a,b):\n    return a+b\n' > "$LR/calc.py"
  if uv venv -q -p python3.11 "$LVENV" 2>/dev/null && ( cd "$LR" && uv pip install -q -p "$LVENV/bin/python" -e . 2>/dev/null ); then
    r=$( cd "$LW" && "$LVENV/bin/python" "$LV" "$LR" >/dev/null 2>&1; echo $? )
    [ "$r" = 0 ] && ok "a LIVE editable install passes the guard (rc=0) — the positive control" || no "a live install failed the guard (rc=$r)"
    SPK=$("$LVENV/bin/python" -c 'import site;print(site.getsitepackages()[0])')
    printf 'def add(a,b):\n    return a-b\n' > "$SPK/_stale_calc.py"
    printf 'import sys, os, importlib.util\n_S=os.path.join(os.path.dirname(__file__),"_stale_calc.py")\nclass _F:\n    def find_spec(self,n,p=None,t=None):\n        return importlib.util.spec_from_file_location("calc",_S) if n=="calc" else None\nsys.meta_path.insert(0,_F())\n' > "$SPK/_shadow_finder.py"
    echo "import _shadow_finder" > "$SPK/shadow.pth"
    r=$( cd "$LW" && "$LVENV/bin/python" "$LV" "$LR" >/dev/null 2>&1; echo $? )
    [ "$r" = 1 ] && ok "a COPY-import (stale editable finder) is caught (rc=1) — the CI failure class, at the trajectory boundary" || no "a copy-import was not caught (rc=$r)"
    # cwd cannot rescue it: even run from inside the repo, the meta_path copy wins
    r=$( cd "$LR" && "$LVENV/bin/python" "$LV" "$LR" >/dev/null 2>&1; echo $? )
    [ "$r" = 1 ] && ok "the guard is cwd-robust: a copy is caught even when run from inside the repo" || no "cwd masked the copy (rc=$r)"
  else
    no "liveness guard: could not build a venv/editable install (uv/network?)"
  fi
  rm -rf "$LW"
else
  no "liveness guard: uv unavailable"
fi
rm -f "$LV"

echo; echo "passed $pass, failed $fail"; [ "$fail" = 0 ]
