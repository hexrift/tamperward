#!/usr/bin/env bash
# Externalize oversized evidence files out of a state snapshot before it is
# committed to the git state branch.
#
# WHY. The counted run checkpoints runs-counted/ to a git branch (ci-pilot-state.sh).
# Each trajectory's runs-counted/seq-NNN/<task>-<arm>-raw/repo-final-tree.tar is a raw
# archive of the agent's final working tree — pure forensic EVIDENCE. It is NOT an input
# to verdict computation: verdict4.mjs computes the verdict live during the run and never
# reads repo-final-tree.tar back. Most are tens of MB, but a large repo can exceed
# GitHub's 100 MB per-file hard limit and the whole state push is then rejected
# (pre-receive hook, GH001) — which is exactly the Round-4 seq-145 failure (a 284 MB
# sqllineage tree). See DEVIATIONS.md D43.
#
# WHAT. Given a snapshot directory, any file over the threshold is uploaded to a durable
# GitHub Release asset (content-addressed by its sha256, no expiry, not LFS) and replaced
# IN PLACE by a `<file>.external.json` pointer carrying sha256, size and the immutable
# locator. The state branch then commits the pointer, never the multi-hundred-MB blob.
# Files at or under the threshold are untouched, so a snapshot with no oversized evidence
# is byte-identical to before and never even invokes `gh`.
#
#   externalize-evidence.sh <snapshot_dir> [find_size_threshold] [release_tag]
#     find_size_threshold  default "+90M"  (GNU find -size syntax; strictly greater-than)
#     release_tag          default "round4-evidence"
#
# Requires GITHUB_REPOSITORY and GITHUB_TOKEN (contents: write) and, only when an
# oversized file is actually present, the `gh` CLI. Fails closed: if an upload cannot be
# confirmed the snapshot is NOT allowed to proceed (exit 1), so evidence is never silently
# dropped.
set -uo pipefail

DIR="${1:?usage: externalize-evidence.sh <snapshot_dir> [threshold] [release_tag]}"
THRESH="${2:-+90M}"
TAG="${3:-round4-evidence}"
SERVER="${GITHUB_SERVER_URL:-https://github.com}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set (needs contents: write)}"
export GH_TOKEN="$GITHUB_TOKEN"

msg() { echo "externalize-evidence: $*"; }

# Oversized files only (never re-process an existing pointer).
mapfile -t BIG < <(find "$DIR" -type f ! -name '*.external.json' -size "$THRESH" 2>/dev/null | sort)
if [ "${#BIG[@]}" -eq 0 ]; then
  msg "no files over ${THRESH} under ${DIR} — nothing to externalize"
  exit 0
fi

command -v gh >/dev/null 2>&1 || { echo "::error::externalize-evidence: ${#BIG[@]} oversized file(s) present but the gh CLI is unavailable — refusing to push a snapshot that GitHub will reject"; exit 1; }

# Ensure the durable release exists (idempotent).
if ! gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  gh release create "$TAG" -R "$REPO" \
    --title "Round-4 oversized evidence" \
    --notes "Durable store for oversized Round-4 trajectory evidence (repo-final-tree.tar snapshots) externalized from the round4-counted-state branch so it stays under GitHub's file-size limit. These are raw final-tree archives, NOT inputs to verdict computation. See harness/taskbench/round4/DEVIATIONS.md D43." >/dev/null \
    || { echo "::error::externalize-evidence: could not create release $TAG"; exit 1; }
  msg "created durable release '$TAG'"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
n=0
for f in "${BIG[@]}"; do
  sz="$(stat -c%s "$f")"
  sha="$(sha256sum "$f" | cut -d' ' -f1)"
  base="$(basename "$f")"
  asset="${sha}-${base}"
  rel="${f#"$DIR"/}"
  msg "externalizing ${rel} (${sz} bytes, sha256 ${sha}) -> release ${TAG} asset ${asset}"
  cp -f "$f" "$tmp/$asset"
  gh release upload "$TAG" "$tmp/$asset" -R "$REPO" --clobber \
    || { echo "::error::externalize-evidence: release upload failed for ${rel}"; exit 1; }
  rm -f "$tmp/$asset"
  # Verify the asset is actually retrievable before we drop the local blob (fail closed).
  gh release view "$TAG" -R "$REPO" --json assets --jq '.assets[].name' 2>/dev/null | grep -qxF "$asset" \
    || { echo "::error::externalize-evidence: uploaded asset ${asset} not visible on release ${TAG} — refusing to drop the local copy"; exit 1; }
  cat > "$f.external.json" <<EOF
{
  "externalized": true,
  "reason": "oversized-evidence-checkpoint (DEVIATIONS D43)",
  "original_path": "${rel}",
  "sha256": "${sha}",
  "size_bytes": ${sz},
  "store": "github-release-asset",
  "repository": "${REPO}",
  "release_tag": "${TAG}",
  "asset_name": "${asset}",
  "asset_url": "${SERVER}/${REPO}/releases/download/${TAG}/${asset}",
  "externalized_at": "$(date -u +%FT%TZ)",
  "note": "Raw final-tree evidence archive. NOT an input to verdict computation (verdict4.mjs never reads it). Retrieve with: gh release download ${TAG} -p '${asset}'."
}
EOF
  rm -f "$f"
  n=$((n+1))
done
msg "externalized ${n} file(s) to release '${TAG}' (threshold ${THRESH})"
