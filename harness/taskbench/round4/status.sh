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
# All runtime state lives under one directory so a separate process — another
# terminal, or a second container sharing a volume — can read it. Defaults to
# /tmp, which is what every existing path was hardcoded to.
TB_RUNTIME_DIR="${TB_RUNTIME_DIR:-/tmp}"; mkdir -p "$TB_RUNTIME_DIR"
POOL="${1:-pilot}"
P="pools/$POOL"
V='"gate":"(EXCLUDED_INACTIVE|G0_NO_PYPROJECT|G0_NOT_PYTEST|G0_NO_TESTS|NO_QUALIFYING_COMMITS|CLONE_FAILED|REPO_UNAVAILABLE|CANDIDATES_EXHAUSTED|TASK_VALIDATED|QUOTA_FULL)"'
# macOS ps has no `sid` column; its process groups are the workable equivalent
# here, because launch-mine.sh puts each miner in its own session AND group.
if ps -o sid= -p $$ >/dev/null 2>&1; then SIDCOL=sid; else SIDCOL=pgid; fi
sid_of(){ ps -o "$SIDCOL=" -p "$1" 2>/dev/null | tr -d ' '; }
self_sid=$(sid_of $$)
sessions=$(for p in $(pgrep -x -f 'bash ./mine5.sh' 2>/dev/null); do
             sid_of "$p"; done | sort -u | grep -v "^$self_sid$" | grep -c . || true)
procs=$(pgrep -x -f 'bash ./mine5.sh' 2>/dev/null | wc -l)
pid=$(cat "$TB_RUNTIME_DIR/tb-mine-$POOL.pid" 2>/dev/null || echo -)
alive=no; [ "$pid" != - ] && kill -0 "$pid" 2>/dev/null && alive=yes
# Two supervision modes, and conflating them manufactures false alarms.
# LAUNCHED: launch-mine.sh detached the miner and owns the pid, status and log
# files. FOREGROUND: the miner runs in the foreground under a supervisor that is
# not launch-mine.sh — a container, or a terminal — so there is no pid file by
# design, and its absence says nothing about health. Docker records the exit
# status (`docker compose ps -a`) and the output (`... logs mine`) itself.
if [ "$pid" = - ]; then mode=foreground; else mode=launched; fi
walk=$(node -p "JSON.parse(require('fs').readFileSync('$P/walk.json')).order.length" 2>/dev/null || echo ?)
echo "pool           $POOL"
echo "mining sessions $sessions  (1 = healthy, >1 = ACCUMULATION, stop everything)"
echo "  processes     $procs  (parent + subshells of those sessions; not a miner count)"
if [ "$mode" = launched ]; then
  echo "launcher pid   $pid (alive: $alive)"
else
  echo "supervision    foreground (no launcher) — pid/status/log files are not"
  echo "               written in this mode; under Docker use \`compose ps -a\`"
  echo "               and \`compose logs mine\`. Read this container from INSIDE"
  echo "               it (\`compose exec mine ./status.sh\`): a separate container"
  echo "               has its own PID namespace and would see 0 sessions."
fi
echo "decided        $(grep -cE "$V" "$P/attrition.jsonl" 2>/dev/null || echo 0) of $walk"
echo "tasks          $(ls "$P/tasks" 2>/dev/null | wc -l)"
cf=$(grep -c CLONE_FAILED "$P/attrition.jsonl" 2>/dev/null); cf=${cf:-0}
echo "CLONE_FAILED   $cf  (D3 regression: must be 0)"
echo "breaker        $([ -e "${TB_CLONE_BREAKER:-$TB_RUNTIME_DIR/tb-clone-breaker}" ] && echo TRIPPED || echo clear)"
hb="${TB_HEARTBEAT:-$TB_RUNTIME_DIR/tb-mine-$POOL.heartbeat}"
if [ -f "$hb" ]; then
  age=$(( $(date +%s) - $(node -p "JSON.parse(require('fs').readFileSync('$hb')).epoch" 2>/dev/null || echo 0) ))
  note="alive"
  [ "$age" -gt 3600 ] && note="STALE — a repository rarely takes an hour; suspect a death"
  [ "$sessions" = 0 ] && note="no miner running: this is when it stopped"
  echo "heartbeat      ${age}s ago ($note)"
  echo "  last repo    $(node -p "JSON.parse(require('fs').readFileSync('$hb')).repo" 2>/dev/null || echo ?)"
else
  echo "heartbeat      none written"
fi
st=$(cat "$TB_RUNTIME_DIR/tb-mine-$POOL.status" 2>/dev/null)
case "$st" in
  signal:*)  st="$st — stopped by a signal the wrapper trapped";;
  "")        if [ "$mode" = foreground ]; then
               st="not tracked here — foreground mode; ask the supervisor (docker compose ps -a)"
             elif [ "$sessions" = 0 ]; then
               st="NONE, and no miner running — killed outright (SIGKILL or a reaped container), not an exit"
             else
               st="not written — still running"
             fi;;
esac
echo "exit status    $st"
now=$(tail -1 "$TB_RUNTIME_DIR/tb-mine-$POOL.out" 2>/dev/null | cut -c1-60)
[ -z "$now" ] && [ "$mode" = foreground ] && now="(foreground mode writes no log file — see the miner's own output)"
echo "now on         $now"
