#!/usr/bin/env bash
# THROWAWAY DIAGNOSTIC — NOT part of the counted apparatus, NOT a frozen binding
# file, NOT merged to main. It faithfully replicates run-task4.sh's PRE-AGENT
# gold-check path for a counted task (materialize -> withheld split -> frozen
# install ladder -> editable-liveness -> .git strip + synthetic base commit ->
# parent-RED confirmation -> gold_check), using the SAME helper scripts, patch
# order, revert/reset steps, working directory and suite command as run-task4
# lines ~457-566.
#
# The ONLY intentional differences vs run-task4 are:
#   (a) it stops after gold_check — no agent, no Claude call, no credential;
#   (b) the suite output is PRESERVED (teed) instead of discarded (>/dev/null),
#       because run-task4 throws PRE_AGENT_GOLD_RED suite output away and rc=1
#       alone is too little evidence.
# It mutates NO counted state. Exit 0 = gold GREEN; exit 1 = PRE_AGENT_GOLD_RED
# (reproduced); other = a different pre-agent stage failed.
set -uo pipefail
ID="${1:?task id}"; ARM="${2:?arm}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HERE="$ROOT/harness/taskbench/runner"                                  # run-task4's $HERE
TASK="$ROOT/harness/taskbench/round4/pools/counted/tasks/$ID"
[ -f "$TASK/manifest.json" ] || { echo "no such task: $ID"; exit 3; }
REPO=$(jq -r .repo "$TASK/manifest.json")
PARENT=$(jq -r .parent_sha "$TASK/manifest.json")
W=$(mktemp -d /tmp/diag-gp-XXXXXX); CTRL=$(mktemp -d /tmp/diag-gp-ctrl-XXXXXX); chmod 700 "$CTRL"
REPODIR="$W/repo"; ORACLE="$CTRL/oracle"; VENV="$W/venv"; mkdir -p "$ORACLE"
export TB_VENV="$VENV"                                                 # run-task4 exports this before the suite
trap 'rm -rf "$W" "$CTRL"' EXIT

# run-task4's suite() / is_red() / revert() — suite() OUTPUT PRESERVED (the one diff).
suite() { ( cd "$1" && timeout 300 "$VENV/bin/python" -m pytest -q -p no:cacheprovider 2>&1 | tee "$W/suite.out" ); return "${PIPESTATUS[0]}"; }
is_red() { [ "$1" -eq 1 ] || [ "$1" -eq 2 ]; }
revert() { git -C "$1" checkout -q -- . 2>/dev/null; git -C "$1" clean -qfd -e '*.egg-info' -e '*.so' -e '*.pyd' 2>/dev/null; }

echo "[diag] $ID-$ARM materializing (REPO=$REPO PARENT=$PARENT)"
git clone -q --filter=blob:none "https://github.com/$REPO.git" "$REPODIR" || { echo CLONE_FAILED; exit 4; }
git -C "$REPODIR" checkout -q --detach "$PARENT"
git -C "$REPODIR" apply "$TASK/test.patch" || { echo TEST_PATCH_FAILED; exit 4; }

# withheld split (semantic tasks) + py_compile gate — verbatim from run-task4
node "$HERE/split-cases-py.mjs" "$TASK" "$REPODIR" "$ORACLE" > "$W/split.json" || true
echo "[diag] split: $(cat "$W/split.json" 2>/dev/null)"
if [ -f "$ORACLE/withheld.json" ]; then
  while read -r f; do
    [ -f "$REPODIR/$f" ] || continue
    python3 -m py_compile "$REPODIR/$f" 2>/dev/null || {
      echo "[diag] split output failed py_compile; dropping split (INTEGRITY fallback)"
      ( cd "$ORACLE/pristine" && find . -type f ) | while read -r g; do
        mkdir -p "$REPODIR/$(dirname "$g")"; cp "$ORACLE/pristine/$g" "$REPODIR/$g"; done
      rm -f "$ORACLE/withheld.json"; break
    }
  done < <(cd "$ORACLE/pristine" && find . -type f | sed 's|^\./||')
fi

# frozen install ladder — verbatim from run-task4
uv venv -q -p python3.11 "$VENV" || { echo VENV_FAILED; exit 4; }
timeout 300 bash -s -- "$REPODIR" "$VENV" "$W" <<'LADDER'
set -u
dir="$1"; venv="$2"; work="$3"; py="$venv/bin/python"
cd "$dir"
for extra in test tests dev; do
  if uv pip install -q -p "$py" -e ".[$extra]" >/dev/null 2>&1; then echo "extras:$extra" > "$work/rung"; break; fi
done
if [ ! -f "$work/rung" ]; then
  uv pip install -q -p "$py" -e . >/dev/null 2>&1 && echo "plain" > "$work/rung"
fi
[ -f "$work/rung" ] || exit 1
for rf in requirements-dev.txt requirements_dev.txt dev-requirements.txt \
          requirements-test.txt test-requirements.txt requirements/dev.txt requirements/test.txt; do
  if [ -f "$rf" ]; then uv pip install -q -p "$py" -r "$rf" >/dev/null 2>&1; break; fi
done
uv pip install -q -p "$py" pytest >/dev/null 2>&1
exit 0
LADDER
[ $? -eq 0 ] || { echo INSTALL_FAILED; exit 4; }
echo "[diag] install rung: $(cat "$W/rung" 2>/dev/null)"

# editable-liveness — verbatim from run-task4
LIVE_OUT=$("$VENV/bin/python" "$HERE/editable-liveness.py" "$REPODIR" 2>&1); LIVERC=$?
echo "[diag] editable-liveness: $LIVE_OUT"
[ "$LIVERC" = 0 ] || { echo "PRE_AGENT_EDITABLE_NOT_LIVE: $LIVE_OUT"; exit 4; }

# strip history; synthetic base commit — verbatim from run-task4
rm -rf "$REPODIR/.git"
( cd "$REPODIR" && git init -q && git add -A && git -c user.email=t@b -c user.name=tb commit -qm base --no-verify )
BASE=$(git -C "$REPODIR" rev-parse HEAD)

echo "=== PARENT suite (test.patch only) — expected RED — OUTPUT PRESERVED ==="
suite "$REPODIR"; rc=$?
if [ "$rc" -eq 0 ] && [ -f "$ORACLE/withheld.json" ]; then
  echo "[diag] visible green under split; dropping split (INTEGRITY fallback)"
  ( cd "$ORACLE/pristine" && find . -type f ) | while read -r f; do
    mkdir -p "$REPODIR/$(dirname "$f")"; cp "$ORACLE/pristine/$f" "$REPODIR/$f"; done
  rm -f "$ORACLE/withheld.json"
  ( cd "$REPODIR" && git add -A && git -c user.email=t@b -c user.name=tb commit -qm unsplit --no-verify )
  BASE=$(git -C "$REPODIR" rev-parse HEAD)
  suite "$REPODIR"; rc=$?
fi
echo "[diag] PARENT rc=$rc"
{ [ "$rc" -eq 0 ] || [ "$rc" -eq 5 ]; } && { echo "PRE_AGENT_NOT_RED (rc=$rc)"; exit 4; }
[ "$rc" -eq 124 ] && { echo "PRE_AGENT_TIMEOUT"; exit 4; }
is_red "$rc" || { echo "PRE_AGENT_ERROR (rc=$rc)"; exit 4; }
revert "$REPODIR"

# gold validation — verbatim from run-task4 (in place + revert), OUTPUT PRESERVED
gold_check() {
  git -C "$REPODIR" apply "$TASK/gold.patch" 2>/dev/null || return 2
  echo "=== GOLD suite (test.patch + gold.patch) — expected GREEN; counted saw RED — OUTPUT PRESERVED ==="
  suite "$REPODIR"; local r=$?
  revert "$REPODIR"
  return $r
}
gold_check; grc=$?
if [ "$grc" -ne 0 ] && [ -f "$ORACLE/withheld.json" ]; then
  echo "[diag] gold-on-visible red with split; dropping split (INTEGRITY fallback)"
  ( cd "$ORACLE/pristine" && find . -type f ) | while read -r f; do
    mkdir -p "$REPODIR/$(dirname "$f")"; cp "$ORACLE/pristine/$f" "$REPODIR/$f"; done
  rm -f "$ORACLE/withheld.json"
  ( cd "$REPODIR" && git add -A && git -c user.email=t@b -c user.name=tb commit -qm unsplit --no-verify )
  BASE=$(git -C "$REPODIR" rev-parse HEAD)
  suite "$REPODIR"; rc=$?
  { [ "$rc" -eq 0 ] || [ "$rc" -eq 5 ]; } && { echo "PRE_AGENT_NOT_RED_UNSPLIT"; exit 4; }
  revert "$REPODIR"
  gold_check; grc=$?
fi
echo "[diag] GOLD rc=$grc"
if [ "$grc" -ne 0 ]; then
  echo "RESULT: PRE_AGENT_GOLD_RED (rc=$grc) — REPRODUCED the counted failure on this run"
  exit 1
fi
echo "RESULT: GOLD GREEN (rc=0) — did NOT reproduce the counted failure on this run"
exit 0
