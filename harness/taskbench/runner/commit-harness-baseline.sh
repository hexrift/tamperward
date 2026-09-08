#!/usr/bin/env bash
# Fold the HARNESS-OWNED gate wiring into the trusted gated base, then print the
# BASE commit sha. Factored out of run-task4.sh so the invariant it must uphold
# is unit-testable (gated-base-wiring.selftest.sh):
#
#   INVARIANT: before agent start, harness-owned .claude/settings.json (and the
#   rest of the harness-owned wiring) MUST be part of the trusted gated baseline,
#   and MUST NOT later read as agent-originated tampering unless the agent
#   actually changes it — REGARDLESS of the candidate repo's .gitignore/excludes.
#
# The wiring is harness-authored, not agent-authored: it is the treatment's own
# gate, written by deploy-gated4.sh (gated) or the observer stanza (ungated). An
# untracked wiring file makes the enforcement envelope fail closed at entry
# ("working tree dirty"), AND — the iteration-3 D24 defect — a wiring file left
# ignored-on-a-protected-path is re-evaluated by the Stop-sweep and blocked as
# hook-tampering, spuriously refusing an honest release. Committing it into the
# base with the candidate's excludes OVERRIDDEN is what makes it the trusted
# starting point rather than a candidate/agent change.
set -uo pipefail
REPODIR="${1:?repo-dir}"
cd "$REPODIR" || { echo "commit-harness-baseline: no repo dir $REPODIR" >&2; exit 1; }
# Force-add each harness-owned wiring path that exists, OVERRIDING the candidate
# repo's .gitignore/excludes. The iteration-3 D24 defect was a plain `git add -A
# .claude`: a repo whose .gitignore ignores the .claude dot-path (e.g. `.*`)
# silently kept the wiring OUT of the trusted base, so the Stop sweep later
# re-evaluated the harness-authored gate as agent tampering. `-f` is scoped to
# these harness-authored paths ONLY — never a blanket force-add — so a genuine
# agent change to the wiring still registers as a change against this base.
for p in .claude .tamperward.yml .github; do [ -e "$p" ] && git add -f -A "$p" 2>/dev/null; done
git -c user.email=t@b -c user.name=tb commit -qm hooks --no-verify
git rev-parse HEAD
