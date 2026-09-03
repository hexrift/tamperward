#!/usr/bin/env bash
# The CANONICAL round-4 gated deployment, factored out so that the trajectory
# runner (run-task4.sh) and the bypass-replay harness (replay4.sh) deploy the
# SAME configuration. A bypass replayed against a hand-built settings file proves
# nothing about the counted treatment; both callers must go through here.
#
# Usage: deploy-gated4.sh <repo-dir> <artefact-cli> <artefact-bin>
#
# DEPLOYMENT RULE: every seed is initialised with `tamperward init` from the
# frozen package. init writes the canonical .claude/settings.json (PreToolUse
# `hook claude`, Stop `sweep claude`, disableAllHooks:false), .tamperward.yml, the
# pre-commit hook, CI and CODEOWNERS — with the `npx --yes tamperward@<v>`
# invocation string. npx is unreliable in this environment, so EVERY tamperward
# invocation init wrote is rewritten in place to a BARE `tamperward`, which the
# parent resolves through a PATH whose first entry is the IMMUTABLE, read-only
# `.bin` directory of the pinned artefact.
#
# Bare is used rather than `node <path>/dist/cli/index.js` because the hook-SCRIPT
# live-gate recogniser (hook-wiring.ts RUNNER) accepts package-runner spellings and
# a bare `tamperward`, but NO `node <path>` form: the node spelling made a hook
# script read as "runs no gate", a harness-induced FALSE POSITIVE. That fails
# closed, which is operationally safe but NOT experimentally neutral — it would
# depress honest completion in the gated arm only and bias the secondary outcome.
# Bare restores canonical recognition AND canonical detection depth without npx.
# Safe only because the launcher is immutable and unshadowable; every one of those
# properties is proven in runner/launcher4.sh (27/27), not assumed.
# (DEVIATIONS: "npx is unreliable"; "the immutable bare-launcher deployment".)
set -uo pipefail
REPO="${1:?repo-dir}"; A_CLI="${2:?artefact-cli}"; A_BIN="${3:?artefact-bin}"

( cd "$REPO" && node "$A_CLI" init >/dev/null 2>&1 ) || { echo "INIT_FAILED" >&2; exit 1; }

rewrite_npx() { # <file>: `npx --yes|-y tamperward[@v]` -> bare `tamperward`
  [ -f "$1" ] || return 0
  node -e '
    const fs=require("fs"), f=process.argv[1];
    let s=fs.readFileSync(f,"utf8");
    s=s.replace(/npx\s+(?:--yes|-y)\s+tamperward(?:@\S+)?/g, "tamperward");
    fs.writeFileSync(f,s);' "$1"
}
rewrite_npx "$REPO/.claude/settings.json"
rewrite_npx "$REPO/.git/hooks/pre-commit"
for wf in "$REPO"/.github/workflows/*.yml "$REPO"/.github/workflows/*.yaml; do
  [ -e "$wf" ] && rewrite_npx "$wf"
done

# The deployment is only correct if the gate SURVIVED the rewrite: the settings
# must still carry a live gate. Fail closed rather than deploy a dead gate.
grep -q 'hook claude' "$REPO/.claude/settings.json" || { echo "DEPLOY_NO_GATE" >&2; exit 1; }
grep -q 'sweep claude' "$REPO/.claude/settings.json" || { echo "DEPLOY_NO_SWEEP" >&2; exit 1; }
exit 0
