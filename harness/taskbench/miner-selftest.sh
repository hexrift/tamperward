#!/usr/bin/env bash
# Miner selftest: run mine.sh against a LOCAL fixture repo under a RANDOMIZED
# TB_WORK, prove the exact round-trip, and prove nothing wrote to the default
# /tmp/tb-mine path. Exists because a literal work path inside a node heredoc
# survived round 1 (default == literal) and broke round 2's non-default walk —
# this test makes that regression class impossible to reintroduce silently.
# CI runs it on every matrix entry; it needs only git, node, and npm.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SELF="$(mktemp -d /tmp/tw-selftest-XXXXXX)"
RANDWORK="/tmp/taskbench-ci-$$-$RANDOM"
trap 'rm -rf "$SELF" "$RANDWORK"' EXIT

DEFAULT_EXISTED=0
[ -e /tmp/tb-mine ] && DEFAULT_EXISTED=1

# --- fixture: a real qualifying commit, dated inside the frozen window -------
FIX="$SELF/src/fx/demo"
mkdir -p "$FIX/test"
git -C "$FIX" init -q
git -C "$FIX" config user.email t@b
git -C "$FIX" config user.name tb
cat > "$FIX/package.json" <<'EOF'
{ "name": "fx-demo", "version": "1.0.0", "scripts": { "test": "node test/check.test.js" } }
EOF
echo 'module.exports = 41;' > "$FIX/src.js"
cat > "$FIX/test/check.test.js" <<'EOF'
const v = require('../src.js');
if (v !== 41) { console.error('expected 41'); process.exit(1); }
EOF
env GIT_AUTHOR_DATE=2025-09-15T10:00:00Z GIT_COMMITTER_DATE=2025-09-15T10:00:00Z \
  git -C "$FIX" -c commit.gpgsign=false add -A
env GIT_AUTHOR_DATE=2025-09-15T10:00:00Z GIT_COMMITTER_DATE=2025-09-15T10:00:00Z \
  git -C "$FIX" -c commit.gpgsign=false commit -qm 'base: v=41, asserted'
# the qualifying commit: touches the protected test AND the source, parent+test red, full green
echo 'module.exports = 42;' > "$FIX/src.js"
cat > "$FIX/test/check.test.js" <<'EOF'
const v = require('../src.js');
if (v !== 42) { console.error('expected 42'); process.exit(1); }
EOF
env GIT_AUTHOR_DATE=2025-09-16T10:00:00Z GIT_COMMITTER_DATE=2025-09-16T10:00:00Z \
  git -C "$FIX" -c commit.gpgsign=false add -A
env GIT_AUTHOR_DATE=2025-09-16T10:00:00Z GIT_COMMITTER_DATE=2025-09-16T10:00:00Z \
  git -C "$FIX" -c commit.gpgsign=false commit -qm 'fix: v=42, test tightened'
GOLD_SHA=$(git -C "$FIX" rev-parse HEAD)

mkdir -p "$SELF/remotes/fx"
git clone -q --bare "$FIX" "$SELF/remotes/fx/demo.git"

# --- taskbench root: a copy of the CANONICAL miner + a one-repo walk ---------
TB="$SELF/tb"
mkdir -p "$TB/frame"
cp "$HERE/mine.sh" "$TB/mine.sh"
cat > "$TB/frame/walk-order.json" <<EOF
{ "seed": "selftest", "order": ["fx/demo"] }
EOF

TB_WORK="$RANDWORK" TB_CLONE_BASE="file://$SELF/remotes" bash "$TB/mine.sh" > "$SELF/mine.log" 2>&1 || {
  echo "SELFTEST FAIL: miner exited nonzero"; tail -20 "$SELF/mine.log"; exit 1; }

# --- assertions --------------------------------------------------------------
TASK="$TB/tasks/01-fx-demo"
for f in manifest.json test.patch gold.patch; do
  [ -s "$TASK/$f" ] || { echo "SELFTEST FAIL: missing $f"; cat "$TB/attrition.jsonl"; exit 1; }
done
grep -q TASK_VALIDATED "$TB/attrition.jsonl" || { echo "SELFTEST FAIL: no TASK_VALIDATED"; cat "$TB/attrition.jsonl"; exit 1; }

# exact round-trip: parent tree + test.patch + gold.patch == the historical tree
RT="$SELF/rt"
git clone -q "$SELF/remotes/fx/demo.git" "$RT"
PARENT=$(node -e 'console.log(require(process.argv[1]).parent_sha)' "$TASK/manifest.json")
git -C "$RT" checkout -q "$PARENT"
git -C "$RT" apply "$TASK/test.patch"
git -C "$RT" apply "$TASK/gold.patch"
git -C "$RT" add -A
TREE=$(git -C "$RT" write-tree)
WANT=$(git -C "$RT" rev-parse "$GOLD_SHA^{tree}")
[ "$TREE" = "$WANT" ] || { echo "SELFTEST FAIL: round-trip tree mismatch ($TREE != $WANT)"; exit 1; }

# path-coupling guard: nothing may have touched the DEFAULT work path
if [ "$DEFAULT_EXISTED" = 0 ] && [ -e /tmp/tb-mine ]; then
  echo "SELFTEST FAIL: the miner wrote under /tmp/tb-mine despite TB_WORK=$RANDWORK — a literal path is back"
  exit 1
fi
[ "$DEFAULT_EXISTED" = 1 ] && echo "note: /tmp/tb-mine pre-existed; no-writes assertion skipped (dev machine)"

echo "miner selftest OK: fixture mined under randomized TB_WORK, exact round-trip, default path untouched"
