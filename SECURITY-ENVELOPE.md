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
| P0-7 | REPRO | a rename INSIDE the tests glob voided the block-count rules — `git mv spec.js spec2.js` carried an arbitrary it()-block deletion past test-deletion and test-content-removal, clean at CI | 1.10.3 | both rules content-inspect `op === 'rename'` exactly like `modify` |
| P0-8 | REPRO | `git mv ci.yml ci.yml.disabled` disabled every check with zero changed lines, clean at CI — the file never leaves the protected glob, only GitHub's executable set | 1.10.3 | ci-tampering fires on executability (`.github/workflows/*.{yml,yaml}`), not glob membership; honest renames (ci.yml → build.yml) stay clean |
| P1-9 | REPRO | `core.hooksPath` — git-native, strictly more general than the covered flags — bypassed no-verify in three spellings (`-c`, `git config`, `GIT_CONFIG_*`) | 1.10.3 | all three spellings covered, plus LEFTHOOK=0 / SKIP_SIMPLE_GIT_HOOKS / PRE_COMMIT_ALLOW_NO_CONFIG |
| P2-11 | REPRO | repo content injected raw ESC bytes into the terminal verdict (clear-screen + forged "clean" line) | 1.10.3 | C0/C1 control bytes replaced before rendering; the human-facing surface the steering story depends on |
| P1-8 | REPRO | effect-drift reused the previous snapshot entry when mtime+size+mode matched — a same-size edit (`it(` → `it.skip(` paid for by a shorter test name) plus `touch -r` slipped a skip past the per-call check | 1.10.4 | the stat fast path is removed: every protected file is hashed on every snapshot. Measured cost 4.0ms → 17.2ms on a 1000-file/4MB protected tree, against ~450ms of node startup per hook call |

## Open — scoped, not yet closed (honest boundary)

| # | sev | finding | disposition |
|---|-----|---------|-------------|
| P0-5 | REPRO | a detached `setsid`/`nohup` worker survived every check and mutated the tree afterwards — GREEN MEANS GREEN, then the suite gutted 6s later | **Closed 1.11.0** by refusing to certify rather than pretending to reap: the tree is fingerprinted across adjudication (portable) and processes started after the agent spawned that still hold the tree are detected (Linux /proc, keyed on spawn time so the caller's own pipeline is not convicted); either → NOT_QUIESCENT, exit 1. `--settle N` extends the window. Residual, stated in SPEC row 17: non-Linux hosts lack the survivor scan, and a worker that outwaits the run needs OS-level isolation.
| P0-6 | REPRO | both suite runs execute the agent-writable, gitignored `node_modules` runner — replacing `node_modules/.bin/<runner>` replaced the program deciding both verdicts (reproduced: VERIFIED, visible and pristine both exit 0, source bug untouched) | **Closed 1.11.1**: the envelope content-hashes the installed dependency tree before the agent and again at adjudication; a change is DEPENDENCY_DRIFT (exit 1). Content-hashed, not stat-compared — P1-8 is the standing lesson. Measured 3.4s over 145MB / 5.4k files inside a command that runs the suite twice. `--allow-dep-drift` is an operator-owned escape, same family as `--allow-dirty`. Verify itself is still fooled by a substituted runner; the fingerprint is what catches it.
| P1-1 | REPRO | verify wrote through a symlinked protected file, landing base content and permissions outside the sandbox regardless of verdict | **Closed 1.12.0**: materialize and the pristine overlay drop a symlink before writing and copy real content; test watches a file outside the repo. |
| P1-2 | AUDIT | `--allow-dirty` re-opens verifier injection (entry policy read from a pre-staged worktree) — mitigated by 1.10.2 using `loadPolicyAt(base)` for BOTH policy and verifier | Re-verify: 1.10.2 moved the verifier resolution to the base commit, which should close this; needs a test under `--allow-dirty`. |
| P1-3 | AUDIT | the anchor-downgrade fix was in `run` only; standalone `verify --base <rev>` resolved with merge-base and could anchor to something older than the caller asked for | **Closed 1.13.0**: `verify --require-ancestor` fails closed (exit 2) when the base is not an ancestor of HEAD, and the shipped workflow passes it. Left opt-in because a PR branched from an older main legitimately has a non-ancestor base — defaulting it on would break ordinary PRs rather than catch attacks. |
| P1-4 | AUDIT | enforcement wiring installed by `init` was protected by nothing | **Closed 1.12.0** for the git-visible paths: `.claude/settings.json`, `.claude/settings.local.json`, `**/.pre-commit-config.yaml` join the `hooks` protected set. `.git/hooks/**` remains outside every git view and so cannot be covered by a glob — residual, stated here. |
| P1-5 | AUDIT | the shipped CI template ran only `check --diff`, so every masked-failure class was adjudicated only at the local layer — the layer an agent shares a filesystem with | **Closed 1.12.0**: `init`'s workflow now runs `tamperward verify --base <base sha>` as a second step. It requires a `verify:` block and fails closed (exit 2) without one, rather than passing quietly. |
| P1-6 | AUDIT | a CI approval matched on rule (or rule:file) alone — nothing tied it to when it was granted, and labels persist across `synchronize`, so one label cleared every later finding on the same PR | **Closed 1.13.0**: approvals may carry `@<head-sha>`, and once the workflow supplies the head it is adjudicating (`TAMPERWARD_OOB_HEAD`), an unbound label clears nothing — the next push re-blocks. Workflows generated before this release supply no head and keep the old behaviour; re-running `init` opts a repository in. |
| P1-7 | AUDIT | a throwing detector was silently dropped from the verdict, so repository content that made a rule throw removed it and the gate reported clean | **Closed 1.12.0**: isolation stays at the tool-call/turn hooks (where a throw already fails open in the runtime), but the adjudicating views — staged, worktree, range — emit a blocking `detector-error` finding. A rule that cannot run is not a rule that passed. |
| P2-15 | AUDIT | **Closed 1.12.0**: the workflow pins `tamperward@<shipped version>` instead of resolving a floating `npx --yes tamperward` at gate time. |
| P2-12 | AUDIT | NotebookEdit modelled by the adapter but absent from the installed matcher, so that branch was unreachable in the default deployment | **Closed 1.14.0**: the matcher `init` writes includes NotebookEdit. |
| P2-13 | AUDIT | default test globs were JS/TS only, so a Python/Go/Rust/Ruby/Java/PHP/C# repo got test rules that could never fire — protection silently absent rather than visibly off | **Closed 1.14.0**: conventional test layouts for those ecosystems join the `tests` class, with a control asserting ordinary source (`src/testing-utils.ts`, `src/latest.py`) is still not protected. |
| P2-14 | AUDIT | a crafted file path broke out of the link/code span into the rendered job summary | **Closed 1.14.0**: the label is neutralised for a code span and the URL percent-encoded; ordinary paths render unchanged. |
| P2-16 | AUDIT | revision arguments reached git unvalidated, so an argument beginning with `-` is parsed as an option | **Closed 1.14.0**: `assertRev` refuses a leading dash at the range, merge-base and verify entry points. Operator-controlled in every shipped wiring, so a guard rather than a demonstrated escape. |
| P2-1..P2-10 | mixed | crash paths return 1 not 2; `.git/tamperward/*` agent-writable; shared env between runs; group-timeout leak; materialize drops ignored/empty/.git; warn findings affect no exit code; self-hosting ignore blind spot; env-var provenance; enumerate-by-cwd; `--keep` lifetime | Backlog. P2-1 (crash → exit 1 not fail-closed 2) and P2-6 (warn findings invisible to the envelope verdict) are the two worth pulling forward. |

## WITHDRAWN claim (1.10.2 → corrected in 1.10.3)

1.10.2 recorded that `check --diff` — the CI authority path — "survives every
finding except P0-6", and every local-layer finding leaned on that as the
fallback. **That claim is withdrawn.** Pass 2 of the external review produced
two committed, diff-visible exploits that the authority layer reported clean
(P0-7, P0-8, both fixed in 1.10.3), and P0-2/P0-6 already defeated it. A
fallback that four findings defeat is not a fallback; it is a fourth surface.

## Held under attack (confirmed negative)
Entry-SHA freeze + descendancy gate; frozen verify command; dirty-start
refusal; the 1.10.2 entry-time policy freeze, CI-layer adjudication and
untracked inclusion; detector isolation; engine dedupe; the policy-file
exemption in `ignore`; escaped GitHub annotations.

## Test integrity: the mutation check

A regression test that passes with its fix reverted proves nothing. Three of
the tests shipped with 1.10.2–1.10.4 did exactly that, and were rewritten once
the check below was run against them:

- **P1-8** (shipped vacuous in 1.10.4): the test restored the mtime with
  `utimesSync(file, atime, mtimeDate)`, which truncates to millisecond
  precision — so `mtimeMs` no longer matched byte-for-byte, the stat fast path
  never engaged, and the test passed against the *unfixed* code. The reported
  exploit uses `touch -r`, which preserves nanoseconds. The test now shells out
  to real `touch -r` and asserts `st.mtimeMs === before.mtimeMs` exactly.
- **P0-2**: the fixture used a red base, so restoring it kept the bug and
  MASKED_FAILURE fired either way. The exploit needs a *green* base (whose
  restoration hides the agent's new bug) and a *visible-green* tree. Now tested
  at the verify layer, asserting both directions: the tree's own widened policy
  reports VERIFIED (the hole), the entry-time policy reports MASKED_FAILURE.
- **P0-3**: the fixture deleted a tracked test, which convicts with or without
  untracked inclusion. Now tested at the builder — `diffWorktree` must not
  contain the dropped file and `diffWorktreeWithUntracked` must.

**Practice**: for each fix, restore the pre-fix source from git, rebuild, and
run that fix's test file. Every exploit test must fail; every control test
("the honest version stays clean") must still pass. Both halves matter — a
suite where the controls also go red is over-blocking, not security.

Automated as `harness/mutation-check.sh <pre-fix-rev> <test-file> <source...>`,
which **refuses to run when the target files have uncommitted changes**. It
restores them with `git checkout HEAD --`, and doing that over an uncommitted
fix once destroyed the P0-5 implementation mid-session: the tests then failed
for the honest reason that the fix no longer existed on disk, and the next hour
went into debugging code that had already been deleted. Commit first.
