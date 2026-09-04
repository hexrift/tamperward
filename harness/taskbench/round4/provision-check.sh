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
ART_DIR="${TB_ART_DIR:-/opt/tw-artefact-2.10.2}"
# The artefact tree hash the freeze pins. Kept in step with freeze-pilot-manifest.mjs.
PIN='a0328112d99451e998037a3b26005c622590f9e5dee075db7606419a06ad3458'

fail() { echo "provision-check: FAIL — $1" >&2; exit 1; }
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
[ "$H" = "$PIN" ] || fail "artefact tree $H != pinned $PIN (this would be binding drift)"
priv chmod -R a-w "$ART_DIR"
echo "provision-check: artefact deployed and pin verified ($PIN)"

# 3. the network jail -------------------------------------------------------
privE bash "$ROOT/harness/taskbench/runner/net-jail.sh" selftest || fail "net-jail.sh selftest failed"
echo "provision-check: net-jail selftest OK"

# 4. the freeze -------------------------------------------------------------
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
