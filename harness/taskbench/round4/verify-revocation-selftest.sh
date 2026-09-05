#!/usr/bin/env bash
# Deterministic self-test for verify-revocation.sh. No network, no agent CLI, no
# credential — the client and the wire are stubbed on PATH, so this runs in
# ordinary CI on every PR.
#
# WHY IT EXISTS. The revocation check is manual and runs once, against a
# credential that by then is expected to be dead. That is the worst possible
# moment to discover that its verdict logic accepts something it should not: a
# false REVOKED would close the registered credential step on evidence that does
# not hold. So the classification is exercised here, on every commit, against the
# failures it is supposed to refuse.
#
# The stubs are placed on PATH rather than injected through environment hooks in
# the verifier. That is deliberate: an env-injectable client would be a bypass
# surface in production (dispatch with a stub that always fails, harvest a
# REVOKED). The verifier calls bare `claude` and `curl` and has no such hook.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/verify-revocation.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0

# Two synthetic tokens of the registered length. Neither is a credential: the
# control is the exact string the verifier constructs for its negative control,
# the subject is a distinct same-length string standing in for the pilot token.
LEN=108
CTRL_TOK="sk-ant-oat01-$(printf 'D%.0s' $(seq 1 $((LEN - 13))))"
SUBJ_TOK="sk-ant-oat01-$(printf 'S%.0s' $(seq 1 $((LEN - 13))))"
OTHER_TOK="sk-ant-oat01-$(printf 'X%.0s' $(seq 1 $((LEN - 13))))"
if command -v sha256sum >/dev/null 2>&1; then _h() { sha256sum; }; else _h() { shasum -a 256; }; fi
fp() { printf 'tb4-credfp:%s' "$1" | _h | cut -c1-16; }
SUBJ_FP="$(fp "$SUBJ_TOK")"

# stage <name> <binding-fp> <binding-len> <manifest-cli> <cli-banner> \
#       <ctrl-rc> <ctrl-out> <ctrl-http> <subj-rc> <subj-out> <subj-http>
stage() {
  local n=$1 bfp=$2 blen=$3 mcli=$4 banner=$5 crc=$6 cout=$7 chttp=$8 src=$9 sout=${10} shttp=${11}
  local s="$TMP/$n"; mkdir -p "$s/bin"
  cp "$SRC" "$s/verify-revocation.sh"
  cat > "$s/pilot-credential.json" <<J
{"fingerprint_sha256_16":"$bfp","length":$blen,"env_key":"CLAUDE_CODE_OAUTH_TOKEN"}
J
  cat > "$s/PILOT-EXECUTION-MANIFEST.json" <<J
{"environment_recorded":{"claude_cli":"$mcli"}}
J
  cat > "$s/cfg" <<J
BANNER='$banner'
CTRL_TOK='$CTRL_TOK'
CTRL_RC=$crc
CTRL_OUT='$cout'
CTRL_HTTP=$chttp
SUBJ_RC=$src
SUBJ_OUT='$sout'
SUBJ_HTTP=$shttp
J
  # The stubs read an ABSOLUTE config path baked in at generation time: the
  # verifier runs the client under `env -i`, so nothing can be handed to them
  # through the environment.
  cat > "$s/bin/claude" <<STUB
#!/usr/bin/env bash
. '$s/cfg'
if [ "\${1:-}" = --version ]; then echo "\$BANNER"; exit 0; fi
if [ "\${CLAUDE_CODE_OAUTH_TOKEN:-}" = "\$CTRL_TOK" ]; then echo "\$CTRL_OUT" >&2; exit \$CTRL_RC; fi
echo "\$SUBJ_OUT" >&2; exit \$SUBJ_RC
STUB
  cat > "$s/bin/curl" <<STUB
#!/usr/bin/env bash
. '$s/cfg'
out=; tok=
while [ \$# -gt 0 ]; do
  case "\$1" in
    -o) out="\$2"; shift 2 ;;
    -H) case "\$2" in "authorization: Bearer "*) tok="\${2#authorization: Bearer }" ;; esac; shift 2 ;;
    *) shift ;;
  esac
done
code=\$SUBJ_HTTP; [ "\$tok" = "\$CTRL_TOK" ] && code=\$CTRL_HTTP
[ -n "\$out" ] && printf '{"error":{"type":"authentication_error"}}' > "\$out"
printf '%s' "\$code"
STUB
  chmod +x "$s/bin/claude" "$s/bin/curl"
  printf '%s' "$s"
}

# expect <label> <token> <expected-verdict|REFUSED> <stage-dir> [extra env assignments...]
expect() {
  local label=$1 tok=$2 want=$3 s=$4; shift 4
  local out rc
  out=$(cd "$s" && env PATH="$s/bin:$PATH" TB_REVOCATION_OUT="$s/out" \
        CLAUDE_CODE_OAUTH_TOKEN="$tok" "$@" bash "$s/verify-revocation.sh" 2>&1)
  rc=$?
  local got
  if printf '%s' "$out" | grep -q '"verdict":"'; then
    got=$(printf '%s' "$out" | grep -o '"verdict":"[A-Z]*"' | head -1 | cut -d'"' -f4)
  else
    got=REFUSED   # a gate fired before any call was made
  fi
  # A pass is the only zero exit, and it is only ever REVOKED.
  local ok=yes
  [ "$got" = "$want" ] || ok=no
  if [ "$want" = REVOKED ]; then [ "$rc" = 0 ] || ok=no; else [ "$rc" != 0 ] || ok=no; fi
  if [ "$ok" = yes ]; then PASS=$((PASS+1)); echo "  ok    $label ($got, exit $rc)"
  else FAIL=$((FAIL+1)); echo "  FAIL  $label — wanted $want, got $got (exit $rc)"; echo "$out" | sed 's/^/        /' | tail -6; fi
}

BANNER='2.1.260 (Claude Code)'
MCLI='2.1.260 (Claude Code)'
REJECT='Invalid bearer token: authentication failed'
GOOD=$(stage good "$SUBJ_FP" $LEN "$MCLI" "$BANNER" 1 "$REJECT" 401 1 "$REJECT" 401)

echo "verify-revocation self-test"
expect "revoked credential, controls calibrated"          "$SUBJ_TOK" REVOKED      "$GOOD"
# The credential identity gates. Testing a different token proves nothing about
# the exposed one, so both of these must refuse before making any call.
expect "a different token of the same length"             "$OTHER_TOK" REFUSED     "$GOOD"
expect "no credential at all"                             ""           REFUSED     "$GOOD"
# The fingerprint is committed, not dispatched. Setting the old input names must
# change nothing — if either ever becomes an input again, this fails.
expect "expected fingerprint cannot be overridden"        "$OTHER_TOK" REFUSED     "$GOOD" \
  TB_EXPECT_CRED_FP="$(fp "$OTHER_TOK")" TB_EXPECT_CRED_LEN=$LEN
# Still live: either arm alone is enough to refuse.
expect "client authenticates (exit 0)"                    "$SUBJ_TOK" LIVE \
  "$(stage live_cli "$SUBJ_FP" $LEN "$MCLI" "$BANNER" 1 "$REJECT" 401 0 ok 401)"
expect "wire accepts the credential (HTTP 200)"           "$SUBJ_TOK" LIVE \
  "$(stage live_http "$SUBJ_FP" $LEN "$MCLI" "$BANNER" 1 "$REJECT" 401 1 "$REJECT" 200)"
# Abnormal client failures are NOT revocation, however plausible the wire looks.
for rc in 124 126 127 137 2; do
  expect "abnormal client exit $rc with a 401"            "$SUBJ_TOK" INCONCLUSIVE \
    "$(stage "abn_$rc" "$SUBJ_FP" $LEN "$MCLI" "$BANNER" 1 "$REJECT" 401 "$rc" "boom" 401)"
done
expect "401 but no authentication signature"              "$SUBJ_TOK" INCONCLUSIVE \
  "$(stage nosig "$SUBJ_FP" $LEN "$MCLI" "$BANNER" 1 "$REJECT" 401 1 "segfault in module" 401)"
expect "client refuses but the wire does not (500)"       "$SUBJ_TOK" INCONCLUSIVE \
  "$(stage http500 "$SUBJ_FP" $LEN "$MCLI" "$BANNER" 1 "$REJECT" 401 1 "$REJECT" 500)"
# If the control does not behave like a rejection, the instrument did not
# calibrate and nothing measured against it means anything.
expect "control does not fail (exit 0)"                   "$SUBJ_TOK" INCONCLUSIVE \
  "$(stage cal_rc "$SUBJ_FP" $LEN "$MCLI" "$BANNER" 0 ok 401 1 "$REJECT" 401)"
expect "control times out"                                "$SUBJ_TOK" INCONCLUSIVE \
  "$(stage cal_to "$SUBJ_FP" $LEN "$MCLI" "$BANNER" 124 "" 401 1 "$REJECT" 401)"
expect "control 400: the request shape yields no 401"     "$SUBJ_TOK" INCONCLUSIVE \
  "$(stage cal_http "$SUBJ_FP" $LEN "$MCLI" "$BANNER" 1 "$REJECT" 400 1 "$REJECT" 400)"
# A different client's refusal is not evidence about the frozen one.
expect "agent CLI is not the frozen version"              "$SUBJ_TOK" REFUSED \
  "$(stage badver "$SUBJ_FP" $LEN "$MCLI" '2.1.259 (Claude Code)' 1 "$REJECT" 401 1 "$REJECT" 401)"
# The binding record is the authority; a missing one cannot default to anything.
BROKEN=$(stage nobinding "$SUBJ_FP" $LEN "$MCLI" "$BANNER" 1 "$REJECT" 401 1 "$REJECT" 401)
rm -f "$BROKEN/pilot-credential.json"
expect "credential binding record missing"                "$SUBJ_TOK" REFUSED "$BROKEN"

echo "verify-revocation self-test: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ] || exit 1
