#!/usr/bin/env bash
# Demonstrates the round-4 agent isolation boundary (freeze-checklist item 4/5 and
# the caution-2 list). Not feasibility — it exercises agent-jail4.sh and asserts,
# from INSIDE the jail: host processes, the control plane (oracle/ledger/runner),
# the Docker socket, and unrelated credential/cloud/SSH/token material are all
# unreachable; there is no /proc/*/root escape to a masked path; capabilities are
# dropped; the candidate tree is WRITABLE; the pinned artefact is READ-ONLY; and
# the active Claude credential IS reachable (the disclosed partial), identically —
# which is what preserves cross-arm symmetry.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
pass=0; fail=0
ok(){ echo "  ok   $1"; pass=$((pass+1)); }
no(){ echo "  FAIL $1"; fail=$((fail+1)); }

command -v unshare >/dev/null && unshare --pid --mount --fork --mount-proc true 2>/dev/null \
  || { echo "SKIP: this host cannot create pid/mount namespaces (needs CAP_SYS_ADMIN)"; exit 0; }

# fake control plane + unrelated secrets
ORACLE=$(mktemp -d); echo "GOLDEN-ORACLE" > "$ORACLE/withheld.json"
LEDGER=$(mktemp -d); echo "verdicts" > "$LEDGER/results.jsonl"
RUNNER=$(mktemp -d); echo "adjudicator" > "$RUNNER/verdict4.mjs"
WORK=$(mktemp -d); echo "src" > "$WORK/src.py"
RO=$(mktemp -d); echo "frozen-package" > "$RO/cli.js"
ac_aws=0; [ -e "$HOME/.aws" ] || { mkdir -p "$HOME/.aws"; echo AKIA-FAKE > "$HOME/.aws/credentials"; ac_aws=1; }
ac_ssh=0; [ -e "$HOME/.ssh/id_probe" ] || { mkdir -p "$HOME/.ssh"; echo PRIVKEY > "$HOME/.ssh/id_probe"; ac_ssh=1; }
cleanup(){ rm -rf "$ORACLE" "$LEDGER" "$RUNNER" "$WORK" "$RO"; [ "$ac_aws" = 1 ] && rm -rf "$HOME/.aws"; [ "$ac_ssh" = 1 ] && rm -f "$HOME/.ssh/id_probe"; }
trap cleanup EXIT

echo "== agent isolation boundary (agent-jail4.sh) =="
PROBE=$(TB_JAIL_MASK="$ORACLE:$LEDGER:$RUNNER" TB_JAIL_PROBE=1 ./agent-jail4.sh - -- true 2>/dev/null)
g(){ printf '%s\n' "$PROBE" | grep -E "^$1 " | awk '{print $2}'; }
[ "$(g host-procs)" -lt 20 ] 2>/dev/null && ok "host processes are hidden (PID ns): $(g host-procs) visible, not the host's" || no "host procs visible: $(g host-procs)"
[ "$(g docker-sock)" = masked ] && ok "docker socket masked" || no "docker sock: $(g docker-sock)"
[ "$(g ssh)" = masked ] && ok "SSH material masked" || no "ssh: $(g ssh)"
[ "$(g aws)" = masked ] && ok "cloud (aws) credentials masked" || no "aws: $(g aws)"
printf '%s\n' "$PROBE" | grep -q "^ctrl:$ORACLE masked" && ok "oracle masked" || no "oracle: $(printf '%s\n' "$PROBE"|grep ctrl:$ORACLE)"
printf '%s\n' "$PROBE" | grep -q "^ctrl:$LEDGER masked" && ok "result ledger masked" || no "ledger not masked"
printf '%s\n' "$PROBE" | grep -q "^ctrl:$RUNNER masked" && ok "adjudicator/runner masked" || no "runner not masked"
[ "$(g proc-root-escape)" = no ] && ok "no /proc/*/root escape to a masked path" || no "proc-root escape: $(g proc-root-escape)"
[ "$(g agent-caps)" = 0000000000000000 ] && ok "all capabilities dropped for the agent exec" || no "agent caps: $(g agent-caps)"

echo "== the candidate tree is writable; the pinned artefact is read-only =="
# a real command in the jail (not the probe): write the workspace, try the artefact
R=$(TB_JAIL_MASK="$ORACLE" TB_JAIL_RO="$RO" ./agent-jail4.sh - -- bash -c '
  touch "'"$WORK"'/agent-wrote" 2>/dev/null && echo "work-writable" || echo "work-READONLY"
  ( echo x > "'"$RO"'/cli.js" ) 2>/dev/null && echo "artefact-WRITABLE" || echo "artefact-readonly"
  cat "'"$RO"'/cli.js"' 2>/dev/null)
echo "$R" | grep -q work-writable && ok "candidate tree is writable inside the jail" || no "candidate tree not writable: $R"
echo "$R" | grep -q artefact-readonly && ok "pinned artefact is read-only (cannot be replaced)" || no "artefact writable: $R"
echo "$R" | grep -q frozen-package && ok "pinned artefact is still READABLE (offline execution intact)" || no "artefact unreadable: $R"

echo "== disclosed partial: the active Claude credential is reachable, symmetrically =="
# Do NOT print the credential; only confirm reachability (the disclosed limitation)
# and that the jail does not asymmetrically hide/expose it. ~/.claude.json exists
# in this environment; the jail leaves it reachable by design.
if [ -e "$HOME/.claude.json" ]; then
  R=$(./agent-jail4.sh - -- bash -c '[ -r "$HOME/.claude.json" ] && echo reachable || echo masked' 2>/dev/null)
  [ "$R" = reachable ] && ok "active Claude credential reachable (disclosed partial; identical in both arms)" \
    || no "claude credential unexpectedly masked ($R) — would break auth AND asymmetry"
else
  ok "no ~/.claude.json present to check (env-specific)"
fi

echo; echo "passed $pass, failed $fail"; [ "$fail" = 0 ]
