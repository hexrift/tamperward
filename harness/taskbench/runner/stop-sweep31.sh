#!/usr/bin/env bash
# Stop a detached sweep and everything it owns. Detachment must not create
# processes that survive an intentional shutdown.
set -uo pipefail
PIDFILE="${TB_SWEEP_PIDFILE:-/tmp/tb31-sweep.pid}"
[ -f "$PIDFILE" ] || { echo "no pidfile at $PIDFILE"; exit 0; }
PID=$(cat "$PIDFILE")
if kill -0 "$PID" 2>/dev/null; then
  PGID=$(ps -o pgid= -p "$PID" | tr -d ' ')
  kill -TERM -"$PGID" 2>/dev/null
  for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$PID" 2>/dev/null && kill -KILL -"$PGID" 2>/dev/null
  echo "stopped sweep pid $PID (process group $PGID)"
else
  echo "sweep pid $PID was not running"
fi
rm -f "$PIDFILE"
