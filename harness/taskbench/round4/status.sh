#!/usr/bin/env bash
# Round-4 mining status. Detects the miner by its POOL LOCK, not by command line.
#
# Every command-line scheme failed: `pgrep -fc mine5.sh` matched the launcher
# and the inspecting shell; exact-argv counted subshells; and exact-argv broke
# entirely the moment the miner was launched by ABSOLUTE path (`bash /abs/mine5.sh`
# no longer matches `bash ./mine5.sh`), reporting a healthy miner as dead — which
# would make the backstop relaunch and create the very accumulation the check
# exists to prevent. The pool lock is the unambiguous signal: the miner holds it
# (via the flock --close guardian) for its whole lifetime, so "lock held" = a
# miner is running, independent of how it was launched and immune to the observer
# counting itself. Accumulation is now impossible by construction — a second
# miner cannot take the lock — so this reports presence, not a count.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
# All runtime state lives under one directory so a separate process — another
# terminal, or a second container sharing a volume — can read it. Defaults to
# /tmp, which is what every existing path was hardcoded to.
TB_RUNTIME_DIR="${TB_RUNTIME_DIR:-/tmp}"; mkdir -p "$TB_RUNTIME_DIR"
POOL="${1:-pilot}"
P="pools/$POOL"
V='"gate":"(EXCLUDED_INACTIVE|G0_NO_PYPROJECT|G0_NOT_PYTEST|G0_NO_TESTS|NO_QUALIFYING_COMMITS|CLONE_FAILED|REPO_UNAVAILABLE|CANDIDATES_EXHAUSTED|TASK_VALIDATED|QUOTA_FULL)"'
POOL_LOCK="${TB_POOL_LOCK:-$TB_RUNTIME_DIR/tb-mine5-$POOL.lock}"
# Held = a miner is running. We try to take it non-blocking in a subshell; if we
# get it we release it immediately (harmless), if we cannot the miner has it.
if ( flock -n 8 ) 8>"$POOL_LOCK" 2>/dev/null; then miner=0; else miner=1; fi
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
echo "miner          $([ "$miner" = 1 ] && echo "running (pool lock held)" || echo "NOT running (pool lock free)")"
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
  [ "$miner" = 0 ] && note="no miner running: this is when it stopped"
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
             elif [ "$miner" = 0 ]; then
               st="NONE, and no miner running — killed outright (SIGKILL or a reaped container), not an exit"
             else
               st="not written — still running"
             fi;;
esac
echo "exit status    $st"
now=$(tail -1 "$TB_RUNTIME_DIR/tb-mine-$POOL.out" 2>/dev/null | cut -c1-60)
[ -z "$now" ] && [ "$mode" = foreground ] && now="(foreground mode writes no log file — see the miner's own output)"
echo "now on         $now"
