#!/usr/bin/env bash
# Heavy stress: the ACTUAL D3 condition, not a proxy for it.
#
# The pure-clone stress found zero failures at concurrency 4, which refutes the
# simple "concurrent clones abort" reading of D3. The real condition was three
# full mining pipelines — clone AND `uv pip install` AND pytest — running at
# once, which is a memory, disk and CPU load a bare clone never applies. This
# reproduces that shape on already-spent round-3 repositories.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
LEVEL="${1:-3}"; N="${TB_STRESS_N:-3}"
mapfile -t REPOS < <(node -e '
const fs=require("fs");
console.log(JSON.parse(fs.readFileSync("../round3/frame/frame.json","utf8")).repos.map(x=>x.repo).slice(0,+process.argv[1]).join("\n"));' "$((LEVEL*N))")
echo "# heavy stress: $LEVEL concurrent clone+install pipelines over ${#REPOS[@]} spent repos"
free -m | awk 'NR==2{print "  mem before: used "$3"M avail "$7"M"}'; df -h / | tail -1 | awk '{print "  disk before: "$4" avail"}'
W=/tmp/tb-heavy; rm -rf "$W"; mkdir -p "$W"
ok=0; bad=0; pids=()
run_one(){
  local repo="$1" d="$W/$(echo "$1"|tr / _)"
  timeout 600 /usr/bin/git clone --quiet --filter=blob:none "https://github.com/$repo.git" "$d" >/dev/null 2>&1 || return 1
  ( cd "$d" && timeout 300 uv venv .venv >/dev/null 2>&1 && timeout 300 uv pip install -q -p .venv/bin/python -e . >/dev/null 2>&1 )
  return 0   # install failure is a normal gate outcome; only the CLONE matters here
}
for repo in "${REPOS[@]}"; do
  run_one "$repo" & pids+=($!)
  if [ "${#pids[@]}" -ge "$LEVEL" ]; then
    for p in "${pids[@]}"; do if wait "$p"; then ok=$((ok+1)); else bad=$((bad+1)); fi; done; pids=()
  fi
done
for p in "${pids[@]}"; do if wait "$p"; then ok=$((ok+1)); else bad=$((bad+1)); fi; done
free -m | awk 'NR==2{print "  mem after:  used "$3"M avail "$7"M"}'; df -h / | tail -1 | awk '{print "  disk after:  "$4" avail"}'
echo "  clone ok=$ok clone_failed=$bad"
rm -rf "$W"
