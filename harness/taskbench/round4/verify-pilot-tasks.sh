#!/usr/bin/env bash
# INDEPENDENT verification of mined pilot tasks, from a FRESH CHECKOUT.
#
# The miner asserted each task's contract while it held the repository in hand.
# This re-establishes it from nothing but the committed artefacts — manifest,
# test.patch, gold.patch — against a clone fetched here. It shares no state with
# the miner: separate work dir, separate venv, separate clone.
#
# Per task:
#   H  the committed patches hash to what the manifest recorded
#   P  the UNTOUCHED parent is GREEN
#   R  parent + test.patch alone is RED
#   G  parent + test.patch + gold.patch is GREEN
#
# P is the control that makes R mean anything. Without it, RED after applying the
# test patch does not show the patch CAUSED the failure — the parent could have
# been failing already, for reasons that have nothing to do with the bug. P, R and
# G together are the fail-before/pass-after contract, attributably.
#
# EXIT-CODE SEMANTICS ARE THE FROZEN ONES (FRAME3, mine5.sh gate 2): green=0,
# red={1,2}, 5=no tests collected, 124=timeout, ANYTHING ELSE is a harness error.
# Collapsing "not zero" into RED would let exit 3, 4, 126, 127 and signal deaths
# masquerade as genuine regression failures — a broken interpreter would read as a
# validated task. The raw status is recorded on every line so the evidence can be
# rechecked without rerunning.
#
# A task that cannot be verified (clone, install, checkout or patch failure) is
# NOT a pass. It is counted separately AND fails the run: a verifier that exits 0
# because every task was unverifiable proves nothing.
#
# The install ladder is the SAME frozen ladder mine5.sh uses, reproduced rather
# than reinvented: a divergent ladder would verify a different environment from
# the one the trajectory will run in.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
POOL="${TB_POOL_DIR:-$HERE/pools/pilot}"
ONLY="${1:-}"
WORK=$(mktemp -d /tmp/tb-verify-XXXXXX)
trap 'rm -rf "$WORK"' EXIT
STEP_TIMEOUT=300
pass=0; fail=0; skipped=0; seen=0
ok(){ printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
na(){ printf '  \033[33mn/a\033[0m  %s\n' "$1"; skipped=$((skipped+1)); }

install_env() { # <repo dir> <venv>
  local dir="$1" venv="$2"
  rm -rf "$venv"
  uv venv -q -p python3.11 "$venv" 2>/dev/null || return 1
  timeout "$STEP_TIMEOUT" bash -s -- "$dir" "$venv" "$WORK" <<'LADDER'
set -u
dir="$1"; venv="$2"; work="$3"; py="$venv/bin/python"
cd "$dir"
rm -f "$work/rung"
for extra in test tests dev; do
  if uv pip install -q -p "$py" -e ".[$extra]" >/dev/null 2>&1; then echo "extras:$extra" > "$work/rung"; break; fi
done
[ -f "$work/rung" ] || { uv pip install -q -p "$py" -e . >/dev/null 2>&1 && echo plain > "$work/rung"; }
[ -f "$work/rung" ] || exit 1
for rf in requirements-dev.txt requirements_dev.txt dev-requirements.txt \
          requirements-test.txt test-requirements.txt requirements/dev.txt requirements/test.txt; do
  [ -f "$rf" ] && { uv pip install -q -p "$py" -r "$rf" >/dev/null 2>&1 && printf '+%s\n' "$rf" >> "$work/rung"; break; }
done
uv pip install -q -p "$py" pytest >/dev/null 2>&1
exit 0
LADDER
}

suite_rc() { # <dir> <venv> -> the RAW pytest exit status
  ( cd "$1" && timeout "$STEP_TIMEOUT" "$2/bin/python" -m pytest -q -p no:cacheprovider >/dev/null 2>&1; echo $? )
}
# frozen classification — never "anything non-zero is red"
classify() { case "$1" in 0) echo green;; 1|2) echo red;; 5) echo no_tests;; 124) echo timeout;; *) echo "error(rc=$1)";; esac; }

# Library seam: sourcing with TB_VERIFY_LIB=1 defines the functions and stops,
# so selftest.sh can assert the exit-code classifier DIRECTLY instead of hoping a
# real run happens to produce every status. The classifier is the piece that most
# needs pinning: it once collapsed every non-zero status into RED.
[ "${TB_VERIFY_LIB:-0}" = 1 ] && return 0 2>/dev/null

for T in $(ls "$POOL/tasks" | sort); do
  [ -n "$ONLY" ] && [ "$T" != "$ONLY" ] && continue
  MF="$POOL/tasks/$T/manifest.json"
  seen=$((seen+1))
  printf '\n== %s ==\n' "$T"
  [ -f "$MF" ] || { no "$T has no manifest"; continue; }
  repo=$(node -p "require('$MF').repo"); parent=$(node -p "require('$MF').parent_sha")
  et=$(node -p "require('$MF').test_patch_sha256"); eg=$(node -p "require('$MF').gold_patch_sha256")
  printf '   repo=%s parent=%s\n' "$repo" "${parent:0:12}"

  at=$(sha256sum "$POOL/tasks/$T/test.patch" | cut -d' ' -f1)
  ag=$(sha256sum "$POOL/tasks/$T/gold.patch" | cut -d' ' -f1)
  [ "$at" = "$et" ] && ok "H test.patch matches the recorded sha256" || no "H test.patch sha $at != $et"
  [ "$ag" = "$eg" ] && ok "H gold.patch matches the recorded sha256" || no "H gold.patch sha $ag != $eg"

  D="$WORK/repo"; V="$WORK/venv"; rm -rf "$D"
  git clone -q --filter=blob:none "https://github.com/$repo" "$D" 2>/dev/null \
    || { na "$T clone failed — NOT VERIFIED"; continue; }
  git -C "$D" checkout -q --detach "$parent" 2>/dev/null \
    || { na "$T parent $parent not checkoutable — NOT VERIFIED"; continue; }
  install_env "$D" "$V" || { na "$T install ladder failed — NOT VERIFIED"; continue; }

  # P — the control: the untouched parent must be GREEN, or R is unattributable
  rc=$(suite_rc "$D" "$V"); st=$(classify "$rc")
  if [ "$st" = green ]; then ok "P untouched parent is GREEN (rc=$rc)"
  else no "P untouched parent is $st (rc=$rc), expected green — R would not be attributable"; continue; fi

  git -C "$D" apply --whitespace=nowarn "$POOL/tasks/$T/test.patch" 2>/dev/null \
    || { na "$T test.patch does not apply to $parent — NOT VERIFIED"; continue; }
  rc=$(suite_rc "$D" "$V"); st=$(classify "$rc")
  [ "$st" = red ] && ok "R parent + tests is RED (rc=$rc; the added cases catch the bug)" \
                  || no "R parent + tests is $st (rc=$rc), expected red"

  git -C "$D" apply --whitespace=nowarn "$POOL/tasks/$T/gold.patch" 2>/dev/null \
    || { na "$T gold.patch does not apply on top of the tests — NOT VERIFIED"; continue; }
  rc=$(suite_rc "$D" "$V"); st=$(classify "$rc")
  [ "$st" = green ] && ok "G parent + tests + gold is GREEN (rc=$rc; the task is solvable)" \
                    || no "G parent + tests + gold is $st (rc=$rc), expected green"
done

printf '\nverify-pilot-tasks: %d task(s) examined — passed %d, failed %d, NOT VERIFIED %d\n' \
  "$seen" "$pass" "$fail" "$skipped"
# A run that examined NOTHING is not a passing run either: with an empty or wrong
# pool every counter stays 0 and a naive "no failures" test would report success.
if [ "$seen" -eq 0 ]; then
  echo "REFUSING: no tasks examined under $POOL/tasks — nothing was verified" >&2
  exit 2
fi
# Zero failures AND zero unverifiable. Skipping is not passing.
[ "$fail" -eq 0 ] && [ "$skipped" -eq 0 ]
