#!/usr/bin/env bash
# Taskbench Phase-0 revalidation sweep — the frozen artifacts prove themselves
# from scratch; nothing the miner recorded is trusted. Run over ALL tasks.
#
# Per task: manifest hashes match → clean materialization (clone parent, apply
# test patch, split where semantic, fresh git) → install → visible suite RED
# (true red, not timeout) → gold-on-visible GREEN → pristine-on-buggy RED and
# pristine-on-gold GREEN (semantic tasks). One JSON line per task; resumable.
#
# v3 adds, from the gold-failure diagnosis: a pre-strip ROUND-TRIP proof
# (parent + test.patch + gold.patch must write-tree to exactly the historical
# commit tree), tree restoration before every gold/suite transition (suite
# runs mutate tracked files and drop artifacts), and the NOT_RED-under-split
# unsplit fallback per frozen section 8.
# v2, after run 1 was contaminated by disk exhaustion (kept as
# revalidation-run1-diskcontaminated.jsonl): all checks run IN PLACE with git
# revert between them — no full-tree copies of installed node_modules — every
# failure path cleans its work dir, and a disk guard aborts the sweep loudly
# below 3GB free rather than emitting spurious failures.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
W="${TB_RV_WORK:-/tmp/tb-reval}"
OUT="$HERE/revalidation.jsonl"
mkdir -p "$W"
touch "$OUT"

suite() { local t0=$SECONDS; ( cd "$1" && timeout 300 npm test --silent >/dev/null 2>&1 ); local r=$?; SUITE_SECS=$((SECONDS-t0)); return $r; }
revert() { git -C "$1" checkout -q -- . 2>/dev/null; git -C "$1" clean -qfd -e node_modules 2>/dev/null; }

for TASK in "$HERE"/tasks/*/; do
  ID=$(basename "$TASK")
  grep -q "\"id\":\"$ID\"" "$OUT" && continue   # resumable

  free_kb=$(df --output=avail / | tail -1 | tr -d ' ')
  if [ "$free_kb" -lt 3000000 ]; then
    echo "REVALIDATION ABORTED: disk below 3GB free ($free_kb KB) — refusing to emit spurious failures"
    exit 2
  fi

  REPO=$(jq -r .repo "$TASK/manifest.json")
  PARENT=$(jq -r .parent_sha "$TASK/manifest.json")
  PM=$(jq -r .pm "$TASK/manifest.json")
  STRENGTH=$(jq -r .oracle_strength "$TASK/manifest.json")
  D="$W/repo"; O="$W/oracle"
  emit() { echo "{\"id\":\"$ID\",\"ok\":$1,\"fail\":\"${2:-}\",\"detail\":\"${3:-}\"}" >> "$OUT"; echo "[reval] $ID -> ${2:-OK}"; rm -rf "$D" "$O"; }

  th=$(sha256sum "$TASK/test.patch" | cut -d' ' -f1); gh=$(sha256sum "$TASK/gold.patch" | cut -d' ' -f1)
  [ "$th" = "$(jq -r .test_patch_sha256 "$TASK/manifest.json")" ] || { emit false HASH_MISMATCH test.patch; continue; }
  [ "$gh" = "$(jq -r .gold_patch_sha256 "$TASK/manifest.json")" ] || { emit false HASH_MISMATCH gold.patch; continue; }

  rm -rf "$D" "$O"; mkdir -p "$O"
  timeout 600 git clone -q --filter=blob:none "https://github.com/$REPO.git" "$D" 2>/dev/null || { emit false CLONE_FAILED; continue; }
  git -C "$D" checkout -q --detach "$PARENT" 2>/dev/null || { emit false PARENT_MISSING; continue; }
  git -C "$D" apply "$TASK/test.patch" 2>/dev/null || { emit false TEST_PATCH_APPLY; continue; }
  # ROUND-TRIP INVARIANT: parent + test.patch + gold.patch must reconstruct
  # the historical commit tree exactly (write-tree comparison — names, modes,
  # symlinks, contents). Proven on the real clone before history is stripped.
  COMMIT=$(jq -r .commit_sha "$TASK/manifest.json")
  if git -C "$D" apply "$TASK/gold.patch" 2>/dev/null; then
    git -C "$D" add -A 2>/dev/null
    NT=$(git -C "$D" write-tree 2>/dev/null)
    HT=$(git -C "$D" rev-parse "$COMMIT^{tree}" 2>/dev/null)
    git -C "$D" reset -q 2>/dev/null; git -C "$D" checkout -q -- . 2>/dev/null; git -C "$D" clean -qfd 2>/dev/null
    git -C "$D" apply "$TASK/test.patch" 2>/dev/null   # clean -fd removed patch-added untracked files; reapply
    [ "$NT" = "$HT" ] || { emit false GOLD_ROUNDTRIP_MISMATCH "$NT!=$HT"; continue; }
  else
    emit false GOLD_APPLY "roundtrip stage"; continue
  fi
  SPLIT="none"
  if [ "$STRENGTH" = "INTEGRITY+SEMANTIC" ]; then
    node "$HERE/runner/split-cases.mjs" "$TASK" "$D" "$O" >/dev/null 2>&1 && SPLIT="applied" || SPLIT="unavailable"
  else
    node "$HERE/runner/split-cases.mjs" "$TASK" "$D" "$O" >/dev/null 2>&1 || true
    rm -f "$O/withheld.json"; SPLIT="none"
    if [ -d "$O/pristine" ]; then (cd "$O/pristine" && find . -type f) | while read -r f; do mkdir -p "$D/$(dirname "$f")"; cp "$O/pristine/$f" "$D/$f"; done; fi
  fi
  rm -rf "$D/.git"
  ( cd "$D" && git init -q && git add -A && git -c user.email=t@b -c user.name=tb commit -qm base --no-verify )

  case "$PM" in
    yarn) I='yarn install 2>/dev/null || yarn install' ;;
    pnpm) I='pnpm install 2>/dev/null || pnpm install' ;;
    *)    I='npm install --no-audit --no-fund' ;;
  esac
  ( cd "$D" && timeout 600 bash -c "$I" >/dev/null 2>&1 ) || { emit false INSTALL_FAILED; continue; }

  # visible red (true red)
  suite "$D"; rc=$?
  if [ "$rc" -eq 0 ] && [ "$SPLIT" = "applied" ]; then
    # section-8: a split that withholds all the red is invalid — unsplit fallback
    ( cd "$O/pristine" && find . -type f ) | while read -r f; do mkdir -p "$D/$(dirname "$f")"; cp "$O/pristine/$f" "$D/$f"; done
    rm -f "$O/withheld.json"; SPLIT="fallback-integrity"
    ( cd "$D" && git add -A && git -c user.email=t@b -c user.name=tb commit -qm unsplit --no-verify )
    suite "$D"; rc=$?
    [ "$rc" -eq 0 ] && { emit false UNSPLIT_NOT_RED; continue; }
  fi
  [ "$rc" -eq 0 ] && { emit false VISIBLE_NOT_RED "secs=$SUITE_SECS"; continue; }
  [ "$rc" -eq 124 ] && { emit false VISIBLE_TIMEOUT "secs=$SUITE_SECS"; continue; }
  # suite runs can mutate tracked files (builds) and drop untracked artifacts;
  # restore before the gold check or the patch context no longer matches
  revert "$D"

  # gold-on-visible green — in place, reverted after
  git -C "$D" apply "$TASK/gold.patch" 2>/dev/null || { emit false GOLD_APPLY; continue; }
  suite "$D"; grc=$?
  revert "$D"
  if [ "$grc" -ne 0 ] && [ "$SPLIT" = "applied" ]; then
    # runner-identical fallback: drop the split, re-prove red and gold
    ( cd "$O/pristine" && find . -type f ) | while read -r f; do mkdir -p "$D/$(dirname "$f")"; cp "$O/pristine/$f" "$D/$f"; done
    rm -f "$O/withheld.json"; SPLIT="fallback-integrity"
    ( cd "$D" && git add -A && git -c user.email=t@b -c user.name=tb commit -qm unsplit --no-verify )
    suite "$D"; rc=$?
    [ "$rc" -eq 0 ] && { emit false UNSPLIT_NOT_RED; continue; }
    revert "$D"
    git -C "$D" apply "$TASK/gold.patch" 2>/dev/null || { emit false GOLD_APPLY unsplit; continue; }
    suite "$D"; grc=$?
    revert "$D"
  fi
  [ "$grc" -eq 124 ] && { emit false GOLD_TIMEOUT "secs=$SUITE_SECS"; continue; }
  [ "$grc" -ne 0 ] && { emit false GOLD_RED "secs=$SUITE_SECS"; continue; }

  # semantic oracle behavior — in place, reverted after each
  if [ "$SPLIT" = "applied" ]; then
    ( cd "$O/pristine" && find . -type f ) | while read -r f; do mkdir -p "$D/$(dirname "$f")"; cp "$O/pristine/$f" "$D/$f"; done
    suite "$D"; prc=$?
    revert "$D"
    { [ "$prc" -eq 0 ] || [ "$prc" -eq 124 ]; } && { emit false PRISTINE_ON_BUGGY_NOT_RED "rc=$prc"; continue; }
    git -C "$D" apply "$TASK/gold.patch" 2>/dev/null
    ( cd "$O/pristine" && find . -type f ) | while read -r f; do mkdir -p "$D/$(dirname "$f")"; cp "$O/pristine/$f" "$D/$f"; done
    suite "$D"; qrc=$?
    revert "$D"
    [ "$qrc" -ne 0 ] && { emit false PRISTINE_ON_GOLD_NOT_GREEN "rc=$qrc"; continue; }
  fi

  echo "{\"id\":\"$ID\",\"ok\":true,\"split\":\"$SPLIT\"}" >> "$OUT"
  echo "[reval] $ID -> OK (split=$SPLIT)"
  rm -rf "$D" "$O"
done
ok=$(grep -c '"ok":true' "$OUT" || true); bad=$(grep -c '"ok":false' "$OUT" || true)
echo "REVALIDATION COMPLETE: $ok ok, $bad failed"
