#!/usr/bin/env bash
# Provision a host to run the round-4 COUNTED round and validate every step SHORT
# OF a trajectory. Runs NOTHING scientific — no run-task4.sh, no agent, no
# credential. The counted analog of provision-check.sh (read that first).
#
# It differs from the pilot's provisioning in exactly one way: WHERE the treatment
# and the freeze come from. The pilot reads its lifecycle (registration.sh) to pick
# a candidate/iteration; the counted round has a single frozen registration, so
# everything — the treatment version, the artefact directory, the pinned tree hash
# — is derived from COUNTED-EXECUTION-MANIFEST.json, the one frozen source, never
# typed a second time.
#
# It is the single source of truth for "can this host run the counted round", used
# by .github/workflows/counted.yml — the `check` action, and the pre-flight before
# a `run-next` / `sweep`.
#
# Steps, all deterministic and token-free:
#   1. the toolchain the counted round needs is present,
#   2. the published treatment (tamperward@<version>) installs and reproduces the
#      manifest's frozen tree hash,
#   3. the network jail builds and enforces (net-jail.sh selftest),
#   4. the counted freeze check passes — exit 0 (a frozen host) or 3 (environment
#      drift, expected on any runner) are both fine; 2/4/5 are not.
#
# Exit 0 means the host can run the counted round. Any non-zero is a provisioning
# fault with a named cause. Like provision-check.sh, EXECUTION is refused
# separately, by counted-drive.sh, which fails closed unless the freeze passes and
# the manifest is execution_ready.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="${TB_COUNTED_MANIFEST:-$HERE/COUNTED-EXECUTION-MANIFEST.json}"
FREEZE="$HERE/freeze-counted-manifest.mjs"
fail() { echo "provision-counted-check: FAIL — $1" >&2; exit 1; }

command -v jq >/dev/null 2>&1 || fail "jq not found on PATH"
[ -s "$MANIFEST" ] || fail "no counted manifest at $MANIFEST"
[ -s "$FREEZE" ] || fail "no freeze-counted-manifest.mjs at $FREEZE"

# The treatment identity is the manifest's, never typed a second time. TB_ART_DIR
# may override only the DIRECTORY (an operator staging the artefact elsewhere); the
# version and the pin always come from the frozen manifest, so an override can never
# smuggle in a different treatment — the pin check below still has to pass.
VERSION="$(jq -r '.treatment.version' "$MANIFEST")"
ART_DIR="${TB_ART_DIR:-$(jq -r '.treatment.artefact_dir' "$MANIFEST")}"
PIN="$(jq -r '.treatment.artefact_pkg_tree_sha256' "$MANIFEST")"
[ -n "$VERSION" ] && [ "$VERSION" != null ] || fail "manifest names no treatment.version"
[ -n "$ART_DIR" ] && [ "$ART_DIR" != null ] || fail "manifest names no treatment.artefact_dir"
[ -n "$PIN" ] && [ "$PIN" != null ]         || fail "manifest names no treatment.artefact_pkg_tree_sha256"

# Run privileged only when we are not already root and sudo exists (CI runner user
# has passwordless sudo; a root container needs none). Mirrors provision-check.sh.
priv()  { if [ "$(id -u)" -ne 0 ]; then sudo "$@";    else "$@"; fi; }
privE() { if [ "$(id -u)" -ne 0 ]; then sudo -E "$@"; else "$@"; fi; }

# 1. toolchain --------------------------------------------------------------
for t in node npm python3.11 uv jq ip nft; do
  command -v "$t" >/dev/null 2>&1 || fail "required tool not found on PATH: $t"
done
echo "provision-counted-check: toolchain present ($(node -v), $(python3.11 --version 2>&1), $(uv --version 2>&1))"

# 2. artefact: install the PUBLISHED treatment, verify the frozen pin --------
# The treatment is the published, immutable tamperward@$VERSION — the exact
# package a user installs, and the bytes the counted pin was frozen against.
# Install it from the registry rather than re-packing the working tree: the
# source tree's non-code files drift as docs are updated — README.md above all,
# and README ships INSIDE the npm package — so `npm pack` of a later working tree
# yields a different tree hash for a byte-identical gate. The published release
# cannot drift, so it deploys precisely the frozen treatment. The pin check below
# still guards correctness: a published tree that ever differed from the frozen
# pin fails closed here, so this can never smuggle in a different treatment.
priv rm -rf "$ART_DIR"
priv mkdir -p "$ART_DIR"
# `--omit=dev`: the CLI needs its runtime deps (picomatch, yaml, typescript) as
# siblings, so install the package (with deps) into the artefact dir.
( cd "$ART_DIR" && priv npm install --omit=dev --no-audit --no-fund --silent "tamperward@$VERSION" ) \
  || fail "install of published tamperward@$VERSION into $ART_DIR failed"
H="$(cd "$ART_DIR/node_modules/tamperward" && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1)"
# The deployed artefact must BE the frozen treatment version AND reproduce its
# frozen tree hash. A mismatch on either is binding drift — the run must not start.
DEPLOYED_V="$(node -p "require('$ART_DIR/node_modules/tamperward/package.json').version")"
[ "$DEPLOYED_V" = "$VERSION" ] || fail "deployed artefact is $DEPLOYED_V, the frozen treatment is $VERSION"
[ "$H" = "$PIN" ]             || fail "artefact tree $H != frozen pin $PIN (this would be binding drift)"
echo "provision-counted-check: published tamperward@$VERSION deployed to $ART_DIR and pin verified ($PIN)"
priv chmod -R a-w "$ART_DIR"

# 3. the network jail -------------------------------------------------------
privE bash "$ROOT/harness/taskbench/runner/net-jail.sh" selftest || fail "net-jail.sh selftest failed"
echo "provision-counted-check: net-jail selftest OK"

# 4. the counted freeze -----------------------------------------------------
# The checker re-derives the whole document from the manifest's own seeds and the
# on-disk pool, verifies the binding set (incl. the driver) and the treatment pin,
# and prints the environment-drift fingerprint for review. Exit 0 (frozen host) or
# 3 (environment drift, expected on any runner — acknowledgeable ONCE at run-next)
# are both fine; binding/structural drift (2), an absent artefact (4) and usage (5)
# are provisioning faults.
set +e
FZ="$(TB_COUNTED_MANIFEST="$MANIFEST" node "$FREEZE" --check 2>&1)"; RC=$?
set -e
echo "$FZ"
case "$RC" in
  0) echo "provision-counted-check: freeze exit 0 — the frozen manifest describes this tree exactly" ;;
  3) echo "provision-counted-check: freeze exit 3 — environment drift (expected on a runner; acknowledge at run-next)" ;;
  2) fail "freeze reports binding/structural drift (exit 2) — never acknowledged; resolve or re-freeze" ;;
  4) fail "freeze exit 4 — the artefact is not deployed, but step 2 should have deployed it" ;;
  5) fail "freeze exit 5 — usage/structural error" ;;
  *) fail "freeze exit $RC (expected 0 or 3)" ;;
esac

echo "provision-counted-check: OK — this host can run the counted round (freeze exit $RC)"
