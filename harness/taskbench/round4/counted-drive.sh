#!/usr/bin/env bash
# Round-4 COUNTED DRIVER — executes the frozen COUNTED manifest, in its order, and
# records what actually happened. It is the faithful counted analog of
# pilot-drive.sh (read that first): the counted round reuses the identical runner
# (run-task4.sh) and the identical verdict predicate (verdict-record.sh); the ONE
# thing it adds is the order-enforcing execution driver for the 264-trajectory
# counted manifest (110×2 primary + 22×2 duplicate).
#
# The manifest froze the order. Nothing enforced it: an operator could run the
# trajectories in any sequence, or twice, and the frozen document would still read
# as satisfied. A registration nobody executes against is a description, not a
# registration — so this driver is the thing that makes the counted freeze binding.
#
# It is a BORING EXECUTOR. It chooses nothing. Every decision — which tasks, which
# 22 duplicates, the task order, the arm order, the model, the treatment — was
# frozen in COUNTED-EXECUTION-MANIFEST.json and is re-verified from its own seeds
# by `freeze-counted-manifest.mjs --check` before a single trajectory runs. The
# driver only:
#
#   1. refuses to start unless `freeze-counted-manifest.mjs --check` passes AND the
#      manifest is `execution_ready` (a counted driver is pinned into the binding
#      set). A tree that has drifted from its registration cannot produce a
#      trajectory.
#   2. derives exactly the manifest's 264 immutable trajectory identities and runs
#      them STRICTLY in frozen `seq` order (primary seq 1..220, then the duplicate
#      instability budget seq 221..264). The next trajectory is the lowest seq with
#      no verdict; if any lower seq is unresolved the driver halts rather than
#      skipping past it. There is no way to name a seq, choose a duplicate, flip an
#      arm, or substitute a task — the manifest is the only source.
#   3. never re-rolls. A trajectory that STARTED has a scientific outcome whether or
#      not it produced a verdict, so an unresolved start marker HALTS the driver for
#      human adjudication instead of being quietly retried. NO registered retry /
#      recovery rule exists for the counted round (checked: PREDICTION4-taskbench.md
#      and DEVIATIONS.md register none), so the driver FAILS CLOSED on every rerun.
#   4. records every attempt — seq, task, arm, duplicate flag, wall time, exit
#      status, the COUNTED manifest hash and the runner-view hash it ran under — to
#      an append-only log, and keeps each trajectory's raw/immutable evidence in its
#      OWN per-seq directory so a duplicate never overwrites its primary twin.
#
#   ./counted-drive.sh --check     validate manifest, state and order. Runs nothing.
#   ./counted-drive.sh --status    what has run, what is next, per-arm timings
#   ./counted-drive.sh --next      run exactly ONE trajectory: the next in order
#   ./counted-drive.sh --all       run trajectories in order until done or halted
#
# Exit codes (mirror pilot-drive.sh):
#   0  did what was asked
#   2  the manifest no longer describes this tree, or state/evidence disagree with it
#   3  HALTED — an unresolved (started, verdictless) trajectory needs adjudication
#   4  a trajectory failed; nothing further was attempted
#   5  usage / structural error
#   6  another driver holds the lock
#
# The EXECUTION is credential-gated (run-task4.sh refuses a registered trajectory
# without a provisioned credential), but this driver's IMPLEMENTATION and TESTS are
# credential-free: the self-test drives it with a stub runner (selftest.sh), exactly
# as pilot-drive.sh is tested. The real Claude credential is needed only when the
# frozen driver actually launches trajectory 1.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TB="$(cd "$HERE/.." && pwd)"
. "$TB/runner/verdict-record.sh"

MODE="${1:-}"
case "$MODE" in --check|--status|--next|--all|--acknowledge-drift) ;; *)
  sed -n '3,53p' "$0" | sed 's|^# \{0,1\}||'; exit 5 ;;
esac

MANIFEST="${TB_COUNTED_MANIFEST:-$HERE/COUNTED-EXECUTION-MANIFEST.json}"
RUNS="${TB_COUNTED_RUNS:-$HERE/runs-counted}"
RUNNER="${TB_COUNTED_RUNNER:-$TB/runner/run-task4.sh}"
# The counted task pool. run-task4.sh reads <pool>/<id>/manifest.json etc.
RUNNER_TASKS="${TB_COUNTED_TASKS:-$HERE/pools/counted/tasks}"
LOG="$RUNS/counted-execution-log.jsonl"
FREEZE="$HERE/freeze-counted-manifest.mjs"

[ -s "$MANIFEST" ] || { echo "no frozen counted manifest at $MANIFEST" >&2; exit 5; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 5; }
[ -s "$FREEZE" ] || { echo "no freeze-counted-manifest.mjs at $FREEZE" >&2; exit 5; }

# ---- 1. the freeze gate, fail-closed -----------------------------------------
# Deliberately NOT skippable, exactly as in the pilot: a driver that can be told to
# ignore the freeze check is a driver that will be told to ignore it, at 2am, once.
# The counted checker (like the pilot one) distinguishes BINDING drift (2) from
# ENVIRONMENT drift (3) from an unverifiable treatment (4). Environment drift is
# acknowledgeable, ONCE, against the exact drift it names; binding drift never is.
#
# The checker is pointed at the SAME manifest the driver drives (TB_COUNTED_MANIFEST
# below). It re-derives the whole document from the manifest's own seeds and the
# on-disk pool, so a hand-edited order, a hand-picked duplicate set, a flipped arm,
# a rewritten task/runner/DRIVER hash, or a swapped treatment is caught here.
ACK="$RUNS/environment-drift.acknowledged"
freeze_check() {
  FREEZE_OUT=$(TB_COUNTED_MANIFEST="$MANIFEST" node "$FREEZE" --check 2>&1); FREEZE_RC=$?
}
drift_fp() { printf %s "$FREEZE_OUT" | sed -n 's/^  environment drift fingerprint: //p'; }

gate_or_die() {
  local where="$1"
  freeze_check
  case "$FREEZE_RC" in
    0) ;;
    3)
      local fp; fp=$(drift_fp)
      if [ -n "$fp" ] && [ -f "$ACK" ] && grep -qxF "fingerprint:$fp" "$ACK"; then
        echo "environment drift acknowledged ($where): ${fp:0:12}"
      else
        echo "$FREEZE_OUT"
        echo
        echo "REFUSING ($where): the environment differs from the freeze and that difference" >&2
        echo "is not acknowledged. Review the drift above, then record it with:" >&2
        echo "    $0 --acknowledge-drift" >&2
        exit 2
      fi ;;
    *)
      echo "$FREEZE_OUT"
      echo
      echo "REFUSING ($where): the frozen counted manifest does not describe this tree (or its" >&2
      echo "treatment could not be verified). Resolve the drift (or re-freeze deliberately and" >&2
      echo "record why in DEVIATIONS.md) before running any counted trajectory." >&2
      exit 2 ;;
  esac
  # A counted trajectory may NEVER run against a manifest that is not execution-ready
  # — one with no order-enforcing driver pinned into its binding set. `--check`
  # already catches a frozen execution_ready:false because the on-disk driver then
  # contradicts the frozen `counted_driver:null` (binding drift); this is the
  # explicit, self-describing refusal for the same fact.
  local er; er=$(jq -r '.execution_ready' "$MANIFEST" 2>/dev/null)
  [ "$er" = true ] || {
    echo "REFUSING ($where): the frozen manifest is not execution_ready (execution_ready=$er)." >&2
    echo "No counted trajectory may run until a counted driver is pinned into the binding set." >&2
    exit 2; }
}

# --acknowledge-drift must NOT go through the startup gate: it exists precisely to
# resolve a refusal (mirrors the pilot).
[ "$MODE" = --acknowledge-drift ] || gate_or_die "startup"

MANIFEST_SHA=$(sha256sum "$MANIFEST" | cut -d' ' -f1)
# The registered model comes FROM the manifest — never typed a second time.
MODEL=$(jq -r '.registration.model' "$MANIFEST")
[ -n "$MODEL" ] && [ "$MODEL" != null ] || { echo "manifest names no registered model" >&2; exit 5; }

# ---- 2. scale invariants — this IS the counted manifest, not merely A manifest --
# Consistency (always): the execution block must follow from the registration's own
# N and duplicate budget, so a mangled count cannot slip past. Plus the frozen
# ABSOLUTE scale of the counted round (N=110, 22 duplicates, 264 trajectories) on
# the real registration — a validly-frozen but wrong-scale manifest (e.g. a shrunk
# self-test fixture) is refused as not-the-counted-round. The absolute check is
# scoped to the real registration: `freeze-counted-manifest.mjs` REFUSES the
# TB_COUNTED_FREEZE_TEST seam against the real manifest path, so the seam cannot be
# used to smuggle a wrong-scale manifest into a real run — if it is set at all, the
# gate above has already failed on the real path.
NP=$(jq -r '.registration.n_primary' "$MANIFEST")
ND=$(jq -r '.registration.n_duplicates' "$MANIFEST")
TOTAL=$(jq -r '.execution.trajectory_count' "$MANIFEST")
PRIMN=$(jq -r '.execution.primary.trajectory_count' "$MANIFEST")
DUPN=$(jq -r '.execution.duplicates.trajectory_count' "$MANIFEST")
DUPIDS=$(jq -r '.execution.duplicates.task_ids | length' "$MANIFEST")
POOLN=$(jq -r '.pool.task_count' "$MANIFEST")
case "$NP$ND" in *[!0-9]*) echo "manifest registration N is not numeric" >&2; exit 5 ;; esac
consistent() {
  [ "$TOTAL"  = "$(( (NP + ND) * 2 ))" ] &&
  [ "$PRIMN"  = "$(( NP * 2 ))" ] &&
  [ "$DUPN"   = "$(( ND * 2 ))" ] &&
  [ "$DUPIDS" = "$ND" ] &&
  [ "$POOLN"  = "$NP" ]
}
consistent || { echo "REFUSING: the execution block does not follow from the registration (N=$NP dup=$ND total=$TOTAL primary=$PRIMN dupTraj=$DUPN dupIds=$DUPIDS pool=$POOLN)" >&2; exit 2; }
if [ -z "${TB_COUNTED_FREEZE_TEST:-}" ]; then
  { [ "$NP" = 110 ] && [ "$ND" = 22 ] && [ "$TOTAL" = 264 ]; } || {
    echo "REFUSING: this is not the frozen counted round (N=$NP duplicates=$ND trajectories=$TOTAL; expected 110 / 22 / 264)" >&2; exit 2; }
fi
[ "$TOTAL" -ge 1 ] 2>/dev/null || { echo "manifest declares no trajectories" >&2; exit 5; }

# ---- the base harness commit the manifest is frozen against ------------------
# The counted round runs on a tree that descends from the registered base commit.
# An answerable "no" (the commit exists and is not an ancestor of HEAD) is drift; an
# unanswerable question (a shallow clone with no history) is UNVERIFIABLE, recorded,
# not treated as drift — mirroring the pilot freeze checker's ancestry handling.
BASE_COMMIT=$(jq -r '.registration.base_commit' "$MANIFEST")
if [ -n "$BASE_COMMIT" ] && [ "$BASE_COMMIT" != null ]; then
  if git -C "$HERE" cat-file -e "$BASE_COMMIT^{commit}" 2>/dev/null; then
    git -C "$HERE" merge-base --is-ancestor "$BASE_COMMIT" HEAD 2>/dev/null || {
      echo "REFUSING: registered base commit ${BASE_COMMIT:0:12} is not an ancestor of HEAD" >&2; exit 2; }
  elif [ "$(git -C "$HERE" rev-parse --is-shallow-repository 2>/dev/null)" = true ]; then
    echo "note: base commit ancestry UNVERIFIABLE — shallow clone (recorded, not drift)"
  else
    echo "REFUSING: registered base commit ${BASE_COMMIT:0:12} does not exist in this repository" >&2; exit 2
  fi
fi

# ---- state -------------------------------------------------------------------
mkdir -p "$RUNS"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
pad() { printf '%03d' "$1"; }
seqdir() { printf '%s/seq-%s' "$RUNS" "$(pad "$1")"; }
# The flattened 264-row view of the frozen execution block: primary rows (their
# seq 1..220) followed by the duplicate rows (their seq 221..264). This is the
# single source the driver enumerates, and — projected per row — the shape the
# runner consumes (see build_runner_view).
row() {
  jq -r --argjson s "$1" \
    '([.execution.primary.trajectories[], .execution.duplicates.trajectories[]]
      | .[] | select(.seq==$s)) | "\(.task) \(.arm)"' "$MANIFEST"
}
is_dup() {
  local d; d=$(jq -r --argjson s "$1" \
    '([.execution.primary.trajectories[], .execution.duplicates.trajectories[]]
      | .[] | select(.seq==$s)) | (.duplicate // false)' "$MANIFEST")
  [ "$d" = true ]
}
have()     { is_verdict_file "$(verdict_path "$(seqdir "$1")" "$2" "$3")" "$2" "$3"; }
started()  { [ -f "$(seqdir "$1")/${2}-${3}.started" ]; }
# An operator resolves a started-but-verdictless trajectory by recording the
# disposition here; the driver then moves past it. Nothing the driver writes can
# create one — that is the point (there is no registered retry rule, so a rerun is
# a HUMAN act, recorded as adjudication, never a fresh stochastic draw).
resolved() { [ -f "$(seqdir "$1")/${2}-${3}.adjudicated" ]; }

# ---- checkpoint / resume agreement -------------------------------------------
# On every invocation, before anything runs: the set of COMPLETED trajectory ids,
# the on-disk EVIDENCE, the append-only LOG, and the current COUNTED MANIFEST HASH
# must all agree. Any disagreement is a refusal, not a repair.
#
#   * a verdict on disk with no matching finished-event under the current manifest
#     hash (or a finished event carrying a DIFFERENT manifest hash) means the
#     manifest changed under a completed run — refuse;
#   * a per-seq evidence directory holding a verdict for a seq outside 1..TOTAL, or
#     a verdict whose (task,arm) is not the frozen row for that seq, is evidence
#     for a trajectory this manifest never registered (a 265th, an unknown one, or a
#     substituted task/arm) — refuse.
verify_state() {
  local s task arm sd want vf n idx
  # finished-event index (seq -> manifest_sha) for the CURRENT manifest hash only.
  local finished_here=" "
  if [ -s "$LOG" ]; then
    finished_here=" $(jq -rs --arg m "$MANIFEST_SHA" \
      'map(select(.event=="finished" and .manifest_sha256==$m and .verdict=="yes") | .seq) | unique | .[]' \
      "$LOG" 2>/dev/null | tr '\n' ' ') "
  fi
  for s in $(seq 1 "$TOTAL"); do
    read -r task arm <<<"$(row "$s")"
    [ -n "$task" ] || { echo "REFUSING: manifest row $s is malformed" >&2; exit 2; }
    sd="$(seqdir "$s")"
    if have "$s" "$task" "$arm"; then
      case "$finished_here" in
        *" $s "*) : ;;
        *) echo "REFUSING: seq $s has a verdict on disk but no finished-event under the current manifest hash ${MANIFEST_SHA:0:12} — the evidence and the manifest do not agree" >&2; exit 2 ;;
      esac
    fi
    # only the frozen row's own verdict file may live in this seq's directory.
    if [ -d "$sd" ]; then
      want="${task}-${arm}.verdict.json"
      for vf in "$sd"/*.verdict.json; do
        [ -e "$vf" ] || continue
        [ "$(basename "$vf")" = "$want" ] || {
          echo "REFUSING: seq $s carries a verdict '$(basename "$vf")' that is not its frozen row ($task/$arm) — a substituted task or arm" >&2; exit 2; }
      done
    fi
  done
  # evidence for a trajectory OUTSIDE the manifest (a 265th, or an unknown seq).
  for sd in "$RUNS"/seq-*; do
    [ -d "$sd" ] || continue
    idx=$(basename "$sd"); idx=${idx#seq-}
    case "$idx" in ''|*[!0-9]*) continue ;; esac
    n=$((10#$idx))
    if [ "$n" -lt 1 ] || [ "$n" -gt "$TOTAL" ]; then
      for vf in "$sd"/*.verdict.json; do
        [ -e "$vf" ] || continue
        echo "REFUSING: $sd holds a verdict for seq $n, which is outside the manifest's 1..$TOTAL — the driver derives exactly $TOTAL identities and no other" >&2; exit 2
      done
    fi
  done
}
verify_state

# The next trajectory is the lowest unfinished seq — and everything below it must be
# finished. Scanning for "the first gap" rather than "the first unfinished" is what
# makes out-of-order execution impossible rather than merely discouraged.
next_seq=""
halt_seq=""
for s in $(seq 1 "$TOTAL"); do
  read -r task arm <<<"$(row "$s")"
  if have "$s" "$task" "$arm"; then continue; fi
  if resolved "$s" "$task" "$arm"; then continue; fi
  if started "$s" "$task" "$arm"; then halt_seq="$s"; break; fi
  next_seq="$s"; break
done

summary() {
  local done=0 s task arm dupdone=0
  for s in $(seq 1 "$TOTAL"); do
    read -r task arm <<<"$(row "$s")"
    if have "$s" "$task" "$arm" || resolved "$s" "$task" "$arm"; then
      done=$((done+1)); is_dup "$s" && dupdone=$((dupdone+1))
    fi
  done
  echo "counted manifest   $MANIFEST"
  echo "  sha256           $MANIFEST_SHA"
  echo "  runs             $RUNS"
  echo "  scale            N=$NP  duplicates=$ND  trajectories=$TOTAL (primary $PRIMN + duplicate $DUPN)"
  echo "  complete         $done of $TOTAL  (duplicate budget: $dupdone of $DUPN)"
  if [ -n "$halt_seq" ]; then
    read -r task arm <<<"$(row "$halt_seq")"
    echo "  HALTED           seq $halt_seq ($task / $arm)$(is_dup "$halt_seq" && echo ' [dup]') started but has no verdict"
  elif [ -n "$next_seq" ]; then
    read -r task arm <<<"$(row "$next_seq")"
    echo "  next             seq $next_seq ($task / $arm)$(is_dup "$next_seq" && echo ' [dup]')"
  else
    echo "  next             none — every trajectory is accounted for"
  fi
  # The arm-specific timing, reported as measured, with n. Primary and duplicate
  # attempts are separated so the duplicate instability budget is never pooled into
  # the primary timing.
  if [ -s "$LOG" ]; then
    echo "  timings (completed attempts, by arm):"
    jq -rs '
      map(select(.event=="finished" and .rc==0))
      | group_by([.arm, (.duplicate // false)])[]
      | "    \(.[0].arm)\(if .[0].duplicate then " [dup]" else "" end)  n=\(length)  mean=\((map(.elapsed_s)|add/length)|floor)s  max=\(map(.elapsed_s)|max)s"
    ' "$LOG" 2>/dev/null || true
  fi
}

if [ "$MODE" = --acknowledge-drift ]; then
  freeze_check
  case "$FREEZE_RC" in
    0) echo "there is no drift to acknowledge — the manifest describes this tree exactly"; exit 0 ;;
    3) : ;;
    *) echo "$FREEZE_OUT"; echo; echo "REFUSING: this is not environment drift. Binding drift is never acknowledged — fix it or re-freeze deliberately." >&2; exit 2 ;;
  esac
  fp=$(drift_fp)
  [ -n "$fp" ] || { echo "the checker reported drift but no fingerprint; refusing to record a blank acknowledgement" >&2; exit 5; }
  { echo "# environment drift acknowledged for the round-4 counted run"
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
  echo "RESULT: counted manifest, state and order are consistent."
  exit 0
fi

# ---- 3. one driver at a time -------------------------------------------------
# have()/started() are read-then-act, so two drivers would both see "no verdict"
# for the same seq and both launch it.
exec 9>"$RUNS/.driver.lock"
flock -n 9 || { echo "another driver holds $RUNS/.driver.lock" >&2; exit 6; }

[ -n "$halt_seq" ] && { summary; echo; echo "HALTED: seq $halt_seq started and has no verdict. A trajectory that started has an outcome; it is never re-rolled. No registered retry rule exists — adjudicate it and record the disposition ($(seqdir "$halt_seq")/<task>-<arm>.adjudicated), then resume." >&2; exit 3; }
[ -n "$next_seq" ] || { summary; echo; echo "nothing to do — every trajectory is accounted for"; exit 0; }

log() { jq -nc "$@" >> "$LOG"; }

# The runner-view: run-task4.sh binds a registered trajectory to a manifest row by
# reading `.execution.trajectories[] | select(.seq==$s)` and `.registration.model`.
# The COUNTED manifest deliberately splits its execution block into primary and
# duplicate sub-blocks, so it does not carry that flat array; the driver projects
# one — a pure, deterministic function of the frozen manifest — so the SAME
# unmodified runner drives the counted round. The view embeds the counted manifest
# hash, so the view's own hash (recorded by the runner as manifest_sha256) is
# cryptographically bound to the exact frozen counted manifest, whose hash the
# driver additionally records natively per trajectory.
RUNNER_VIEW="$RUNS/.counted-runner-view.json"
build_runner_view() {
  local tmp; tmp=$(mktemp "$RUNS/.rv-XXXXXX") || return 1
  jq --arg model "$MODEL" --arg csha "$MANIFEST_SHA" -n --slurpfile m "$MANIFEST" '
    { schema: "tamperward.round4.counted-runner-view/1",
      counted_manifest_sha256: $csha,
      registration: { model: $model },
      execution: {
        trajectories: ($m[0].execution.primary.trajectories + $m[0].execution.duplicates.trajectories),
        trajectory_count: $m[0].execution.trajectory_count } }' > "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$RUNNER_VIEW" || { rm -f "$tmp"; return 1; }
  RUNNER_VIEW_SHA=$(sha256sum "$RUNNER_VIEW" | cut -d' ' -f1)
}

run_one() {
  local s="$1" task arm t0 t1 rc dup=false
  read -r task arm <<<"$(row "$s")"
  [ -n "$task" ] || { echo "manifest row $s is malformed" >&2; return 2; }
  is_dup "$s" && dup=true
  # Re-assert the WHOLE binding set immediately before launching, not just the
  # manifest's own hash: a runner or policy file changing after trajectory one, with
  # the manifest untouched, would run every later trajectory against a different
  # instrument under the same registration. `gate_or_die` re-runs the full counted
  # --check (registration, pool, binding_set incl. the DRIVER, treatment, and the
  # execution re-derivation), and the manifest hash is re-pinned too.
  local sha_now; sha_now=$(sha256sum "$MANIFEST" | cut -d' ' -f1)
  [ "$sha_now" = "$MANIFEST_SHA" ] || {
    echo "REFUSING: the counted manifest changed under the driver ($MANIFEST_SHA -> $sha_now)" >&2; return 2; }
  gate_or_die "before seq $s"
  build_runner_view || { echo "REFUSING: could not project the runner-view for seq $s" >&2; return 2; }

  local sd; sd="$(seqdir "$s")"; mkdir -p "$sd"
  echo "== seq $s/$TOTAL  $task  $arm$([ "$dup" = true ] && echo '  [dup]')"
  t0=$(date +%s)
  log --arg ev started --arg ts "$(ts)" --argjson seq "$s" --arg task "$task" --arg arm "$arm" \
      --argjson duplicate "$dup" --arg manifest_sha256 "$MANIFEST_SHA" --arg runner_view_sha256 "$RUNNER_VIEW_SHA" \
      '{event:$ev,ts:$ts,seq:$seq,task:$task,arm:$arm,duplicate:$duplicate,manifest_sha256:$manifest_sha256,runner_view_sha256:$runner_view_sha256}'

  # Registered mode is ESTABLISHED here, not asserted. run-task4.sh refuses on its
  # own without a credential and without TB_RUNTASK4_READY; the frozen row and the
  # registered model travel with the trajectory so the runner binds itself to the
  # (projected) manifest rather than trusting the caller's word for the row. Each
  # trajectory gets its OWN per-seq TB_RUNS so a duplicate's evidence never collides
  # with its primary twin's (same task+arm, different immutable identity).
  TB_RUNS="$sd" \
  TB_TASKS="$RUNNER_TASKS" \
  TB_RUNTASK4_READY=1 \
  TB_NETJAIL="${TB_COUNTED_NETJAIL:-1}" \
  TB_REGISTERED_MODEL="$MODEL" \
  TB_PILOT_MANIFEST="$RUNNER_VIEW" \
  TB_PILOT_MANIFEST_SHA256="$RUNNER_VIEW_SHA" \
  TB_PILOT_SEQ="$s" \
  TB_COUNTED_MANIFEST_SHA256="$MANIFEST_SHA" \
  TB_COUNTED_SEQ="$s" \
    bash "$RUNNER" "$task" "$arm"
  rc=$?
  t1=$(date +%s)

  local got=no; have "$s" "$task" "$arm" && got=yes
  log --arg ev finished --arg ts "$(ts)" --argjson seq "$s" --arg task "$task" --arg arm "$arm" \
      --argjson duplicate "$dup" --argjson rc "$rc" --argjson elapsed_s "$((t1-t0))" \
      --arg verdict "$got" --arg manifest_sha256 "$MANIFEST_SHA" --arg runner_view_sha256 "$RUNNER_VIEW_SHA" \
      '{event:$ev,ts:$ts,seq:$seq,task:$task,arm:$arm,duplicate:$duplicate,rc:$rc,elapsed_s:$elapsed_s,verdict:$verdict,manifest_sha256:$manifest_sha256,runner_view_sha256:$runner_view_sha256}'

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
    if have "$s" "$task" "$arm" || resolved "$s" "$task" "$arm"; then continue; fi
    if started "$s" "$task" "$arm"; then
      summary; echo; echo "HALTED: seq $s started and has no verdict." >&2; exit 3
    fi
    next_seq="$s"; break
  done
done
summary
