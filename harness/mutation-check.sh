#!/usr/bin/env bash
# Mutation check: a regression test that passes with its fix reverted proves
# nothing. Restore the pre-fix source, rebuild, run that fix's tests, and
# require the exploit tests to FAIL (controls must still pass).
#
# One invocation = one mutation (the named source files reverted together to
# <pre-fix-rev>). The check ASSERTS: vitest's exit status against the mutated
# build must be non-zero, or the exploit tests are not testing the fix. Exit
# codes: 0 mutation detected; 1 MUTATION NOT DETECTED (the suite stayed green
# with the fix reverted); 2 refused (uncommitted changes); 3 the mutated tree
# did not build, so the mutation could not be evaluated. The original source is
# restored and rebuilt on every path.
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
restore() { for f in "$@"; do git checkout HEAD -- "$f"; done; npm run build >/dev/null 2>&1; }
for f in "$@"; do git show "$prefix:$f" > "$f"; done
if ! npm run build >/dev/null 2>&1; then
  echo "MUTATION NOT EVALUABLE: the tree does not build with $* at $prefix" >&2
  restore "$@"; exit 3
fi
log=$(mktemp)
npx vitest run "$testfile" > "$log" 2>&1; rc=$?
grep -E '✓|×|Tests ' "$log"; rm -f "$log"
restore "$@"
if [ "$rc" -eq 0 ]; then
  echo "MUTATION NOT DETECTED: $testfile stayed green with $* reverted to $prefix — the exploit tests do not test the fix" >&2
  exit 1
fi
echo "mutation detected: $testfile fails (vitest exit $rc) with $* reverted to $prefix"
