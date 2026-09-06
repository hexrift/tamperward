#!/usr/bin/env bash
# Selftest for the editable-liveness primitive (editable-liveness.py).
#
# The primitive must prove LIVE COUPLING by construction, independent of the
# install mechanism's paths. The decisive cases are taken from the iteration-2
# task-04 failure (DEVIATIONS D16 Finding D):
#   * a src-layout package installed editable via setuptools' PEP 660 import-hook
#     finder is LIVE — the old path-equality guard FALSE-REJECTED exactly this;
#   * a src-layout package installed as a static COPY is NOT live — a source edit
#     in the repo is not what Python executes;
#   * a flat-layout editable is LIVE;
#   * no editable dist at all is NOT_VERIFIED (never a silent pass).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PRIM="$HERE/editable-liveness.py"
command -v python3 >/dev/null || { echo "SKIP: python3 not installed"; exit 0; }
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/edlive-XXXXXX")
trap 'rm -rf "$ROOT"' EXIT
fail=0
ok(){ printf '  ok   %s\n' "$1"; }
no(){ printf '  FAIL %s\n' "$1"; fail=1; }

# build a package fixture: $1=layout(flat|src) $2=dir
mkpkg() {
  local layout="$1" d="$2" pkg=livepkg
  mkdir -p "$d"
  cat > "$d/pyproject.toml" <<TOML
[build-system]
requires = ["setuptools>=64"]
build-backend = "setuptools.build_meta"
[project]
name = "livepkg"
version = "0.0.1"
TOML
  if [ "$layout" = src ]; then
    mkdir -p "$d/src/$pkg"
    printf 'VALUE = 1\n' > "$d/src/$pkg/__init__.py"
    printf '[tool.setuptools.packages.find]\nwhere = ["src"]\n' >> "$d/pyproject.toml"
  else
    mkdir -p "$d/$pkg"
    printf 'VALUE = 1\n' > "$d/$pkg/__init__.py"
    printf '[tool.setuptools.packages.find]\nwhere = ["."]\n' >> "$d/pyproject.toml"
  fi
}

# run the primitive against a repo installed into a venv; echo STATUS + rc
runprim() { # <venv-python> <repo>
  local out rc
  out=$("$1" "$PRIM" "$2" 2>&1); rc=$?
  echo "$rc|$out"
}

venv() { python3 -m venv "$1" >/dev/null 2>&1 && "$1/bin/python" -m pip install -q --upgrade pip setuptools wheel >/dev/null 2>&1; }

# --- 1. src-layout EDITABLE (PEP 660 finder-hook) -> LIVE ---
mkpkg src "$ROOT/src-e"
venv "$ROOT/venv-src-e"
if "$ROOT/venv-src-e/bin/python" -m pip install -q -e "$ROOT/src-e" >/dev/null 2>&1; then
  r=$(runprim "$ROOT/venv-src-e/bin/python" "$ROOT/src-e"); rc=${r%%|*}; msg=${r#*|}
  [ "$rc" = 0 ] && echo "$msg" | grep -q '^LIVE' \
    && ok "src-layout editable (finder-hook) => LIVE: $msg" \
    || no "src-layout editable should be LIVE, got rc=$rc: $msg"
  # prove the OLD path check would have mis-judged it (evidence, not asserted hard)
  loc=$("$ROOT/venv-src-e/bin/python" -c 'import livepkg,pathlib;print(getattr(livepkg,"__file__",None))' 2>/dev/null)
  echo "       (livepkg.__file__ = $loc — a path-equality guard keys off this)"
else
  no "could not editable-install the src fixture (setuptools/pip)"
fi

# --- 2. src-layout COPY install (not editable) -> NOT_VERIFIED ---
mkpkg src "$ROOT/src-c"
venv "$ROOT/venv-src-c"
if "$ROOT/venv-src-c/bin/python" -m pip install -q "$ROOT/src-c" >/dev/null 2>&1; then
  r=$(runprim "$ROOT/venv-src-c/bin/python" "$ROOT/src-c"); rc=${r%%|*}; msg=${r#*|}
  # a plain copy install has no editable direct_url -> PROBE_ERROR (apparatus can't measure), exit 2
  [ "$rc" = 2 ] && echo "$msg" | grep -q 'NO_EDITABLE_DIST' && ok "src-layout copy install => PROBE_ERROR (rc 2): $msg" \
    || no "src-layout copy should be PROBE_ERROR (rc 2), got rc=$rc: $msg"
else
  no "could not copy-install the src fixture"
fi

# --- 3. static-copy shadow: editable dist present, but the module resolves to a
# FROZEN COPY (the iteration-2 "build dir" failure mode) — deterministically, via a
# .pth that prepends a copy dir to the front of sys.path so it always wins. A source
# edit in the repo is then NOT what Python executes, and the primitive must catch it.
mkpkg src "$ROOT/src-shadow"
venv "$ROOT/venv-shadow"
if "$ROOT/venv-shadow/bin/python" -m pip install -q -e "$ROOT/src-shadow" >/dev/null 2>&1; then
  COPY="$ROOT/frozen-copy"; mkdir -p "$COPY/livepkg"; printf 'VALUE = 1\n' > "$COPY/livepkg/__init__.py"
  SP=$("$ROOT/venv-shadow/bin/python" -c 'import site;print(site.getsitepackages()[0])')
  printf "import sys; sys.path.insert(0, '%s')\n" "$COPY" > "$SP/zzz_shadow.pth"   # one-line, valid .pth
  r=$(runprim "$ROOT/venv-shadow/bin/python" "$ROOT/src-shadow"); rc=${r%%|*}; msg=${r#*|}
  [ "$rc" = 1 ] && echo "$msg" | grep -q 'SENTINEL_NOT_OBSERVED' \
    && ok "editable dist but a frozen shadowing copy => NOT_VERIFIED: $msg" \
    || no "a shadowed editable should be NOT_VERIFIED (SENTINEL_NOT_OBSERVED), got rc=$rc: $msg"
else
  no "could not set up the shadow fixture"
fi

# --- 4. no editable dist at all -> NOT_VERIFIED ---
mkpkg flat "$ROOT/none"
venv "$ROOT/venv-none"
r=$(runprim "$ROOT/venv-none/bin/python" "$ROOT/none"); rc=${r%%|*}; msg=${r#*|}
[ "$rc" = 2 ] && echo "$msg" | grep -q 'NO_EDITABLE_DIST' \
  && ok "no editable dist => PROBE_ERROR (rc 2): $msg" \
  || no "no editable dist should be PROBE_ERROR (rc 2), got rc=$rc: $msg"

# --- 4b. a sibling tests/ package must NOT be chosen as the target: the primitive
# must resolve the PACKAGE under test, not the test tree a finder may also expose
# (the iteration-2 task-04 / RxPY shape where top_level.txt is absent or noisy). ---
mkpkg flat "$ROOT/withtests"
mkdir -p "$ROOT/withtests/tests"; printf 'X = 1\n' > "$ROOT/withtests/tests/__init__.py"
venv "$ROOT/venv-withtests"
if "$ROOT/venv-withtests/bin/python" -m pip install -q -e "$ROOT/withtests" >/dev/null 2>&1; then
  r=$(runprim "$ROOT/venv-withtests/bin/python" "$ROOT/withtests"); rc=${r%%|*}; msg=${r#*|}
  [ "$rc" = 0 ] && echo "$msg" | grep -q 'LIVE livepkg' \
    && ok "a tests/ sibling is excluded; the package is the target => LIVE: $msg" \
    || no "target resolution picked the wrong module (expected livepkg), rc=$rc: $msg"
else
  no "could not install the with-tests fixture"
fi

# --- 5. flat-layout EDITABLE -> LIVE ---
mkpkg flat "$ROOT/flat-e"
venv "$ROOT/venv-flat-e"
if "$ROOT/venv-flat-e/bin/python" -m pip install -q -e "$ROOT/flat-e" >/dev/null 2>&1; then
  r=$(runprim "$ROOT/venv-flat-e/bin/python" "$ROOT/flat-e"); rc=${r%%|*}; msg=${r#*|}
  [ "$rc" = 0 ] && echo "$msg" | grep -q '^LIVE' \
    && ok "flat-layout editable => LIVE: $msg" \
    || no "flat-layout editable should be LIVE, got rc=$rc: $msg"
else
  no "could not editable-install the flat fixture"
fi

[ "$fail" = 0 ] && echo "editable-liveness.selftest: ALL PASS" || echo "editable-liveness.selftest: FAILURES"
exit "$fail"
