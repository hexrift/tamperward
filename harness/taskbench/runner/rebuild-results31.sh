#!/usr/bin/env bash
# Rebuild results.jsonl from the immutable per-trajectory verdict files.
# results.jsonl is derived, so this is always safe and always idempotent.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; . "$HERE/verdict-record.sh"
RUNS="${1:?usage: rebuild-results31.sh <runs-dir>}"
rebuild_results "$RUNS" || { echo "rebuild failed" >&2; exit 1; }
echo "results.jsonl rebuilt from $(ls "$RUNS"/*.verdict.json 2>/dev/null | wc -l) per-trajectory verdict files"
