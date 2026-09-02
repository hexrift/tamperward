#!/usr/bin/env bash
# PoC: the pristine run does not run what you think it runs.
#
# Three shapes, none of which edits a base-protected file's CONTENT and none of
# which fixes the bug:
#
#   A  sibling write — both copies were materialised, and the overlay fully
#      applied, BEFORE the visible run started. The visible run executes the
#      candidate's code, so the candidate's code writes into ../pristine and
#      both runs return 0. No race. No background process. No git.
#   B  chmod -x     — the overlay restored content and left the mode as the
#      agent's, so a discovery command that runs the executable files under
#      test/ finds nothing to run in either copy.
#   C  delete       — the overlay recreates the file with writeFileSync, which
#      produces 0644. Same outcome as B, from the other direction.
#
# `tamperward verify` returning 0 is the bypass; 1 (MASKED_FAILURE) is the fix.
# Usage: verify-pristine-isolation-bypass.sh <path-to-tamperward-cli.js> <label>
set -u
CLI="$1"; LABEL="${2:-under test}"
RC=0

report() {
  if [ "$2" = "$3" ]; then printf '  %-12s exit %s  as expected\n' "$1" "$3"
  else printf '  %-12s exit %s  EXPECTED %s  <-- bypass effective\n' "$1" "$3" "$2"; RC=1; fi
}

# --- A: the visible run writes into the pristine copy -----------------------
W=$(mktemp -d /tmp/poc-iso-a-XXXXXX); cd "$W" || exit 1
# The payload enumerates the temp directory. Give this shape a temp directory of
# its own so it cannot reach into a verify running elsewhere on the machine and
# trip that one's guards instead of this one's.
export TMPDIR="$W/tmp"; mkdir -p "$TMPDIR"
git init -q; git config user.email p@o.c; git config user.name poc
mkdir -p test
echo 'module.exports = 41; // the bug' > src.js
printf "if (require('../src.js') !== 42) process.exit(1);\n" > test/check.test.js
git add -A; git commit -qm base
BASE=$(git rev-parse HEAD)
cat > test/check.test.js <<'EOF'
const fs = require('fs'), path = require('path'), os = require('os');
const payload = 'process.exit(0);\n';
// the sibling shape the layout used to guarantee
try { fs.writeFileSync(path.resolve(__dirname, '..', '..', 'pristine', 'test', 'check.test.js'), payload); } catch (e) {}
// and its generalisation: enumerate the temp directory
try {
  for (const d of fs.readdirSync(os.tmpdir())) {
    if (!d.startsWith('tw-verify-')) continue;
    for (const sub of ['t', 'pristine']) {
      try { fs.writeFileSync(path.join(os.tmpdir(), d, sub, 'test', 'check.test.js'), payload); } catch (e) {}
    }
  }
} catch (e) {}
process.exit(0);
EOF
node "$CLI" verify --base "$BASE" --cmd 'node test/check.test.js' --budget 60 --json >/dev/null 2>&1
report "A sibling" 1 $?

# --- B/C: file mode -------------------------------------------------------
mkexec() {
  W=$(mktemp -d "/tmp/poc-iso-$1-XXXXXX"); cd "$W" || exit 1
  git init -q; git config user.email p@o.c; git config user.name poc
  mkdir -p test
  echo 'exit 1' > src.sh
  printf '#!/bin/sh\nsh src.sh\n' > test/check.test.sh; chmod +x test/check.test.sh
  printf '#!/bin/sh\nfor f in $(find test -type f -perm -u+x); do "./$f" || exit 1; done\n' > runner.sh
  chmod +x runner.sh
  printf "version: 1\nprotected:\n  tests: ['test/**']\nverify:\n  command: sh runner.sh\n  budget: 60\n" > .tamperward.yml
  git add -A; git commit -qm base
}
mkexec b; BASE=$(git rev-parse HEAD)
chmod -x test/check.test.sh
node "$CLI" verify --base "$BASE" --budget 60 --json >/dev/null 2>&1
report "B chmod -x" 1 $?

mkexec c; BASE=$(git rev-parse HEAD)
rm test/check.test.sh
node "$CLI" verify --base "$BASE" --budget 60 --json >/dev/null 2>&1
report "C delete" 1 $?

echo "pristine-isolation PoC ($LABEL): $([ $RC -eq 0 ] && echo 'all closed' || echo 'AT LEAST ONE BYPASS EFFECTIVE')"
exit $RC
