#!/usr/bin/env bash
# Composed jailed-network boundary proof (PRE-FREEZE, credential-free, non-binding).
#
# It proves ONE property — the composed AGENT NETWORK EDGE — and asserts each of
# four facts SEPARATELY, from inside the SAME jail namespace the agent would run in:
#
#     inside agent jail/netns  ->  allowlist-proxy  ->  supplied upstream proxy
#         ->  api.anthropic.com  ->  a real HTTP response observed
#
#   1. direct egress from inside the jail FAILS (no proxy bypass);
#   2. a non-allowlisted destination is DENIED BY THE ALLOWLIST (distinguished
#      from a mere DNS/network failure — the DENY decision must be observed);
#   3. the allowed destination succeeds through the intended chain — a genuine
#      Anthropic HTTP response, observed FROM INSIDE the jail (never host-side);
#   4. the SUPPLIED UPSTREAM is actually traversed — the upstream emits its own
#      CONNECT api.anthropic.com:443 evidence record, which this proof asserts
#      (setting HTTPS_PROXY is NOT, by itself, proof of traversal).
#
# It runs NO agent, deploys NO artefact, produces NO treatment outcome, needs NO
# OAuth token: a real Anthropic HTTP status (401/403/…) is sufficient because it
# shows traffic reached the real endpoint through the intended chain. It does not
# pretend to prove authenticated model execution.
#
# WHY ONLY THIS EDGE. The fully-credentialed joint
#   registered row -> PRE_AGENT liveness -> jail -> proxy -> authenticated Claude
#   -> candidate trajectory -> adjudication/verdict
# is, by run-task4.sh's deliberate design, runnable ONLY as a registered trajectory
# (it refuses a real agent outside a frozen manifest row), and is reserved for
# iteration-3 seq 1 after freeze, where the fail-closed start marker classifies any
# pre-execution composition failure as non-execution/apparatus failure rather than
# an experimental outcome. See DEVIATIONS D21. The other legs are proven
# independently (net-jail selftest, smoke4, preflight-auth, the liveness audit).
#
# HOST: Linux with iproute2 + nftables + sudo (the Ubuntu CI runner). It CANNOT run
# on Docker-Desktop-for-Mac — that kernel has no nf_tables (nft: "Netlink socket:
# Protocol not supported"), so the jail cannot be built there at all.
#
# EVIDENCE: a machine-readable NETWORK_INTEGRATION_PROOF block. No tokens, headers,
# credentials, or environment dumps are ever emitted.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$(cd "$HERE/../runner" && pwd)"
ALLOWLIST_PROXY="$RUNNER/allowlist-proxy.mjs"
UPSTREAM_PROXY="$HERE/ci-upstream-proxy.mjs"
NETJAIL="$RUNNER/net-jail.sh"

priv()  { if [ "$(id -u)" -ne 0 ]; then sudo "$@"; else "$@"; fi; }
privE() { if [ "$(id -u)" -ne 0 ]; then sudo -E "$@"; else "$@"; fi; }
say()   { printf '[net-proof] %s\n' "$*"; }

for c in ip nft node jq curl python3; do
  command -v "$c" >/dev/null || { say "MISSING $c — needs a Linux jail-capable host (the Ubuntu CI runner, NOT Docker-for-Mac)"; exit 2; }
done

UPSTREAM_PORT=8888
PROXY_PORT=$(( 20000 + RANDOM % 20000 ))
TAG="netproof-$$"
UPSTREAM_URL="http://127.0.0.1:${UPSTREAM_PORT}"
ALLOWED_HOST="api.anthropic.com"
DENIED_HOST="example.com"           # stable, deliberately outside the allowlist
TMP="$(mktemp -d "${TMPDIR:-/tmp}/net-proof-XXXXXX")"
NETLOG="$TMP/allowlist-decisions.log"; : > "$NETLOG"          # allowlist-proxy ALLOW/DENY
UPLOG="$TMP/upstream-connects.log";    : > "$UPLOG"           # ci-upstream CONNECT record
UP_PID=""; AP_PID=""; NS=""; HOSTIP=""

# the facts (+ observations), machine-readable at the end. Each negative/control
# has a DISTINCT named outcome (DIRECT_EGRESS_BLOCKED / DENIED_BY_ALLOWLIST /
# UPSTREAM_REQUIRED) so a forensic reader sees WHICH property held, not three bare
# booleans that all read `false` for different reasons.
jail_enforced=false
direct_egress_blocked=false          # DIRECT_EGRESS_BLOCKED
non_allowlisted_denied=false         # DENIED_BY_ALLOWLIST
allowlist_proxy_observed=false
upstream_proxy_observed=false        # upstream emitted its own CONNECT record
upstream_load_bearing=false          # UPSTREAM_REQUIRED (kill-upstream control)
remote_http_observed=false           # anthropic_reachable
STATUS="none"
UPSTREAM_CONNECT_TARGET="none"

cleanup() {
  [ -n "$AP_PID" ] && kill "$AP_PID" 2>/dev/null
  [ -n "$UP_PID" ] && kill "$UP_PID" 2>/dev/null
  [ -n "$NS" ] && priv bash "$NETJAIL" teardown "$TAG" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

emit() {   # machine-readable evidence block, then the human verdict
  local status="$1"
  echo
  echo "NETWORK_INTEGRATION_PROOF"
  echo "jail_enforced=$jail_enforced"
  echo "direct_egress_blocked=$direct_egress_blocked"
  echo "non_allowlisted_denied=$non_allowlisted_denied"
  echo "allowlisted_host=$ALLOWED_HOST"
  echo "allowlist_proxy_observed=$allowlist_proxy_observed"
  echo "upstream_proxy_observed=$upstream_proxy_observed"
  echo "upstream_connect_target=$UPSTREAM_CONNECT_TARGET"
  echo "upstream_load_bearing=$upstream_load_bearing"
  echo "remote_http_observed=$remote_http_observed"
  echo "jail_netns=$NS"
  echo "allowlist_proxy_endpoint=$HOSTIP:$PROXY_PORT"
  echo "supplied_upstream=$UPSTREAM_URL"
  echo "observed_http_status=$STATUS"
  echo "status=$status"
}

pass_all() { $jail_enforced && $direct_egress_blocked && $non_allowlisted_denied \
             && $allowlist_proxy_observed && $upstream_proxy_observed \
             && $upstream_load_bearing && $remote_http_observed; }

# ============================================================================
# FACT 0 — jail exists and ENFORCES isolation (also proves direct egress blocked
# against a local target: numeric + DNS egress blocked, port-confined).
# ============================================================================
say "[fact 0] net-jail.sh selftest — jail builds and enforces isolation"
if privE bash "$NETJAIL" selftest 2>&1 | sed 's/^/    /'; then
  jail_enforced=true; say "  jail builds and enforces (numeric + DNS direct egress blocked, port-confined)"
else
  say "  jail did not build/enforce — cannot proceed"; emit FAIL; exit 1
fi

# ---- bring up supplied upstream, real jail, allowlist proxy ------------------
say "[setup] supplied upstream: ci-upstream-proxy on 127.0.0.1:${UPSTREAM_PORT} (no credentials)"
TB_UPSTREAM_LOG="$UPLOG" node "$UPSTREAM_PROXY" "$UPSTREAM_PORT" >"$TMP/upstream.out" 2>&1 & UP_PID=$!
for _ in $(seq 1 40); do (exec 3<>/dev/tcp/127.0.0.1/$UPSTREAM_PORT) 2>/dev/null && { exec 3>&- 3<&-; break; }; sleep 0.25; done
kill -0 "$UP_PID" 2>/dev/null || { cat "$TMP/upstream.out"; say "supplied upstream did not start"; emit FAIL; exit 1; }

say "[setup] building the agent jail (net-jail.sh setup)"
read -r HOSTIP NS < <(privE bash "$NETJAIL" setup "$TAG" "$PROXY_PORT") \
  || { say "could not build the boundary jail"; emit FAIL; exit 1; }
say "        jail netns=$NS  allowlist endpoint=$HOSTIP:$PROXY_PORT  supplied upstream=$UPSTREAM_URL"

say "[setup] allowlist-proxy on $HOSTIP:$PROXY_PORT -> $UPSTREAM_URL (allow: $ALLOWED_HOST only)"
node "$ALLOWLIST_PROXY" "$PROXY_PORT" "$NETLOG" "$HOSTIP" "$UPSTREAM_URL" >"$TMP/allowlist.out" 2>&1 & AP_PID=$!
privE ip netns exec "$NS" bash -c "for _ in \$(seq 1 40); do (exec 3<>/dev/tcp/$HOSTIP/$PROXY_PORT) 2>/dev/null && exit 0; sleep 0.25; done; exit 1" \
  || { cat "$TMP/allowlist.out"; say "allowlist proxy never accepted a connection from inside the jail"; emit FAIL; exit 1; }

NETRUN=(privE ip netns exec "$NS")

# ============================================================================
# FACT 1 — DIRECT egress from inside the jail FAILS (same namespace, proxy vars
# deliberately removed) — both a hostname (no resolver) and a numeric IP (no route).
# ============================================================================
say "[fact 1] direct egress from inside $NS (no proxy) must fail"
"${NETRUN[@]}" env -u HTTPS_PROXY -u https_proxy curl -sS --max-time 10 --noproxy '*' -o /dev/null "https://$ALLOWED_HOST/" 2>/dev/null; DH=$?
"${NETRUN[@]}" env -u HTTPS_PROXY -u https_proxy curl -sS --max-time 10 --noproxy '*' -o /dev/null "https://1.1.1.1/" 2>/dev/null; DI=$?
if [ "$DH" != 0 ] && [ "$DI" != 0 ]; then
  direct_egress_blocked=true; say "  outcome=DIRECT_EGRESS_BLOCKED (hostname rc=$DH, numeric rc=$DI — both fail)"
else
  say "  outcome=DIRECT_EGRESS_OPEN — direct egress SUCCEEDED (hostname rc=$DH, numeric rc=$DI); chain is bypassable"
fi

# ============================================================================
# FACT 2 — a NON-allowlisted destination is DENIED BY THE ALLOWLIST. We key on the
# proxy's own DENY decision, so this is DENIED_BY_ALLOWLIST, not merely unreachable.
# ============================================================================
say "[fact 2] non-allowlisted $DENIED_HOST via the proxy must be DENIED BY THE ALLOWLIST"
"${NETRUN[@]}" env NO_PROXY= no_proxy= curl -sS --max-time 15 -o /dev/null \
    -x "http://$HOSTIP:$PROXY_PORT" "https://$DENIED_HOST/" 2>/dev/null; NRC=$?
if grep -q "DENY CONNECT ${DENIED_HOST}" "$NETLOG"; then
  non_allowlisted_denied=true; say "  outcome=DENIED_BY_ALLOWLIST: $DENIED_HOST (proxy logged DENY CONNECT; curl rc=$NRC)"
elif [ "$NRC" != 0 ]; then
  say "  outcome=UNREACHABLE_FOR_SOME_OTHER_REASON: $DENIED_HOST failed (rc=$NRC) but no allowlist DENY was observed — NOT the property we assert"
else
  say "  outcome=NON_ALLOWLISTED_REACHED: $DENIED_HOST was REACHED (rc=$NRC) — allowlist did not deny"
fi

# ============================================================================
# FACT 3 — the ALLOWED destination succeeds through the chain: a real Anthropic
# HTTP response FROM INSIDE the jail, the allowlist proxy is observed to ALLOW it,
# and the SUPPLIED UPSTREAM emits its own CONNECT api.anthropic.com:443 record.
# ============================================================================
say "[fact 3] allowed $ALLOWED_HOST via $HOSTIP:$PROXY_PORT -> $UPSTREAM_URL (from inside $NS)"
STATUS="$( "${NETRUN[@]}" env NO_PROXY= no_proxy= curl -sS --max-time 25 -o /dev/null \
             -w '%{http_code}' -x "http://$HOSTIP:$PROXY_PORT" "https://$ALLOWED_HOST/" 2>"$TMP/pos.err" )"; PRC=$?
say "        observed HTTP status: ${STATUS:-none} (curl rc=$PRC)"
if [ "$PRC" = 0 ] && printf '%s' "$STATUS" | grep -qE '^[234][0-9][0-9]$'; then
  remote_http_observed=true; say "  real $ALLOWED_HOST response observed from inside the jail (HTTP $STATUS)"
else
  STATUS="${STATUS:-none}"; say "  no real $ALLOWED_HOST response through the chain (status=$STATUS rc=$PRC): $(head -1 "$TMP/pos.err" 2>/dev/null)"
fi
if grep -q "ALLOW CONNECT ${ALLOWED_HOST}:" "$NETLOG"; then
  allowlist_proxy_observed=true; say "  allowlist proxy observed the request (ALLOW CONNECT ${ALLOWED_HOST})"
else
  say "  no ALLOW CONNECT ${ALLOWED_HOST} in the allowlist log — request did not traverse the allowlist proxy"
fi
UPSTREAM_CONNECT_TARGET="$(grep -oE "CONNECT ${ALLOWED_HOST}:[0-9]+" "$UPLOG" | head -1 | sed 's/^CONNECT //')"
if [ -n "$UPSTREAM_CONNECT_TARGET" ]; then
  upstream_proxy_observed=true; say "  supplied upstream traversed (its own record: CONNECT $UPSTREAM_CONNECT_TARGET)"
else
  UPSTREAM_CONNECT_TARGET="none"; say "  supplied upstream emitted no CONNECT record for $ALLOWED_HOST — traversal NOT proven"
fi

# ============================================================================
# FACT 4 — the SUPPLIED upstream is LOAD-BEARING (UPSTREAM_REQUIRED). Kill it and
# repeat the allowed jailed request: it MUST now fail. This rules out the most
# important alternative explanation for fact 3 — that the request ignored the
# configured upstream and escaped by some other route. Combined with the upstream's
# own CONNECT record, it proves the traffic both DID traverse the supplied upstream
# and could NOT have reached the endpoint without it.
# ============================================================================
say "[fact 4] load-bearing control: kill the supplied upstream; the allowed jailed request must now FAIL"
kill "$UP_PID" 2>/dev/null; wait "$UP_PID" 2>/dev/null; UP_PID=""
"${NETRUN[@]}" env NO_PROXY= no_proxy= curl -sS --max-time 15 -o /dev/null \
    -x "http://$HOSTIP:$PROXY_PORT" "https://$ALLOWED_HOST/" 2>/dev/null; LRC=$?
if [ "$LRC" != 0 ]; then
  upstream_load_bearing=true; say "  outcome=UPSTREAM_REQUIRED: with the supplied upstream down, $ALLOWED_HOST is unreachable (curl rc=$LRC)"
else
  say "  outcome=UPSTREAM_BYPASSED: $ALLOWED_HOST still reachable with the supplied upstream DOWN (rc=$LRC) — the chain is bypassable"
fi

# ============================================================================
if pass_all; then emit PASS; echo; say "STEP-6 NETWORK-BOUNDARY PROOF: PASS"; exit 0; fi
emit FAIL; echo; say "STEP-6 NETWORK-BOUNDARY PROOF: FAIL — one or more facts not established"; exit 1
