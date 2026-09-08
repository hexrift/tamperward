#!/usr/bin/env bash
# Selftest for the positive execution contract (agent-exec-contract.mjs).
#
# The contract is the single authority for "did an agent genuinely execute?".
# These cases pin the POSITIVE semantics: executed=true ONLY on proof of a real
# model completion; every ambiguous or degenerate transcript is executed=false so
# an unexecuted agent can never become a counted trajectory. The shapes are taken
# from what Claude Code actually emits — in particular the "<synthetic>" assistant
# turn with is_api_error_message it produces when the credential is rejected, which
# is exactly the failure that recorded a bogus NOT_FIXED at pilot seq 1.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MOD="$HERE/agent-exec-contract.mjs"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/exec-contract-selftest-XXXXXX")" || exit 1
trap 'rm -rf "$WORK"' EXIT
fail=0
# check <name> <expect: EXEC|NOEXEC> <fixture-file>
check() {
  local name="$1" expect="$2" f="$3" out rc
  out="$(node "$MOD" "$f" 2>&1)"; rc=$?
  local got=NOEXEC; [ "$rc" -eq 0 ] && got=EXEC
  if [ "$got" = "$expect" ]; then
    printf 'ok    %-28s %s\n' "$name" "$out"
  else
    printf 'FAIL  %-28s expected %s got %s (rc=%s) :: %s\n' "$name" "$expect" "$got" "$rc" "$out"
    fail=1
  fi
}

# --- a genuine completion: real model + real token usage --------------------
cat > "$WORK/genuine.jsonl" <<'EOF'
{"type":"system","subtype":"init","session_id":"s"}
{"type":"assistant","message":{"model":"claude-sonnet-5","role":"assistant","usage":{"input_tokens":1200,"output_tokens":45}},"session_id":"s"}
{"type":"result","subtype":"success"}
EOF
check genuine EXEC "$WORK/genuine.jsonl"

# --- genuine turn then a TORN final line (agent killed mid-stream) -----------
cat > "$WORK/genuine-torn.jsonl" <<'EOF'
{"type":"system","subtype":"init"}
{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"input_tokens":800,"output_tokens":10}}}
{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"input_tokens":900,"output_to
EOF
check genuine-torn EXEC "$WORK/genuine-torn.jsonl"

# --- output-only turn (some completions emit output before input accounting) -
cat > "$WORK/output-only.jsonl" <<'EOF'
{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"input_tokens":0,"output_tokens":7}}}
EOF
check output-only EXEC "$WORK/output-only.jsonl"

# --- the REAL synthetic auth-failure shape: <synthetic> + api_error + 0 tokens
cat > "$WORK/synthetic-auth.jsonl" <<'EOF'
{"type":"system","subtype":"init","session_id":"s"}
{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","usage":{"input_tokens":0,"output_tokens":0},"content":[{"type":"text","text":"Invalid auth token"}]},"is_api_error_message":true,"error":"invalid_request"}
{"duration_api_ms":0,"stop_reason":"stop_sequence","total_cost_usd":0,"terminal_reason":"api_error"}
EOF
check synthetic-auth NOEXEC "$WORK/synthetic-auth.jsonl"

# --- assistant with a real model but ZERO token usage (no real turn) ---------
cat > "$WORK/zero-token.jsonl" <<'EOF'
{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"input_tokens":0,"output_tokens":0}}}
EOF
check zero-token NOEXEC "$WORK/zero-token.jsonl"

# --- a real model id but flagged as an api-error message ---------------------
cat > "$WORK/model-but-apierror.jsonl" <<'EOF'
{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"input_tokens":10,"output_tokens":1}},"is_api_error_message":true}
EOF
check model-but-apierror NOEXEC "$WORK/model-but-apierror.jsonl"

# --- system + result only, no assistant turn --------------------------------
cat > "$WORK/no-assistant.jsonl" <<'EOF'
{"type":"system","subtype":"init"}
{"type":"result","subtype":"error_during_execution"}
EOF
check no-assistant NOEXEC "$WORK/no-assistant.jsonl"

# --- empty transcript --------------------------------------------------------
: > "$WORK/empty.jsonl"
check empty NOEXEC "$WORK/empty.jsonl"

# --- only-garbage / non-JSON lines ------------------------------------------
printf 'not json\n{also not\n' > "$WORK/garbage.jsonl"
check garbage NOEXEC "$WORK/garbage.jsonl"

# --- unreadable transcript (missing file) -----------------------------------
check missing NOEXEC "$WORK/does-not-exist.jsonl"

if [ "$fail" = 0 ]; then echo "agent-exec-contract.selftest: ALL PASS"; else echo "agent-exec-contract.selftest: FAILURES"; fi
exit "$fail"
