#!/usr/bin/env bash
# Round-4 PILOT DRIVER — executes the frozen manifest, in its order, and records
# what actually happened.
#
# The manifest froze the order. Nothing enforced it: an operator could run the
# trajectories in any sequence, or twice, and the frozen document would still
# read as satisfied. A registration nobody executes against is a description, not
# a registration — so this driver is the thing that makes the freeze binding.
#
# It does four jobs and refuses to do anything else:
#
#   1. It will not start unless `freeze-pilot-manifest.mjs --check` passes, so a
#      tree that has drifted from its registration cannot produce a trajectory.
#   2. It runs trajectories STRICTLY in frozen `seq` order. The next trajectory
#      is the lowest seq with no verdict; if any lower seq is unresolved the
#      driver halts rather than skipping past it.
#   3. It never re-rolls. A trajectory that STARTED has a scientific outcome
#      whether or not it produced a verdict, so an unresolved start marker halts
#      the driver for human adjudication instead of being quietly retried.
#   4. It records every attempt — seq, task, arm, wall time, exit status, and the
#      manifest hash it ran under — to an append-only log, which is also what
#      yields the round-4 ARM-SPECIFIC timing estimate the counted round needs.
#      Round 3.1's 5.8-minute mean predates the envelope; the gated arm may cost
#      more, and only a real run can say by how much.
#
#   ./pilot-drive.sh --check     validate manifest, state and order. Runs nothing.
#   ./pilot-drive.sh --status    what has run, what is next, per-arm timings
#   ./pilot-drive.sh --next      run exactly ONE trajectory: the next in order
#   ./pilot-drive.sh --all       run trajectories in order until done or halted
#
# Exit codes:
#   0  did what was asked
#   2  the manifest no longer describes this tree (freeze check failed)
#   3  HALTED — an unresolved trajectory needs human adjudication
#   4  a trajectory failed; nothing further was attempted
#   5  usage / structural error
#   6  another driver holds the lock
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TB="$(cd "$HERE/.." && pwd)"
. "$TB/runner/verdict-record.sh"

MODE="${1:-}"
case "$MODE" in --check|--status|--next|--all|--acknowledge-drift) ;; *)
  sed -n '3,30p' "$0" | sed 's|^# \{0,1\}||'; exit 5 ;;
esac

MANIFEST="${TB_PILOT_MANIFEST:-$HERE/PILOT-EXECUTION-MANIFEST.json}"
RUNS="${TB_PILOT_RUNS:-$HERE/runs-pilot}"
RUNNER="${TB_PILOT_RUNNER:-$TB/runner/run-task4.sh}"
LOG="$RUNS/pilot-execution-log.jsonl"

[ -s "$MANIFEST" ] || { echo "no frozen manifest at $MANIFEST" >&2; exit 5; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 5; }

# ---- 1. the freeze gate, fail-closed -----------------------------------------
# Deliberately NOT skippable. A driver that can be told to ignore the freeze check
# is a driver that will be told to ignore it, at 2am, once.
#
# But "refuse everything non-zero" was too blunt: the checker distinguishes
# BINDING drift (2) from ENVIRONMENT drift (3), and collapsing them left exit 3 —
# the case the checker explicitly says to record and proceed from — with no way to
# proceed. Environment drift is now acknowledgeable, ONCE, against the exact drift
# it describes; binding drift never is.
ACK="$RUNS/environment-drift.acknowledged"
freeze_check() { FREEZE_OUT=$(node "$HERE/freeze-pilot-manifest.mjs" --check 2>&1); FREEZE_RC=$?; }
drift_fp() { printf %s "$FREEZE_OUT" | sed -n 's/^  environment drift fingerprint: //p'; }

# `where` names the moment for the message: a refusal before trajectory one and a
# refusal between trajectories are the same check but very different situations.
gate_or_die() {
  local where="$1"
  freeze_check
  case "$FREEZE_RC" in
    0) return 0 ;;
    3)
      local fp; fp=$(drift_fp)
      if [ -n "$fp" ] && [ -f "$ACK" ] && grep -qxF "fingerprint:$fp" "$ACK"; then
        echo "environment drift acknowledged ($where): ${fp:0:12}"
        return 0
      fi
      echo "$FREEZE_OUT"
      echo
      echo "REFUSING ($where): the environment differs from the freeze and that difference" >&2
      echo "is not acknowledged. Review the drift above, then record it with:" >&2
      echo "    $0 --acknowledge-drift" >&2
      exit 2 ;;
    *)
      echo "$FREEZE_OUT"
      echo
      echo "REFUSING ($where): the frozen manifest does not describe this tree. Resolve the" >&2
      echo "drift (or re-freeze deliberately and record why) before running any trajectory." >&2
      exit 2 ;;
  esac
}
# --acknowledge-drift must NOT go through the startup gate: it exists precisely to
# resolve a refusal, and gating it behind that refusal makes the drift
# unacknowledgeable — a dead end dressed as a safeguard. It runs its own check,
# and refuses anything that is not environment drift.
[ "$MODE" = --acknowledge-drift ] || gate_or_die "startup"
MANIFEST_SHA=$(sha256sum "$MANIFEST" | cut -d' ' -f1)
# The registered model comes FROM the manifest. Typing it anywhere else would
# create a second source for a registered value.
MODEL=$(jq -r '.registration.model' "$MANIFEST")
[ -n "$MODEL" ] && [ "$MODEL" != null ] || { echo "manifest names no registered model" >&2; exit 5; }

# ---- state -------------------------------------------------------------------
mkdir -p "$RUNS"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
row()      { jq -r ".execution.trajectories[] | select(.seq==$1) | \"\(.task) \(.arm)\"" "$MANIFEST"; }
total()    { jq -r '.execution.trajectory_count' "$MANIFEST"; }
have()     { is_verdict_file "$(verdict_path "$RUNS" "$1" "$2")" "$1" "$2"; }
started()  { [ -f "$RUNS/${1}-${2}.started" ]; }
# An operator resolves a started-but-verdictless trajectory by recording the
# disposition here; the driver then moves past it. Nothing the driver itself
# writes can create one — that is the point.
resolved() { [ -f "$RUNS/${1}-${2}.adjudicated" ]; }

TOTAL=$(total)
[ "$TOTAL" -ge 1 ] 2>/dev/null || { echo "manifest declares no trajectories" >&2; exit 5; }

# The next trajectory is the lowest unfinished seq — and everything below it must
# be finished. Scanning for "the first gap" rather than "the first unfinished"
# is what makes out-of-order execution impossible rather than merely discouraged.
next_seq=""
halt_seq=""
for s in $(seq 1 "$TOTAL"); do
  read -r task arm <<<"$(row "$s")"
  [ -n "$task" ] || { echo "manifest row $s is malformed" >&2; exit 5; }
  if have "$task" "$arm"; then continue; fi
  if resolved "$task" "$arm"; then continue; fi
  if started "$task" "$arm"; then halt_seq="$s"; break; fi
  next_seq="$s"; break
done

summary() {
  local done=0 s task arm
  for s in $(seq 1 "$TOTAL"); do
    read -r task arm <<<"$(row "$s")"
    { have "$task" "$arm" || resolved "$task" "$arm"; } && done=$((done+1))
  done
  echo "manifest      $MANIFEST"
  echo "  sha256      $MANIFEST_SHA"
  echo "  runs        $RUNS"
  echo "  complete    $done of $TOTAL"
  if [ -n "$halt_seq" ]; then
    read -r task arm <<<"$(row "$halt_seq")"
    echo "  HALTED      seq $halt_seq ($task / $arm) started but has no verdict"
  elif [ -n "$next_seq" ]; then
    read -r task arm <<<"$(row "$next_seq")"
    echo "  next        seq $next_seq ($task / $arm)"
  else
    echo "  next        none — every trajectory is accounted for"
  fi
  # The arm-specific estimate. Reported as measured, with n, because two
  # trajectories per arm is not a timing estimate and should not be read as one.
  if [ -s "$LOG" ]; then
    echo "  timings (completed attempts, by arm):"
    jq -rs '
      map(select(.event=="finished" and .rc==0))
      | group_by(.arm)[]
      | "    \(.[0].arm)  n=\(length)  mean=\((map(.elapsed_s)|add/length)|floor)s  max=\(map(.elapsed_s)|max)s"
    ' "$LOG" 2>/dev/null || true
  fi
}

if [ "$MODE" = --acknowledge-drift ]; then
  # Only ENVIRONMENT drift is acknowledgeable, and only the drift actually
  # present: the record names the exact fingerprint, so tomorrow's different
  # drift is not silently covered by today's acknowledgement.
  freeze_check
  case "$FREEZE_RC" in
    0) echo "there is no drift to acknowledge — the manifest describes this tree exactly"; exit 0 ;;
    3) : ;;
    *) echo "$FREEZE_OUT"; echo; echo "REFUSING: this is not environment drift. Binding drift is never acknowledged — fix it or re-freeze deliberately." >&2; exit 2 ;;
  esac
  fp=$(drift_fp)
  [ -n "$fp" ] || { echo "the checker reported drift but no fingerprint; refusing to record a blank acknowledgement" >&2; exit 5; }
  { echo "# environment drift acknowledged for the round-4 pilot"
    echo "# recorded $(ts) against manifest $MANIFEST_SHA"
    echo "# this acknowledgement covers EXACTLY the drift below and no other"
    printf '%s\n' "$FREEZE_OUT" | sed -n 's/^  /# /p'
    echo "fingerprint:$fp"; } >> "$ACK"
  echo "recorded in $ACK"
  echo "  fingerprint: $fp"
  echo "Also record it in DEVIATIONS.md — this file lets the driver proceed; the ledger is the scientific record."
  exit 0
fi

if [ "$MODE" = --status ]; then summary; exit 0; fi

if [ "$MODE" = --check ]; then
  summary
  echo
  if [ -n "$halt_seq" ]; then
    echo "RESULT: HALTED — adjudicate the started trajectory before continuing."
    exit 3
  fi
  echo "RESULT: manifest, state and order are consistent."
  exit 0
fi

# ---- 2. one driver at a time -------------------------------------------------
# have()/started() are read-then-act, so two drivers would both see "no verdict"
# for the same seq and both launch it.
exec 9>"$RUNS/.driver.lock"
flock -n 9 || { echo "another driver holds $RUNS/.driver.lock" >&2; exit 6; }

[ -n "$halt_seq" ] && { summary; echo; echo "HALTED: seq $halt_seq started and has no verdict. A trajectory that started has an outcome; it is never re-rolled. Adjudicate it and record the disposition, then resume." >&2; exit 3; }
[ -n "$next_seq" ] || { summary; echo; echo "nothing to do — every trajectory is accounted for"; exit 0; }

log() { jq -nc "$@" >> "$LOG"; }

run_one() {
  local s="$1" task arm t0 t1 rc
  read -r task arm <<<"$(row "$s")"
  # Re-assert the WHOLE binding set immediately before launching, not just the
  # manifest's own hash. Hashing only the manifest caught an edited manifest and
  # missed the case that matters more: policy3.yml, verdict4.mjs or run-task4.sh
  # changing after trajectory one, with the manifest untouched, so every later
  # trajectory ran against a different instrument under the same registration.
  local sha_now; sha_now=$(sha256sum "$MANIFEST" | cut -d' ' -f1)
  [ "$sha_now" = "$MANIFEST_SHA" ] || {
    echo "REFUSING: the manifest changed under the driver ($MANIFEST_SHA -> $sha_now)" >&2; return 2; }
  gate_or_die "before seq $s"

  echo "== seq $s/$TOTAL  $task  $arm"
  t0=$(date +%s)
  log --arg ev started --arg ts "$(ts)" --argjson seq "$s" --arg task "$task" \
      --arg arm "$arm" --arg manifest_sha256 "$MANIFEST_SHA" \
      '{event:$ev,ts:$ts,seq:$seq,task:$task,arm:$arm,manifest_sha256:$manifest_sha256}'

  # Registered mode is ESTABLISHED here, not asserted. TB_RUNTASK4_READY means
  # "the freeze checklist passed and a credential is provisioned": the binding
  # check above is that checklist, and run-task4.sh refuses on its own if no
  # credential is present. The registered model and the frozen row travel with the
  # trajectory so the runner can bind itself to the manifest rather than trusting
  # the caller's word for which row this is.
  TB_RUNS="$RUNS" \
  TB_RUNTASK4_READY=1 \
  TB_REGISTERED_MODEL="$MODEL" \
  TB_PILOT_MANIFEST="$MANIFEST" \
  TB_PILOT_MANIFEST_SHA256="$MANIFEST_SHA" \
  TB_PILOT_SEQ="$s" \
    bash "$RUNNER" "$task" "$arm"
  rc=$?
  t1=$(date +%s)

  local got=no; have "$task" "$arm" && got=yes
  log --arg ev finished --arg ts "$(ts)" --argjson seq "$s" --arg task "$task" \
      --arg arm "$arm" --argjson rc "$rc" --argjson elapsed_s "$((t1-t0))" \
      --arg verdict "$got" --arg manifest_sha256 "$MANIFEST_SHA" \
      '{event:$ev,ts:$ts,seq:$seq,task:$task,arm:$arm,rc:$rc,elapsed_s:$elapsed_s,verdict:$verdict,manifest_sha256:$manifest_sha256}'

  if [ "$rc" != 0 ]; then echo "seq $s exited $rc" >&2; return 4; fi
  if [ "$got" != yes ]; then echo "seq $s exited 0 but produced no verdict" >&2; return 4; fi
  return 0
}

if [ "$MODE" = --next ]; then
  run_one "$next_seq"; rc=$?; [ "$rc" = 0 ] && summary; exit $rc
fi

# --all: strictly in order, stopping at the first thing that is not a clean pass.
while [ -n "$next_seq" ]; do
  run_one "$next_seq" || exit $?
  prev="$next_seq"; next_seq=""
  for s in $(seq $((prev+1)) "$TOTAL"); do
    read -r task arm <<<"$(row "$s")"
    if have "$task" "$arm" || resolved "$task" "$arm"; then continue; fi
    if started "$task" "$arm"; then
      summary; echo; echo "HALTED: seq $s started and has no verdict." >&2; exit 3
    fi
    next_seq="$s"; break
  done
done
summary
