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

# ---- already-running: the POOL LOCK is the authority, not a pid file ----------
# A pid file is a report; the flock the miner holds on its pool is the fact. Asking
# the lock cannot be fooled by a stale pid, a recycled pid, or a pid file that was
# never written. The pid file remains for operators and for shutdown targeting.
POOL_LOCK="${TB_POOL_LOCK:-$TB_RUNTIME_DIR/tb-mine5-$POOL.lock}"
LAUNCH_LOCK="$TB_RUNTIME_DIR/tb-launch-$POOL.lock"

# Serialise launches. Two operators racing here could both pass the already-running
# check and both start a miner; the pool lock would then refuse one of them AFTER it
# had already clobbered the other's pid and status files.
exec 9>"$LAUNCH_LOCK" || { echo "REFUSING: cannot open the launcher lock $LAUNCH_LOCK" >&2; exit 6; }
flock -n 9 || { echo "REFUSING: a launch is already in progress for $POOL" >&2; exit 6; }

if [ -e "$POOL_LOCK" ] && ! ( flock -n 8 ) 8<"$POOL_LOCK" 2>/dev/null; then
  echo "REFUSING: mining already running for $POOL (the pool lock is held)" >&2
  [ -s "$PIDFILE" ] && echo "  recorded pid: $(cat "$PIDFILE")" >&2
  exit 6
fi
if [ -e "${TB_CLONE_BREAKER:-$TB_RUNTIME_DIR/tb-clone-breaker}" ]; then
  echo "REFUSING: the clone breaker is tripped; stress-test cloning first." >&2; exit 8
fi
# Only now, holding the launcher lock and knowing no miner owns the pool, is it safe
# to discard the previous run's pid and status.
rm -f "$PIDFILE" "$STATUS"

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

# The wrapper records HOW it ended, not just that it did: a miner that exits writes
# its status, one killed by a signal we can trap records the signal, and a status
# file that never appears at all means SIGKILL or a reaped container — a different
# diagnosis from a crash, and previously indistinguishable.
#
# `--fork` is not optional. setsid only forks when it is already a process-group
# leader, so without it the behaviour is conditional on how the launcher was
# invoked; `$!` was then sometimes the worker and sometimes a process that exited
# at once while the worker ran on under another pid — measured $!=6527, worker 6529.
# The child publishes its OWN pid, written to a temp file and RENAMED into place, so
# a reader never sees a half-written pid file.
setsid --fork bash -c '
  pidfile=$1; status=$2; log=$3; shift 3
  tmp="$pidfile.tmp.$$"
  printf "%s\n" "$$" > "$tmp" || exit 70
  mv -- "$tmp" "$pidfile" || exit 70
  for sig in TERM INT HUP QUIT; do trap "echo signal:$sig > $status; exit 1" "$sig"; done
  "$@" >> "$log" 2>&1
  printf "%s\n" "$?" > "$status"
' _ "$PIDFILE" "$STATUS" "$LOG" "${CMD[@]}" < /dev/null > /dev/null 2>&1 9>&- &
# 9>&- is load-bearing: without it the worker INHERITS the launcher lock and holds
# it for its whole life, so a later launch is refused by the launcher lock instead
# of the pool lock — the authority check would never be reached, and the refusal
# would be right by accident. This is the same fd-inheritance defect the pool lock
# was already fixed for (a descendant outliving the miner keeping the pool locked).

# Wait for the published pid, then VALIDATE it rather than trusting the file. A
# launch that cannot be confirmed is a failed launch: printing "pid unknown" and
# exiting 0 reports a success nobody observed.
for _ in $(seq 1 50); do [ -s "$PIDFILE" ] && break; sleep 0.2; done
MPID=$(tr -dc '0-9' < "$PIDFILE" 2>/dev/null || true)
if [ -z "$MPID" ]; then
  echo "LAUNCH_UNCONFIRMED: no pid was published to $PIDFILE within 10s" >&2
  echo "  check $LOG and the pool lock before retrying" >&2
  exit 5
fi
# Either it is alive AND its own session leader (setsid --fork guarantees that), or
# it has already finished and left a status behind. Anything else is unconfirmed.
SID=$(ps -o sid= -p "$MPID" 2>/dev/null | tr -d ' ')
if [ -n "$SID" ]; then
  [ "$SID" = "$MPID" ] || { echo "LAUNCH_UNCONFIRMED: pid $MPID is not its own session leader (sid=$SID)" >&2; exit 5; }
elif [ ! -s "$STATUS" ]; then
  echo "LAUNCH_UNCONFIRMED: pid $MPID is gone and no status was written" >&2
  echo "  check $LOG before retrying" >&2
  exit 5
fi
echo "launched $POOL (workers=$WORKERS) pid $MPID"
echo "  log    $LOG"
echo "  status $STATUS  (written on exit)"
