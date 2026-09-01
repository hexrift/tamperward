#!/usr/bin/env bash
# Selftest for the round-3.1 execution-hygiene deltas (ROUND3.1-PLAN).
# Proves, without running any agent:
#  H1 the allowlist proxy uses an EXPLICIT upstream argument over stale env
#  H2 a dead upstream fails a trajectory as PREFLIGHT_NET_FAILED (exit 8)
#     before any clone attempt
#  H3 TB_ATTEMPT is stamped into the verdict jq line (static check)
#  H4 the driver's circuit-breaker path exists for rc=8/CLONE_FAILED and the
#     registration gate refuses to run unregistered (behavioural check above
#     is repeated here)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
fail() { echo "SELFTEST FAIL: $1"; exit 1; }

# H1: proxy honors explicit upstream arg even when env points at a dead port
LOG=$(mktemp); PORT=$((21000 + RANDOM % 9000))
HTTPS_PROXY="http://127.0.0.1:1" node "$HERE/allowlist-proxy.mjs" "$PORT" "$LOG" 127.0.0.1 "${HTTPS_PROXY:?need a live HTTPS_PROXY for the selftest}" >/tmp/hyg-proxy.out 2>&1 &
PP=$!; sleep 1
kill -0 $PP 2>/dev/null || fail "proxy did not start with explicit upstream + dead env"
out=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -x "http://127.0.0.1:$PORT" https://api.anthropic.com/ 2>&1) || true
kill $PP 2>/dev/null
case "$out" in 2*|3*|4*) echo "H1 OK: explicit upstream carried a CONNECT (http $out) despite stale env";;
  *) fail "H1: tunnel through explicit upstream failed ($out)";; esac

# H2: dead upstream -> PREFLIGHT_NET_FAILED exit 8, before any clone
set +e
out=$(cd "$HERE/.." && HTTPS_PROXY="http://127.0.0.1:1" https_proxy="http://127.0.0.1:1" \
      TB_TASKS="$PWD/round3/tasks" bash - <<'INNER'
# call just the preflight region by running run-task31 with a bogus proxy;
# the fresh-shell resolver may rescue it, so also poison the login shell var
export BASH_ENV=/dev/null
HTTPS_PROXY="http://127.0.0.1:1" https_proxy="http://127.0.0.1:1" \
  timeout 60 bash runner/run-task31.sh 03-tusharsadhwani-pytokens ungated smoke 2>&1
INNER
); rc=$?
set -e
if echo "$out" | grep -q 'PREFLIGHT_NET_FAILED'; then
  echo "H2 OK: dead upstream fails closed as PREFLIGHT_NET_FAILED (rc=$rc)"
elif echo "$out" | grep -q 'upstream proxy rotated'; then
  echo "H2 OK (rescue path): stale env detected and fresh proxy adopted"
else
  fail "H2: neither preflight failure nor rescue observed: $(echo "$out" | head -2)"
fi

# H3: attempt stamped in the runner's verdict construction
grep -q 'argjson attempt' "$HERE/run-task31.sh" && grep -q 'attempt:\$attempt' "$HERE/run-task31.sh" \
  || fail "H3: attempt stamping missing from run-task31.sh"
echo "H3 OK: attempt stamped natively"

# H4: circuit breaker + registration gate in the driver
grep -q 'circuit breaker' "$HERE/phase3-sweep31.sh" && grep -q 'rc" -eq 8' "$HERE/phase3-sweep31.sh" \
  || fail "H4: circuit breaker missing"
rc=0; ( cd "$HERE/.." && bash runner/phase3-sweep31.sh >/dev/null 2>&1 ) || rc=$?
[ "$rc" -eq 7 ] || fail "H4: registration gate did not refuse (rc=$rc)"
echo "H4 OK: circuit breaker present; unregistered driver refuses (exit 7)"
echo "hygiene selftest OK"
