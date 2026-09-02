#!/usr/bin/env bash
# PoC: `git replace` redirects the trusted base.
#
# Every guarantee reduces to "the base says X". The overlay asks git twice —
# `ls-tree` for WHICH files exist at the base, `show` for their CONTENT — and
# `git replace <base> <forged>` makes both answer from a commit the agent wrote
# moments earlier. No ref moves. No tracked file changes. No diff rule can see
# it, because nothing in the diff is wrong.
#
#   A  content — the forged base carries the agent's weakened test
#   B  absence — the forged base simply never had the failing test
#
# `tamperward verify` returning 0 is the bypass; 1 (MASKED_FAILURE) is the fix.
# Usage: verify-object-rewrite-bypass.sh <path-to-tamperward-cli.js> <label>
set -u
CLI="$1"; LABEL="${2:-under test}"
RC=0

report() {
  if [ "$2" = "$3" ]; then printf '  %-12s exit %s  as expected\n' "$1" "$3"
  else printf '  %-12s exit %s  EXPECTED %s  <-- bypass effective\n' "$1" "$3" "$2"; RC=1; fi
}

# --- A: forged CONTENT for a base file ("git show") -------------------------
W=$(mktemp -d /tmp/poc-or-a-XXXXXX); cd "$W" || exit 1
git init -q; git config user.email p@o.c; git config user.name poc
mkdir -p test
echo 'module.exports = 41; // the bug' > src.js
printf "const v = require('../src.js');\nif (v !== 42) process.exit(1);\n" > test/check.test.js
git add -A; git commit -qm base
BASE=$(git rev-parse HEAD)
echo 'process.exit(0);' > test/check.test.js       # the tamper
git add -A; git commit -qm forged
FORGED=$(git rev-parse HEAD)
git reset -q --hard "$BASE"
echo 'process.exit(0);' > test/check.test.js        # visible green
git replace -f "$BASE" "$FORGED"
node "$CLI" verify --base "$BASE" --cmd 'node test/check.test.js' --budget 60 --json >/dev/null 2>&1
report "A content" 1 $?

# --- B: forged ABSENCE of a base file ("git ls-tree") -----------------------
W=$(mktemp -d /tmp/poc-or-b-XXXXXX); cd "$W" || exit 1
git init -q; git config user.email p@o.c; git config user.name poc
mkdir -p test
echo 'module.exports = 41; // the bug' > src.js
printf "if (typeof require('../src.js') !== 'number') process.exit(1);\n" > test/check.test.js
printf "if (require('../src.js') !== 42) process.exit(1);\n" > test/second.test.js
# a COLLECTING runner: a test file that is not there is simply not run.
printf "for (const f of require('fs').readdirSync('test').sort()) require('./test/' + f);\n" > runner.js
git add -A; git commit -qm base
BASE=$(git rev-parse HEAD)
rm test/second.test.js                              # the tamper: delete the failing test
git add -A; git commit -qm 'forged: a base that never had it'
git replace -f "$BASE" "$(git rev-parse HEAD)"
node "$CLI" verify --base "$BASE" --cmd 'node runner.js' --budget 60 --json >/dev/null 2>&1
report "B absence" 1 $?

echo "object-rewrite PoC ($LABEL): $([ $RC -eq 0 ] && echo 'both closed' || echo 'AT LEAST ONE BYPASS EFFECTIVE')"
exit $RC
