#!/usr/bin/env bash
# DIAGNOSTIC v2 — round-4 Finding 2, RE-DIAGNOSED against the real scoring path.
#
# The first diagnostic (checkdocs-diagnostic.sh) modeled the pristine run as
# network-DENIED and concluded the network policy caused seq 18's pristine red.
# That was wrong about the environment: `verdict4.mjs` runs the pristine suite
# with `[agent-jail4.sh, '-', …]` — `'-'` is "no netns", so the adjudication keeps
# parent network. The earlier matrix varied the AGENT's environment while the
# question was about the ADJUDICATOR's, and its own network-present cell was green.
# The network attribution is withdrawn (DEVIATIONS D10 correction).
#
# The FACT stands: seq 18 had sound agent work and a red pristine adjudication.
# This isolates the ACTUAL cause by reproducing the real scoring environment and
# varying one component at a time. That environment, from verdict4.mjs:
#   - the mount/PID jail (agent-jail4.sh), masks on the control plane,
#   - the interpreter prefix exposed READ-ONLY (the task venv),
#   - a fresh HOME/TMPDIR and scrubbed PYTEST_*/PYTHON* variables,
#   - network PRESENT,
#   - suite = `python -m pytest -q -p no:cacheprovider` over the pristine tree
#     (agent source + the original protected config restored).
#
# THE FIRST GATE (the #221 fidelity rule, applied to this question). If the
# adjudication-equivalent cell does NOT reproduce the red, this makes NO causal
# claim — a matrix that cannot reproduce the effect cannot explain it. Only once
# it reproduces does varying one component at a time attribute the cause.
#
# NOT an adjudication: writes no verdict, alters no pilot record. Exits 0 on every
# reachable conclusion so a surprising result is read, not swallowed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$(cd "$HERE/../runner" && pwd)"
STATE_REF="${TB_STATE_REF:-origin/round4-pilot-state}"
TRAJ="${TB_TRAJ:-11-jsonpickle-jsonpickle-gated}"
OUT_DIR="${TB_DIAG_OUT:-${RUNNER_TEMP:-/tmp}/checkdocs-adj-diag}"
rm -rf "$OUT_DIR"; mkdir -p "$OUT_DIR"
# The jailed working set (repo, venv, the suite's HOME/TMPDIR boxes, the mask dir)
# MUST live somewhere every uid can search — the jail drops CAP_DAC_OVERRIDE, so a
# venv under a path like /home/runner/work/_temp (RUNNER_TEMP), whose parent
# /home/runner is 750 and owned by another user, is unreachable to uid 0 inside
# the jail: execve returns EACCES and the suite never runs. run-task4.sh puts its
# work under /tmp (mode 1777, world-searchable) for exactly this reason; matching
# it is part of reproducing the scoring environment faithfully. The RECORD (logs,
# cells.jsonl, the json) stays under OUT_DIR so the upload step collects it.
W="$(mktemp -d /tmp/tb-adjdiag-XXXXXX)"
die() { echo "::error::$*" >&2; exit 1; }
for c in git uv python3.11 jq unshare; do command -v "$c" >/dev/null 2>&1 || die "$c is required"; done
ADJ_JAIL="$RUNNER/agent-jail4.sh"
[ -r "$ADJ_JAIL" ] || die "agent-jail4.sh not found at $ADJ_JAIL"
# The jailed cells are the point, so a host that cannot build the mount/PID
# namespace cannot run this diagnostic at all. Fail closed and say so — do not
# fall through to the unjailed cells and present a partial matrix as an answer.
unshare --pid --mount --fork --mount-proc true 2>/dev/null \
  || die "this host cannot create pid/mount namespaces (needs CAP_SYS_ADMIN / unprivileged userns); the adjudication-equivalent cell cannot be built here"

echo "== materialise the recorded pristine tree ($TRAJ) =="
# The pristine tree is the agent's final source with the protected verification
# surface RESTORED to the original — for this task that is pytest.ini with
# checkdocs enabled. Recovered by reversing the recorded hunk, exactly as the
# scoring run restores it, so the config is the record's fact not a retype.
git -C "$HERE" cat-file -e "$STATE_REF:$TRAJ-raw/repo-final-tree.tar" 2>/dev/null || die "no final tree on $STATE_REF for $TRAJ"
REPO="$W/repo"; mkdir -p "$REPO"
git -C "$HERE" show "$STATE_REF:$TRAJ-raw/repo-final-tree.tar" | tar -x -C "$REPO"
( cd "$REPO" && git init -q . )
git -C "$HERE" show "$STATE_REF:$TRAJ-raw/diff-from-base.patch" > "$W/diff.patch"
( cd "$REPO" && git apply -R --include=pytest.ini "$W/diff.patch" ) || die "could not restore original pytest.ini"
grep -q -- '-p no:checkdocs' "$REPO/pytest.ini" && die "restore did not re-enable checkdocs"
echo "pristine config restored (checkdocs enabled):"; grep -n addopts "$REPO/pytest.ini" | sed 's/^/  /'

echo "== install the COMPLETE frozen FRAME3 ladder (network present, as the trajectory did) =="
VENV="$W/venv"
uv venv -q -p python3.11 "$VENV" || die "venv failed"
RUNG=
for extra in test tests dev; do
  if ( cd "$REPO" && uv pip install -q -p "$VENV/bin/python" -e ".[$extra]" ) >/dev/null 2>&1; then RUNG="extras:$extra"; break; fi
done
[ -n "$RUNG" ] || { ( cd "$REPO" && uv pip install -q -p "$VENV/bin/python" -e . ) >/dev/null 2>&1 && RUNG=plain; }
[ -n "$RUNG" ] || die "install failed"
for rf in requirements-dev.txt requirements_dev.txt dev-requirements.txt requirements-test.txt test-requirements.txt requirements/dev.txt requirements/test.txt; do
  [ -f "$REPO/$rf" ] && { ( cd "$REPO" && uv pip install -q -p "$VENV/bin/python" -r "$rf" ) >/dev/null 2>&1; break; }
done
( cd "$REPO" && uv pip install -q -p "$VENV/bin/python" pytest ) >/dev/null 2>&1
RECORDED_RUNG=$(git -C "$HERE" show "$STATE_REF:$TRAJ.verdict.json" | jq -r '.install_rung')
echo "install rung: $RUNG (recorded: $RECORDED_RUNG)"
[ "$RUNG" = "$RECORDED_RUNG" ] || die "rung $RUNG != recorded $RECORDED_RUNG — not the trajectory's environment"
PYBIN="$VENV/bin/python"
VENV_PREFIX="$(cd "$(dirname "$(dirname "$PYBIN")")" && pwd)"

# Reproduce verdict4.runPytest FAITHFULLY. verdict4 does NOT use `env -i`: it
# starts from the parent environment, overrides HOME/TMPDIR/TMP/TEMP/XDG_* to a
# fresh box, and DELETES a fixed scrub list — then spawns
# `bash agent-jail4.sh - -- <suite>` with cwd = the tree. An earlier version of
# this script wrapped that in `env -i … bash -c 'exec "$@"'`, which stripped the
# environment the suite needs and returned 126 (could-not-execute) from inside the
# jail — not a pytest result at all. Matching verdict4 exactly removes that
# artefact.
SUITE=(timeout 300 "$PYBIN" -m pytest -q -p no:cacheprovider)
SCRUB=(PYTEST_ADDOPTS PYTEST_PLUGINS PYTHONPATH PYTHONSTARTUP NODE_OPTIONS NODE_PATH BASH_ENV ENV LD_PRELOAD)
MASKDIR="$W/ctrl"; mkdir -p "$MASKDIR"

cell() { # <tag> <jailed:yes|no> <ro:yes|no>
  local tag=$1 jailed=$2 ro=$3
  local box; box="$(mktemp -d "$W/box-$tag-XXXXXX")"
  mkdir -p "$box/home" "$box/tmp"
  # GNU env: options (--unset) BEFORE NAME=VALUE assignments.
  local -a env_over=()
  local k; for k in "${SCRUB[@]}"; do env_over+=("--unset=$k"); done
  env_over+=(
    "HOME=$box/home" "TMPDIR=$box/tmp" "TMP=$box/tmp" "TEMP=$box/tmp"
    "XDG_CACHE_HOME=$box/cache" "XDG_CONFIG_HOME=$box/config"
  )
  local -a jail_env=()
  local -a pre=()
  if [ "$jailed" = yes ]; then
    jail_env=("TB_JAIL_MASK=$MASKDIR")
    [ "$ro" = yes ] && jail_env+=("TB_JAIL_RO=$VENV_PREFIX")
    pre=(bash "$ADJ_JAIL" - --)
  fi
  # `env` applies the overrides/unsets to the INHERITED environment (no -i), which
  # is what verdict4 does; the jail vars are passed the same way so agent-jail4.sh
  # reads them; cwd is the tree, via a subshell.
  ( cd "$REPO" && env "${env_over[@]}" "${jail_env[@]}" "${pre[@]}" "${SUITE[@]}" >"$OUT_DIR/$tag.log" 2>&1 )
  local rc=$?
  # #221 discipline, this time obeyed. pytest: 0 green, 1/2 red, 5 no-tests,
  # 124 timeout. ANYTHING ELSE (126 not-executable, 127 not-found, >=128 signal,
  # a jail/setup error) is an EXECUTION FAILURE and NOT a test result — it must
  # never be read as red.
  # The SHARED classifier (runner/suite-status.mjs), not a local case — exit 2 is
  # a collection error (EXEC_FAILED), never a test red. Mapped to this script's
  # lowercase vocabulary.
  # The shared classifier reports STATUS, PHASE and the raw code. All three are
  # recorded — this is the forensic point: the old scorer discarded exactly this.
  local sstat st phase class
  sstat=$(node "$RUNNER/suite-status.mjs" --exit "$rc" --log "$OUT_DIR/$tag.log" 2>/dev/null)
  st=$(printf '%s' "$sstat" | awk '{print $1}')
  phase=$(printf '%s' "$sstat" | awk '{print $2}')
  case "$st" in
    PASS) class=green ;;
    FAIL) class=red ;;
    NO_TESTS) class=no_tests ;;
    TIMEOUT) class=timeout ;;
    *) class=exec_failed ;;
  esac
  local failed summary
  summary=$(grep -E ' in [0-9.]+s' "$OUT_DIR/$tag.log" | tail -1 | tr -s ' ' | tr -d '\r')
  failed=$(grep -E '^(FAILED|ERROR) ' "$OUT_DIR/$tag.log" | awk '{print $2}' | sort -u | tr '\n' ',' | sed 's/,$//')
  local proj=no; [ "$failed" = ".::project" ] && proj=yes; [ -z "$failed" ] && proj=n/a
  echo "cell $tag (jail=$jailed ro=$ro): rc=$rc STATUS=$st phase=$phase project_only=$proj failed=[${failed:-none}] :: ${summary:-<no summary>}"
  # An execution failure means the suite never ran — the log holds the reason
  # (a jail/exec error, not test output). Surface it on stdout so it lands in the
  # CI step log without needing to fetch the artifact.
  if [ "$class" = exec_failed ]; then
    echo "  --- cell $tag did not run the suite (rc=$rc); log tail: ---"
    sed 's/^/  | /' "$OUT_DIR/$tag.log" | tail -15
    echo "  --- end cell $tag log ---"
  fi
  jq -nc --arg t "$tag" --arg j "$jailed" --arg ro "$ro" --argjson rc "$rc" --arg st "$st" --arg ph "$phase" --arg cl "$class" \
     --arg f "${failed:-}" --arg po "$proj" --arg s "$summary" \
     '{cell:$t,jailed:$j,interpreter_ro:$ro,exit:$rc,status:$st,phase:$ph,class:$cl,failed_items:$f,project_only:$po,summary:$s}' >> "$OUT_DIR/cells.jsonl"
}

echo "== component-isolation matrix (network present throughout) =="
# A: plain — task venv, fresh box, network, NO jail. The control: agent work sound.
cell A no  no
# B: + mount/PID jail and control-plane mask, interpreter NOT read-only.
cell B yes no
# C: + interpreter read-only. This is the adjudication-equivalent — the closest
#    reproduction of what verdict4 actually ran (jail, mask, RO venv, fresh box).
cell C yes yes

cls() { jq -r --arg c "$1" 'select(.cell==$c).class' "$OUT_DIR/cells.jsonl"; }
A=$(cls A); B=$(cls B); C=$(cls C)
C_PO=$(jq -r 'select(.cell=="C").project_only' "$OUT_DIR/cells.jsonl")

# An execution failure in ANY cell means the matrix did not run the suite it
# claims to compare — no component can be attributed from it. This is the #221
# rule, and the reason CAUSE_MOUNT_PID_JAIL from the first run was withdrawn: its
# B/C were rc=126, not red.
if [ "$A" = exec_failed ] || [ "$B" = exec_failed ] || [ "$C" = exec_failed ] \
   || [ "$A" = timeout ] || [ "$B" = timeout ] || [ "$C" = timeout ]; then
  FINDING=EXECUTION_FAILED
  NOTE="a cell did not run the suite (A=$A B=$B C=$C) — 126/127/timeout/signal are not test results. No component is attributed; fix the invocation and re-run."
# FIRST GATE: the adjudication-equivalent cell C must REPRODUCE the red.
elif [ "$C" != red ]; then
  FINDING=NOT_REPRODUCED
  NOTE="cell C (adjudication-equivalent) is $C, not red — this environment does not reproduce seq 18's pristine red, so no cause is attributed. The reproduction target must be refined (mask set, cwd/layout, or venv state not modeled here)."
elif [ "$A" = green ] && [ "$B" = red ]; then
  FINDING=CAUSE_MOUNT_PID_JAIL
  NOTE="red appears with the mount/PID jail alone (cell B), before the interpreter is made read-only: the contaminant is the jail's mount/PID/mask environment, not the RO interpreter."
elif [ "$A" = green ] && [ "$B" = green ] && [ "$C" = red ]; then
  FINDING=CAUSE_READONLY_INTERPRETER
  NOTE="green under the jail until the interpreter prefix is made read-only (cell C), which is when it goes red: the contaminant is the RO interpreter — a suite item that installs at collection (checkdocs .::project) cannot write to the venv. project_only=$C_PO."
elif [ "$A" != green ]; then
  FINDING=CAUSE_NOT_ENVIRONMENTAL
  NOTE="the plain cell A is $A, so the pristine red is not attributable to the jail/RO environment — the pristine tree itself fails here. Needs a separate look (venv contents, config, recorded tree)."
else
  FINDING=INCONCLUSIVE
  NOTE="the cells do not form a single-variable story (A=$A B=$B C=$C); read cells.jsonl."
fi

jq -nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg traj "$TRAJ" --arg ref "$STATE_REF" \
   --arg rung "$RUNG" --arg finding "$FINDING" --arg note "$NOTE" \
   --slurpfile cells <(jq -s '.' "$OUT_DIR/cells.jsonl") \
   '{ts:$ts,kind:"diagnostic",note:"NOT an adjudication; no pilot verdict created or altered",
     trajectory:$traj,state_ref:$ref,install_rung:$rung,
     models:"the real scoring path: agent-jail4.sh mount/PID jail, control-plane mask, RO interpreter, fresh HOME/TMPDIR, network present",
     first_gate:"cell C (adjudication-equivalent) must reproduce the pristine red, else no causal claim",
     cells:$cells[0],finding:$finding,interpretation:$note}' | tee "$OUT_DIR/checkdocs-adj-diag.json"

echo
echo "FINDING: $FINDING — $NOTE"
# The job runs this under sudo (the jail needs root), so the output is root-owned;
# make it world-readable so the unprivileged upload-artifact step can collect it.
chmod -R a+rX "$OUT_DIR" 2>/dev/null || true
exit 0
