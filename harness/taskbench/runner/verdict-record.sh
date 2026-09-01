#!/usr/bin/env bash
# THE definition of a complete verdict record, and the durable persistence path.
# Sourced by run-task31.sh (persist), phase3-sweep31.sh (accept + complete) and
# adjudicate31.sh (reconstruct), so all three agree on what a verdict IS. A row
# that merely carries a matching task and arm is not a verdict.
#
# Persistence is per-trajectory and immutable: <task>-<arm>.verdict.json is
# written temp -> validate -> fsync -> rename, and results.jsonl is DERIVED from
# those files in trajectory-start order. An interrupted write can therefore
# never poison the ledger, and the ledger can always be rebuilt from the files.
VERDICT_REQUIRED='
  (.task|type=="string") and ((.task|length)>0)
  and (.arm=="ungated" or .arm=="gated")
  and (.outcome|type=="string") and ((.outcome|length)>0)
  and (.oracle_strength|type=="string")
  and (.visible_suite|type=="string") and (.pristine_suite|type=="string")
  and (.model|type=="string") and ((.model|length)>0)
  and (.transcript|type=="string")
  and (.ts|type=="string")
  and (.driver_pass|type=="number") and (.execution_attempt|type=="number")
'

results_lock() { printf '/tmp/tb31-results-%s.lock' "$(printf %s "$1" | md5sum | cut -c1-12)"; }

# is_verdict_file <file> [task] [arm]
is_verdict_file() {
  local f="$1" t="${2:-}" a="${3:-}"
  [ -s "$f" ] || return 1
  if [ -n "$t" ]; then
    jq -e --arg t "$t" --arg a "$a" "($VERDICT_REQUIRED) and .task==\$t and .arm==\$a" "$f" >/dev/null 2>&1
  else
    jq -e "$VERDICT_REQUIRED" "$f" >/dev/null 2>&1
  fi
}

# verdict_path <runs> <task> <arm>
verdict_path() { printf '%s/%s-%s.verdict.json' "$1" "$2" "$3"; }

# rebuild_results <runs> — results.jsonl is DERIVED, never appended to.
rebuild_results() {
  local runs="$1"
  ( flock 8
    local tmp idx f
    tmp=$(mktemp "$runs/.results-XXXXXX") || exit 1
    idx=$(mktemp "$runs/.index-XXXXXX")   || { rm -f "$tmp"; exit 1; }
    for f in "$runs"/*.verdict.json; do
      [ -e "$f" ] || continue
      is_verdict_file "$f" || { echo "REBUILD REFUSED: $f is not a complete verdict record" >&2; rm -f "$tmp" "$idx"; exit 1; }
      printf '%s\t%s\n' "$(jq -r .ts "$f")" "$f" >> "$idx"
    done
    if [ -s "$idx" ]; then
      LC_ALL=C sort "$idx" | cut -f2- | while IFS= read -r f; do jq -c . "$f"; done > "$tmp" || { rm -f "$tmp" "$idx"; exit 1; }
    fi
    sync "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$runs/results.jsonl" || { rm -f "$tmp" "$idx"; exit 1; }
    rm -f "$idx"
  ) 8>"$(results_lock "$1")"
}

# persist_verdict <runs> <task> <arm> <line.json>
persist_verdict() {
  local runs="$1" task="$2" arm="$3" src="$4" final tmp
  final=$(verdict_path "$runs" "$task" "$arm")
  is_verdict_file "$src" "$task" "$arm" || return 1
  [ -e "$final" ] && return 1          # verdicts are written once, never replaced
  tmp=$(mktemp "$runs/.verdict-XXXXXX") || return 1
  jq -c . "$src" > "$tmp" || { rm -f "$tmp"; return 1; }
  sync "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$final" || { rm -f "$tmp"; return 1; }
  rebuild_results "$runs"
}
