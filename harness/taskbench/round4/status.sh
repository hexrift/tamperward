#!/usr/bin/env bash
# Round-4 mining status. Counts miners EXACTLY.
#
# `pgrep -fc mine5.sh` is wrong and cried wolf once already: it matches the
# launcher wrapper (whose command line names the script) and any shell inspecting
# the miner (whose command line contains the pattern). Both inflate the count and
# make a genuine accumulation alarm indistinguishable from an observer effect.
# Match the exact argv instead, and cross-check the launcher's own pid file.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
POOL="${1:-pilot}"
P="pools/$POOL"
V='"gate":"(EXCLUDED_INACTIVE|G0_NO_PYPROJECT|G0_NOT_PYTEST|G0_NO_TESTS|NO_QUALIFYING_COMMITS|CLONE_FAILED|CANDIDATES_EXHAUSTED|TASK_VALIDATED|QUOTA_FULL)"'
miners=$(pgrep -x -f 'bash ./mine5.sh' | wc -l)
pid=$(cat "/tmp/tb-mine-$POOL.pid" 2>/dev/null || echo -)
alive=no; [ "$pid" != - ] && kill -0 "$pid" 2>/dev/null && alive=yes
walk=$(node -p "JSON.parse(require('fs').readFileSync('$P/walk.json')).order.length" 2>/dev/null || echo ?)
echo "pool           $POOL"
echo "miners         $miners  (exact argv match; 1 = healthy, >1 = ACCUMULATION, stop everything)"
echo "launcher pid   $pid (alive: $alive)"
echo "decided        $(grep -cE "$V" "$P/attrition.jsonl" 2>/dev/null || echo 0) of $walk"
echo "tasks          $(ls "$P/tasks" 2>/dev/null | wc -l)"
echo "CLONE_FAILED   $(grep -c CLONE_FAILED "$P/attrition.jsonl" 2>/dev/null || echo 0)  (D3 regression: must be 0)"
echo "breaker        $([ -e "${TB_CLONE_BREAKER:-/tmp/tb-clone-breaker}" ] && echo TRIPPED || echo clear)"
echo "exit status    $(cat "/tmp/tb-mine-$POOL.status" 2>/dev/null || echo 'not written — still running')"
echo "now on         $(tail -1 "/tmp/tb-mine-$POOL.out" 2>/dev/null | cut -c1-60)"
