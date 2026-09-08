#!/usr/bin/env bash
# Non-consuming credential preflight — the POSITIVE CONTROL for a dispatch.
#
# Proves the provisioned credential can obtain a GENUINE model completion BEFORE
# any trajectory is dispatched, so the ordinary failure (a malformed, revoked or
# unprovisioned token; a broken egress route) fails the job fast and burns
# nothing. It uses the SAME credential resolution, the SAME claude CLI, the SAME
# registered model and the SAME proxy egress route as a real dispatch — but a
# trivial, non-task prompt, in a throwaway workdir, creating NO trajectory state
# (no .started, no <task>-<arm>.verdict.json, no results.jsonl, nothing under a
# runs directory). It PASSES only when the shared execution contract
# (agent-exec-contract.mjs) — the same authority the runner applies after a real
# agent run — can prove a real completion. The runner-side gate remains
# authoritative: credentials/API availability can fail AFTER preflight, and only
# the runner guards that.
#
# It deliberately does NOT reproduce the mount/PID/net namespace jail: that is
# egress/isolation confinement, not authentication, and standing it up for a
# throwaway probe would add failure modes unrelated to the credential. The
# credential, CLI, model and proxy route — everything auth actually depends on —
# are identical to the dispatch.
#
# Usage: preflight-auth.sh [MODEL]
#   MODEL defaults to $TB_REGISTERED_MODEL, then $TB_MODEL, then the argument,
#   then claude-sonnet-5.
# Exit 0 = genuine completion proven; 7 = no credential present; 8 = credential
# could not obtain a real completion. Non-zero means: fix it before dispatch —
# nothing was consumed.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MODEL="${1:-${TB_REGISTERED_MODEL:-${TB_MODEL:-claude-sonnet-5}}}"

# Same credential requirement as a registered dispatch (run-task4.sh
# cred_env_present): an ENV credential must be present. A preflight that "passed"
# with no credential would defeat its own purpose.
present=0
for k in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN; do
  [ -n "${!k:-}" ] && present=1
done
[ "$present" = 1 ] || { echo "PREFLIGHT_FAIL: no credential in ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN — provision one before dispatch." >&2; exit 7; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tb-preflight-XXXXXX")" || { echo "PREFLIGHT_FAIL: mktemp" >&2; exit 1; }
trap 'rm -rf "$WORK"' EXIT
TRANSCRIPT="$WORK/probe.jsonl"

# Same invocation shape as the real agent (claude -p, registered model,
# stream-json), through whatever proxy env is already in effect, with a trivial
# non-task prompt so nothing about any pilot task is exposed. A test may substitute
# the CLI via TB_PREFLIGHT_CLI to exercise this script deterministically without a
# network; the default is the real `claude` on PATH.
CLI="${TB_PREFLIGHT_CLI:-claude}"
run_bounded() { # bound the probe if a timeout is available; portable (no bash-4 arrays)
  if command -v timeout >/dev/null 2>&1; then
    timeout --signal=TERM --kill-after=15 "${TB_PREFLIGHT_SECS:-120}" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout --signal=TERM --kill-after=15 "${TB_PREFLIGHT_SECS:-120}" "$@"
  else
    "$@"
  fi
}
run_bounded "$CLI" -p "Reply with the single word READY and nothing else." \
    --model "$MODEL" --output-format stream-json --verbose \
  > "$TRANSCRIPT" 2>"$WORK/probe.err"
RC=$?

# The authority is the SAME positive contract the runner uses; the CLI exit status
# is deliberately NOT trusted (claude can exit 0 while emitting a <synthetic>
# api_error turn — exactly the seq-1 failure).
if node "$HERE/agent-exec-contract.mjs" "$TRANSCRIPT"; then
  echo "PREFLIGHT_OK: credential obtained a genuine completion (model $MODEL)."
  exit 0
fi
{
  echo "PREFLIGHT_FAIL: no genuine model completion (cli_rc=$RC, model $MODEL)."
  echo "  The credential/route cannot obtain a real completion — fix it before dispatch; nothing was consumed."
  echo "  transcript head:"; head -c 600 "$TRANSCRIPT" 2>/dev/null | tr -d '\r'; echo
  echo "  stderr head:";     head -c 300 "$WORK/probe.err" 2>/dev/null; echo
} >&2
exit 8
