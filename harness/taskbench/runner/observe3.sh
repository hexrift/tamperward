#!/usr/bin/env bash
# Taskbench trajectory observer — ROUND 3 (DESIGN §5). PostToolUse hook,
# identical in BOTH arms, non-blocking always (exit 0 no matter what).
# Round-3 pre-count corrections over the round-2 observer:
#   1. The protected surface is DERIVED from the neutral round-3 policy
#      (TB_POLICY3 -> policy-globs.mjs, cached once per run) — the round-2
#      observer hard-coded JS globs and silently watched nothing in a Python
#      repo (pilot reproduction: two ungated FALSE_GREEN(test_skip) pilots
#      with observed_protected_mutations 0).
#   2. A BASELINE invocation before the agent's first tool call writes the
#      entry hash AND the entry snapshot, so a mutation in the very first
#      call registers as a transition and is classifiable.
# On change it snapshots the protected files so the policy oracle can
# classify the mutation later. Spelling-independent by construction.
# Env: TB_OBS=observer dir (outside the repo); TB_POLICY3=neutral policy.
set -u
OBS="${TB_OBS:?}"
mkdir -p "$OBS/snapshots"
payload=$(cat 2>/dev/null || true)
tool=$(printf '%s' "$payload" | jq -r '.tool_name // "?"' 2>/dev/null || echo '?')
tool=${tool:-baseline}   # empty stdin (the pre-agent baseline call) keeps columns aligned

if [ ! -f "$OBS/find-args" ]; then
  node "$(dirname "$0")/policy-globs.mjs" "${TB_POLICY3:?}" > "$OBS/find-args" 2>/dev/null || : > "$OBS/find-args"
fi
list_protected() {
  local args=() k v
  while IFS= read -r k && IFS= read -r v; do
    [ ${#args[@]} -gt 0 ] && args+=(-o)
    args+=("$k" "$v")
  done < "$OBS/find-args"
  [ ${#args[@]} -eq 0 ] && return 0
  find . -path ./node_modules -prune -o -type f \( "${args[@]}" \) -print 2>/dev/null | sort
}

files=$(list_protected)
hash=$(printf '%s\n' "$files" | xargs -r sha256sum 2>/dev/null | sha256sum | cut -c1-16)
last=$(tail -1 "$OBS/tree.log" 2>/dev/null | awk '{print $3}')
n=$( { wc -l < "$OBS/tree.log"; } 2>/dev/null || echo 0)
printf '%s %s %s\n' "$(date -u +%H:%M:%SZ)" "$tool" "$hash" >> "$OBS/tree.log"
# snapshot on the baseline call (n=0) and on every change thereafter
if [ "$n" -eq 0 ] || { [ -n "$last" ] && [ "$hash" != "$last" ]; }; then
  printf '%s\n' "$files" | tar -cf "$OBS/snapshots/$((n+1)).tar" -T - 2>/dev/null || true
fi
exit 0
