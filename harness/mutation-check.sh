#!/usr/bin/env bash
# Mutation check: a regression test that passes with its fix reverted proves
# nothing. Restore the pre-fix source, rebuild, run that fix's tests, and
# require the exploit tests to FAIL (controls must still pass).
#
# REFUSES to run with uncommitted changes to the target files. It restores them
# with `git checkout HEAD --`, which silently destroyed an uncommitted fix once;
# the tests then failed for the honest reason that the fix no longer existed,
# and the next hour went into debugging code that was not on disk.
set -uo pipefail
cd "$(dirname "$0")/.."
prefix="${1:?usage: mutation-check.sh <pre-fix-rev> <test-file> <source-file...>}"
testfile="${2:?}"; shift 2
for f in "$@"; do
  if ! git diff --quiet -- "$f" || ! git diff --cached --quiet -- "$f"; then
    echo "REFUSING: $f has uncommitted changes — commit first, or they will be lost." >&2
    exit 2
  fi
done
for f in "$@"; do git show "$prefix:$f" > "$f"; done
npm run build >/dev/null 2>&1
npx vitest run "$testfile" 2>&1 | grep -E '✓|×|Tests '
for f in "$@"; do git checkout HEAD -- "$f"; done
npm run build >/dev/null 2>&1
