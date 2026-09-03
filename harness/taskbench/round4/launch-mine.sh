#!/usr/bin/env bash
# Committed detached launcher for round-4 mining, with PID and status files.
#
# The claim that mining ran under setsid was previously untrue: the launcher was
# an ad-hoc `nohup ... &` typed at a tool call, which is exactly the supervision
# path round 3.1 recorded as unreliable (runner/launch-sweep31.sh). This puts the
# miner in its own session and process group, records its pid, and records the
# exit status where a check-in can read it.
#
# Usage: ./launch-mine.sh pilot          # sequential, the only pilot mode
#        ./launch-mine.sh counted 3      # sharded, counted pool only
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
POOL="${1:-pilot}"; WORKERS="${2:-1}"
PIDFILE="/tmp/tb-mine-$POOL.pid"; STATUS="/tmp/tb-mine-$POOL.status"; LOG="/tmp/tb-mine-$POOL.out"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "REFUSING: mining already running for $POOL (pid $(cat "$PIDFILE"))" >&2; exit 6
fi
if [ -e "${TB_CLONE_BREAKER:-/tmp/tb-clone-breaker}" ]; then
  echo "REFUSING: the clone breaker is tripped; stress-test cloning first." >&2; exit 8
fi
rm -f "$STATUS"

# The PILOT is never sharded (D4) and never goes through the parallel driver:
# it runs mine5.sh directly, so no shard-shaped configuration can reach it.
if [ "$POOL" = pilot ]; then
  [ "$WORKERS" = 1 ] || { echo "REFUSING: the pilot is sequential; workers must be 1" >&2; exit 3; }
  CMD=(env TB_POOL=pilot TB_PILOT_NEED=10 ./mine5.sh)
else
  CMD=(env TB_POOL="$POOL" ./mine-parallel.sh "$WORKERS")
fi

setsid bash -c '
  "$@" >> "'"$LOG"'" 2>&1
  echo $? > "'"$STATUS"'"
' _ "${CMD[@]}" < /dev/null > /dev/null 2>&1 &
echo $! > "$PIDFILE"
echo "launched $POOL (workers=$WORKERS) pid $(cat "$PIDFILE")"
echo "  log    $LOG"
echo "  status $STATUS  (written on exit)"
