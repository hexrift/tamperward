#!/usr/bin/env bash
# Adjudicate a POST_START_FINALIZATION_FAILURE — a trajectory that RAN but whose
# verdict never persisted. The failure EVENT is append-only and stays in the
# ledger forever; this records the separate, final DISPOSITION.
#
# Adjudication is a DETERMINISTIC LADDER over the preserved artifacts, not a
# choice. Whether a trajectory is reconstructed or excluded is a fact about
# which artifacts survived, never about what outcome it appears to have had --
# an exclusion drops the whole PAIR from the McNemar analysis, so a discretionary
# post-outcome exclusion would be a researcher degree of freedom. The ladder is
# frozen in PREDICTION3.1 §1:
#
#   R1  the runner's own verdict line survived  -> APPEND IT (it is the verdict
#       that trajectory already earned; nothing is recomputed)
#   R2  no verdict line, but the trajectory workspace survived (repo + venv +
#       oracle) -> RE-DERIVE with the same verdict3.mjs oracle over those
#       artifacts, at the recorded base. Deterministic re-derivation, not a re-run.
#   R3  neither -> EXCLUDE. The only sanctioned exclusion, and only for these
#       enumerated conditions.
#
# The ladder is re-evaluated on every invocation, so a manual `verdict` or
# `exclusion` that disagrees with it is REFUSED.
#
# Usage:
#   adjudicate31.sh <runs-dir> <task> <arm> auto            # the sanctioned path
#   adjudicate31.sh <runs-dir> <task> <arm> ladder          # diagnostic: print the rule
#   adjudicate31.sh <runs-dir> <task> <arm> exclusion ["reason"]
#   adjudicate31.sh <runs-dir> <task> <arm> verdict <line.json> ["reason"]
#
# `verdict` VERIFIES a supplied record against what the ladder derives and
# refuses anything that differs; it is an import/diagnostic interface, never a
# way to substitute an outcome after seeing the trajectory.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; . "$HERE/verdict-record.sh"
RUNS="${1:?runs directory}"; TASK="${2:?task id}"; ARM="${3:?ungated|gated}"; MODE="${4:-auto}"
DEV="$RUNS/deviations.jsonl"; KEEP="$RUNS/$TASK-$ARM-poststart-workdir"; MARKER="$RUNS/$TASK-$ARM.started"
die() { echo "ADJUDICATION REFUSED: $*" >&2; exit 1; }
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
sha() { [ -e "${1:-}" ] && sha256sum "$1" 2>/dev/null | cut -d' ' -f1 || echo ""; }
who() { printf %s "${TB_ADJUDICATOR:-$(git config user.email 2>/dev/null || echo unknown)}"; }

case "$ARM" in ungated|gated) ;; *) die "arm must be ungated or gated, got '$ARM'" ;; esac
[ -f "$DEV" ] || die "no deviations ledger at $DEV"
jq -e --arg t "$TASK" --arg a "$ARM" \
   'select(.task==$t and .arm==$a and .event=="POST_START_FINALIZATION_FAILURE")' "$DEV" >/dev/null 2>&1 \
  || die "$TASK/$ARM has no POST_START_FINALIZATION_FAILURE to adjudicate"
if [ "$MODE" != ladder ]; then
  jq -e --arg t "$TASK" --arg a "$ARM" \
     'select(.task==$t and .arm==$a and (.event=="POST_START_ADJUDICATED_EXCLUSION" or .event=="POST_START_ADJUDICATED_VERDICT"))' \
     "$DEV" >/dev/null 2>&1 \
    && die "$TASK/$ARM is already adjudicated — dispositions are final and recorded once"
  [ -e "$(verdict_path "$RUNS" "$TASK" "$ARM")" ] && die "$TASK/$ARM already carries a verdict"
fi

WD=$(jq -r '.workdir // empty' "$MARKER" 2>/dev/null | tail -1)
BASE=$(jq -r '.base // empty' "$MARKER" 2>/dev/null | tail -1)
TASKDIR=$(jq -r '.task_dir // empty' "$MARKER" 2>/dev/null | tail -1)
# Bind the pristine oracle to THIS trajectory, deterministically. The
# control-plane correction moved the oracle out of the workspace, so the
# original `$WD/oracle` test is no longer sufficient (Amendment 2). Discovery
# only -- this cannot change which verdict is derived, and ambiguity is refused.
locate_oracle() {
  local o
  o=$(jq -r '.oracle_dir // empty' "$MARKER" 2>/dev/null | tail -1)          # 1. recorded in the marker
  [ -n "$o" ] && [ -d "$o" ] && { printf %s "$o"; return 0; }
  [ -n "$WD" ] && [ -d "$WD/oracle" ] && { printf %s "$WD/oracle"; return 0; } # 2. legacy in-workspace
  [ -d "$KEEP/oracle" ] && { printf %s "$KEEP/oracle"; return 0; }            # 3. this trajectory's frozen evidence
  local c n                                                                   # 4. exactly ONE surviving control oracle
  c=$(ls -d /tmp/tb31-ctrl-*/oracle 2>/dev/null || true)
  n=$(printf '%s\n' "$c" | grep -c . || true)
  if [ "$n" -eq 1 ]; then printf %s "$c"; return 0; fi
  [ "$n" -gt 1 ] && echo "[adjudicate31] $n candidate control oracles survive — ambiguous, refusing to guess (falls to R3)" >&2
  return 1
}
workspace_reconstructible() {
  [ -n "$WD" ] && [ -d "$WD/repo" ] && [ -d "$WD/venv" ] && [ -n "$BASE" ] && ORACLE_DIR=$(locate_oracle)
}
RULE=""; WHY=""; ORACLE_DIR=""
# R1 requires a COMPLETE verdict, not merely a non-empty file: an outer timeout
# can leave a torn verdict-line.json, and that must fall through to R2 rather
# than dead-end the ladder at a record the schema check will reject.
if is_verdict_file "$KEEP/verdict-line.json" "$TASK" "$ARM"; then
  RULE=R1; WHY="the runner's own complete verdict line survived in $KEEP"
elif workspace_reconstructible; then
  RULE=R2; WHY="the trajectory workspace survived at $WD; the verdict is re-derivable at $BASE"
  [ -s "$KEEP/verdict-line.json" ] && WHY="$WHY (a partial verdict line was present and disregarded)"
else
  RULE=R3
  WHY="unrecoverable: $( is_verdict_file "$KEEP/verdict-line.json" "$TASK" "$ARM" || printf 'no complete preserved verdict line; ' )$( [ -n "$WD" ] && [ -d "$WD/repo" ] || printf 'no final repository tree; ' )$( [ -n "$WD" ] && [ -d "$WD/venv" ] || printf 'no task venv; ' )$( locate_oracle >/dev/null 2>&1 || printf 'no bindable pristine oracle; ' )$( [ -n "$BASE" ] || printf 'no recorded base; ' )"
fi
echo "[adjudicate31] ladder: $RULE — $WHY"
[ "$MODE" = ladder ] && exit 0

case "$MODE" in
  exclusion) [ "$RULE" = R3 ] || die "the ladder resolves to $RULE ($WHY); exclusion is only sanctioned at R3 — run 'auto'" ;;
  verdict)   [ "$RULE" = R3 ] && die "the ladder resolves to R3 ($WHY); no verdict can be derived from these artifacts"
             [ -n "${5:-}" ] || die "verdict mode needs the file to VERIFY against the ladder" ;;
  auto)      ;;
  ladder)    ;;
  *) die "mode must be auto, ladder, exclusion or verdict, got '$MODE'" ;;
esac

record() {  # <event> <reason> [verdict-sha]
  jq -nc --arg ts "$(ts)" --arg t "$TASK" --arg a "$ARM" --arg e "$1" --arg r "$2" \
     --arg rule "$RULE" --arg by "$(who)" --arg vs "${3:-}" \
     --arg mh "$(sha "$MARKER")" --arg th "$(sha "$KEEP/repo-final-tree.tar")" \
     '{ts:$ts,task:$t,arm:$a,event:$e,rule:$rule,note:$r,adjudicated_by:$by,
       artifacts:{marker_sha256:$mh,repo_tree_sha256:$th,verdict_sha256:$vs}}' >> "$DEV" \
    || die "could not append the disposition"
}

LINE=""
case "$RULE" in
  R1) LINE="$KEEP/verdict-line.json" ;;
  R2)
    echo "[adjudicate31] re-deriving the verdict with verdict3.mjs over the preserved workspace"
    echo "[adjudicate31] oracle bound at $ORACLE_DIR"
    RAW=$(TB_VENV="$WD/venv" node "$HERE/verdict3.mjs" "$TASKDIR" "$WD/repo" "$ORACLE_DIR" "$WD/obs" "$BASE") \
      || die "verdict3.mjs failed over the preserved workspace; the ladder cannot re-derive"
    LINE=$(mktemp); printf '%s' "$RAW" | jq -c \
      --arg arm "$ARM" --arg model "$(jq -r .model "$MARKER")" --arg ts "$(jq -r .ts "$MARKER")" \
      --arg tr "$(jq -r .transcript "$MARKER")" \
      --argjson pass "$(jq -r '.driver_pass // 1' "$MARKER")" \
      --argjson xa "$(jq -r '.execution_attempt // 1' "$MARKER")" \
      '. + {arm:$arm, model:$model, ts:$ts, transcript:$tr, driver_pass:$pass,
            execution_attempt:$xa, reconstructed:true}' > "$LINE" \
      || die "could not build the re-derived verdict line"
    ;;
esac

if [ "$RULE" = R3 ]; then
  record POST_START_ADJUDICATED_EXCLUSION "${5:-$WHY}"
  echo "POST_START_ADJUDICATED_EXCLUSION recorded for $TASK $ARM under rule R3"
else
  is_verdict_file "$LINE" "$TASK" "$ARM" || die "the derived line is not a complete verdict record for $TASK/$ARM"
  # `verdict` VERIFIES a supplied record against the ladder; it never substitutes
  # one. A structurally valid record for the same trajectory but with a different
  # outcome is exactly the post-outcome substitution the ladder exists to prevent.
  if [ "$MODE" = verdict ]; then
    [ -f "$5" ] || die "no such file: $5"
    diff -q <(jq -S -c . "$LINE" 2>/dev/null) <(jq -S -c . "$5" 2>/dev/null) >/dev/null 2>&1 \
      || die "the supplied record is NOT identical to the one rule $RULE derives from the artifacts. A verdict is determined by the trajectory, never chosen after seeing it — run 'auto'."
  fi
  persist_verdict "$RUNS" "$TASK" "$ARM" "$LINE" || die "could not persist the reconstructed verdict"
  record POST_START_ADJUDICATED_VERDICT "${6:-$WHY}" "$(sha "$(verdict_path "$RUNS" "$TASK" "$ARM")")"
  echo "reconstructed verdict persisted and POST_START_ADJUDICATED_VERDICT recorded for $TASK $ARM under rule $RULE"
fi
