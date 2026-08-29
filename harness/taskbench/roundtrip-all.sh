#!/usr/bin/env bash
# Universal round-trip proof (pre-tag requirement): for EVERY task,
# parent + test.patch + gold.patch must write-tree to exactly the historical
# commit tree. Pure artifact check — no installs, no suites. Records one line
# per task to roundtrip.jsonl including the patch hashes at proof time, so
# verify-pool.sh can permanently assert that every pooled artifact carries a
# valid proof (a changed artifact invalidates its recorded proof).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/roundtrip.jsonl"
: > "$OUT"
fail=0
for TASK in "$HERE"/tasks/*/; do
  ID=$(basename "$TASK")
  REPO=$(jq -r .repo "$TASK/manifest.json")
  P=$(jq -r .parent_sha "$TASK/manifest.json")
  C=$(jq -r .commit_sha "$TASK/manifest.json")
  th=$(sha256sum "$TASK/test.patch" | cut -d' ' -f1)
  gh=$(sha256sum "$TASK/gold.patch" | cut -d' ' -f1)
  W=$(mktemp -d /tmp/tb-rt-XXXXXX)
  ok=false; tree=""; note=""
  if timeout 600 git clone -q --filter=blob:none "https://github.com/$REPO.git" "$W/r" 2>/dev/null \
     && git -C "$W/r" checkout -q --detach "$P" 2>/dev/null \
     && git -C "$W/r" apply "$TASK/test.patch" 2>/dev/null \
     && git -C "$W/r" apply "$TASK/gold.patch" 2>/dev/null; then
    git -C "$W/r" add -A 2>/dev/null
    NT=$(git -C "$W/r" write-tree 2>/dev/null)
    HT=$(git -C "$W/r" rev-parse "$C^{tree}" 2>/dev/null)
    tree="$NT"
    [ -n "$NT" ] && [ "$NT" = "$HT" ] && ok=true || note="tree $NT != $HT"
  else
    note="clone/checkout/apply failed"
  fi
  rm -rf "$W"
  echo "{\"id\":\"$ID\",\"ok\":$ok,\"tree\":\"$tree\",\"test_sha\":\"$th\",\"gold_sha\":\"$gh\",\"note\":\"$note\"}" >> "$OUT"
  $ok || { echo "[roundtrip] $ID FAILED: $note"; fail=1; }
  echo "[roundtrip] $ID $($ok && echo OK || echo FAILED)"
done
n=$(grep -c '"ok":true' "$OUT" || true)
echo "ROUNDTRIP COMPLETE: $n/$(ls -d "$HERE"/tasks/*/ | wc -l) exact tree matches"
exit $fail
