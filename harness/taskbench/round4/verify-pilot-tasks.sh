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
#
# Manifest `repo` is always owner/name. Production fetches those from github.com;
# TB_VERIFY_REPO_BASE can point elsewhere ONLY with TB_VERIFY_TEST_MODE=1, so the
# claim that verification starts from a canonical fresh clone stays true by
# construction rather than by convention.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
POOL="${TB_POOL_DIR:-$HERE/pools/pilot}"
ONLY="${1:-}"
WORK=$(mktemp -d /tmp/tb-verify-XXXXXX)
trap 'rm -rf "$WORK"' EXIT
STEP_TIMEOUT=300
pass=0; fail=0; skipped=0; seen=0; livefail=0
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
# The classification is the SHARED one (runner/suite-status.mjs), not a local
# copy. The old copy read {1,2} as red — the same collapse that let a collection
# error (exit 2) count as a regression. Now exit 1 is the only "red"; 2, 126, 127,
# signals and timeouts are non-measurements, which the P/R/G checks below treat as
# NOT VERIFIED rather than as a test result.
# Located by env override first so a COPY of this script (the counterfactual
# selftest copies it to a temp dir to strip the P control) still finds the shared
# classifier — a relative $HERE/../runner breaks the moment the script moves.
SUITE_STATUS="${TB_SUITE_STATUS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../runner" 2>/dev/null && pwd)/suite-status.mjs}"
classify() { node "$SUITE_STATUS" --exit "$1" 2>/dev/null | awk '{print $1}'; }
# The SAME editable-liveness primitive run-task4.sh calls at PRE_AGENT time, so the
# pre-freeze qualification and the trajectory enforce the identical liveness property.
LIVENESS="${TB_LIVENESS_PRIM:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../runner" 2>/dev/null && pwd)/editable-liveness.py}"

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
  # A manifest `repo` is ALWAYS "owner/name" — never a path, never a URL. Accepting
  # an absolute path because a manifest happened to contain one would let the
  # production verifier read from disk while documenting a canonical fresh clone;
  # the shape of the field is what keeps that claim true.
  # Validate BOTH components explicitly. A glob is the wrong tool here: `*/*` happily
  # accepts `../repo`, `owner/..`, `owner/` and names containing whitespace, any of
  # which would either escape the base or produce a nonsense clone URL.
  repo_ok=1
  case "$repo" in
    */*/*|/*|*/) repo_ok=0 ;;
    */*) owner=${repo%%/*}; name=${repo#*/}
         for part in "$owner" "$name"; do
           case "$part" in
             ''|.|..) repo_ok=0 ;;
             *[!A-Za-z0-9._-]*) repo_ok=0 ;;   # whitespace, ':', '@', '~' and friends
           esac
         done ;;
    *)   repo_ok=0 ;;
  esac
  [ "$repo_ok" = 1 ] || { no "$T manifest repo is not owner/name: '$repo'"; continue; }
  # Where those owner/name pairs are fetched FROM is a separate, explicit decision.
  # Production clones from GitHub. A test may point the base elsewhere, but only by
  # setting BOTH the base and TB_VERIFY_TEST_MODE=1 — a non-GitHub base without the
  # flag is refused, so no fixture path can slip in silently.
  BASE="${TB_VERIFY_REPO_BASE:-https://github.com}"
  if [ "$BASE" != "https://github.com" ] && [ "${TB_VERIFY_TEST_MODE:-0}" != 1 ]; then
    no "$T refuses a non-GitHub repo base ($BASE) without TB_VERIFY_TEST_MODE=1"
    continue
  fi
  case "$BASE" in https://github.com) CLONE_ARGS=(--filter=blob:none) ;; *) CLONE_ARGS=() ;; esac
  SRC="$BASE/$repo"

  GIT_TERMINAL_PROMPT=0 git clone -q "${CLONE_ARGS[@]}" "$SRC" "$D" 2>/dev/null \
    || { na "$T clone failed — NOT VERIFIED"; continue; }
  git -C "$D" checkout -q --detach "$parent" 2>/dev/null \
    || { na "$T parent $parent not checkoutable — NOT VERIFIED"; continue; }
  install_env "$D" "$V" || { na "$T install ladder failed — NOT VERIFIED"; continue; }

  # PRE_FREEZE_EDITABLE_LIVE (D19). Same install ladder + python3.11 interpreter as
  # the trajectory (install_env above); the primitive proves a repo source edit is
  # live for the suite. A failure is QUALIFICATION ATTRITION — a distinct class,
  # never a suite red/PASS. Full audit evidence is emitted for the frozen record.
  if [ "${TB_LIVENESS:-0}" = 1 ]; then
    RUNG=$(tr '\n' ' ' < "$WORK/rung" 2>/dev/null)
    LVOUT=$("$V/bin/python" "$LIVENESS" "$D" 2>&1); LVRC=$?
    printf '  [liveness-audit] task=%s interp=%s rung=%s status=%s\n' "$T" "$V/bin/python" "${RUNG:-?}" "$LVOUT"
    if [ "$LVRC" = 0 ]; then
      ok "LIVENESS: a repo source edit is live for the suite ($LVOUT)"
    else
      printf '  \033[35mLIVE-ATTR\033[0m %s: LIVENESS_NOT_VERIFIED — %s (qualification attrition)\n' "$T" "$LVOUT"
      livefail=$((livefail+1)); continue
    fi
  fi

  # P — the control: the untouched parent must be GREEN, or R is unattributable
  rc=$(suite_rc "$D" "$V"); st=$(classify "$rc")
  case "$st" in
    PASS) ok "P untouched parent is GREEN (rc=$rc)" ;;
    FAIL) no "P untouched parent is RED (rc=$rc), expected green — R would not be attributable"; continue ;;
    *)    na "$T P could not be measured ($st, rc=$rc) — NOT VERIFIED"; continue ;;
  esac

  git -C "$D" apply --whitespace=nowarn "$POOL/tasks/$T/test.patch" 2>/dev/null \
    || { na "$T test.patch does not apply to $parent — NOT VERIFIED"; continue; }
  rc=$(suite_rc "$D" "$V"); st=$(classify "$rc")
  case "$st" in
    FAIL) ok "R parent + tests is RED (rc=$rc; the added cases catch the bug)" ;;
    PASS) no "R parent + tests is GREEN (rc=$rc), expected red" ;;
    *)    na "$T R could not be measured ($st, rc=$rc) — NOT VERIFIED"; continue ;;
  esac

  git -C "$D" apply --whitespace=nowarn "$POOL/tasks/$T/gold.patch" 2>/dev/null \
    || { na "$T gold.patch does not apply on top of the tests — NOT VERIFIED"; continue; }
  rc=$(suite_rc "$D" "$V"); st=$(classify "$rc")
  case "$st" in
    PASS) ok "G parent + tests + gold is GREEN (rc=$rc; the task is solvable)" ;;
    FAIL) no "G parent + tests + gold is RED (rc=$rc), expected green" ;;
    *)    na "$T G could not be measured ($st, rc=$rc) — NOT VERIFIED" ;;
  esac
done

printf '\nverify-pilot-tasks: %d task(s) examined — passed %d, failed %d, NOT VERIFIED %d, LIVENESS attrition %d\n' \
  "$seen" "$pass" "$fail" "$skipped" "$livefail"
# A run that examined NOTHING is not a passing run either: with an empty or wrong
# pool every counter stays 0 and a naive "no failures" test would report success.
if [ "$seen" -eq 0 ]; then
  echo "REFUSING: no tasks examined under $POOL/tasks — nothing was verified" >&2
  exit 2
fi
# Zero failures AND zero unverifiable. Skipping is not passing.
[ "$fail" -eq 0 ] && [ "$skipped" -eq 0 ] && [ "$livefail" -eq 0 ]
