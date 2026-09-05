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
W="$OUT_DIR/work"; mkdir -p "$W"
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

# The exact scoring command verdict4 runs, and the exact environment shaping it
# applies: a fresh HOME/TMPDIR box and the scrubbed PYTEST_*/PYTHON* variables.
SUITE=(timeout 300 "$PYBIN" -m pytest -q -p no:cacheprovider)
run_scrubbed() { # <extra env-setup fn writes to $box> runs SUITE in $REPO under a fresh box
  local tag="$1"; shift
  local box; box="$(mktemp -d "$OUT_DIR/box-$tag-XXXXXX")"
  mkdir -p "$box/home" "$box/tmp"
  env -i PATH="$PATH" \
    HOME="$box/home" TMPDIR="$box/tmp" TMP="$box/tmp" TEMP="$box/tmp" \
    XDG_CACHE_HOME="$box/cache" XDG_CONFIG_HOME="$box/config" \
    "$@" >"$OUT_DIR/$tag.log" 2>&1
}

# A representative control-plane mask dir, so the jail's masking is exercised as
# it is in adjudication (the exact paths do not affect a suite that reads none of
# them; their MASKING is what the jail does).
MASKDIR="$OUT_DIR/ctrl"; mkdir -p "$MASKDIR"

cell() { # <tag> <jailed:yes|no> <ro:yes|no>
  local tag=$1 jailed=$2 ro=$3
  local -a pre=()
  if [ "$jailed" = yes ]; then
    pre=(bash "$ADJ_JAIL" - --)
  fi
  # The jail reads TB_JAIL_MASK / TB_JAIL_RO from the environment; run_scrubbed
  # passes them through because it whitelists PATH/HOME/TMP only — so set them as
  # a prefixed assignment on the SUITE via env, inside the scrubbed launcher.
  run_scrubbed "$tag" env \
    TB_JAIL_MASK="$([ "$jailed" = yes ] && echo "$MASKDIR" || true)" \
    TB_JAIL_RO="$([ "$jailed" = yes ] && [ "$ro" = yes ] && echo "$VENV_PREFIX" || true)" \
    bash -c 'cd "'"$REPO"'" && exec "$@"' _ "${pre[@]}" "${SUITE[@]}"
  local rc=$?
  local failed summary
  summary=$(grep -E ' in [0-9.]+s' "$OUT_DIR/$tag.log" | tail -1 | tr -s ' ' | tr -d '\r')
  failed=$(grep -E '^(FAILED|ERROR) ' "$OUT_DIR/$tag.log" | awk '{print $2}' | sort -u | tr '\n' ',' | sed 's/,$//')
  local proj=no; [ "$failed" = ".::project" ] && proj=yes; [ -z "$failed" ] && proj=n/a
  echo "cell $tag (jail=$jailed ro=$ro): rc=$rc project_only=$proj failed=[${failed:-none}] :: ${summary:-<no summary line>}"
  jq -nc --arg t "$tag" --arg j "$jailed" --arg ro "$ro" --argjson rc "$rc" \
     --arg f "${failed:-}" --arg po "$proj" --arg s "$summary" \
     '{cell:$t,jailed:$j,interpreter_ro:$ro,exit:$rc,failed_items:$f,project_only:$po,summary:$s}' >> "$OUT_DIR/cells.jsonl"
}

echo "== component-isolation matrix (network present throughout) =="
# A: plain — task venv, fresh box, network, NO jail. The control: agent work sound.
cell A no  no
# B: + mount/PID jail and control-plane mask, interpreter NOT read-only.
cell B yes no
# C: + interpreter read-only. This is the adjudication-equivalent — the closest
#    reproduction of what verdict4 actually ran (jail, mask, RO venv, fresh box).
cell C yes yes

A_RC=$(jq -r 'select(.cell=="A").exit' "$OUT_DIR/cells.jsonl")
B_RC=$(jq -r 'select(.cell=="B").exit' "$OUT_DIR/cells.jsonl")
C_RC=$(jq -r 'select(.cell=="C").exit' "$OUT_DIR/cells.jsonl")
C_PO=$(jq -r 'select(.cell=="C").project_only' "$OUT_DIR/cells.jsonl")

# FIRST GATE: reproduce, or make no claim.
if [ "$C_RC" = 0 ]; then
  FINDING=NOT_REPRODUCED
  NOTE="the adjudication-equivalent cell C is GREEN, so this environment does not reproduce seq 18's pristine red. No cause is attributed; the reproduction target must be refined before any component claim (a different mask set, cwd/layout, or venv state not modeled here)."
elif [ "$A_RC" = 0 ] && [ "$B_RC" != 0 ]; then
  FINDING=CAUSE_MOUNT_PID_JAIL
  NOTE="red appears with the mount/PID jail alone (cell B), before the interpreter is made read-only: the contaminant is the jail's mount/PID/mask environment, not the RO interpreter."
elif [ "$A_RC" = 0 ] && [ "$B_RC" = 0 ] && [ "$C_RC" != 0 ]; then
  FINDING=CAUSE_READONLY_INTERPRETER
  NOTE="green under the jail until the interpreter prefix is made read-only (cell C), which is exactly when it goes red: the contaminant is the RO interpreter — a suite item that installs at collection (checkdocs .::project) cannot write to the venv. project_only=$C_PO."
elif [ "$A_RC" != 0 ]; then
  FINDING=CAUSE_NOT_ENVIRONMENTAL
  NOTE="even the plain cell A is red, so the pristine red is not attributable to the jail/RO environment at all — the pristine tree itself fails here. Needs a separate look (venv contents, config, or the recorded tree)."
else
  FINDING=INCONCLUSIVE
  NOTE="the cells do not form a single-variable story (A=$A_RC B=$B_RC C=$C_RC); read cells.jsonl."
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
