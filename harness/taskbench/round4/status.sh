#!/usr/bin/env bash
# Round-4 mining status. Counts miners EXACTLY.
#
# Counting miners by command line does not work, in three distinct ways, each
# found the hard way:
#   1. `pgrep -fc mine5.sh` matches the launcher wrapper, whose command line
#      names the script;
#   2. it also matches the SHELL DOING THE INSPECTING, whose command line
#      contains the pattern — the observer counts itself;
#   3. even exact-argv matching over-counts, because a bash SUBSHELL inherits
#      its parent's argv and appears as another `bash ./mine5.sh`.
# The unambiguous unit is the SESSION: one launched miner is one session id.
# Accumulation is more than one mining session, which is what actually happened
# in D3 and what this must be able to see.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
POOL="${1:-pilot}"
P="pools/$POOL"
V='"gate":"(EXCLUDED_INACTIVE|G0_NO_PYPROJECT|G0_NOT_PYTEST|G0_NO_TESTS|NO_QUALIFYING_COMMITS|CLONE_FAILED|CANDIDATES_EXHAUSTED|TASK_VALIDATED|QUOTA_FULL)"'
self_sid=$(ps -o sid= -p $$ | tr -d ' ')
sessions=$(for p in $(pgrep -x -f 'bash ./mine5.sh' 2>/dev/null); do
             ps -o sid= -p "$p" 2>/dev/null | tr -d ' '; done | sort -u | grep -v "^$self_sid$" | grep -c . || true)
procs=$(pgrep -x -f 'bash ./mine5.sh' 2>/dev/null | wc -l)
pid=$(cat "/tmp/tb-mine-$POOL.pid" 2>/dev/null || echo -)
alive=no; [ "$pid" != - ] && kill -0 "$pid" 2>/dev/null && alive=yes
walk=$(node -p "JSON.parse(require('fs').readFileSync('$P/walk.json')).order.length" 2>/dev/null || echo ?)
echo "pool           $POOL"
echo "mining sessions $sessions  (1 = healthy, >1 = ACCUMULATION, stop everything)"
echo "  processes     $procs  (parent + subshells of those sessions; not a miner count)"
echo "launcher pid   $pid (alive: $alive)"
echo "decided        $(grep -cE "$V" "$P/attrition.jsonl" 2>/dev/null || echo 0) of $walk"
echo "tasks          $(ls "$P/tasks" 2>/dev/null | wc -l)"
cf=$(grep -c CLONE_FAILED "$P/attrition.jsonl" 2>/dev/null); cf=${cf:-0}
echo "CLONE_FAILED   $cf  (D3 regression: must be 0)"
echo "breaker        $([ -e "${TB_CLONE_BREAKER:-/tmp/tb-clone-breaker}" ] && echo TRIPPED || echo clear)"
echo "exit status    $(cat "/tmp/tb-mine-$POOL.status" 2>/dev/null || echo 'not written — still running')"
echo "now on         $(tail -1 "/tmp/tb-mine-$POOL.out" 2>/dev/null | cut -c1-60)"
