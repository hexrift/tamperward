#!/usr/bin/env bash
# Clone stress test — the gate before mining resumes or concurrency is raised.
#
# Uses ONLY repositories already spent in rounds 1-3, so nothing in the round-4
# frame is touched or burnt. Clones exactly as the miner does
# (--filter=blob:none, 600s timeout) at rising concurrency, and reports the
# failure rate at each level. The D3 incident was concurrent clones aborting and
# being recorded as terminal verdicts; this measures whether that reproduces and
# at what concurrency it starts.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
OUT="${1:-incident-D3/clone-stress.txt}"
N="${TB_STRESS_N:-8}"
mapfile -t REPOS < <(node -e '
const fs=require("fs");
const r3=JSON.parse(fs.readFileSync("../round3/frame/frame.json","utf8")).repos.map(x=>x.repo);
console.log(r3.slice(0, +process.argv[1]).join("\n"));' "$N")

{
echo "# Clone stress test — $(date -u +%FT%TZ)"
echo "# Repositories: the first $N of the round-3 frame (already spent; nothing in the round-4 frame is touched)."
echo "# Clone form: git clone --quiet --filter=blob:none, 600s timeout — identical to mine5.sh."
echo
for LEVEL in 1 2 3 4; do
  W=/tmp/tb-stress-$LEVEL; rm -rf "$W"; mkdir -p "$W"
  echo "== concurrency $LEVEL"
  start=$(date +%s); ok=0; bad=0; pids=(); i=0
  for repo in "${REPOS[@]}"; do
    ( timeout 600 /usr/bin/git clone --quiet --filter=blob:none "https://github.com/$repo.git" "$W/$(echo "$repo"|tr / _)" >/dev/null 2>&1 ) &
    pids+=($!); i=$((i+1))
    if [ "${#pids[@]}" -ge "$LEVEL" ]; then
      for p in "${pids[@]}"; do if wait "$p"; then ok=$((ok+1)); else bad=$((bad+1)); fi; done
      pids=()
    fi
  done
  for p in "${pids[@]}"; do if wait "$p"; then ok=$((ok+1)); else bad=$((bad+1)); fi; done
  el=$(( $(date +%s) - start ))
  echo "   ok=$ok failed=$bad elapsed=${el}s"
  rm -rf "$W"
done
echo
echo "# A non-zero failure count at any level reproduces D3 and means concurrency"
echo "# stays at that level or below. Zero failures throughout clears sharding for"
echo "# the COUNTED pool only; the pilot remains sequential by protocol (D4)."
} | tee "$OUT"
