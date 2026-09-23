#!/usr/bin/env bash
# Git choreography for the tamperward-audit evidence branch (#518). The store
# is partitioned so that a run reads only what it needs: the ledger to decide
# what is new, and the small index/summary files to ingest. Historical
# partitions are never downloaded unless a full rebuild is requested.
#
#   audit-store-git.sh clone-ledger <remote> <dir>
#       A depth-1, blob-less, no-checkout clone of the evidence branch with only
#       ingested/batches.jsonl materialised. Leaves <dir> empty when the branch
#       does not exist yet.
#   audit-store-git.sh clone-store <remote> <dir> [--full]
#       A depth-1 clone for publishing. Without --full it is blob-less with a
#       sparse cone (ingested, summaries, ids, sessions and the root files), so
#       no historical partition is fetched. --full checks out everything, which
#       a rebuild needs. Initialises an orphan tamperward-audit branch when the
#       remote has none yet.
#   audit-store-git.sh stage <dir> <changed-paths-file>
#       Stages exactly the store-relative paths listed in the file (one per
#       line): new partition files outside the sparse cone, rewritten shards,
#       and shard files a rebuild deleted (a listed path that no longer exists
#       stages its removal). Prints "staged" or "nothing".
set -euo pipefail

BRANCH=tamperward-audit

branch_exists() {
  git ls-remote --exit-code "$1" "refs/heads/${BRANCH}" >/dev/null 2>&1
}

usage() {
  echo "usage: audit-store-git.sh clone-ledger <remote> <dir> | clone-store <remote> <dir> [--full] | stage <dir> <changed-paths-file>" >&2
  exit 2
}

case "${1:-}" in
  clone-ledger)
    remote="${2:-}"; dir="${3:-}"
    [ -n "$remote" ] && [ -n "$dir" ] || usage
    if branch_exists "$remote"; then
      git clone --quiet --branch "$BRANCH" --single-branch --depth 1 --filter=blob:none --no-checkout "$remote" "$dir"
      if [ -n "$(git -C "$dir" ls-tree --name-only HEAD ingested/batches.jsonl)" ]; then
        git -C "$dir" checkout --quiet HEAD -- ingested/batches.jsonl
      fi
    else
      mkdir -p "$dir"
    fi
    ;;
  clone-store)
    remote="${2:-}"; dir="${3:-}"; mode="${4:-}"
    [ -n "$remote" ] && [ -n "$dir" ] || usage
    if branch_exists "$remote"; then
      if [ "$mode" = "--full" ]; then
        git clone --quiet --branch "$BRANCH" --single-branch --depth 1 "$remote" "$dir"
      else
        git clone --quiet --branch "$BRANCH" --single-branch --depth 1 --filter=blob:none --no-checkout "$remote" "$dir"
        git -C "$dir" sparse-checkout init --cone
        git -C "$dir" sparse-checkout set ingested summaries ids sessions
        git -C "$dir" checkout --quiet
      fi
    else
      git init --quiet "$dir"
      git -C "$dir" checkout --quiet --orphan "$BRANCH"
      git -C "$dir" remote add origin "$remote"
    fi
    ;;
  stage)
    dir="${2:-}"; list="${3:-}"
    [ -n "$dir" ] && [ -n "$list" ] || usage
    if [ -s "$list" ]; then
      # --sparse lets a new partition file outside the cone be staged without
      # widening the cone (which would check out the sibling files as well).
      tr '\n' '\0' < "$list" | xargs -0 git -C "$dir" add --sparse --
    fi
    if git -C "$dir" diff --cached --quiet; then echo nothing; else echo staged; fi
    ;;
  *)
    usage
    ;;
esac
