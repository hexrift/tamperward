#!/usr/bin/env bash
# Deterministic self-test for the pilot iteration LIFECYCLE. No artefact, no
# network, no credential, no trajectory — it drives the state machine against
# synthetic registration records.
#
# WHY. The lifecycle exists to stop "no iteration is frozen" from being read as
# "anything may run". That is a safety property with exactly one interesting
# failure mode — the permissive answer given for the wrong reason — and it is
# reachable in ordinary ways: a malformed record, a missing field, a manifest
# quietly edited after its iteration closed. So the between state is asserted to
# be UNREACHABLE except when the record actually says so, and pilot execution is
# asserted to be refused whenever it is.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok    $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
check() { # <label> <expected> <actual>
  [ "$2" = "$3" ] && ok "$1 ($3)" || bad "$1 — wanted $2, got $3"
}

reg() { printf '%s' "$1" > "$TMP/reg.json"; echo "$TMP/reg.json"; }
state_of() { TB_PILOT_REGISTRATION="$1" bash -c ". '$HERE/registration.sh'; reg_state" 2>&1; }
drive() { # <registration> <mode> -> "<rc> <first line>"
  local out rc
  out=$(TB_PILOT_REGISTRATION="$1" bash "$HERE/pilot-drive.sh" "$2" 2>&1); rc=$?
  printf '%s %s' "$rc" "$(printf '%s' "$out" | head -1 | cut -c1-40)"
}

echo "pilot lifecycle self-test"

# --- the state machine reads exactly what the record says --------------------
check "an active iteration is FROZEN" "frozen 2" \
  "$(state_of "$(reg '{"active_iteration":2,"iterations":[{"iteration":2,"lifecycle":"frozen"}]}')")"
check "a null active iteration is BETWEEN" "between" \
  "$(state_of "$(reg '{"active_iteration":null,"iterations":[]}')")"

# --- an unreadable lifecycle is an ERROR, never the permissive answer ---------
# Each of these could plausibly be treated as "nothing is frozen" by a lenient
# reader, and each would then quietly permit what the state exists to forbid.
for case in \
  'missing field|{"iterations":[]}' \
  'not JSON at all|{ this is not json' \
  'a non-numeric iteration|{"active_iteration":"latest","iterations":[]}' \
  'an empty iteration|{"active_iteration":"","iterations":[]}'
do
  label=${case%%|*}; body=${case#*|}
  out=$(state_of "$(reg "$body")")
  case "$out" in ERROR*) ok "$label is an error, not \"between\"" ;; *) bad "$label returned \"$out\" instead of an error" ;; esac
done
missing=$(TB_PILOT_REGISTRATION="$TMP/nope.json" bash -c ". '$HERE/registration.sh'; reg_state" 2>&1)
case "$missing" in ERROR*) ok "a missing record is an error, not \"between\"" ;; *) bad "a missing record returned \"$missing\"" ;; esac

# --- pilot EXECUTION is refused outside FROZEN -------------------------------
# The refusal is NOT a branch inside the driver. pilot-drive.sh is itself a
# binding file, and closing an iteration must not require editing something that
# iteration pinned — so `--check` answers 6 ("no iteration is registered") and the
# driver refuses on it through the fail-closed default it already applies to every
# code it does not recognise. Nothing had to be added to the driver to make this
# true, which is also why it cannot be removed from it.
BETWEEN="$(reg '{"active_iteration":null,"iterations":[{"iteration":1,"lifecycle":"closed","outcome":"failed","manifest":"PILOT-EXECUTION-MANIFEST.json","manifest_sha256":"x"}]}')"
for mode in --next --all --status; do
  r=$(drive "$BETWEEN" "$mode")
  case "$r" in
    0\ *) bad "$mode SUCCEEDED between iterations — trajectories must not be reachable here" ;;
    *)    ok "$mode is refused between iterations (exit ${r%% *})" ;;
  esac
done
# And the checker says so in as many words, so the refusal is legible rather than
# looking like ordinary drift.
out=$(TB_PILOT_REGISTRATION="$BETWEEN" TB_PILOT_CHECK_NO_ARTEFACT=1 TB_PILOT_CHECK_BINDING_ONLY=1 \
      node "$HERE/freeze-pilot-manifest.mjs" --check 2>&1); rc=$?
check "the checker exits 6 between iterations" 6 "$rc"
case "$out" in *"no active pilot iteration"*) ok "the checker names the state" ;; *) bad "the checker did not name the state: $out" ;; esac
# A frozen registration must NOT produce that refusal. It may still refuse for
# real drift — a different gate, not under test here — so the assertion is on the
# reason, not on the exit code.
FROZEN="$(reg '{"active_iteration":9,"iterations":[{"iteration":9,"lifecycle":"frozen"}]}')"
out=$(TB_PILOT_REGISTRATION="$FROZEN" TB_PILOT_CHECK_NO_ARTEFACT=1 TB_PILOT_CHECK_BINDING_ONLY=1 \
      node "$HERE/freeze-pilot-manifest.mjs" --check 2>&1); rc=$?
[ "$rc" = 6 ] && bad "a frozen iteration was told there is no active iteration" || ok "a frozen iteration is checked normally (exit $rc)"
case "$out" in *"no active pilot iteration"*) bad "a frozen registration produced the between-state message" ;; *) ok "a frozen registration is not treated as between" ;; esac

# --- a closed iteration is immutable -----------------------------------------
immut() { TB_PILOT_REGISTRATION="$1" bash -c ". '$HERE/registration.sh'; reg_assert_closed_immutable" >/dev/null 2>&1; echo $?; }
check "the real record's closed iteration verifies" 0 "$(immut "$HERE/PILOT-REGISTRATION.json")"
REAL_SHA=$(jq -r '.iterations[0].manifest_sha256' "$HERE/PILOT-REGISTRATION.json")
check "a changed manifest hash is caught" 1 \
  "$(immut "$(reg "{\"active_iteration\":null,\"iterations\":[{\"iteration\":1,\"lifecycle\":\"closed\",\"manifest\":\"PILOT-EXECUTION-MANIFEST.json\",\"manifest_sha256\":\"${REAL_SHA%??}00\"}]}")")"
check "a missing manifest is caught" 1 \
  "$(immut "$(reg '{"active_iteration":null,"iterations":[{"iteration":1,"lifecycle":"closed","manifest":"NO-SUCH-MANIFEST.json","manifest_sha256":"x"}]}')")"
check "no closed iteration at all is unaccounted for" 5 \
  "$(immut "$(reg '{"active_iteration":null,"iterations":[]}')")"

echo "pilot lifecycle self-test: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ] || exit 1
