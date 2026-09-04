#!/usr/bin/env bash
# CI-only durable state for the round-4 pilot on ephemeral runners.
#
# The pilot is 20 sequential trajectories with a NEVER-RE-ROLL guarantee: a trajectory
# that started is never run again. That guarantee lives entirely in runs-pilot/ — the
# .started markers, the .verdict.json files, the .adjudicated dispositions, the
# execution log and the drift acknowledgement. A GitHub runner starts from a clean
# checkout every dispatch, so without this the driver would forget every prior
# trajectory: it could never advance past seq 1, and a started-but-verdictless
# trajectory would be silently re-rolled instead of halting.
#
# This is the H5 checkpoint mechanism adapted to Actions: before a trajectory,
# `restore` pulls runs-pilot/ from a non-protected state branch; after it (always),
# `save` force-pushes the current runs-pilot/ back. The branch holds ONLY a snapshot of
# runs-pilot/ (an orphan commit, force-pushed), never repo code, so it cannot affect the
# freeze or the binding set.
#
# RESIDUAL: a runner that dies between the .started write and `save` (i.e. mid agent
# run) loses that marker, so the next dispatch would re-roll that seq. The 120-minute
# job timeout keeps a normal run from being cut mid-agent (agent budget is 50 min), so
# this is only an infra-death window, not a routine one. Documented, not hidden.
#
#   ci-pilot-state.sh restore   # runs-pilot/ <- state branch (no-op if the branch is absent)
#   ci-pilot-state.sh save      # state branch <- runs-pilot/ (no-op if runs-pilot/ is empty)
set -uo pipefail

CMD="${1:-}"
BRANCH="${TB_PILOT_STATE_BRANCH:-round4-pilot-state}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$HERE/runs-pilot"
SERVER="${GITHUB_SERVER_URL:-https://github.com}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"
TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN must be set (needs contents: write)}"
# Authenticated remote. Never echoed — git prints only the host, and the token is a
# GitHub-masked secret in Actions logs regardless.
REMOTE="${SERVER#https://}"
AUTH_URL="https://x-access-token:${TOKEN}@${REMOTE}/${REPO}.git"

msg() { echo "ci-pilot-state: $*"; }

case "$CMD" in
  restore)
    mkdir -p "$DIR"
    W="$(mktemp -d)"
    if git clone -q --depth 1 --branch "$BRANCH" "$AUTH_URL" "$W" 2>/dev/null; then
      rm -rf "$W/.git"
      # Copy the snapshot in; the branch is the source of truth for prior state.
      cp -a "$W/." "$DIR/" 2>/dev/null || true
      n="$(find "$DIR" -type f | wc -l | tr -d ' ')"
      msg "restored $n file(s) from state branch '$BRANCH'"
    else
      msg "no state branch '$BRANCH' yet — starting from an empty runs-pilot/"
    fi
    rm -rf "$W"
    ;;
  save)
    if [ ! -d "$DIR" ] || [ -z "$(find "$DIR" -type f -print -quit 2>/dev/null)" ]; then
      msg "runs-pilot/ is empty — nothing to save"
      exit 0
    fi
    W="$(mktemp -d)"
    cp -a "$DIR/." "$W/" || { msg "cp of runs-pilot/ reported errors (unreadable files?)"; }
    # Integrity: a file present in runs-pilot/ but missing from the snapshot was
    # unreadable (e.g. a root-only verdict.json under sudo) and would be silently lost —
    # persisting that would spuriously halt the next dispatch. Refuse instead.
    missing=0
    while IFS= read -r f; do
      rel="${f#"$DIR"/}"
      [ -e "$W/$rel" ] || { msg "MISSING from snapshot: $rel"; missing=1; }
    done < <(find "$DIR" -type f)
    if [ "$missing" != 0 ]; then
      rm -rf "$W"
      msg "REFUSING to save an incomplete snapshot — fix the file permissions (chown runs-pilot/ to the runner) and re-run"
      exit 1
    fi
    (
      cd "$W"
      git init -q
      git checkout -q -b "$BRANCH"
      git add -A
      git -c user.name='pilot-ci' -c user.email='pilot-ci@users.noreply.github.com' \
          commit -q -m "round-4 pilot state @ $(date -u +%FT%TZ) (${GITHUB_RUN_ID:-local})"
      # Force-push: the branch carries only the latest cumulative snapshot; its history
      # is not the record (the uploaded artefact and the ledger are).
      git push -q -f "$AUTH_URL" "$BRANCH" 2>&1 | sed -E 's#//[^@]*@#//<redacted>@#g'
    )
    rc=$?
    rm -rf "$W"
    [ "$rc" = 0 ] && msg "saved runs-pilot/ to state branch '$BRANCH'" || { msg "FAILED to save state (rc=$rc)"; exit 1; }
    ;;
  *)
    echo "usage: $0 restore|save" >&2; exit 2 ;;
esac
