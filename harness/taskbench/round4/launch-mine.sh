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
# All runtime state lives under one directory so a separate process — another
# terminal, or a second container sharing a volume — can read it. Defaults to
# /tmp, which is what every existing path was hardcoded to.
TB_RUNTIME_DIR="${TB_RUNTIME_DIR:-/tmp}"; mkdir -p "$TB_RUNTIME_DIR"
POOL="${1:-pilot}"; WORKERS="${2:-1}"
PIDFILE="$TB_RUNTIME_DIR/tb-mine-$POOL.pid"; STATUS="$TB_RUNTIME_DIR/tb-mine-$POOL.status"; LOG="$TB_RUNTIME_DIR/tb-mine-$POOL.out"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "REFUSING: mining already running for $POOL (pid $(cat "$PIDFILE"))" >&2; exit 6
fi
if [ -e "${TB_CLONE_BREAKER:-$TB_RUNTIME_DIR/tb-clone-breaker}" ]; then
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

# The wrapper records HOW it ended, not just that it did. A miner that exits
# writes its status; one killed by a signal we can trap records the signal; and
# a status file that never appears at all means SIGKILL or a reaped container —
# which is a different diagnosis from a crash, and previously indistinguishable.
setsid bash -c '
  S="'"$STATUS"'"
  for sig in TERM INT HUP QUIT; do trap "echo signal:$sig > $S; exit 1" "$sig"; done
  "$@" >> "'"$LOG"'" 2>&1
  echo $? > "$S"
' _ "${CMD[@]}" < /dev/null > /dev/null 2>&1 &
echo $! > "$PIDFILE"
echo "launched $POOL (workers=$WORKERS) pid $(cat "$PIDFILE")"
echo "  log    $LOG"
echo "  status $STATUS  (written on exit)"
