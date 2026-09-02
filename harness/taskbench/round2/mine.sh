#!/usr/bin/env bash
# Taskbench Phase 0 miner: walk frame/walk-order.json, apply FRAME.md's gates,
# emit attrition.jsonl + tasks/<id>/{manifest.json,test.patch,gold.patch}.
# Deterministic given the frame and walk order; resumable (repos already in
# attrition.jsonl or tasks/ are skipped). No agent runs happen here.
set -uo pipefail
cd "$(dirname "$0")"
WORK="${TB_WORK:-/tmp/tb-mine}"
CLONE_BASE="${TB_CLONE_BASE:-https://github.com}"  # file:// base for a local fixture walk (as in ../mine.sh)
mkdir -p "$WORK" tasks
ATTR=attrition.jsonl
touch "$ATTR"

SINCE="2024-08-29"; UNTIL="2026-08-29"
CAND_CAP=8; STEP_TIMEOUT=300
PILOT_NEED=3; QUOTA_SINGLE=15; QUOTA_WS=15

TESTGLOB_RE='(\.test\.[^/]+$|\.spec\.[^/]+$|(^|/)__tests__/)'
SRC_RE='\.(ts|tsx|js|jsx|mjs|cjs)$'

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
      else if (m.stratum==="single-package") s++;
      else w++;
    }
    console.log(`${p} ${s} ${w}`);'
}

run_suite() { # dir -> exit code of test script under timeout
  ( cd "$1" && timeout "$STEP_TIMEOUT" npm test --silent >/dev/null 2>&1 )
}

process_repo() {
  local repo="$1" dir="$WORK/repo"
  rm -rf "$dir"
  if ! timeout 600 git clone --quiet --filter=blob:none "$CLONE_BASE/$repo.git" "$dir" 2>/dev/null; then
    jlog "$repo" "CLONE_FAILED"; return
  fi
  # activity floor
  local head_date; head_date=$(git -C "$dir" log -1 --format=%cs 2>/dev/null || echo "")
  if [[ -z "$head_date" || "$head_date" < "2025-08-29" ]]; then
    jlog "$repo" "EXCLUDED_INACTIVE" "\"head_date\":\"$head_date\""; return
  fi
  # gate 0: npm-associated with a real test script
  if [ ! -f "$dir/package.json" ]; then jlog "$repo" "G0_NO_PACKAGE_JSON"; return; fi
  local testscript
  testscript=$(node -e 'const p=require(process.argv[1]);process.stdout.write((p.scripts&&p.scripts.test)||"")' "$dir/package.json")
  if [[ -z "$testscript" || "$testscript" == *"no test specified"* ]]; then
    jlog "$repo" "G0_NO_TEST_SCRIPT"; return
  fi
  # classification
  local stratum
  stratum=$(node -e '
    const fs=require("fs"),p=require(process.argv[1]);
    const ws=p.private===true||!!p.workspaces||fs.existsSync(require("path").dirname(process.argv[1])+"/pnpm-workspace.yaml");
    process.stdout.write(ws?"workspace":"single-package");' "$dir/package.json")
  # quota check (pilot slots are stratum-blind)
  read -r P S W <<< "$(counts)"
  if [ "$P" -ge "$PILOT_NEED" ]; then
    if [[ "$stratum" == "single-package" && "$S" -ge "$QUOTA_SINGLE" ]]; then jlog "$repo" "QUOTA_FULL" "\"stratum\":\"$stratum\""; return; fi
    if [[ "$stratum" == "workspace" && "$W" -ge "$QUOTA_WS" ]]; then jlog "$repo" "QUOTA_FULL" "\"stratum\":\"$stratum\""; return; fi
  fi
  # enumerate qualifying commits, newest first
  local cands
  cands=$(git -C "$dir" log --no-merges --since="$SINCE" --until="$UNTIL" --pretty='%x01%H' --name-only 2>/dev/null | node -e '
    const RE_T=new RegExp(process.argv[1]), RE_S=new RegExp(process.argv[2]);
    let out=[],cur=null,t=false,s=false;
    require("fs").readFileSync(0,"utf8").split("\n").forEach(l=>{
      if (l.startsWith("\x01")) { if(cur&&t&&s) out.push(cur); cur=l.slice(1); t=s=false; }
      else if (l && !l.includes("node_modules/")) {
        if (RE_T.test(l)) t=true; else if (RE_S.test(l)) s=true;
      }
    });
    if(cur&&t&&s) out.push(cur);
    console.log(out.slice(0, +process.argv[3]).join(" "));
  ' "$TESTGLOB_RE" "$SRC_RE" "$CAND_CAP")
  if [ -z "$cands" ]; then jlog "$repo" "NO_QUALIFYING_COMMITS"; return; fi

  local n=0
  for c in $cands; do
    n=$((n+1))
    local parent="$c^"
    # NUL-delimited into an array: test-file names come from a third-party
    # repository and may contain whitespace or shell metacharacters, so they are
    # never word-split or re-parsed as a glob (--literal-pathspecs below).
    local -a tfiles=()
    mapfile -d '' -t tfiles < <(git -C "$dir" diff --name-only -z "$parent" "$c" | grep -zE "$TESTGLOB_RE" | grep -zv node_modules || true)
    [ "${#tfiles[@]}" -eq 0 ] && { jlog "$repo" "C_NO_TESTFILES" "\"commit\":\"$c\""; continue; }
    git -C "$dir" checkout -q --detach "$parent" 2>/dev/null || { jlog "$repo" "C_CHECKOUT_FAILED" "\"commit\":\"$c\""; continue; }
    git -C "$dir" clean -qfdx 2>/dev/null
    # gate 1: install
    local pm="npm" inst
    [ -f "$dir/yarn.lock" ] && pm="yarn"
    [ -f "$dir/pnpm-lock.yaml" ] && pm="pnpm"
    case "$pm" in
      npm)  inst='npm install --no-audit --no-fund --ignore-scripts=false' ;;
      yarn) inst='yarn install --frozen-lockfile 2>/dev/null || yarn install' ;;
      pnpm) inst='pnpm install --frozen-lockfile 2>/dev/null || pnpm install' ;;
    esac
    if ! ( cd "$dir" && timeout "$STEP_TIMEOUT" bash -c "$inst" >/dev/null 2>&1 ); then
      jlog "$repo" "G1_INSTALL_FAILED" "\"commit\":\"$c\",\"pm\":\"$pm\""; continue
    fi
    # gate 2: parent suite green
    run_suite "$dir"; rc=$?
    if [ "$rc" -eq 124 ]; then jlog "$repo" "G2_PARENT_TIMEOUT" "\"commit\":\"$c\""; continue; fi
    if [ "$rc" -ne 0 ]; then jlog "$repo" "G2_PARENT_RED" "\"commit\":\"$c\""; continue; fi
    # gate 3: apply test patch -> red
    git --literal-pathspecs -C "$dir" diff --binary --full-index "$parent" "$c" -- "${tfiles[@]}" > "$WORK/test.patch" 2>/dev/null
    [ -s "$WORK/test.patch" ] || { jlog "$repo" "C_EMPTY_TEST_PATCH" "\"commit\":\"$c\""; continue; }
    if ! git -C "$dir" apply "$WORK/test.patch" 2>/dev/null; then
      jlog "$repo" "G3_PATCH_APPLY_FAILED" "\"commit\":\"$c\""; continue
    fi
    run_suite "$dir"; rc=$?
    if [ "$rc" -eq 124 ]; then
      git -C "$dir" checkout -q -- . ; jlog "$repo" "G3_TIMEOUT" "\"commit\":\"$c\""; continue
    fi
    if [ "$rc" -eq 0 ]; then
      git -C "$dir" checkout -q -- . ; jlog "$repo" "G3_NOT_RED" "\"commit\":\"$c\""; continue
    fi
    # gate 4: red (true red, not timeout) reproduces twice more
    local red_ok=1
    for i in 1 2; do
      run_suite "$dir"; rc=$?
      if [ "$rc" -eq 0 ] || [ "$rc" -eq 124 ]; then red_ok=0; break; fi
    done
    if [ "$red_ok" -ne 1 ]; then
      git -C "$dir" checkout -q -- .
      if [ "$rc" -eq 124 ]; then jlog "$repo" "G4_TIMEOUT" "\"commit\":\"$c\""; else jlog "$repo" "G4_NONDETERMINISTIC" "\"commit\":\"$c\""; fi
      continue
    fi
    # gate 5: full commit tree green
    git -C "$dir" checkout -q -- .
    git -C "$dir" checkout -q --detach "$c" 2>/dev/null
    run_suite "$dir"; rc=$?
    if [ "$rc" -eq 124 ]; then jlog "$repo" "G5_TIMEOUT" "\"commit\":\"$c\""; continue; fi
    if [ "$rc" -ne 0 ]; then jlog "$repo" "G5_COMMIT_RED" "\"commit\":\"$c\""; continue; fi
    # PASS: materialize task artifacts (TASK_VALIDATED only on materialization success)
    if ! node - "$repo" "$c" "$WORK/test.patch" "$dir" "$stratum" "$pm" <<'EOF'
const fs=require('fs'),cp=require('child_process'),crypto=require('crypto');
const [repo,commit,testPatch,dir,stratum,pm]=process.argv.slice(2);
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
// argv arrays throughout, never a shell string: file names come from a
// third-party repository, and a single quote in a test-file name used to break
// out of the "':(exclude)…'" quoting of the old bash -c command line.
const git=(...args)=>cp.execFileSync('git',['-C',dir,...args],{encoding:'utf8',maxBuffer:1<<28});
const parent=git('rev-parse',`${commit}^`).trim();
const tglob=/(\.test\.[^/]+$|\.spec\.[^/]+$|(^|\/)__tests__\/)/;
const tfiles=git('diff','--name-only','-z',parent,commit).split('\0').filter(f=>f&&tglob.test(f));
// long-form + literal magic: an excluded name is never re-parsed as a glob
const excl=tfiles.map(f=>`:(exclude,literal)${f}`);
// TB_WORK-aware (round-2 correction: this literal ignored TB_WORK and broke every
// candidate reaching patch generation when the walk ran with a non-default workdir)
const work=process.env.TB_WORK || '/tmp/tb-mine';
// --binary --full-index: repos can mark files (lockfiles, fixtures) -diff via
// gitattributes, and a default diff then emits an unapplyable binary stub —
// found by revalidation on a task whose gold patch could not reconstruct.
fs.writeFileSync(`${work}/gold.patch`,
  cp.execFileSync('git',['-C',dir,'diff','--binary','--full-index',parent,commit,'--','.',...excl],{maxBuffer:1<<28}));
const tp=fs.readFileSync(testPatch,'utf8');
const cases=(tp.match(/^\+.*\b(test|it)\s*\(/gm)||[]).length;
let n=0; for (const d of fs.existsSync('tasks')?fs.readdirSync('tasks'):[]) n++;
const pilot = (()=>{let p=0;for(const d of fs.existsSync('tasks')?fs.readdirSync('tasks'):[]){try{if(JSON.parse(fs.readFileSync(`tasks/${d}/manifest.json`)).role==='pilot')p++}catch{}}return p})();
const id=String(n+1).padStart(2,'0')+'-'+repo.replace('/','-');
fs.mkdirSync(`tasks/${id}`,{recursive:true});
fs.copyFileSync(testPatch,`tasks/${id}/test.patch`);
fs.copyFileSync(`${work}/gold.patch`,`tasks/${id}/gold.patch`);
const manifest={
  id, repo, role: pilot<3?'pilot':'main', stratum,
  parent_sha:parent, commit_sha:commit,
  test_patch_sha256:sha(`tasks/${id}/test.patch`),
  gold_patch_sha256:sha(`tasks/${id}/gold.patch`),
  test_files:tfiles, pm, node:process.version,
  added_case_lines:cases,
  oracle_strength:cases>=3?'INTEGRITY+SEMANTIC':'INTEGRITY',
  test_script:JSON.parse(fs.readFileSync(`${dir}/package.json`)).scripts.test,
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
  # resumability: skip only repos with a REPO-LEVEL VERDICT. The original
  # round-2 walk skipped on ANY line for the repo, so candidate-level lines from
  # an interrupted run counted as decided and four repos were silently skipped
  # (FRAME2 correction 3; the standing rule, as in ../mine.sh and
  # round3/mine3.sh, is a verdict line or a re-walk). grep -F: the repo name is
  # a fixed string, not a regex.
  grep -F -- "\"repo\":\"$repo\"" "$ATTR" 2>/dev/null \
    | grep -qE '"gate":"(EXCLUDED_INACTIVE|NO_QUALIFYING_COMMITS|G0_NO_TEST_SCRIPT|G0_NO_PACKAGE_JSON|CLONE_FAILED|CANDIDATES_EXHAUSTED|TASK_VALIDATED|QUOTA_FULL)"' \
    && continue
  read -r P S W <<< "$(counts)"
  if [ "$P" -ge "$PILOT_NEED" ] && [ "$S" -ge "$QUOTA_SINGLE" ] && [ "$W" -ge "$QUOTA_WS" ]; then
    echo "DONE: pilot=$P single=$S workspace=$W"; exit 0
  fi
  echo "[walk] $repo (pilot=$P single=$S ws=$W)"
  process_repo "$repo"
  rm -rf "$WORK/repo"
done
read -r P S W <<< "$(counts)"
echo "FRAME EXHAUSTED: pilot=$P single=$S workspace=$W"
