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
#   R  parent + test.patch alone -> the suite is RED   (the bug is real, and the
#      added cases actually catch it)
#   G  parent + test.patch + gold.patch -> the suite is GREEN (the fix works and
#      the task is solvable)
#
# R and G together are the fail-before/pass-after contract. A task that passes H
# but fails R would be one whose tests never detected the bug; one that fails G
# would be unsolvable. Either makes the task unusable, so both are asserted.
#
# The install ladder is the SAME frozen ladder mine5.sh uses (FRAME3.md gate 1),
# reproduced rather than reinvented: a divergent ladder would verify a different
# environment from the one the trajectory will run in.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
POOL="${TB_POOL_DIR:-$HERE/pools/pilot}"
ONLY="${1:-}"                      # optional: verify one task id
WORK=$(mktemp -d /tmp/tb-verify-XXXXXX)
trap 'rm -rf "$WORK"' EXIT
STEP_TIMEOUT=300
pass=0; fail=0; skipped=0
ok(){ printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

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

suite_state() { # <dir> <venv> -> green|red|no_tests|timeout
  ( cd "$1" && timeout "$STEP_TIMEOUT" "$2/bin/python" -m pytest -q -p no:cacheprovider >/dev/null 2>&1
    case $? in 0) echo green;; 5) echo no_tests;; 124) echo timeout;; *) echo red;; esac )
}

for T in $(ls "$POOL/tasks" | sort); do
  [ -n "$ONLY" ] && [ "$T" != "$ONLY" ] && continue
  MF="$POOL/tasks/$T/manifest.json"
  [ -f "$MF" ] || { no "$T no manifest"; continue; }
  repo=$(node -p "require('$MF').repo"); parent=$(node -p "require('$MF').parent_sha")
  et=$(node -p "require('$MF').test_patch_sha256"); eg=$(node -p "require('$MF').gold_patch_sha256")
  printf '\n== %s (%s) ==\n' "$T" "$repo"

  # H — the committed patches are the ones the manifest describes
  at=$(sha256sum "$POOL/tasks/$T/test.patch" | cut -d' ' -f1)
  ag=$(sha256sum "$POOL/tasks/$T/gold.patch" | cut -d' ' -f1)
  [ "$at" = "$et" ] && ok "H test.patch matches the recorded sha256" || no "H test.patch sha $at != $et"
  [ "$ag" = "$eg" ] && ok "H gold.patch matches the recorded sha256" || no "H gold.patch sha $ag != $eg"

  D="$WORK/repo"; V="$WORK/venv"; rm -rf "$D"
  if ! git clone -q --filter=blob:none "https://github.com/$repo" "$D" 2>/dev/null; then
    printf '  \033[33mn/a\033[0m  %s clone failed — not verifiable here\n' "$T"; skipped=$((skipped+1)); continue; fi
  git -C "$D" checkout -q --detach "$parent" 2>/dev/null || { no "$T parent $parent not checkoutable"; continue; }
  if ! install_env "$D" "$V"; then no "$T install ladder failed — cannot verify the contract"; continue; fi

  # R — the added cases catch the bug on the unfixed parent
  git -C "$D" apply --whitespace=nowarn "$POOL/tasks/$T/test.patch" 2>/dev/null \
    || { no "R test.patch does not apply to $parent"; continue; }
  r=$(suite_state "$D" "$V")
  [ "$r" = red ] && ok "R parent + tests is RED (the added cases catch the bug)" \
                 || no "R parent + tests is $r, expected red — the tests do not detect the bug"

  # G — the gold fix turns it green, so the task is solvable
  git -C "$D" apply --whitespace=nowarn "$POOL/tasks/$T/gold.patch" 2>/dev/null \
    || { no "G gold.patch does not apply on top of the tests"; continue; }
  g=$(suite_state "$D" "$V")
  [ "$g" = green ] && ok "G parent + tests + gold is GREEN (the task is solvable)" \
                   || no "G parent + tests + gold is $g, expected green"
done

printf '\nverify-pilot-tasks: passed %d, failed %d, not-verifiable %d\n' "$pass" "$fail" "$skipped"
[ "$fail" = 0 ]
