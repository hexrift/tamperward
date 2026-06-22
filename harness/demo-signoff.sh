#!/usr/bin/env bash
# Reproducible demonstration of the three-layer sign-off trust model — the artifact that proves
# the escape valve is safe BY DESIGN, not by accident. Each layer honors only a signal the party
# it protects against cannot forge:
#   AGENT (hook): honors nothing — denies even the agent's own ledger sign-off.
#   LOCAL (pre-commit): honors a human's fingerprint-bound ledger entry.
#   CI (authority): ignores the committed ledger; honors only an out-of-band approval (env from a
#                   reviewed label / CODEOWNERS), which the PR/agent cannot author.
# Usage: bash harness/demo-signoff.sh   (run from the repo root after `npm run build`)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; CLI="$ROOT/dist/cli/index.js"
D="$(mktemp -d)"; mkdir -p "$D/src"
CLEAN='export function parse(s: string): number { const r: unknown = JSON.parse(s); return Number(r); }'
CAST='export function parse(s: string): number { const r = JSON.parse(s) as any; return r.value; }'
printf '%s\n' "$CLEAN" > "$D/src/parse.ts"
( cd "$D" && git init -q && git add -A && git -c user.email=h@x -c user.name=h commit -qm baseline )
payload(){ node -e 'process.stdout.write(JSON.stringify({cwd:process.argv[1],tool_name:"Write",tool_input:{file_path:process.argv[1]+"/src/parse.ts",content:process.argv[2]+"\n"}}))' "$D" "$CAST"; }
hookdeny(){ payload | node "$CLI" hook claude | grep -oq '"permissionDecision":"deny"' && echo "DENIED" || echo "allowed"; }

# Pre-create a human sign-off bound to this exact cast (apply -> allow -> revert to clean tree).
printf '%s\n' "$CAST" > "$D/src/parse.ts"
( cd "$D" && node "$CLI" allow ts-any-cast --file src/parse.ts --reason "human: reviewed, dynamic boundary" >/dev/null 2>&1 )
( cd "$D" && git checkout -q -- src/parse.ts )

echo "Setup: tree clean; a fingerprint-bound sign-off for this exact cast sits in the ledger."
echo "STEP 1  AGENT hook, agent introduces the cast (net-new):        $(hookdeny)"
echo "STEP 2  AGENT hook again, WITH its own ledger sign-off present: $(hookdeny)   <- never consults the ledger (THE GUARANTEE)"
printf '%s\n' "$CAST" > "$D/src/parse.ts"; ( cd "$D" && git add -A )
( cd "$D" && node "$CLI" check --staged >/dev/null 2>"$D/.e"; echo "STEP 3  LOCAL pre-commit (human sign-off honored): exit $? $(sed -n 's/.*\(cleared by local.*\)/(\1)/p' "$D/.e")" )
( cd "$D" && git -c user.email=h@x -c user.name=h commit -qm "cast+ledger" )
( cd "$D" && node "$CLI" check --diff HEAD~1...HEAD >/dev/null 2>&1; echo "STEP 4  CI authority (committed ledger IGNORED): exit $? (1=still blocked)" )
( cd "$D" && HOLDFAST_OOB_SIGNOFF=ts-any-cast node "$CLI" check --diff HEAD~1...HEAD >/dev/null 2>"$D/.e2"; echo "STEP 5  CI + out-of-band approval: exit $? $(sed -n 's/.*\(cleared by out-of-band.*\)/(\1)/p' "$D/.e2")" )
rm -rf "$D"
