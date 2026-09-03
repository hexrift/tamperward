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
out=$(TB_CLONE_BREAKER="$B" TB_MINER_PID=999999 PATH="$HERE/shim:$PATH" timeout 30 git clone https://example.invalid/x /tmp/tb-st-$$ 2>&1); rc=$?
[ "$rc" = 90 ] && ok "shim exits 90 and kills nothing when no live miner is named" || no "shim exit was $rc, want 90"
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

echo "== P1: the frozen walk artefact is a real file, never a symlink"
[ -L pools/pilot/walk.json ] && no "pools/pilot/walk.json is a SYMLINK — writes reach the frozen frame" || ok "pools/pilot/walk.json is a real file"
n=$(node -p "JSON.parse(require('fs').readFileSync('frame/pilot-walk-order.json')).order.length")
[ "$n" = 500 ] && ok "frame/pilot-walk-order.json still holds the frozen 500" || no "frozen walk has $n entries, want 500"

echo "== P1: the burn list regenerates from committed evidence"
python3 incident-D3/build-burn-list.py --check >/dev/null 2>&1 && ok "burn list matches the incident evidence" || no "burn list does not regenerate"

echo; echo "passed $pass, failed $fail"; [ "$fail" = 0 ]
