# `tamperward run` envelope — security findings tracker

External P0/P1/P2 review of the 1.10.0/1.10.1 envelope (executed exploits +
source audit). Every finding is recorded with status; the envelope's boundary
is only as honest as this table. REPRO = executed end-to-end; AUDIT = code path.

## Closed

| # | sev | finding | closed in | how |
|---|-----|---------|-----------|-----|
| P0-1 | REPRO | worktree verdict used the policy the agent just wrote (uncommitted `.tamperward.yml` disabling test-deletion + hook-tampering → clean) | 1.10.2 | envelope freezes the entry-time policy from the base commit (`loadPolicyAt(base)`); worktree check + verify use it, never the working tree's |
| P0-2 | REPRO | widening `protected` reverted the pristine copy to base (masking the agent's own bug) and scored a strengthening | 1.10.2 | verify's overlay classes come from the frozen entry policy |
| P0-3 | REPRO | untracked files invisible to the worktree view (`git diff HEAD` misses `--others`) | 1.10.2 (scan) | envelope worktree view includes untracked, not-ignored files. NOTE: a *brand-new* workflow file is now scanned but is not itself a modeled violation — see P2-new-file |
| P0-4 | REPRO | envelope adjudicated at the `local` layer, so the agent cleared its own findings with `tamperward allow` | 1.10.2 | envelope adjudicates at the CI layer: only out-of-band approval, never the agent-writable ledger |
| anchor/verifier | REPRO | history rewrite + agent-authored verifier | 1.10.1 | descendancy gate + frozen verify command/budget |

## Open — scoped, not yet closed (honest boundary)

| # | sev | finding | disposition |
|---|-----|---------|-------------|
| P0-5 | REPRO | `run` owns the child's exit, not its process group: a detached `setsid`/`nohup` worker mutates the tree AFTER the three checks (TOCTOU) | **Open, high.** Needs a process-group session + post-adjudication quiescence (spawn in a new pgid, kill the group, re-hash the tree after checks, or run the whole agent in a throwaway worktree adjudicated at rest). Roadmap 1c. Until then SPEC row 17 must not claim the tree is quiescent. |
| P0-6 | REPRO | both suite runs execute the agent-writable, gitignored `node_modules` runner | **Open, documented out-of-TCB** (SPEC row 17 / roadmap 1b). The review is right that the SPEC caveat and the CI-consumed exit code are in tension; detect-only (entry-time dep hash) is patch-sized and should land before any "deps closed" claim. |
| P1-1 | REPRO | verify writes through a symlinked protected file out of the sandbox (bounded to base blobs — destructive, not RCE) | Open. Materialize/overlay must refuse to follow symlinks for protected paths. |
| P1-2 | AUDIT | `--allow-dirty` re-opens verifier injection (entry policy read from a pre-staged worktree) — mitigated by 1.10.2 using `loadPolicyAt(base)` for BOTH policy and verifier | Re-verify: 1.10.2 moved the verifier resolution to the base commit, which should close this; needs a test under `--allow-dirty`. |
| P1-3 | AUDIT | anchor-downgrade fix is in `run` only; standalone `verify --base origin/main` in CI has no ancestry guard | Open. Document the CI wiring must pin base, or add an opt-in ancestry check to verify. |
| P1-4 | AUDIT | enforcement wiring (`.claude/settings.json`, `.git/hooks/*`) is installed into files no glob protects | Open. Add the enforcement-wiring paths to the default `hooks` protected set. |
| P1-5 | AUDIT | no shipped CI wiring runs `verify` — default adoption adjudicates masked failures only at the local layer | Open. `init` CI template should include `tamperward run`/`verify`. |
| P1-6 | AUDIT | OOB sign-off is unbound (rule/file only, no evidence fingerprint or head SHA) and sticky across `synchronize` | Open. Bind OOB approvals to a head SHA + finding fingerprint. |
| P1-7 | AUDIT | a throwing detector fails open at the check layer | Open. At the range/envelope layer a detector throw should fail closed, not drop silently. |
| P2-1..P2-10 | mixed | crash paths return 1 not 2; `.git/tamperward/*` agent-writable; shared env between runs; group-timeout leak; materialize drops ignored/empty/.git; warn findings affect no exit code; self-hosting ignore blind spot; env-var provenance; enumerate-by-cwd; `--keep` lifetime | Backlog. P2-1 (crash → exit 1 not fail-closed 2) and P2-6 (warn findings invisible to the envelope verdict) are the two worth pulling forward. |

## Held under attack (confirmed negative)
Entry-SHA freeze + descendancy gate; frozen verify command; dirty-start
refusal; and now (1.10.2) the entry-time policy freeze, CI-layer adjudication,
and untracked inclusion. `check --diff` governed by the merge-base policy
remains the soundest path and survives every finding except P0-6.
