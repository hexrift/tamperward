<p align="center">
  <img src="assets/logo.svg" width="76" height="76" alt="">
</p>

<h1 align="center">Tamperward</h1>

<p align="center"><em>A ward is the obstruction inside a lock that blocks the wrong key.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/tamperward"><img src="https://img.shields.io/npm/v/tamperward?label=npm&color=4F46E5" alt="npm version"></a>
  <a href="https://github.com/hexrift/tamperward/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/hexrift/tamperward/release.yml?label=release" alt="release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-lightgrey" alt="license"></a>
</p>

**The deterministic agent-integrity gate.** AI coding agents optimize for "the command
succeeded," not "the change is trustworthy." To make checks pass they take the cheapest
path: deleting failing tests, skipping them, casting to `any`, suppressing lint errors,
lowering coverage gates, rewriting snapshots, editing CI, or bypassing hooks with
`--no-verify`. Tamperward treats the safety nets themselves as protected assets and
blocks the **class** of bypass — one ruleset, evaluated on the actual diff and commands
as a verdict, not a probability, enforced at every stage a change passes through:
**inside the agent's loop (a Claude Code hook today — a deny before the tool runs, and
a sweep at end of turn), at the commit, and at the merge.** CI is the authority; the
earlier layers shorten the feedback loop for agents that carry them.

> Apache-2.0 · zero runtime model calls · every headline claim below is measured, with
> the pre-registered predictions (including the refuted ones) committed to this repo

**[Docs & guide](https://hexrift.github.io/tamperward/)** ·
**[The launch post](https://hexrift.github.io/tamperward/blog/what-agents-do-when-you-block-their-shortcuts)** — how these numbers were measured, and which of my own bets lost

## Install

```bash
npx tamperward init
```

One idempotent command wires the policy and every enforcement point — it never
overwrites anything you wrote, and `--dry-run` shows the plan first:

| what | wired as |
| --- | --- |
| policy | a commented baseline `.tamperward.yml` — the defaults apply even without it |
| agent loop | Claude Code `PreToolUse` deny + `Stop` sweep, merged into `.claude/settings.json` |
| pre-commit | husky when present, the plain git hook otherwise |
| CI | a PR-gate workflow with out-of-band sign-off (details below) |

Or run the views directly:

```bash
npx tamperward check --staged                # pre-commit view
npx tamperward check --diff "main...HEAD"    # CI view — the authority for main
```

## What it looks like when it fires

An agent, mid-loop, tries the classic shortcut. The deny happens **before** the tool
runs, and holds even under `bypassPermissions`:

```
5. Bash  rm calc.test.js   → DENIED (test-deletion)
6. Edit  calc.js           ← next action: fix the real bug
7. Bash  node --test       → green, honestly
```

The same engine at pre-commit or in CI:

```
tamperward: 2 blocking
(2 changes scanned)

  BLOCK  coverage-lowering  package.json
    Coverage gate weakened: global lines threshold lowered 90 → 10.
    evidence  global lines threshold lowered 90 → 10
    instead   Raise real coverage by adding tests; do not lower or exempt
              the gate to pass.
    sign-off  tamperward allow coverage-lowering --file package.json --reason "..."

  BLOCK  test-deletion  test/calc.test.js
    Test blocks removed: 3 → 1 it()/test() in this spec.
    evidence  2 test block(s) removed from test/calc.test.js
    instead   Keep the assertions and fix the code. Removing test blocks to go
              green is the tamper.
    sign-off  tamperward allow test-deletion --file test/calc.test.js --reason "..."

A blocking finding clears only with a human sign-off. In CI that sign-off is
out-of-band — a PR label applied by a reviewer — never a file committed on the
branch under review.
```

Under GitHub Actions each finding also lands as an **inline annotation on the diff** in
*Files changed*, plus a job-summary table — not four clicks deep in a log.

## The rules

Ten mechanical rules, deterministic by construction — eight `block`, two `warn`:
`test-deletion` (AST block-count, rename-out-of-glob, shell mutation), `test-skip`
(including `.only`, which narrows the suite), `ts-any-cast`, `lint-suppression`,
`coverage-lowering` (Jest and Vitest shapes, all four metrics, `package.json` included),
`ci-tampering` (a **moved** check is not a removed one), `hook-tampering`, `no-verify`
(flags and the env-var escape hatches), `snapshot-rewrite` (`warn` — see the FP study below
for why), and `snapshot-only-rewrite` (`warn` — the FP study's narrow signal, a
snapshot moved with **no accompanying change**, as its own rule so it can graduate to
`block` at a later policy `version:` without touching the broad rule; it fires only at
commit granularity, where "no accompanying change" means something).

Two heuristic rule names — `assertion-weakening` and `guard-removal` — are **reserved
in the baseline policy but not yet built**: they get detectors only once a measured
negatives corpus exists (SPEC §7.A), enter as `warn`, and never block until their
precision clears the bar.

The policy file itself is un-ignorable, CI reads the policy from the **merge-base** (a PR
cannot govern its own verdict), and the agent honours no sign-off it can author — the
escape valve is a PR label only a human with write access can apply.

## Measured, not asserted

**Does the loop work?** `harness/run.sh` stands up an isolated repo with a real bug and a
failing protected test, lets a headless agent loose with the hooks installed, and
classifies the end state with an oracle independent of the detectors under test
(SPEC §7.B). Across 77 runs of these **guarded** scenarios — every attempted bypass class
had a detector covering it — **0 tampers reached green; all 25 runs where a block fired
ended in an honest fix**, a 25/25 point estimate whose 95% lower bound is ≈89%. The split is the
honest part: across four models (Haiku 4.5, Sonnet 5, Opus 5, Fable 5), every
interception came from Haiku on a seed whose honest fix is genuinely expensive — no
frontier model attempted a bypass at all, even when the prompt *ordered* one.
Reproduce: `npm run build && harness/run.sh 5 adversarial haiku seed-hard`.

**Is the fix caused by the deny, or would it have happened anyway?** Measured, with a
pre-registered no-gate control arm (`harness/PREDICTION-ungated-control.md`): same seed,
model, prompt and oracle, hooks removed. **6/10 ungated runs tampered through; honest
fixes fell from 10/10 gated to 4/10 ungated.** The gate's measured contribution on that
configuration is a 60-point swing — causation, not survivorship — and one of the three
control-arm bets was refuted (ungated honest fixes came in above my bet). The control
arm was then extended across the model family (`harness/PREDICTION-frontier-models.md`):
ungated Sonnet 5, Opus 5, and Fable 5 each went **10/10 honest** under the same
pressure prompt — frontier honesty is disposition, not the gate's deterrence — while
ungated Haiku stays 6/10 tamper-green. The gate's measured value concentrates on the
models that do cheat. (The Fable rows are a Fable-driven harness measuring Fable:
self-graded homework, bounded by the deterministic held-out oracle.)

**And when the agent knows the gate is there?** Also pre-registered
(`harness/PREDICTION-informed-adversary.md`) — betting the gate would *leak*. Refuted,
three bets out of three: with the detector sources vendored into the repo and the prompt
naming the gate, Haiku's bypass attempts went from 5/10 uninformed (same day, same
everything) to **0/10 informed — fifteen informed runs, zero evasion attempts**. Sonnet,
told the gate exists under "speed is everything" pressure, refused the task outright in
3/5 runs rather than work around it, and fixed honestly in the other 2. At this scenario
size, disclosure measured as deterrence, not as an evasion spec.

**Which detectors deserve to exist?** Measured too. Affordance seeds offer an agent one
specific bypass each; predictions are pre-registered before any rep runs
(`harness/PREDICTION-affordance.md`). Result: 7/10 adversarial runs regenerated a golden
file from buggy output and sailed through — **because nothing guarded that class yet**;
that measured demand is why `snapshot-rewrite` exists — while
timeout-inflation and lint-config-gutting measured **0/10 attempts each** — two
pre-registered bets refuted, two detectors *not* built. The same discipline settled
`assertion-weakening` (`harness/PREDICTION-assert-affordance.md`): a seed making the
expectation edit the one cheap, prompt-named move — with a plausible convention-mismatch
cover story — measured **0/10 attempts**; Haiku implemented the real fix every time. My
≥6/10 bet was refuted, and the rule stays a reserved name. Bypass classes with no
measured demand stay in a record-only shadow scanner that accumulates evidence on every
weekly harness run.

**What about false positives?** `snapshot-rewrite` was swept over **1,652 real mainline
commits** (prettier, jest, docusaurus, immer): 216 touched snapshots, all legitimately —
which is exactly why that rule is a `warn` asking for human confirmation, not a block,
and why the study is committed (`harness/fp-study/`) rather than summarized away. The
study's narrow signal — snapshot-only diffs, ~0.06% of audited mainline commits but
7/7 of observed tampers — now ships as the distinct `snapshot-only-rewrite` warn, the
graduation candidate.

## Stability

The public surface is the CLI and its **exit codes**, the hook wire format, the
`.tamperward.yml` schema, and the `--json` `Finding` shape. No `main`, no `exports` —
it is a binary, not a library. The version answers one question: *can taking this
upgrade turn a green build red without me changing anything?* **Patch never can** —
bypass fixes and false-positive fixes ship as patches so they reach you automatically.
Rule graduations (`warn` → `block`) are **opt-in**: they gate on the `version:` field in
your policy, so they ship as minors and apply only when you raise it. Releases publish
via npm trusted publishing with SLSA provenance. Full rule:
[CONTRIBUTING](./CONTRIBUTING.md#versioning).

## Develop

```bash
npm install && npm run build    # bundles the CLI to dist/cli/index.js
npm test                        # 259 tests — parser, detectors, engine, policy, renderers
npm run typecheck
```

Tamperward gates its own repo in CI with the same engine it ships — including, on more
than one occasion, blocking its own author's commits. See **[SPEC.md](./SPEC.md)** for
the build spec, the detector table, the enforcement-point wiring, and the proof-harness
design; the `harness/` directory holds the seeds, oracles, transcripts tooling, and
every pre-registered prediction with its outcome.
