#!/usr/bin/env bash
# Taskbench round-3 revalidation sweep — the frozen artifacts prove themselves
# from scratch; nothing the miner recorded is trusted. Run over ALL tasks.
# Pytest adaptation of round2/revalidate.sh (v3 semantics preserved: manifest
# hashes -> round-trip tree proof on the real clone -> frozen install ladder
# -> history strip -> visible RED (pytest true red: exit 1|2; 0/5 not-red,
# 3/4 error, 124 timeout) -> gold-on-visible GREEN (exit 0 exactly) ->
# pristine-on-buggy RED and pristine-on-gold GREEN for split tasks.
# Split uses split-cases-py.mjs (identical frozen semantics, Python grammar),
# plus a py_compile gate: a syntax-broken split would read as a FALSE red
# (collection error), so any touched visible file that fails to compile
# forces the runner-identical unsplit fallback instead. Disk guard aborts
# below 3GB free (round-2 run-1 and this round's ENOSPC precedents).
# v2 after run-1 (preserved as revalidation-run1-harnessdefects.jsonl): clean
# keeps in-tree *.so/*.pyd (02-orjson: cleaning the editable install's
# compiled extension read as GOLD_RED), and install precedes the history
# strip (09-iniconfig: post-strip scm version + pytest-dependency resolution
# replaced the code under test with the released wheel).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
W="${TB_RV_WORK:-/tmp/tb-reval3}"
OUT="${TB_RV_OUT:-$HERE/revalidation.jsonl}"   # supplements write elsewhere; run files are never mixed
mkdir -p "$W"
touch "$OUT"

VENV="$W/venv"
suite() { local t0=$SECONDS; ( cd "$1" && timeout 300 "$VENV/bin/python" -m pytest -q -p no:cacheprovider >/dev/null 2>&1 ); local r=$?; SUITE_SECS=$((SECONDS-t0)); return $r; }
is_red() { [ "$1" -eq 1 ] || [ "$1" -eq 2 ]; }
revert() { git -C "$1" checkout -q -- . 2>/dev/null; git -C "$1" clean -qfd -e '*.egg-info' -e '*.so' -e '*.pyd' 2>/dev/null; }

install_env() { # frozen FRAME3 ladder, one 300s budget, venv outside the tree
  local dir="$1"
  rm -rf "$VENV" "$W/rung"
  uv venv -q -p python3.11 "$VENV" 2>/dev/null || return 1
  timeout 300 bash -s -- "$dir" "$VENV" "$W" <<'LADDER'
set -u
dir="$1"; venv="$2"; work="$3"; py="$venv/bin/python"
cd "$dir"
for extra in test tests dev; do
  if uv pip install -q -p "$py" -e ".[$extra]" >/dev/null 2>&1; then echo "extras:$extra" > "$work/rung"; break; fi
done
if [ ! -f "$work/rung" ]; then
  uv pip install -q -p "$py" -e . >/dev/null 2>&1 && echo "plain" > "$work/rung"
fi
[ -f "$work/rung" ] || exit 1
for rf in requirements-dev.txt requirements_dev.txt dev-requirements.txt \
          requirements-test.txt test-requirements.txt requirements/dev.txt requirements/test.txt; do
  if [ -f "$rf" ]; then uv pip install -q -p "$py" -r "$rf" >/dev/null 2>&1; break; fi
done
uv pip install -q -p "$py" pytest >/dev/null 2>&1
exit 0
LADDER
}

unsplit() { # restore pristine full files into the tree, drop the withheld ledger
  local D="$1" O="$2"
  ( cd "$O/pristine" && find . -type f ) | while read -r f; do mkdir -p "$D/$(dirname "$f")"; cp "$O/pristine/$f" "$D/$f"; done
  rm -f "$O/withheld.json"
}

for TASK in "$HERE"/tasks/*/; do
  ID=$(basename "$TASK")
  if [ -n "${TB_RV_ONLY:-}" ]; then case " $TB_RV_ONLY " in *" $ID "*) ;; *) continue ;; esac; fi
  grep -q "\"id\":\"$ID\"" "$OUT" && continue   # resumable

  free_kb=$(df --output=avail / | tail -1 | tr -d ' ')
  if [ "$free_kb" -lt 3000000 ]; then
    echo "REVALIDATION ABORTED: disk below 3GB free ($free_kb KB) — refusing to emit spurious failures"
    exit 2
  fi

  REPO=$(jq -r .repo "$TASK/manifest.json")
  PARENT=$(jq -r .parent_sha "$TASK/manifest.json")
  STRENGTH=$(jq -r .oracle_strength "$TASK/manifest.json")
  D="$W/repo"; O="$W/oracle"
  emit() { echo "{\"id\":\"$ID\",\"ok\":$1,\"fail\":\"${2:-}\",\"detail\":\"${3:-}\"}" >> "$OUT"; echo "[reval] $ID -> ${2:-OK}"; rm -rf "$D" "$O" "$VENV"; }

  th=$(sha256sum "$TASK/test.patch" | cut -d' ' -f1); gh=$(sha256sum "$TASK/gold.patch" | cut -d' ' -f1)
  [ "$th" = "$(jq -r .test_patch_sha256 "$TASK/manifest.json")" ] || { emit false HASH_MISMATCH test.patch; continue; }
  [ "$gh" = "$(jq -r .gold_patch_sha256 "$TASK/manifest.json")" ] || { emit false HASH_MISMATCH gold.patch; continue; }

  rm -rf "$D" "$O"; mkdir -p "$O"
  timeout 600 git clone -q --filter=blob:none "https://github.com/$REPO.git" "$D" 2>/dev/null || { emit false CLONE_FAILED; continue; }
  git -C "$D" checkout -q --detach "$PARENT" 2>/dev/null || { emit false PARENT_MISSING; continue; }
  git -C "$D" apply "$TASK/test.patch" 2>/dev/null || { emit false TEST_PATCH_APPLY; continue; }
  # ROUND-TRIP INVARIANT: parent + test.patch + gold.patch == historical tree
  COMMIT=$(jq -r .commit_sha "$TASK/manifest.json")
  if git -C "$D" apply "$TASK/gold.patch" 2>/dev/null; then
    git -C "$D" add -A 2>/dev/null
    NT=$(git -C "$D" write-tree 2>/dev/null)
    HT=$(git -C "$D" rev-parse "$COMMIT^{tree}" 2>/dev/null)
    git -C "$D" reset -q 2>/dev/null; git -C "$D" checkout -q -- . 2>/dev/null; git -C "$D" clean -qfd 2>/dev/null
    git -C "$D" apply "$TASK/test.patch" 2>/dev/null
    [ "$NT" = "$HT" ] || { emit false GOLD_ROUNDTRIP_MISMATCH "$NT!=$HT"; continue; }
  else
    emit false GOLD_APPLY "roundtrip stage"; continue
  fi

  SPLIT="none"
  if [ "$STRENGTH" = "INTEGRITY+SEMANTIC" ]; then
    node "$HERE/../runner/split-cases-py.mjs" "$TASK" "$D" "$O" >/dev/null 2>&1 && SPLIT="applied" || SPLIT="unavailable"
    if [ "$SPLIT" = "applied" ]; then
      # py_compile gate: a syntax-broken split reads as a false red
      while read -r f; do
        [ -f "$D/$f" ] || continue
        python3 -m py_compile "$D/$f" 2>/dev/null || { unsplit "$D" "$O"; SPLIT="fallback-syntax"; break; }
      done < <(cd "$O/pristine" && find . -type f | sed 's|^\./||')
    fi
  else
    node "$HERE/../runner/split-cases-py.mjs" "$TASK" "$D" "$O" >/dev/null 2>&1 || true
    rm -f "$O/withheld.json"; SPLIT="none"
    if [ -d "$O/pristine" ]; then unsplit "$D" "$O"; fi
  fi
  # install BEFORE the history strip: mining installed against the real clone,
  # and scm-versioned repos that are dependencies of pytest itself (run-1
  # failure 09-iniconfig) otherwise get their editable install replaced by the
  # released wheel when the ladder ensures pytest. The editable finder points
  # at the path, so it survives the strip.
  install_env "$D" || { emit false INSTALL_FAILED; continue; }
  rm -rf "$D/.git"
  ( cd "$D" && git init -q && git add -A && git -c user.email=t@b -c user.name=tb commit -qm base --no-verify )

  # visible red (pytest true red: 1|2)
  suite "$D"; rc=$?
  if [ "$rc" -eq 0 ] && [ "$SPLIT" = "applied" ]; then
    # section-8: a split that withholds all the red is invalid — unsplit fallback
    unsplit "$D" "$O"; SPLIT="fallback-integrity"
    ( cd "$D" && git add -A && git -c user.email=t@b -c user.name=tb commit -qm unsplit --no-verify )
    suite "$D"; rc=$?
    [ "$rc" -eq 0 ] && { emit false UNSPLIT_NOT_RED; continue; }
  fi
  { [ "$rc" -eq 0 ] || [ "$rc" -eq 5 ]; } && { emit false VISIBLE_NOT_RED "rc=$rc secs=$SUITE_SECS"; continue; }
  [ "$rc" -eq 124 ] && { emit false VISIBLE_TIMEOUT "secs=$SUITE_SECS"; continue; }
  is_red "$rc" || { emit false VISIBLE_ERROR "rc=$rc"; continue; }
  revert "$D"

  # gold-on-visible green (exit 0 exactly) — in place, reverted after
  git -C "$D" apply "$TASK/gold.patch" 2>/dev/null || { emit false GOLD_APPLY; continue; }
  suite "$D"; grc=$?
  revert "$D"
  if [ "$grc" -ne 0 ] && [ "$SPLIT" = "applied" ]; then
    # runner-identical fallback: drop the split, re-prove red and gold
    unsplit "$D" "$O"; SPLIT="fallback-integrity"
    ( cd "$D" && git add -A && git -c user.email=t@b -c user.name=tb commit -qm unsplit --no-verify )
    suite "$D"; rc=$?
    [ "$rc" -eq 0 ] && { emit false UNSPLIT_NOT_RED; continue; }
    revert "$D"
    git -C "$D" apply "$TASK/gold.patch" 2>/dev/null || { emit false GOLD_APPLY unsplit; continue; }
    suite "$D"; grc=$?
    revert "$D"
  fi
  [ "$grc" -eq 124 ] && { emit false GOLD_TIMEOUT "secs=$SUITE_SECS"; continue; }
  [ "$grc" -ne 0 ] && { emit false GOLD_RED "rc=$grc secs=$SUITE_SECS"; continue; }

  # semantic oracle behavior — in place, reverted after each
  if [ "$SPLIT" = "applied" ]; then
    unsplit_keep() { ( cd "$O/pristine" && find . -type f ) | while read -r f; do mkdir -p "$D/$(dirname "$f")"; cp "$O/pristine/$f" "$D/$f"; done; }
    unsplit_keep
    suite "$D"; prc=$?
    revert "$D"
    is_red "$prc" || { emit false PRISTINE_ON_BUGGY_NOT_RED "rc=$prc"; continue; }
    git -C "$D" apply "$TASK/gold.patch" 2>/dev/null
    unsplit_keep
    suite "$D"; qrc=$?
    revert "$D"
    [ "$qrc" -ne 0 ] && { emit false PRISTINE_ON_GOLD_NOT_GREEN "rc=$qrc"; continue; }
  fi

  echo "{\"id\":\"$ID\",\"ok\":true,\"split\":\"$SPLIT\"}" >> "$OUT"
  echo "[reval] $ID -> OK (split=$SPLIT)"
  rm -rf "$D" "$O" "$VENV"
done
ok=$(grep -c '"ok":true' "$OUT" || true); bad=$(grep -c '"ok":false' "$OUT" || true)
echo "REVALIDATION COMPLETE: $ok ok, $bad failed"
