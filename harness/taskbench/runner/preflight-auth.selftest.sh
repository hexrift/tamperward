#!/usr/bin/env bash
# Selftest for the non-consuming credential preflight (preflight-auth.sh).
#
# Deterministic and offline: the claude CLI is stubbed via TB_PREFLIGHT_CLI to
# emit a chosen transcript, so we can prove the preflight's decisions and, above
# all, that it consumes NO trajectory state. The stub exits 0 even on the
# synthetic case (as the real CLI does), which is exactly why the preflight must
# trust the execution contract and not the CLI exit status.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PF="$HERE/preflight-auth.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/preflight-selftest-XXXXXX")" || exit 1
trap 'rm -rf "$WORK"' EXIT
fail=0

# A stub CLI that cats a fixture to stdout regardless of args, exit 0.
make_stub() { # <path-to-fixture>
  local stub="$WORK/claude-stub-$RANDOM.sh"
  cat > "$stub" <<EOF
#!/usr/bin/env bash
cat "$1"
exit 0
EOF
  chmod +x "$stub"; echo "$stub"
}

cat > "$WORK/genuine.jsonl" <<'EOF'
{"type":"system","subtype":"init"}
{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"input_tokens":20,"output_tokens":2}}}
{"type":"result","subtype":"success"}
EOF
cat > "$WORK/synthetic.jsonl" <<'EOF'
{"type":"assistant","message":{"model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0}},"is_api_error_message":true}
EOF

# A canary runs directory: the preflight must never create anything in it.
RUNS="$WORK/runs"; mkdir -p "$RUNS"
canary_clean() { [ -z "$(ls -A "$RUNS" 2>/dev/null)" ]; }

check() { # <name> <expect-rc> ; runs with env already set
  local name="$1" exp="$2"; shift 2
  local out rc; out="$("$@" 2>&1)"; rc=$?
  if [ "$rc" = "$exp" ] && canary_clean; then
    printf 'ok    %-26s rc=%s (no trajectory state)\n' "$name" "$rc"
  else
    printf 'FAIL  %-26s expected rc=%s got rc=%s ; runs-empty=%s :: %s\n' \
      "$name" "$exp" "$rc" "$(canary_clean && echo yes || echo NO)" "$out"
    fail=1
  fi
}

STUB_OK="$(make_stub "$WORK/genuine.jsonl")"
STUB_SYN="$(make_stub "$WORK/synthetic.jsonl")"

# env is the executable in each case (not a prefix to the shell function), so it
# runs the real `bash "$PF"` chain with a controlled credential environment.
# 1. positive control: a genuine completion => PREFLIGHT_OK, exit 0
check positive-control 0 \
  env CLAUDE_CODE_OAUTH_TOKEN=dummy-token-value TB_PREFLIGHT_CLI="$STUB_OK" TB_RUNS="$RUNS" \
  bash "$PF" claude-sonnet-5

# 2. synthetic/api_error completion => PREFLIGHT_FAIL, exit 8 (CLI exit 0 ignored)
check synthetic-fail 8 \
  env CLAUDE_CODE_OAUTH_TOKEN=dummy-token-value TB_PREFLIGHT_CLI="$STUB_SYN" TB_RUNS="$RUNS" \
  bash "$PF" claude-sonnet-5

# 3. no credential present => exit 7, before any call
check no-credential 7 \
  env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN \
  TB_PREFLIGHT_CLI="$STUB_OK" TB_RUNS="$RUNS" \
  bash "$PF" claude-sonnet-5

if [ "$fail" = 0 ]; then echo "preflight-auth.selftest: ALL PASS"; else echo "preflight-auth.selftest: FAILURES"; fi
exit "$fail"
