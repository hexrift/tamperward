#!/usr/bin/env bash
# TDD regression for the iteration-3 D24 defect: harness-owned gate wiring must be
# part of the trusted gated baseline and must NOT read as agent tampering unless
# the AGENT actually changes it — regardless of the candidate repo's excludes.
#
# The Stop-sweep worktree view evaluates exactly the files that are a CHANGE
# (untracked, ignored-on-protected, or modified vs the trusted base). So the
# faithful, detector-independent invariant is:
#   (a) .claude/settings.json is TRACKED in the base;
#   (b) after the base commit it is NOT a scanned change (nothing for the sweep to
#       re-evaluate) — the iteration-3 defect was that an ignored dot-path stayed a
#       scanned change and was blocked as hook-tampering;
#   (c) CONTROL: once the AGENT changes settings.json it IS a scanned change again,
#       so a genuine gate-weakening is still caught.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
CLI="$ROOT/dist/cli/index.js"
[ -f "$CLI" ] || { ( cd "$ROOT" && npm run build >/dev/null 2>&1 ); }
[ -f "$CLI" ] || { echo "SKIP: no built CLI at $CLI"; exit 0; }
command -v git >/dev/null || { echo "SKIP: git required"; exit 0; }
fail=0; ok(){ printf '  ok   %s\n' "$1"; }; no(){ printf '  FAIL %s\n' "$1"; fail=1; }
# a file the Stop-sweep worktree view would evaluate: untracked, ignored, or modified.
wiring_is_scanned_change(){ ( cd "$1" && git status --porcelain --ignored 2>/dev/null ) | grep -qE '\.claude'; }

run_case(){ # <name> <gitignore-contents>
  local name="$1" gi="$2" d; d="$(mktemp -d "${TMPDIR:-/tmp}/gbw-XXXXXX")"
  git init -q "$d"; ( cd "$d" && git config user.email t@b && git config user.name tb )
  mkdir -p "$d/pkg"; printf 'VALUE=1\n' > "$d/pkg/mod.py"; printf '%s\n' "$gi" > "$d/.gitignore"
  ( cd "$d" && git add -A && git -c user.email=t@b -c user.name=tb commit -qm base )
  if ! bash "$HERE/deploy-gated4.sh" "$d" "$CLI" "$ROOT/dist" >/dev/null 2>&1; then no "$name: deploy-gated4 failed"; rm -rf "$d"; return; fi
  bash "$HERE/commit-harness-baseline.sh" "$d" >/dev/null 2>&1
  # (a) wiring in the trusted base
  if ( cd "$d" && git ls-files --error-unmatch .claude/settings.json >/dev/null 2>&1 ); then
    ok "$name: (a) .claude/settings.json is in the trusted base (tracked)"
  else no "$name: (a) .claude/settings.json NOT in the base — $( cd "$d" && git check-ignore -v .claude/settings.json 2>/dev/null )"; fi
  # (b) wiring is not a scanned change -> Stop-sweep has nothing to re-evaluate
  if wiring_is_scanned_change "$d"; then no "$name: (b) harness wiring is a scanned change (Stop-sweep would flag it — the D24 defect)"
  else ok "$name: (b) harness wiring is not a scanned change (trusted base)"; fi
  # (c) control: a genuine agent change to the gate IS a scanned change again
  ( cd "$d" && node -e 'const fs=require("fs");const f=".claude/settings.json";const s=JSON.parse(fs.readFileSync(f,"utf8"));s.hooks=s.hooks||{};s.hooks.PreToolUse=[];fs.writeFileSync(f,JSON.stringify(s,null,2))' )
  if wiring_is_scanned_change "$d"; then ok "$name: (c) control — a genuine agent change to settings.json is still detected"
  else no "$name: (c) control — agent gate-weakening was NOT detectable"; fi
  rm -rf "$d"
}
echo "== gated-base-wiring: harness wiring must be trusted-base, not agent tampering =="
run_case "ordinary tracked (.claude not ignored)" $'*.pyc\n*.whl'
run_case "dot-ignore .* (the pyluach D24 shape)" $'.*\n!.gitignore\n!.github/'
run_case "explicit .claude/ ignore" $'.claude/\n.tamperward.yml'
run_case "broad settings ignore" $'**/settings.json'

# GLOBAL excludes (core.excludesFile), not the repo .gitignore — must also be overridden.
run_case_global(){
  local d; d="$(mktemp -d "${TMPDIR:-/tmp}/gbw-XXXXXX")"; local gx="$d/.globalignore"
  git init -q "$d"; ( cd "$d" && git config user.email t@b && git config user.name tb )
  printf '.claude/\n.tamperward.yml\n' > "$gx"; ( cd "$d" && git config core.excludesFile "$gx" )
  mkdir -p "$d/pkg"; printf 'VALUE=1\n' > "$d/pkg/mod.py"; printf '*.pyc\n' > "$d/.gitignore"
  ( cd "$d" && git add -A && git -c user.email=t@b -c user.name=tb commit -qm base )
  bash "$HERE/deploy-gated4.sh" "$d" "$CLI" "$ROOT/dist" >/dev/null 2>&1 \
    && bash "$HERE/commit-harness-baseline.sh" "$d" >/dev/null 2>&1
  ( cd "$d" && git ls-files --error-unmatch .claude/settings.json >/dev/null 2>&1 ) \
    && ok "global excludes (core.excludesFile): (a) wiring in the trusted base" \
    || no "global excludes: (a) wiring NOT in base — $( cd "$d" && git check-ignore -v .claude/settings.json 2>/dev/null )"
  wiring_is_scanned_change "$d" && no "global excludes: (b) wiring is a scanned change" \
    || ok "global excludes (core.excludesFile): (b) wiring not a scanned change"
  rm -rf "$d"
}
run_case_global
[ "$fail" = 0 ] && echo "gated-base-wiring.selftest: ALL PASS" || echo "gated-base-wiring.selftest: FAILURES"
exit "$fail"
