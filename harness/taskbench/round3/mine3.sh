#!/usr/bin/env bash
# Taskbench round-3 miner: walk frame/walk-order.json, apply FRAME3.md's
# pytest gates, emit attrition.jsonl + tasks/<id>/{manifest.json,test.patch,
# gold.patch}. Deterministic given the frame and walk order; resumable — a
# repo is skipped ONLY on a repo-level verdict line (FRAME2 correction 3's
# standing rule), and walk completion is checked by completeness arithmetic.
# Frozen with FRAME3.md before mapping or mining; a mid-walk edit to this
# file is a logged protocol deviation. No agent runs happen here.
set -uo pipefail
cd "$(dirname "$0")"
WORK="${TB_WORK:-/tmp/tb-mine3}"
CLONE_BASE="${TB_CLONE_BASE:-https://github.com}"  # file:// base in the selftest
mkdir -p "$WORK" tasks
ATTR=attrition.jsonl
touch "$ATTR"

SINCE="2024-08-29"; UNTIL="2026-08-29"
FLOOR="2025-08-31"
CAND_CAP=8; STEP_TIMEOUT=300
PILOT_NEED=3; QUOTA_SINGLE=15; QUOTA_WS=15

# The neutral v1.14.0 policy's Python protected.tests, as regexes:
# **/test_*.py  **/*_test.py  **/conftest.py
TESTGLOB_RE='((^|/)test_[^/]*\.py$|(^|/)[^/]*_test\.py$|(^|/)conftest\.py$)'
SRC_RE='\.py$'
VENDOR_RE='(^|/)(vendor|_vendor|third_party)/'
STRATUM_EXCL_RE='(^|/)(test|tests|testing|doc|docs|example|examples|fixtures|vendor|_vendor|third_party|benchmark|benchmarks)/'
# Repo-level verdicts (resume + completeness both key on exactly this set)
VERDICT_RE='"gate":"(EXCLUDED_INACTIVE|G0_NO_PYPROJECT|G0_NOT_PYTEST|G0_NO_TESTS|NO_QUALIFYING_COMMITS|CLONE_FAILED|CANDIDATES_EXHAUSTED|TASK_VALIDATED|QUOTA_FULL)"'

PYV=$(python3 --version 2>&1 | awk '{print $2}')
UVV=$(uv --version 2>&1 | awk '{print $2}')
VENV="$WORK/venv"

log() { echo "$1" >> "$ATTR"; }
jlog() { # repo, code, extra-json-fragment
  log "{\"repo\":\"$1\",\"gate\":\"$2\"${3:+,$3}}"
}

counts() { # prints "pilot single ws"
  node -e '
    const fs=require("fs");
    let p=0,s=0,w=0;
    if (fs.existsSync("tasks")) for (const d of fs.readdirSync("tasks")) {
      const mf=`tasks/${d}/manifest.json`;
      if (!fs.existsSync(mf)) continue;
      const m=JSON.parse(fs.readFileSync(mf,"utf8"));
      if (m.role==="pilot") p++;
      else if (m.stratum==="single-distribution") s++;
      else w++;
    }
    console.log(`${p} ${s} ${w}`);'
}

run_suite() { # dir -> exit code of the frozen suite command under timeout
  ( cd "$1" && timeout "$STEP_TIMEOUT" "$VENV/bin/python" -m pytest -q -p no:cacheprovider >/dev/null 2>&1 )
}

install_env() { # dir -> 0 on success; writes the successful rung to $WORK/rung
  local dir="$1"
  rm -rf "$VENV" "$WORK/rung"
  uv venv -q -p python3.11 "$VENV" 2>/dev/null || return 1
  # One 300s budget for the whole frozen ladder (FRAME3.md gate 1)
  timeout "$STEP_TIMEOUT" bash -s -- "$dir" "$VENV" "$WORK" <<'LADDER'
set -u
dir="$1"; venv="$2"; work="$3"; py="$venv/bin/python"
cd "$dir"
for extra in test tests dev; do
  if uv pip install -q -p "$py" -e ".[$extra]" >/dev/null 2>&1; then
    echo "extras:$extra" > "$work/rung"; break
  fi
done
if [ ! -f "$work/rung" ]; then
  uv pip install -q -p "$py" -e . >/dev/null 2>&1 && echo "plain" > "$work/rung"
fi
[ -f "$work/rung" ] || exit 1
for rf in requirements-dev.txt requirements_dev.txt dev-requirements.txt \
          requirements-test.txt test-requirements.txt requirements/dev.txt requirements/test.txt; do
  if [ -f "$rf" ]; then
    uv pip install -q -p "$py" -r "$rf" >/dev/null 2>&1 && printf '+%s\n' "$rf" >> "$work/rung"
    break
  fi
done
uv pip install -q -p "$py" pytest >/dev/null 2>&1
exit 0
LADDER
}

process_repo() {
  local repo="$1" dir="$WORK/repo"
  rm -rf "$dir"
  if ! timeout 600 git clone --quiet --filter=blob:none "$CLONE_BASE/$repo.git" "$dir" 2>/dev/null; then
    jlog "$repo" "CLONE_FAILED"; return
  fi
  # activity floor (12 months before the FRAME3 freeze)
  local head_date; head_date=$(git -C "$dir" log -1 --format=%cs 2>/dev/null || echo "")
  if [[ -z "$head_date" || "$head_date" < "$FLOOR" ]]; then
    jlog "$repo" "EXCLUDED_INACTIVE" "\"head_date\":\"$head_date\""; return
  fi
  # gate 0 (per-repo): project marker, pytest-shaped, tests present
  if [ ! -f "$dir/pyproject.toml" ] && [ ! -f "$dir/setup.py" ] && [ ! -f "$dir/setup.cfg" ]; then
    jlog "$repo" "G0_NO_PYPROJECT"; return
  fi
  local shaped=0
  [ -f "$dir/pytest.ini" ] && shaped=1
  [ "$shaped" -eq 0 ] && [ -f "$dir/pyproject.toml" ] && grep -q 'pytest' "$dir/pyproject.toml" 2>/dev/null && shaped=1
  [ "$shaped" -eq 0 ] && [ -f "$dir/setup.cfg" ] && grep -q '\[tool:pytest\]' "$dir/setup.cfg" 2>/dev/null && shaped=1
  [ "$shaped" -eq 0 ] && [ -f "$dir/tox.ini" ] && grep -q '^\[pytest\]' "$dir/tox.ini" 2>/dev/null && shaped=1
  [ "$shaped" -eq 0 ] && git -C "$dir" ls-files 2>/dev/null | grep -qE '(^|/)conftest\.py$' && shaped=1
  if [ "$shaped" -eq 0 ]; then jlog "$repo" "G0_NOT_PYTEST"; return; fi
  if ! git -C "$dir" ls-files 2>/dev/null | grep -qE "$TESTGLOB_RE"; then
    jlog "$repo" "G0_NO_TESTS"; return
  fi
  # classification (FRAME3.md): tracked non-root pyproject/setup.py outside the
  # frozen segment-exclusion list -> workspace; else single-distribution
  local stratum="single-distribution"
  if git -C "$dir" ls-files -- '*/pyproject.toml' '*/setup.py' 2>/dev/null \
      | grep -vE "$STRATUM_EXCL_RE" | grep -q .; then
    stratum="workspace"
  fi
  # quota check (pilot slots are stratum-blind)
  read -r P S W <<< "$(counts)"
  if [ "$P" -ge "$PILOT_NEED" ]; then
    if [[ "$stratum" == "single-distribution" && "$S" -ge "$QUOTA_SINGLE" ]]; then jlog "$repo" "QUOTA_FULL" "\"stratum\":\"$stratum\""; return; fi
    if [[ "$stratum" == "workspace" && "$W" -ge "$QUOTA_WS" ]]; then jlog "$repo" "QUOTA_FULL" "\"stratum\":\"$stratum\""; return; fi
  fi
  # enumerate qualifying commits, newest first
  local cands
  cands=$(git -C "$dir" log --no-merges --since="$SINCE" --until="$UNTIL" --pretty='%x01%H' --name-only 2>/dev/null | node -e '
    const RE_T=new RegExp(process.argv[1]), RE_S=new RegExp(process.argv[2]), RE_V=new RegExp(process.argv[3]);
    let out=[],cur=null,t=false,s=false;
    require("fs").readFileSync(0,"utf8").split("\n").forEach(l=>{
      if (l.startsWith("\x01")) { if(cur&&t&&s) out.push(cur); cur=l.slice(1); t=s=false; }
      else if (l && !RE_V.test(l)) {
        if (RE_T.test(l)) t=true; else if (RE_S.test(l)) s=true;
      }
    });
    if(cur&&t&&s) out.push(cur);
    console.log(out.slice(0, +process.argv[4]).join(" "));
  ' "$TESTGLOB_RE" "$SRC_RE" "$VENDOR_RE" "$CAND_CAP")
  if [ -z "$cands" ]; then jlog "$repo" "NO_QUALIFYING_COMMITS"; return; fi

  local n=0
  for c in $cands; do
    n=$((n+1))
    local parent="$c^"
    local tfiles
    tfiles=$(git -C "$dir" diff --name-only "$parent" "$c" 2>/dev/null | grep -E "$TESTGLOB_RE" | grep -vE "$VENDOR_RE" || true)
    [ -z "$tfiles" ] && { jlog "$repo" "C_NO_TESTFILES" "\"commit\":\"$c\""; continue; }
    git -C "$dir" checkout -q --detach "$parent" 2>/dev/null || { jlog "$repo" "C_CHECKOUT_FAILED" "\"commit\":\"$c\""; continue; }
    git -C "$dir" clean -qfdx 2>/dev/null
    # gate 1: fresh venv + the frozen install ladder
    if ! install_env "$dir"; then
      jlog "$repo" "G1_INSTALL_FAILED" "\"commit\":\"$c\""; continue
    fi
    local rung; rung=$(tr '\n' ' ' < "$WORK/rung" 2>/dev/null | sed 's/ $//'); rung=${rung:-unknown}
    # gate 2: parent suite green (FRAME3 exit-code semantics: green=0, red={1,2},
    # 5=no tests collected, 124=timeout, else harness error)
    run_suite "$dir"; rc=$?
    if [ "$rc" -eq 124 ]; then jlog "$repo" "G2_PARENT_TIMEOUT" "\"commit\":\"$c\""; continue; fi
    if [ "$rc" -eq 5 ]; then jlog "$repo" "G2_NO_TESTS_COLLECTED" "\"commit\":\"$c\""; continue; fi
    if [ "$rc" -eq 1 ] || [ "$rc" -eq 2 ]; then jlog "$repo" "G2_PARENT_RED" "\"commit\":\"$c\""; continue; fi
    if [ "$rc" -ne 0 ]; then jlog "$repo" "G2_PARENT_ERROR" "\"commit\":\"$c\",\"rc\":$rc"; continue; fi
    # gate 3: apply test patch -> red
    git -C "$dir" diff --binary --full-index "$parent" "$c" -- $tfiles > "$WORK/test.patch" 2>/dev/null
    [ -s "$WORK/test.patch" ] || { jlog "$repo" "C_EMPTY_TEST_PATCH" "\"commit\":\"$c\""; continue; }
    if ! git -C "$dir" apply "$WORK/test.patch" 2>/dev/null; then
      jlog "$repo" "G3_PATCH_APPLY_FAILED" "\"commit\":\"$c\""; continue
    fi
    run_suite "$dir"; rc=$?
    if [ "$rc" -eq 124 ]; then
      git -C "$dir" checkout -q -- . ; jlog "$repo" "G3_TIMEOUT" "\"commit\":\"$c\""; continue
    fi
    if [ "$rc" -eq 0 ] || [ "$rc" -eq 5 ]; then
      git -C "$dir" checkout -q -- . ; jlog "$repo" "G3_NOT_RED" "\"commit\":\"$c\",\"rc\":$rc"; continue
    fi
    if [ "$rc" -ne 1 ] && [ "$rc" -ne 2 ]; then
      git -C "$dir" checkout -q -- . ; jlog "$repo" "G3_ERROR" "\"commit\":\"$c\",\"rc\":$rc"; continue
    fi
    # gate 4: true red reproduces twice more
    local red_ok=1
    for i in 1 2; do
      run_suite "$dir"; rc=$?
      if [ "$rc" -ne 1 ] && [ "$rc" -ne 2 ]; then red_ok=0; break; fi
    done
    if [ "$red_ok" -ne 1 ]; then
      git -C "$dir" checkout -q -- .
      if [ "$rc" -eq 124 ]; then jlog "$repo" "G4_TIMEOUT" "\"commit\":\"$c\""; else jlog "$repo" "G4_NONDETERMINISTIC" "\"commit\":\"$c\",\"rc\":$rc"; fi
      continue
    fi
    # gate 5: full commit tree green
    git -C "$dir" checkout -q -- .
    git -C "$dir" checkout -q --detach "$c" 2>/dev/null
    run_suite "$dir"; rc=$?
    if [ "$rc" -eq 124 ]; then jlog "$repo" "G5_TIMEOUT" "\"commit\":\"$c\""; continue; fi
    if [ "$rc" -ne 0 ]; then jlog "$repo" "G5_COMMIT_RED" "\"commit\":\"$c\",\"rc\":$rc"; continue; fi
    # PASS: materialize task artifacts (TASK_VALIDATED only on materialization success)
    if ! node - "$repo" "$c" "$WORK/test.patch" "$dir" "$stratum" "$rung" "$PYV" "$UVV" <<'EOF'
const fs=require('fs'),cp=require('child_process'),crypto=require('crypto');
const [repo,commit,testPatch,dir,stratum,rung,pyv,uvv]=process.argv.slice(2);
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const parent=cp.execSync(`git -C ${dir} rev-parse ${commit}^`).toString().trim();
const tglob=/((^|\/)test_[^/]*\.py$|(^|\/)[^/]*_test\.py$|(^|\/)conftest\.py$)/;
const tfiles=cp.execSync(`git -C ${dir} diff --name-only ${parent} ${commit}`).toString().trim().split('\n').filter(f=>tglob.test(f));
const excl=tfiles.map(f=>`':(exclude)${f}'`).join(' ');
// --binary --full-index + long-form excludes: round-1/2 lessons (gitattributes
// -diff stubs; underscore-leading paths). TB_WORK-aware (round-2 correction).
cp.execSync(`git -C ${dir} diff --binary --full-index ${parent} ${commit} -- . ${excl} > ${process.env.TB_WORK || '/tmp/tb-mine3'}/gold.patch`,{shell:'/bin/bash'});
const tp=fs.readFileSync(testPatch,'utf8');
const cases=(tp.match(/^\+\s*(async\s+)?def test_/gm)||[]).length;
let n=0; for (const d of fs.existsSync('tasks')?fs.readdirSync('tasks'):[]) n++;
const pilot = (()=>{let p=0;for(const d of fs.existsSync('tasks')?fs.readdirSync('tasks'):[]){try{if(JSON.parse(fs.readFileSync(`tasks/${d}/manifest.json`)).role==='pilot')p++}catch{}}return p})();
const id=String(n+1).padStart(2,'0')+'-'+repo.replace('/','-');
fs.mkdirSync(`tasks/${id}`,{recursive:true});
fs.copyFileSync(testPatch,`tasks/${id}/test.patch`);
fs.copyFileSync(`${process.env.TB_WORK || '/tmp/tb-mine3'}/gold.patch`,`tasks/${id}/gold.patch`);
const manifest={
  id, repo, role: pilot<3?'pilot':'main', stratum,
  parent_sha:parent, commit_sha:commit,
  test_patch_sha256:sha(`tasks/${id}/test.patch`),
  gold_patch_sha256:sha(`tasks/${id}/gold.patch`),
  test_files:tfiles,
  python:pyv, uv:uvv, install_rung:rung,
  suite_cmd:'python -m pytest -q -p no:cacheprovider',
  added_case_lines:cases,
  oracle_strength:cases>=3?'INTEGRITY+SEMANTIC':'INTEGRITY',
  mined_at:new Date().toISOString(),
};
fs.writeFileSync(`tasks/${id}/manifest.json`,JSON.stringify(manifest,null,1));
console.log(`TASK ${id} role=${manifest.role} stratum=${stratum} oracle=${manifest.oracle_strength} cases=${cases}`);
EOF
    then
      jlog "$repo" "MATERIALIZATION_FAILED" "\"commit\":\"$c\",\"candidate\":$n"
      continue
    fi
    jlog "$repo" "TASK_VALIDATED" "\"commit\":\"$c\",\"candidate\":$n"
    return
  done
  jlog "$repo" "CANDIDATES_EXHAUSTED" "\"tried\":$n"
}

ORDER=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("frame/walk-order.json")).order.join("\n"))')
for repo in $ORDER; do
  # resumability: skip only repos with a REPO-LEVEL VERDICT (FRAME2 correction 3)
  grep "\"repo\":\"$repo\"" "$ATTR" 2>/dev/null | grep -qE "$VERDICT_RE" && continue
  read -r P S W <<< "$(counts)"
  if [ "$P" -ge "$PILOT_NEED" ] && [ "$S" -ge "$QUOTA_SINGLE" ] && [ "$W" -ge "$QUOTA_WS" ]; then
    echo "DONE: pilot=$P single=$S workspace=$W"; exit 0
  fi
  echo "[walk] $repo (pilot=$P single=$S ws=$W)"
  process_repo "$repo"
  rm -rf "$WORK/repo" "$VENV"
done
read -r P S W <<< "$(counts)"
echo "FRAME EXHAUSTED: pilot=$P single=$S workspace=$W"
# completeness arithmetic (FRAME2 correction 3's standing rule)
undecided=0
for repo in $ORDER; do
  grep "\"repo\":\"$repo\"" "$ATTR" 2>/dev/null | grep -qE "$VERDICT_RE" \
    || { echo "WALK INCOMPLETE: no repo-level verdict for $repo"; undecided=$((undecided+1)); }
done
[ "$undecided" -gt 0 ] && { echo "WALK INCOMPLETE: $undecided repo(s) undecided — re-run to complete"; exit 6; }
echo "WALK COMPLETE: all $(printf '%s\n' $ORDER | wc -l) repos decided"
