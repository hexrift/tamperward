#!/usr/bin/env bash
# Classification-only audit (FRAME3 rules, verbatim): stratum predicate + G0 marker facts.
# No installs, no suite runs, no eligibility changes. One JSONL row per repo.
set -u
repo="$1"; W="$(mktemp -d /tmp/sweep-XXXXXX)"; trap 'rm -rf "$W"' EXIT
STRATUM_EXCL_RE='(^|/)(test|tests|testing|doc|docs|example|examples|fixtures|vendor|_vendor|third_party|benchmark|benchmarks)/'
TESTGLOB_RE='((^|/)test_[^/]*\.py$|(^|/)[^/]*_test\.py$|(^|/)conftest\.py$)'
if ! timeout 300 git clone --quiet --filter=blob:none --depth 1 "https://github.com/$repo.git" "$W/r" 2>/dev/null; then
  echo "{\"repo\":\"$repo\",\"audit\":\"CLASSIFICATION_IMPOSSIBLE\",\"why\":\"clone_failed\"}"; exit 0
fi
d="$W/r"
root_marker=0; { [ -f "$d/pyproject.toml" ] || [ -f "$d/setup.py" ] || [ -f "$d/setup.cfg" ]; } && root_marker=1
shaped=0
[ -f "$d/pytest.ini" ] && shaped=1
[ "$shaped" -eq 0 ] && [ -f "$d/pyproject.toml" ] && grep -q 'pytest' "$d/pyproject.toml" 2>/dev/null && shaped=1
[ "$shaped" -eq 0 ] && [ -f "$d/setup.cfg" ] && grep -q '\[tool:pytest\]' "$d/setup.cfg" 2>/dev/null && shaped=1
[ "$shaped" -eq 0 ] && [ -f "$d/tox.ini" ] && grep -q '^\[pytest\]' "$d/tox.ini" 2>/dev/null && shaped=1
[ "$shaped" -eq 0 ] && git -C "$d" ls-files 2>/dev/null | grep -qE '(^|/)conftest\.py$' && shaped=1
has_tests=0; git -C "$d" ls-files 2>/dev/null | grep -qE "$TESTGLOB_RE" && has_tests=1
stratum="single-distribution"
git -C "$d" ls-files -- '*/pyproject.toml' '*/setup.py' 2>/dev/null | grep -vE "$STRATUM_EXCL_RE" | grep -q . && stratum="workspace"
nonroot=$(git -C "$d" ls-files -- '*/pyproject.toml' '*/setup.py' 2>/dev/null | grep -vE "$STRATUM_EXCL_RE" | wc -l)
echo "{\"repo\":\"$repo\",\"stratum_by_rule\":\"$stratum\",\"root_marker\":$root_marker,\"pytest_shaped\":$shaped,\"has_tests\":$has_tests,\"nonroot_project_files\":$nonroot}"
