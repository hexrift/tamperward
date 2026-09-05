#!/usr/bin/env bash
# Provision a host to run the round-4 pilot and validate every step SHORT OF a
# trajectory. Runs NOTHING scientific — no run-task4.sh, no agent, no credential.
#
# It is the single source of truth for "can this host run the pilot", used by:
#   - .github/workflows/pilot.yml  — the `check` action, and the pre-flight before
#     a `run-next`.
#   - .github/workflows/ci.yml     — the `pilot-provisioning` job, so a runner
#     image / package / action change that breaks provisioning fails a PR here,
#     rather than being discovered on a manual pilot dispatch (the python3.11-on-
#     noble regression this script exists to prevent recurring).
#
# Steps, all deterministic and token-free:
#   1. the toolchain the pilot needs is present,
#   2. the pinned treatment artefact builds, deploys and reproduces its tree hash,
#   3. the network jail builds and enforces (net-jail.sh selftest),
#   4. the freeze check passes — exit 0 (a frozen host) or 3 (environment drift,
#      expected on any runner) are both fine; 2/4/5 are not.
#
# Exit 0 means the host can run the pilot. Any non-zero is a provisioning fault
# with a named cause.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
fail() { echo "provision-check: FAIL — $1" >&2; exit 1; }
. "$(dirname "$0")/registration.sh"

# WHICH QUESTION IS VALID DEPENDS ON THE LIFECYCLE STATE, and that is the whole
# point of reading it here. This script used to carry its own copy of the pinned
# artefact hash and the artefact directory, "kept in step with
# freeze-pilot-manifest.mjs" by hand — a pin duplicated into a script is a pin
# that drifts, and it also meant a closed iteration's pin was asserted against an
# unfrozen candidate, failing a PR for being correct.
#
#   FROZEN   assert the registered iteration's pin, and run the full freeze check.
#   BETWEEN  make NO freeze claim. Everything else still has to hold: the
#            candidate builds, deploys reproducibly, is the CURRENT candidate and
#            not a stale one, the jail enforces, and the closed iteration's
#            manifest is immutable and internally reproducible.
#
# BETWEEN must never read as "anything goes": it drops exactly the assertions
# that are about a registration, and no others. Pilot EXECUTION is refused
# separately, by pilot-drive.sh, which will not run outside FROZEN.
STATE="$(reg_state)" || fail "cannot read the pilot lifecycle: $STATE"
echo "provision-check: lifecycle — $STATE"
CANDIDATE="$(reg_candidate_version)"
case "$STATE" in
  frozen*)
    ACTIVE="${STATE#frozen }"
    ITER="$(reg_iteration "$ACTIVE")"
    [ -n "$ITER" ] || fail "active_iteration is $ACTIVE but no such iteration is recorded"
    PIN="$(printf '%s' "$ITER" | jq -r '.treatment_artefact_sha256')"
    ART_DIR="${TB_ART_DIR:-$(printf '%s' "$ITER" | jq -r '.treatment_artefact_dir')}"
    ;;
  between)
    PIN=
    # The candidate's own directory, never a closed iteration's: deploying 2.10.3
    # into /opt/tw-artefact-2.10.2 would leave the path asserting a version the
    # tree no longer is.
    ART_DIR="${TB_ART_DIR:-/opt/tw-artefact-$CANDIDATE}"
    ;;
esac

# Run privileged only when we are not already root and sudo exists (CI runner user
# has passwordless sudo; a root container needs none).
priv() { if [ "$(id -u)" -ne 0 ]; then sudo "$@"; else "$@"; fi; }
privE() { if [ "$(id -u)" -ne 0 ]; then sudo -E "$@"; else "$@"; fi; }

# 1. toolchain --------------------------------------------------------------
for t in node npm python3.11 uv jq ip nft; do
  command -v "$t" >/dev/null 2>&1 || fail "required tool not found on PATH: $t"
done
echo "provision-check: toolchain present ($(node -v), $(python3.11 --version 2>&1), $(uv --version 2>&1))"

# 2. artefact: build, deploy, verify the pin --------------------------------
cd "$ROOT"
TGZ="$ROOT/$(npm pack --silent)" || fail "npm pack failed"
priv rm -rf "$ART_DIR"
priv mkdir -p "$ART_DIR"
# `--packages=external`: the CLI needs its runtime deps (picomatch, yaml, typescript)
# as siblings, so install the tarball rather than unpacking it.
( cd "$ART_DIR" && priv npm install --omit=dev --no-audit --no-fund --silent "$TGZ" ) \
  || fail "artefact install into $ART_DIR failed"
rm -f "$TGZ"
H="$(cd "$ART_DIR/node_modules/tamperward" && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1)"
# The deployed artefact must BE the current candidate. Without this the between
# state could pass while a stale tree sat in the directory — the deployment is a
# fresh install so it is true by construction, and asserted anyway because "true
# by construction" is what stops being true after a refactor.
DEPLOYED_V="$(node -p "require('$ART_DIR/node_modules/tamperward/package.json').version")"
[ "$DEPLOYED_V" = "$CANDIDATE" ] || fail "deployed artefact is $DEPLOYED_V, the candidate is $CANDIDATE"
if [ -n "$PIN" ]; then
  [ "$H" = "$PIN" ] || fail "artefact tree $H != pinned $PIN (this would be binding drift)"
  echo "provision-check: artefact deployed and pin verified ($PIN)"
else
  # No registration to pin against, so the assertion that remains is
  # REPRODUCIBILITY: the same packed artefact installed twice yields the same
  # tree. That is what "the deployed artefact is the one just built" can mean
  # when there is no registered hash to compare it to.
  TGZ2="$ROOT/$(npm pack --silent)" || fail "npm pack failed (second)"
  CTRL="$(mktemp -d)"
  ( cd "$CTRL" && npm install --omit=dev --no-audit --no-fund --silent "$TGZ2" ) || fail "control install failed"
  H2="$(cd "$CTRL/node_modules/tamperward" && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1)"
  rm -rf "$CTRL"; rm -f "$TGZ2"
  [ "$H" = "$H2" ] || fail "the artefact is not reproducible: deployed $H != rebuilt $H2"
  echo "provision-check: artefact $CANDIDATE deployed and reproducible ($H) — no registration, so no pin is claimed"
fi
priv chmod -R a-w "$ART_DIR"

# 3. the network jail -------------------------------------------------------
privE bash "$ROOT/harness/taskbench/runner/net-jail.sh" selftest || fail "net-jail.sh selftest failed"
echo "provision-check: net-jail selftest OK"

# 4. the freeze -------------------------------------------------------------
# BETWEEN iterations there is no registration to check the tree against, and
# asserting a closed iteration's binding set would forbid exactly the work that
# state exists to allow. What IS asserted is that the closed iteration's record
# stayed put: its manifest is byte-identical to what the registration recorded,
# and its rendered page still derives from it. Immutable, and internally
# reproducible, without any claim about the current tree.
if [ -z "$PIN" ]; then
  reg_assert_closed_immutable | sed 's/^/provision-check: /' || fail "a closed iteration is not immutable or not reproducible"
  echo "provision-check: OK — candidate $CANDIDATE provisions; no pilot iteration is registered, so no freeze claim is made and pilot execution is refused by pilot-drive.sh"
  exit 0
fi
set +e
FZ="$(node "$ROOT/harness/taskbench/round4/freeze-pilot-manifest.mjs" --check 2>&1)"; RC=$?
set -e
echo "$FZ"
case "$RC" in
  0) echo "provision-check: freeze exit 0 — the frozen manifest describes this tree exactly" ;;
  3) echo "provision-check: freeze exit 3 — environment drift (expected on a runner; acknowledge at run-next)" ;;
  2|5) fail "freeze reports binding/structural drift (exit $RC) — never acknowledged; resolve or re-freeze" ;;
  4) fail "freeze exit 4 — the artefact is not deployed, but step 2 should have deployed it" ;;
  *) fail "freeze exit $RC (expected 0 or 3)" ;;
esac

echo "provision-check: OK — this host can run the pilot (freeze exit $RC)"
