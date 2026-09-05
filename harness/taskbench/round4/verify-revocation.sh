#!/usr/bin/env bash
# Round-4 registered step 6, second half: VERIFY that the pilot credential is dead.
#
# The registered credential lifecycle (DEVIATIONS, "Credential isolation — the
# authoritative record") requires at point 7 that "revocation is tested, not
# merely assumed (a post-revocation call must fail)". Revocation is an operator
# action; this is the test, and its whole job is to be unable to produce a
# confirmation that is not true.
#
# WHY THE AGENT CLI IS THE GROUND TRUTH. A hand-rolled request with a guessed
# header shape cannot distinguish "the token is revoked" from "I framed the
# request wrong" — both return 401, and the second would record a false death.
# The pilot's own client cannot make that mistake: it builds the request the way
# it built the 20 that worked. So the primary test runs the freeze-pinned CLI and
# requires it to fail to authenticate. The HTTP call is corroboration only.
#
# THE POSITIVE CONTROL IS HISTORICAL. This CLI version authenticated with this
# credential fingerprint across all 20 pilot trajectories on 2026-09-04 (every
# runs-pilot/*-provenance.json records it). "Same client, same credential,
# previously accepted, now refused" is a before/after with a live arm.
#
# THE NEGATIVE CONTROL IS MEASURED IN THIS RUN, NOT ASSUMED. What exit code does
# this CLI return when a credential is REJECTED, as opposed to when it crashes,
# is missing, or is killed? Guessing that, or accepting "any nonzero exit", lets
# an abnormal client failure be recorded as revocation. So the check first runs
# the same CLI, the same way, with a synthetic INVALID token, and measures the
# rejection exit code and the 401 the wire returns for a rejected credential. The
# credential under test must then reproduce THAT signature exactly. If the
# controls themselves do not behave like a rejection, the instrument did not
# calibrate and the verdict is INCONCLUSIVE — never a pass.
#
# The synthetic control token is invalid by construction. Nothing here mints,
# regenerates or reactivates a credential.
#
# NOTHING IS DISPATCHER-CONTROLLED. The expected fingerprint, length and CLI
# version come from files committed next to this script — the credential binding
# record and the frozen pilot manifest. If they were inputs, anyone could point
# the check at a different revoked token, supply its fingerprint, and harvest a
# REVOKED. They are not inputs.
#
# Never prints, logs or persists credential material — not the token, and not raw
# client output, which is attacker-influenced text that can carry whatever the
# response body contained. Only the one-way fingerprint, exit codes, a boolean
# signature and the HTTP status leave this script.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINDING="$HERE/pilot-credential.json"
MANIFEST="$HERE/PILOT-EXECUTION-MANIFEST.json"
OUT_DIR="${TB_REVOCATION_OUT:-${RUNNER_TEMP:-/tmp}/revocation-check}"
rm -rf "$OUT_DIR"; mkdir -p "$OUT_DIR"

fail() { echo "::error::$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }
need jq; need curl
# The fingerprint construction must be byte-identical to run-task4.sh's, which
# uses sha256sum. macOS ships `shasum -a 256` instead; same digest, so the
# self-test runs on a developer machine without weakening what CI computes.
if command -v sha256sum >/dev/null 2>&1; then sha256_hex() { sha256sum; }
elif command -v shasum >/dev/null 2>&1; then sha256_hex() { shasum -a 256; }
else fail "no sha256sum or shasum"; fi
# coreutils `timeout` on the Linux runner this actually runs on; a bash watchdog
# elsewhere so the self-test is runnable on a developer machine. Both report a
# killed client as 124, which the classification treats as INCONCLUSIVE.
if command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN=timeout
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN=gtimeout
else TIMEOUT_BIN=; fi
run_limited() {
  local secs=$1; shift
  if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" "$secs" "$@"; return $?; fi
  "$@" & local pid=$! rc=0
  ( sleep "$secs"; kill -TERM "$pid" 2>/dev/null ) & local watch=$!
  wait "$pid"; rc=$?
  kill "$watch" 2>/dev/null; wait "$watch" 2>/dev/null
  [ "$rc" = 143 ] && rc=124
  return $rc
}

# ---- the identities the check is pinned to (committed, never dispatched) ----
[ -r "$BINDING" ]  || fail "credential binding record missing: $BINDING"
[ -r "$MANIFEST" ] || fail "frozen pilot manifest missing: $MANIFEST"
EXPECT_FP=$(jq -er '.fingerprint_sha256_16' "$BINDING")  || fail "binding record has no fingerprint"
EXPECT_LEN=$(jq -er '.length' "$BINDING")                || fail "binding record has no length"
ENV_KEY=$(jq -er '.env_key' "$BINDING")                  || fail "binding record has no env_key"
# The CLI identity comes from the freeze, not from a constant here: the manifest
# is the registered description of the environment, and round4-harness fails a PR
# that edits it without re-freezing.
EXPECT_CLI=$(jq -er '.environment_recorded.claude_cli' "$MANIFEST") || fail "manifest records no claude_cli"
EXPECT_CLI_VER=$(printf '%s' "$EXPECT_CLI" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
[ -n "$EXPECT_CLI_VER" ] || fail "cannot parse a version out of manifest claude_cli: $EXPECT_CLI"

# ---- the credential under test must be the one the pilot used ----------------
# Deleting the GitHub secret is NOT revocation, and it destroys the ability to run
# this test — the token value lives only there. Revoke, verify here, then delete.
TOK="${!ENV_KEY:-}"
[ -n "$TOK" ] || fail "no $ENV_KEY. Revocation cannot be VERIFIED without the token value: revoke, verify here, and only then delete the secret."
FP=$(printf 'tb4-credfp:%s' "$TOK" | sha256_hex | cut -c1-16)
LEN=${#TOK}
echo "credential under test: env:$ENV_KEY:sha256:$FP:len:$LEN"
echo "pilot credential:      env:$ENV_KEY:sha256:$EXPECT_FP:len:$EXPECT_LEN"
[ "$FP" = "$EXPECT_FP" ] && [ "$LEN" = "$EXPECT_LEN" ] \
  || fail "this is NOT the pilot credential ($FP/$LEN vs $EXPECT_FP/$EXPECT_LEN). Verifying a different token says nothing about the exposed one; refusing to record a pass."

# ---- the client must be the frozen one --------------------------------------
command -v claude >/dev/null 2>&1 || fail "the pinned agent CLI ($EXPECT_CLI_VER) is not on PATH."
CLI_BANNER=$(claude --version 2>&1 | head -1)
CLI_VER=$(printf '%s' "$CLI_BANNER" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
echo "agent CLI: $CLI_BANNER (expected $EXPECT_CLI_VER)"
[ "$CLI_VER" = "$EXPECT_CLI_VER" ] \
  || fail "agent CLI is $CLI_VER, the freeze records $EXPECT_CLI_VER. A different client's refusal is not evidence about the frozen one."

# ---- how this client rejects a credential, measured now ---------------------
# `env -i` is the point: no ANTHROPIC_API_KEY, no inherited credential file, a
# clean HOME with no ~/.claude/.credentials.json. The token passed in is the only
# thing that could authenticate the call, so a success cannot come from elsewhere.
run_cli() { # $1 = token, $2 = tag  -> sets RC
  local home="$OUT_DIR/home-$2"; rm -rf "$home"; mkdir -p "$home"
  run_limited 120 env -i PATH="$PATH" HOME="$home" "$ENV_KEY=$1" \
    claude -p 'reply with the single word ok' \
    </dev/null >"$OUT_DIR/$2.out" 2>"$OUT_DIR/$2.err"
  RC=$?
}
# Raw client output is never echoed; only this boolean derived from it is.
auth_sig() { grep -qEi 'unauthor|authenticat|invalid.*(token|api key|bearer|credential)|oauth|expired|revoked|log ?in|401' "$OUT_DIR/$1.out" "$OUT_DIR/$1.err" 2>/dev/null && echo yes || echo no; }

http_call() { # $1 = token, $2 = tag -> echoes status
  curl -sS -o "$OUT_DIR/$2.body" -w '%{http_code}' -X POST \
    https://api.anthropic.com/v1/messages \
    -H "authorization: Bearer $1" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: oauth-2025-04-20" \
    -H "content-type: application/json" \
    -d '{"model":"claude-sonnet-5","max_tokens":1,"messages":[{"role":"user","content":"ok"}]}' \
    2>"$OUT_DIR/$2.curlerr" || echo "000"
}

# A token that is invalid BY CONSTRUCTION and the right shape and length, so the
# service rejects it as a credential rather than as a malformed request.
CTRL_TOK="sk-ant-oat01-$(printf 'D%.0s' $(seq 1 $((EXPECT_LEN - 13))))"
run_cli "$CTRL_TOK" control; CTRL_RC=$RC
CTRL_SIG=$(auth_sig control)
CTRL_HTTP=$(http_call "$CTRL_TOK" control-http)
echo "control (synthetic invalid token): cli_exit=$CTRL_RC auth_signature=$CTRL_SIG http=$CTRL_HTTP"

# Did the instrument calibrate? A rejection exit code must be an ordinary
# non-success exit: not 0 (accepted), not 124 (timeout), not 126/127 (not
# executable / not found), not >=128 (killed by a signal).
CAL=ok
# First failure wins, so the reason names what actually broke first rather than
# whatever happened to be checked last.
calfail() { [ "$CAL" = ok ] && CAL="$1"; return 0; }
case "$CTRL_RC" in 0|124|126|127) calfail "control exit $CTRL_RC is not a credential rejection" ;; esac
[ "$CTRL_RC" -ge 128 ] 2>/dev/null && calfail "control died on a signal (exit $CTRL_RC)"
[ "$CTRL_SIG" = yes ] || calfail "control produced no authentication-failure signature"
[ "$CTRL_HTTP" = 401 ] || calfail "control HTTP was $CTRL_HTTP, not 401 — this request shape does not yield 401 for a rejected credential, so a 401 from the token under test would mean nothing"

# ---- the credential under test ----------------------------------------------
run_cli "$TOK" subject; CLI_RC=$RC
SIG=$(auth_sig subject)
HTTP=$(http_call "$TOK" subject-http)
ERR_TYPE=$(jq -r '.error.type // "-"' "$OUT_DIR/subject-http.body" 2>/dev/null || echo -)
echo "subject (pilot credential):        cli_exit=$CLI_RC auth_signature=$SIG http=$HTTP error_type=$ERR_TYPE"

# ---- classification ----------------------------------------------------------
# REVOKED requires the subject to reproduce the MEASURED rejection signature
# exactly. Every other outcome — an abnormal exit, a timeout, a signal, an
# uncalibrated control, a 401 that is not accompanied by a client rejection — is
# INCONCLUSIVE, which fails the job. An unresolved credential step must never
# read as a cleared one.
if [ "$CLI_RC" = 0 ] || [ "$HTTP" = 200 ]; then
  VERDICT=LIVE; REASON="the credential still authenticates"
elif [ "$CAL" != ok ]; then
  VERDICT=INCONCLUSIVE; REASON="the negative control did not calibrate: $CAL"
elif [ "$CLI_RC" = "$CTRL_RC" ] && [ "$SIG" = yes ] && [ "$HTTP" = 401 ]; then
  VERDICT=REVOKED; REASON="the frozen client refuses the credential exactly as it refuses a known-invalid one, and the wire returns 401"
else
  VERDICT=INCONCLUSIVE; REASON="subject (exit $CLI_RC, signature $SIG, http $HTTP) does not match the measured rejection (exit $CTRL_RC, signature yes, http 401)"
fi

jq -nc \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg fp "env:$ENV_KEY:sha256:$FP:len:$LEN" \
  --arg cli "$CLI_BANNER" --arg clipin "$EXPECT_CLI_VER" \
  --argjson rc "$CLI_RC" --arg sig "$SIG" --arg http "$HTTP" --arg etype "$ERR_TYPE" \
  --argjson ctrlrc "$CTRL_RC" --arg ctrlsig "$CTRL_SIG" --arg ctrlhttp "$CTRL_HTTP" --arg cal "$CAL" \
  --arg verdict "$VERDICT" --arg reason "$REASON" \
  '{ts:$ts,step:"round4-step-6-revocation",credential_fingerprint:$fp,
    cli:$cli,cli_pin:$clipin,
    subject:{cli_exit:$rc,auth_failure_signature:$sig,http_status:$http,http_error_type:$etype},
    control:{cli_exit:$ctrlrc,auth_failure_signature:$ctrlsig,http_status:$ctrlhttp,calibration:$cal},
    verdict:$verdict,reason:$reason,
    limitation:"exit-code equality is only as discriminating as the client makes it; if this CLI collapses distinct failures onto one code, the authentication signature and the control carry the weight"}' \
  | tee "$OUT_DIR/revocation-check.json"

case "$VERDICT" in
  REVOKED) echo "PASS — $REASON. Step 6 is satisfied."; exit 0 ;;
  LIVE)    fail "the pilot credential STILL AUTHENTICATES — $REASON. Step 6 is NOT satisfied." ;;
  *)       fail "INCONCLUSIVE — $REASON. Not recorded as revoked." ;;
esac
