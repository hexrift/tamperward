#!/usr/bin/env bash
# Regression selftest for split-cases-py.mjs (v2, AST-derived extents).
# Exists because v1's indentation-derived extents cut a function mid-string
# when a multiline string contained column-0 interior lines (revalidation
# run-2, 04-ipython). Fixture holds exactly the general failure shapes:
#   - a test whose body embeds a triple-quoted string with column-0 lines
#   - a decorated test (decorators must leave with their def)
#   - an async test
#   - a non-test helper that must never be selected
# Asserts: split applies; every withheld def (and its decorators) is gone
# from the visible file; the visible file still py_compiles; pristine copy
# is the full-patch state; selection universe is exactly the added tests.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
S="$(mktemp -d /tmp/tw-split-selftest-XXXXXX)"
trap 'rm -rf "$S"' EXIT
mkdir -p "$S/repo/tests" "$S/task" "$S/oracle"

BASE="$S/repo/tests/test_fx.py"
cat > "$BASE" <<'EOF'
import pytest


def helper():
    return 1
EOF
cd "$S/repo" && git init -q && git config user.email t@b && git config user.name tb
git add -A && git commit -qm base

cat > "$BASE" <<'EOF'
import pytest


def helper():
    return 1


def test_embedded_code():
    code = """
import sys
if True:
    sys.exit(0)
"""
    assert code.strip().startswith("import")


@pytest.mark.parametrize("v", [1, 2])
@pytest.mark.slow
def test_decorated(v):
    assert v > 0


async def test_async_case():
    assert helper() == 1


def test_plain():
    assert True
EOF
git add -A && git -c commit.gpgsign=false commit -qm tests
# task patch = the added tests; the repo dir already holds the PATCHED state
git diff HEAD^ HEAD -- tests/test_fx.py > "$S/task/test.patch"

OUT=$(node "$HERE/split-cases-py.mjs" "$S/task" "$S/repo" "$S/oracle")
echo "splitter: $OUT"
python3 - "$S" "$OUT" <<'EOF'
import json, sys, subprocess, pathlib
S, out = sys.argv[1], json.loads(sys.argv[2])
assert out["cases"] == 4, f"selection universe must be the 4 added tests, got {out['cases']}"
assert out["withheld"] == 2, f"ceil-half: 2 visible, 2 withheld, got {out['withheld']}"
vis = pathlib.Path(S, "repo/tests/test_fx.py").read_text()
w = json.load(open(pathlib.Path(S, "oracle/withheld.json")))
names = [c["header"] for c in w["withheld"]]
assert any("test_embedded_code" in h for h in names), (
    "fixture must withhold the embedded-string case or the v1 regression is unexercised: " + str(names))
for h in names:
    assert h.split("def ")[1].split("(")[0] not in vis, f"withheld {h} still visible"
if any("test_decorated" in h for h in names):
    assert "@pytest.mark.slow" not in vis and "@pytest.mark.parametrize" not in vis, "decorators left behind"
assert "def helper" in vis, "non-test helper must never be selected/removed"
# the killer case: whichever half test_embedded_script landed in, the visible file must compile
subprocess.run([sys.executable, "-m", "py_compile", str(pathlib.Path(S, "repo/tests/test_fx.py"))], check=True)
pris = pathlib.Path(S, "oracle/pristine/tests/test_fx.py").read_text()
for n in ["test_embedded_code", "test_decorated", "test_async_case", "test_plain"]:
    assert n in pris, f"pristine missing {n}"
print("split-cases-py selftest OK: AST extents, decorators, async, embedded column-0 string")
EOF