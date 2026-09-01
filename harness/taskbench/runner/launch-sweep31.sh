#!/usr/bin/env bash
# Session-detached launcher for the counted sweep.
#
# The round-3.1 sweep driver disappeared twice mid-trajectory when launched with
# `nohup ... &` from an interactive tool call: no OOM, ample disk, no runner
# failure recorded, stdout simply ending. Elapsed times differed (2h49m, 18m),
# so it is not a timeout. The precise external cause is NOT established -- what
# is demonstrated is that the previous supervision path is unreliable.
#
# This detaches the driver into its own session and process group, so a signal
# delivered to the invoking shell's process group cannot reach it. It changes
# nothing a trajectory sees: same driver, same model, prompt, treatment, oracle,
# budgets and registered ordering.
#
# Cleanly stopping the sweep still works and still cleans up: stop-sweep31.sh
# signals the driver's process GROUP, so the runner, agent, proxy and jail it
# owns go with it. Detachment must not create immortal orphans.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; TB="$(cd "$HERE/.." && pwd)"
PIDFILE="${TB_SWEEP_PIDFILE:-/tmp/tb31-sweep.pid}"
LOG="${TB_SWEEP_LAUNCH_LOG:-/tmp/tb31-sweep-launch.out}"
DRIVER="${TB_SWEEP_DRIVER:-$HERE/phase3-sweep31.sh}"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "REFUSING: a sweep is already running (pid $(cat "$PIDFILE"))" >&2; exit 6
fi
cd "$TB"
setsid bash "$DRIVER" --execute-counted >"$LOG" 2>&1 < /dev/null &
PID=$!
echo "$PID" > "$PIDFILE"
sleep 1
kill -0 "$PID" 2>/dev/null || { echo "LAUNCH FAILED — see $LOG" >&2; rm -f "$PIDFILE"; exit 1; }
echo "sweep detached: pid $PID  sid $(ps -o sid= -p "$PID" | tr -d ' ')  log $LOG  pidfile $PIDFILE"
