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
PASS=0; FAIL=0; SKIP=0
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

# --- the driver executes ONLY a positively valid registration -----------------
# Asserted from OUTSIDE, on what the driver does rather than on how it is
# written. The safety here is an ABSENCE of permission: pilot-drive.sh refuses on
# freeze code 6 through the fail-closed default it applies to every code it does
# not recognise, so nothing had to be added to the driver to make a closed
# iteration unrunnable — and nothing in it can be removed to make one runnable.
#
# The observable is the trajectory itself. A refusal that still invoked the
# runner would be no refusal at all, and an exit code alone cannot tell the two
# apart, so each case proves the runner was NEVER CALLED. A future
# `6) ... continue ...` fails here immediately: the driver would reach the
# runner, the log would exist, and no amount of adjusting an expected exit code
# would hide it.
STUB="$TMP/stub-runner.sh"; CALLS="$TMP/calls.log"
printf '#!/usr/bin/env bash\necho "$@" >> "%s"\nexit 0\n' "$CALLS" > "$STUB"; chmod +x "$STUB"
observe() { # <registration> <mode> -> "<rc> <called|not-called>"
  local rc runs; rm -f "$CALLS"; runs="$(mktemp -d)"
  TB_PILOT_REGISTRATION="$1" TB_PILOT_CHECK_NO_ARTEFACT=1 TB_PILOT_CHECK_BINDING_ONLY=1 \
  TB_PILOT_RUNS="$runs" TB_PILOT_RUNNER="$STUB" bash "$HERE/pilot-drive.sh" "$2" >/dev/null 2>&1
  rc=$?; rm -rf "$runs"
  printf '%s %s' "$rc" "$([ -s "$CALLS" ] && echo called || echo not-called)"
}

CLOSED_VALID="$(reg '{"active_iteration":null,"iterations":[{"iteration":1,"lifecycle":"closed","outcome":"failed","manifest":"PILOT-EXECUTION-MANIFEST.json","manifest_sha256":"x"}]}')"
MALFORMED="$(reg '{"iterations":[]}')"
UNREADABLE="$TMP/no-such-registration.json"
FROZEN_VALID="$(reg '{"active_iteration":1,"iterations":[{"iteration":1,"lifecycle":"frozen"}]}')"

# THE POSITIVE CONTROL RUNS FIRST, and the refusal cases run only if it passed.
# Order is the whole point. A driver that cannot execute here for an unrelated
# reason — this suite found `flock` absent on macOS, which makes every invocation
# exit 6 before the lifecycle is consulted at all — would make every refusal below
# pass while proving nothing. Running the control first turns that from four false
# "ok"s into one honest "not exercised".
r=$(observe "$FROZEN_VALID" --next)
if [ "${r##* }" = called ]; then
  ok "frozen registration → execution permitted (the runner is reached)"

  # A validly CLOSED registration makes the checker answer 6, and 6 must stop the
  # driver dead — without the driver knowing what 6 is. The observable is the
  # trajectory: a refusal that still invoked the runner would be no refusal, and
  # an exit code alone cannot tell those apart. A future `6) ... continue ...`
  # fails here immediately — the runner would be reached and the log would exist,
  # and no adjustment to an expected exit code could hide it.
  r=$(observe "$CLOSED_VALID" --next)
  case "$r" in 0\ *|*\ called) bad "closed registration: driver gave \"$r\"; no trajectory may start" ;;
               *) ok "closed registration → checker 6 → driver refuses, runner never called (exit ${r%% *})" ;; esac
  # Corruption must not manufacture the permissive state either. These are ERRORS,
  # a different answer from 6, and they must refuse just as hard.
  for c in "malformed:$MALFORMED" "unreadable:$UNREADABLE"; do
    r=$(observe "${c#*:}" --next)
    case "$r" in 0\ *|*\ called) bad "${c%%:*} registration: driver gave \"$r\"; no trajectory may start" ;;
                 *) ok "${c%%:*} registration → ERROR → driver refuses, runner never called (exit ${r%% *})" ;; esac
  done
else
  # Not a pass and not a failure of the property — a statement that this host
  # cannot ask the question. Counted separately so it can never be mistaken for
  # either, and named precisely so it is actionable rather than noise.
  miss=""
  for t in flock sha256sum; do command -v "$t" >/dev/null 2>&1 || miss="$miss $t"; done
  SKIP=$((SKIP+1))
  echo "  skip  driver execution matrix — the driver cannot run on this host (missing:${miss:- unknown}); refusals NOT exercised"
fi

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

echo "pilot lifecycle self-test: $PASS passed, $FAIL failed$([ "$SKIP" -gt 0 ] && echo ", $SKIP skipped (not exercised, not proven)")"
[ "$FAIL" = 0 ] || exit 1
