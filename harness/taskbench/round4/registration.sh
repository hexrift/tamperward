# Round-4 pilot LIFECYCLE — the one place that answers "is an iteration
# registered right now?". Sourced, never executed.
#
# WHY THIS EXISTS. The frozen manifest pins one iteration's treatment and pool.
# When an iteration closes and its result forces a treatment change (round 4
# iteration 1: D10, 2.10.3), the tree legitimately stops matching that pin — and
# until the next pool is mined there is nothing to freeze. That state was
# unrepresentable, so `provision-check.sh` asked a closed iteration's question of
# an unfrozen candidate and failed a PR for being correct.
#
# Three states, three different questions:
#
#   FROZEN   an iteration is registered. Its treatment and pool are pinned, the
#            full freeze assertions are armed, trajectories may run.
#   BETWEEN  no iteration is registered. The tree may differ from the last closed
#            treatment; NO freeze claim is made; provisioning, artefact and jail
#            integrity must still pass; pilot execution is FORBIDDEN.
#   CLOSED   a historical iteration. Its pins are immutable and describe what
#            actually ran. It is never reopened.
#
# The transition is one-way — frozen -> closed -> between -> (mine) -> frozen —
# and `freeze-pilot-manifest.mjs --derive` is the ONLY operation that returns the
# protocol to frozen. Nothing here can re-arm it; this file only reads.
#
# The danger this design has to avoid is BETWEEN becoming an accidental
# weakening: "nothing is frozen" must not read as "anything may run". So the
# state is consumed in exactly two places — provision-check.sh, which selects
# WHICH assertions are valid, and pilot-drive.sh, which refuses to execute at all
# outside FROZEN.

# The authoritative registration record. Never duplicated into a caller: a pin
# copied into a script is a pin that drifts, which is the bug this replaces.
# Resolved once, AT SOURCE TIME. Inside a function BASH_SOURCE is the defining
# file, but a caller that has since changed directory would resolve a relative
# one against the wrong root — so the directory is captured here, not per call.
TB_R4_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TB_REPO_ROOT="$(cd "$TB_R4_DIR/../../.." && pwd)"
reg_file() { echo "${TB_PILOT_REGISTRATION:-$TB_R4_DIR/PILOT-REGISTRATION.json}"; }

# `frozen <n>` or `between`. Anything unreadable is a structural error, never a
# silent `between` — an unreadable lifecycle must not be the permissive one.
reg_state() {
  local f; f="$(reg_file)"
  [ -r "$f" ] || { echo "ERROR no registration record at $f" >&2; return 5; }
  local a; a=$(jq -r 'if has("active_iteration") then (.active_iteration // "null") else "MISSING" end' "$f" 2>/dev/null) \
    || { echo "ERROR registration record is not readable JSON: $f" >&2; return 5; }
  case "$a" in
    MISSING) echo "ERROR registration record has no active_iteration field: $f" >&2; return 5 ;;
    null)    echo "between" ;;
    ''|*[!0-9]*) echo "ERROR active_iteration is not an iteration number: $a" >&2; return 5 ;;
    *)       echo "frozen $a" ;;
  esac
}

# The record for one iteration, as JSON.
reg_iteration() { jq -c --argjson n "$1" '.iterations[] | select(.iteration == $n)' "$(reg_file)"; }

# The candidate under development, which is the package's own version — NOT a
# constant restated somewhere a release can forget to update.
reg_candidate_version() { node -p "require('$TB_REPO_ROOT/package.json').version"; }

# A CLOSED iteration is immutable and internally reproducible. Immutable: the
# manifest file is byte-identical to what the registration recorded. Internally
# reproducible: its rendered page still derives from that document. Neither
# assertion mentions the current tree — a closed iteration describes what ran,
# and forbidding the tree to move on from it would forbid exactly the work the
# between state exists to allow.
#
# It lives here rather than inside provision-check.sh so the lifecycle has ONE
# owner, and so it can be driven by the self-test without deploying an artefact.
# Prints its findings; returns non-zero on the first violation.
reg_assert_closed_immutable() {
  local f it n mf want got closed
  f="$(reg_file)"
  closed="$(jq -c '.iterations[] | select(.lifecycle == "closed")' "$f")" || return 5
  [ -n "$closed" ] || { echo "no closed iteration is recorded — the lifecycle is unaccounted for" >&2; return 5; }
  while IFS= read -r it; do
    [ -n "$it" ] || continue
    n=$(printf '%s' "$it" | jq -r '.iteration')
    mf="$TB_R4_DIR/$(printf '%s' "$it" | jq -r '.manifest')"
    want=$(printf '%s' "$it" | jq -r '.manifest_sha256')
    [ -r "$mf" ] || { echo "iteration $n records manifest $mf, which is missing" >&2; return 1; }
    if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$mf" | cut -d' ' -f1)
    else got=$(shasum -a 256 "$mf" | cut -d' ' -f1); fi
    [ "$got" = "$want" ] || { echo "iteration $n manifest changed: $got != recorded $want. A closed iteration is immutable." >&2; return 1; }
    TB_PILOT_MANIFEST="$mf" node "$TB_R4_DIR/freeze-pilot-manifest.mjs" --render >/dev/null 2>&1 \
      || { echo "iteration $n manifest does not render — it is not internally reproducible" >&2; return 1; }
    echo "iteration $n closed and immutable ($want)"
  done <<< "$closed"
}
