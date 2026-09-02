#!/usr/bin/env bash
# Round-3 miner selftest: run mine3.sh against a LOCAL pytest fixture repo
# under a RANDOMIZED TB_WORK, prove the exact round-trip, and prove nothing
# wrote to the default /tmp/tb-mine3 path. The round-1 selftest exists because
# a literal work path survived one round and broke the next; this is the same
# guard for the pytest miner, plus a check of the pytest-specific gates
# (install ladder, exit-code semantics, `def test_` oracle counting,
# single-distribution classification). Needs git, node, python3.11, uv.
# How to run: bash harness/taskbench/round3/selftest3.sh
# Status: manual, unwired — NOT in CI (python3.11 + uv are not on the CI
# matrix); run it locally after any edit to mine3.sh.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SELF="$(mktemp -d /tmp/tw-selftest3-XXXXXX)"
RANDWORK="/tmp/taskbench3-ci-$$-$RANDOM"
trap 'rm -rf "$SELF" "$RANDWORK"' EXIT

DEFAULT_EXISTED=0
[ -e /tmp/tb-mine3 ] && DEFAULT_EXISTED=1

# --- fixture: a real qualifying pytest commit inside the frozen window -------
FIX="$SELF/src/fx/pydemo"
mkdir -p "$FIX/tests"
git -C "$FIX" init -q
git -C "$FIX" config user.email t@b
git -C "$FIX" config user.name tb
cat > "$FIX/pyproject.toml" <<'EOF'
[project]
name = "fx-pydemo"
version = "1.0.0"

[project.optional-dependencies]
test = ["pytest"]

[build-system]
requires = ["setuptools"]
build-backend = "setuptools.build_meta"

[tool.setuptools]
py-modules = ["calc"]

[tool.pytest.ini_options]
testpaths = ["tests"]
EOF
cat > "$FIX/calc.py" <<'EOF'
def add(a, b):
    return a + b


def sub(a, b):
    return a + b  # bug at parent: fixed by the qualifying commit
EOF
cat > "$FIX/tests/test_calc.py" <<'EOF'
from calc import add


def test_add():
    assert add(2, 3) == 5
EOF
env GIT_AUTHOR_DATE=2025-09-15T10:00:00Z GIT_COMMITTER_DATE=2025-09-15T10:00:00Z \
  git -C "$FIX" -c commit.gpgsign=false add -A
env GIT_AUTHOR_DATE=2025-09-15T10:00:00Z GIT_COMMITTER_DATE=2025-09-15T10:00:00Z \
  git -C "$FIX" -c commit.gpgsign=false commit -qm 'base: add() tested green, sub() buggy and untested'
# the qualifying commit: touches a protected test AND the source; parent+test
# red (assertion failure -> pytest exit 1), full tree green
cat > "$FIX/calc.py" <<'EOF'
def add(a, b):
    return a + b


def sub(a, b):
    return a - b
EOF
cat >> "$FIX/tests/test_calc.py" <<'EOF'

from calc import sub


def test_sub():
    assert sub(5, 3) == 2


def test_sub_zero():
    assert sub(3, 3) == 0
EOF
env GIT_AUTHOR_DATE=2025-09-16T10:00:00Z GIT_COMMITTER_DATE=2025-09-16T10:00:00Z \
  git -C "$FIX" -c commit.gpgsign=false add -A
env GIT_AUTHOR_DATE=2025-09-16T10:00:00Z GIT_COMMITTER_DATE=2025-09-16T10:00:00Z \
  git -C "$FIX" -c commit.gpgsign=false commit -qm 'fix: sub(), tests added'
GOLD_SHA=$(git -C "$FIX" rev-parse HEAD)

mkdir -p "$SELF/remotes/fx"
git clone -q --bare "$FIX" "$SELF/remotes/fx/pydemo.git"

# --- taskbench root: a copy of the CANONICAL miner + a one-repo walk ---------
TB="$SELF/tb"
mkdir -p "$TB/frame"
cp "$HERE/mine3.sh" "$TB/mine3.sh"
cat > "$TB/frame/walk-order.json" <<EOF
{ "seed": "selftest3", "order": ["fx/pydemo"] }
EOF

TB_WORK="$RANDWORK" TB_CLONE_BASE="file://$SELF/remotes" bash "$TB/mine3.sh" > "$SELF/mine.log" 2>&1 || {
  echo "SELFTEST FAIL: miner exited nonzero"; tail -20 "$SELF/mine.log"; cat "$TB/attrition.jsonl" 2>/dev/null; exit 1; }

# --- assertions --------------------------------------------------------------
TASK="$TB/tasks/01-fx-pydemo"
for f in manifest.json test.patch gold.patch; do
  [ -s "$TASK/$f" ] || { echo "SELFTEST FAIL: missing $f"; cat "$TB/attrition.jsonl"; exit 1; }
done
grep -q TASK_VALIDATED "$TB/attrition.jsonl" || { echo "SELFTEST FAIL: no TASK_VALIDATED"; cat "$TB/attrition.jsonl"; exit 1; }

# pytest-specific fields: stratum, oracle counting (2 added def test_ -> INTEGRITY)
node -e '
const m=require(process.argv[1]);
const fail=(s)=>{console.error("SELFTEST FAIL: "+s);process.exit(1);};
if (m.stratum!=="single-distribution") fail("stratum "+m.stratum);
if (m.added_case_lines!==2) fail("added_case_lines "+m.added_case_lines+" (want 2: def test_sub + def test_sub_zero)");
if (m.oracle_strength!=="INTEGRITY") fail("oracle "+m.oracle_strength);
if (!/^extras:test/.test(m.install_rung)) fail("install_rung "+m.install_rung);
if (m.suite_cmd!=="python -m pytest -q -p no:cacheprovider") fail("suite_cmd "+m.suite_cmd);
' "$TASK/manifest.json"

# the oracle-count regex itself must count async defs too (kept out of the
# executed fixture: a bare `async def test_` without an async plugin is a
# pytest-9 failure, which is a fixture property, not a counting property)
node -e '
const n=("+def test_a():\n+    async def helper():\n+async def test_b():\n+  def test_c():\n".match(/^\+\s*(async\s+)?def test_/gm)||[]).length;
if (n!==3) { console.error("SELFTEST FAIL: oracle regex counted "+n+" (want 3: test_a, test_b, test_c; not the non-test helper)"); process.exit(1); }
'

# exact round-trip: parent tree + test.patch + gold.patch == the historical tree
RT="$SELF/rt"
git clone -q "$SELF/remotes/fx/pydemo.git" "$RT"
PARENT=$(node -e 'console.log(require(process.argv[1]).parent_sha)' "$TASK/manifest.json")
git -C "$RT" checkout -q "$PARENT"
git -C "$RT" apply "$TASK/test.patch"
git -C "$RT" apply "$TASK/gold.patch"
git -C "$RT" add -A
TREE=$(git -C "$RT" write-tree)
WANT=$(git -C "$RT" rev-parse "$GOLD_SHA^{tree}")
[ "$TREE" = "$WANT" ] || { echo "SELFTEST FAIL: round-trip tree mismatch ($TREE != $WANT)"; exit 1; }

# path-coupling guard: nothing may have touched the DEFAULT work path
if [ "$DEFAULT_EXISTED" = 0 ] && [ -e /tmp/tb-mine3 ]; then
  echo "SELFTEST FAIL: the miner wrote under /tmp/tb-mine3 despite TB_WORK=$RANDWORK — a literal path is back"
  exit 1
fi
[ "$DEFAULT_EXISTED" = 1 ] && echo "note: /tmp/tb-mine3 pre-existed; no-writes assertion skipped (dev machine)"

echo "round-3 miner selftest OK: pytest fixture mined under randomized TB_WORK, exact round-trip, default path untouched"
