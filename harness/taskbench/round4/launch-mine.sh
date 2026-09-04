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

# Argument validation runs FIRST, before any state is read or written, so that a
# refusal and a dry run are both side-effect free. TB_DRY_RUN used to be checked
# after `rm -f "$STATUS"`, which meant asking what WOULD run deleted the real
# status file of the pool.
if [ "$POOL" = pilot ]; then
  [ "$WORKERS" = 1 ] || { echo "REFUSING: the pilot is sequential; workers must be 1" >&2; exit 3; }
  NEED="${TB_PILOT_NEED:-10}"
  case "$NEED" in ''|*[!0-9]*) echo "REFUSING: TB_PILOT_NEED must be a whole number, got '$NEED'" >&2; exit 4;; esac
  if [ "$NEED" -lt 1 ] || [ "$NEED" -gt 20 ]; then
    echo "REFUSING: TB_PILOT_NEED=$NEED is outside the sacrificial bound 1..20" >&2; exit 4
  fi
fi
if [ "${TB_DRY_RUN:-0}" = 1 ]; then
  echo "DRY_RUN pool=$POOL workers=$WORKERS${NEED:+ need=$NEED}"; exit 0
fi

if [ -f "$PIDFILE" ]; then
  if kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
    echo "REFUSING: mining already running for $POOL (pid $(cat "$PIDFILE"))" >&2; exit 6
  fi
  # A pid file left by a miner that died is not "already running", and leaving it
  # in place let the wait loop below accept the STALE pid immediately and report it
  # as the new launch. Clear it once its process is gone.
  rm -f "$PIDFILE"
fi
if [ -e "${TB_CLONE_BREAKER:-$TB_RUNTIME_DIR/tb-clone-breaker}" ]; then
  echo "REFUSING: the clone breaker is tripped; stress-test cloning first." >&2; exit 8
fi
rm -f "$STATUS"

# The PILOT is never sharded (D4) and never goes through the parallel driver:
# it runs mine5.sh directly, so no shard-shaped configuration can reach it.
if [ "$POOL" = pilot ]; then
  # NEED was validated above, before any state was touched. The guard itself is
  # unchanged: default 10, whole number, 1..20 — the same bound mine5.sh enforces
  # when it refuses more than 20 on a sacrificial pool, so the two cannot drift.
  CMD=(env TB_POOL=pilot TB_PILOT_NEED="$NEED" ./mine5.sh)
else
  CMD=(env TB_POOL="$POOL" ./mine-parallel.sh "$WORKERS")
fi

# The wrapper records HOW it ended, not just that it did. A miner that exits
# writes its status; one killed by a signal we can trap records the signal; and
# a status file that never appears at all means SIGKILL or a reaped container —
# which is a different diagnosis from a crash, and previously indistinguishable.
# The supervised child records its OWN pid. `$!` is the pid of the process this
# shell forked, but setsid FORKS AGAIN whenever it is already a process-group
# leader, so `$!` is then a process that exits immediately while the real worker
# runs on under a different pid — measured here as $!=6527 with the worker at 6529.
# That made the PID file unreliable, and with it the "already running" refusal
# above: `kill -0` on a dead pid reports not-running, so a second miner could be
# launched onto the same pool — the shape D3 is best explained by. The flock pool
# lock is what actually prevented that; this makes the recorded pid honest too.
setsid bash -c '
  echo $$ > "'"$PIDFILE"'"
  S="'"$STATUS"'"
  for sig in TERM INT HUP QUIT; do trap "echo signal:$sig > $S; exit 1" "$sig"; done
  "$@" >> "'"$LOG"'" 2>&1
  echo $? > "$S"
' _ "${CMD[@]}" < /dev/null > /dev/null 2>&1 &
# The child writes it; wait rather than reporting a pid we never observed. If it
# never appears the launch did NOT demonstrably start, and saying "pid unknown"
# while exiting 0 would report a success nobody confirmed — so that is a failure.
for _ in $(seq 1 50); do [ -s "$PIDFILE" ] && break; sleep 0.2; done
MPID=$(cat "$PIDFILE" 2>/dev/null || true)
if [ -z "$MPID" ] || ! kill -0 "$MPID" 2>/dev/null; then
  echo "LAUNCH_UNCONFIRMED: no live child pid appeared in $PIDFILE within 10s" >&2
  echo "  the miner may or may not be running; check $LOG and the pool lock before retrying" >&2
  exit 5
fi
echo "launched $POOL (workers=$WORKERS) pid $MPID"
echo "  log    $LOG"
echo "  status $STATUS  (written on exit)"
