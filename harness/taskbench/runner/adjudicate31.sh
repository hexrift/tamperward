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
#   adjudicate31.sh <runs-dir> <task> <arm> exclusion ["reason"]
#   adjudicate31.sh <runs-dir> <task> <arm> verdict <line.json> ["reason"]
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
jq -e --arg t "$TASK" --arg a "$ARM" \
   'select(.task==$t and .arm==$a and (.event=="POST_START_ADJUDICATED_EXCLUSION" or .event=="POST_START_ADJUDICATED_VERDICT"))' \
   "$DEV" >/dev/null 2>&1 \
  && die "$TASK/$ARM is already adjudicated — dispositions are final and recorded once"
[ -e "$(verdict_path "$RUNS" "$TASK" "$ARM")" ] && die "$TASK/$ARM already carries a verdict"

WD=$(jq -r '.workdir // empty' "$MARKER" 2>/dev/null | tail -1)
BASE=$(jq -r '.base // empty' "$MARKER" 2>/dev/null | tail -1)
TASKDIR=$(jq -r '.task_dir // empty' "$MARKER" 2>/dev/null | tail -1)
RULE=""; WHY=""
if [ -s "$KEEP/verdict-line.json" ]; then
  RULE=R1; WHY="the runner's own verdict line survived in $KEEP"
elif [ -n "$WD" ] && [ -d "$WD/repo" ] && [ -d "$WD/venv" ] && [ -d "$WD/oracle" ] && [ -n "$BASE" ]; then
  RULE=R2; WHY="the trajectory workspace survived at $WD; the verdict is re-derivable at $BASE"
else
  RULE=R3
  WHY="unrecoverable: $( [ -s "$KEEP/verdict-line.json" ] || printf 'no preserved verdict line; ' )$( [ -n "$WD" ] && [ -d "$WD/repo" ] || printf 'no final repository tree; ' )$( [ -n "$WD" ] && [ -d "$WD/venv" ] || printf 'no task venv; ' )$( [ -n "$WD" ] && [ -d "$WD/oracle" ] || printf 'no oracle; ' )$( [ -n "$BASE" ] || printf 'no recorded base; ' )"
fi
echo "[adjudicate31] ladder: $RULE — $WHY"

case "$MODE" in
  exclusion) [ "$RULE" = R3 ] || die "the ladder resolves to $RULE ($WHY); exclusion is only sanctioned at R3 — run 'auto'" ;;
  verdict)   [ "$RULE" = R3 ] && die "the ladder resolves to R3 ($WHY); no verdict can be derived from these artifacts" ;;
  auto)      ;;
  *) die "mode must be auto, exclusion or verdict, got '$MODE'" ;;
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
    RAW=$(TB_VENV="$WD/venv" node "$HERE/verdict3.mjs" "$TASKDIR" "$WD/repo" "$WD/oracle" "$WD/obs" "$BASE") \
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
  [ "$MODE" = verdict ] && [ -n "${5:-}" ] && LINE="$5"
  is_verdict_file "$LINE" "$TASK" "$ARM" || die "the derived line is not a complete verdict record for $TASK/$ARM"
  persist_verdict "$RUNS" "$TASK" "$ARM" "$LINE" || die "could not persist the reconstructed verdict"
  record POST_START_ADJUDICATED_VERDICT "${6:-$WHY}" "$(sha "$(verdict_path "$RUNS" "$TASK" "$ARM")")"
  echo "reconstructed verdict persisted and POST_START_ADJUDICATED_VERDICT recorded for $TASK $ARM under rule $RULE"
fi
