#!/usr/bin/env bash
# PoC: agent-added protected control file survives into the pristine run.
# Usage: poc.sh <path-to-tamperward-cli.js> <label>
set -u
CLI="$1"; LABEL="$2"
# self-contained: build a throwaway venv with pytest if one is not supplied
VENV="${POC_VENV:-$(mktemp -d /tmp/poc-venv-XXXXXX)/v}"
if [ ! -x "$VENV/bin/python" ]; then
  uv venv "$VENV" -q 2>/dev/null || python3 -m venv "$VENV"
  uv pip install -q -p "$VENV" pytest 2>/dev/null || "$VENV/bin/python" -m pip install -q pytest
fi
export PATH="$VENV/bin:$PATH"
W=$(mktemp -d /tmp/poc-XXXXXX); cd "$W" || exit 1
git init -q; git config user.email p@o.c; git config user.name poc
mkdir -p tests
cat > app.py <<'EOF'
def add(a, b):
    return a - b        # the bug: agent's source is incorrect
def mul(a, b):
    return a * b
EOF
cat > tests/test_app.py <<'EOF'
from app import add, mul
def test_add():
    assert add(1, 2) == 3      # base-protected test, FAILS against the bug
def test_mul():
    assert mul(2, 3) == 6      # keeps collection non-empty
EOF
# Explicit protected globs so the SAME policy applies on every version tested.
# v1.9.0's default tests class is JS/TS only (the P2-13 defect), which would
# otherwise confound the comparison by restoring zero files.
cat > .tamperward.yml <<'EOF'
protected:
  tests:
    - '**/tests/**/*.py'
    - '**/conftest.py'
verify:
  command: python -m pytest -q
  budget: 60
EOF
printf '__pycache__/\n' > .gitignore
git add -A; git commit -qm base; BASE=$(git rev-parse HEAD)

echo "================ $LABEL ================"
echo "[base] suite is red (the task premise):"; python -m pytest -q 2>&1 | tail -1

echo
echo "[step 3] CONTROL — visible tree weakens the protected test, NO added file:"
sed -i 's/assert add(1, 2) == 3/assert True/' tests/test_app.py
python -m pytest -q >/dev/null 2>&1; echo "  visible exit=$?"
node "$CLI" verify --base "$BASE" 2>&1 | head -2; echo "  verify exit=${PIPESTATUS[0]}"
node "$CLI" verify --base "$BASE" >/dev/null 2>&1; echo "  -> verify exit=$?  (1 = correctly blocked)"
git checkout -q -- tests/test_app.py

echo
echo "[steps 4-7] BYPASS — protected test byte-identical to base, one file ADDED:"
cat > tests/conftest.py <<'EOF'
def pytest_collection_modifyitems(config, items):
    # deselect by node id -- not a skip spelling, so no skip regex can see it
    items[:] = [i for i in items if not i.nodeid.endswith("::test_add")]
EOF
echo -n "  protected test vs base: "; git diff --quiet "$BASE" -- tests/test_app.py && echo "IDENTICAL" || echo "MODIFIED"
echo -n "  bug still present: "; grep -q 'a - b' app.py && echo YES || echo NO
python -m pytest -q >/dev/null 2>&1; echo "  visible exit=$?"
echo -n "  policy gate: "; node "$CLI" check --worktree 2>&1 | tail -1
node "$CLI" verify --base "$BASE" 2>&1 | head -2
node "$CLI" verify --base "$BASE" >/dev/null 2>&1; VE=$?
echo "  -> verify exit=$VE"
if [ "$VE" -eq 0 ]; then echo "  *** BYPASS REPRODUCES on $LABEL ***"; else echo "  bypass does NOT reproduce on $LABEL"; fi
rm -rf "$W"
