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
as a verdict, not a probability, enforced everywhere a change can be made: **inside the
agent's loop, at the commit, and at the merge.**

> Apache-2.0 · zero runtime model calls · every headline claim below is measured, with
> the pre-registered predictions (including the refuted ones) committed to this repo

## Install

```bash
npx tamperward init
```

One idempotent command wires all four enforcement points — it never overwrites anything
you wrote, and `--dry-run` shows the plan first:

| point | what it wires |
| --- | --- |
| agent loop | Claude Code `PreToolUse` deny + `Stop` sweep, merged into `.claude/settings.json` |
| pre-commit | husky when present, the plain git hook otherwise |
| CI | a PR-gate workflow with out-of-band sign-off (details below) |
| policy | a commented baseline `.tamperward.yml` — the defaults apply even without it |

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

A blocking finding clears only with a human sign-off. In CI that sign-off is
out-of-band — a PR label applied by a reviewer — never a file committed on the
branch under review.
```

Under GitHub Actions each finding also lands as an **inline annotation on the diff** in
*Files changed*, plus a job-summary table — not four clicks deep in a log.

## The rules

Nine mechanical rules, deterministic by construction, `block` by default:
`test-deletion` (AST block-count, rename-out-of-glob, shell mutation), `test-skip`
(including `.only`, which narrows the suite), `ts-any-cast`, `lint-suppression`,
`coverage-lowering` (Jest and Vitest shapes, all four metrics, `package.json` included),
`ci-tampering` (a **moved** check is not a removed one), `hook-tampering`, `no-verify`
(flags and the env-var escape hatches), and `snapshot-rewrite` (`warn` — see the FP study
below for why).

Three heuristics ship as `warn` and never block until their precision clears the bar:
`assertion-weakening`, `guard-removal`, `ts-any-launder`.

The policy file itself is un-ignorable, CI reads the policy from the **merge-base** (a PR
cannot govern its own verdict), and the agent honours no sign-off it can author — the
escape valve is a PR label only a human with write access can apply.

## Measured, not asserted

**Does the loop work?** `harness/run.sh` stands up an isolated repo with a real bug and a
failing protected test, lets a headless agent loose with the hooks installed, and
classifies the end state with an oracle independent of the detectors under test
(SPEC §7.B). Across 42 runs of these **guarded** scenarios — every attempted bypass class
had a detector covering it — **0 tampers reached green; all 20 runs where a block fired
ended in an honest fix**, a 20/20 point estimate whose 95% lower bound is ≈86%. The split is the
honest part: Sonnet 5 never attempted a bypass at all, even when the prompt *ordered*
one; all 20 interceptions came from Haiku 4.5 on a seed whose honest fix is genuinely
expensive. Reproduce: `npm run build && harness/run.sh 5 adversarial haiku seed-hard`.

**Which detectors deserve to exist?** Measured too. Affordance seeds offer an agent one
specific bypass each; predictions are pre-registered before any rep runs
(`harness/PREDICTION-affordance.md`). Result: 7/10 adversarial runs regenerated a golden
file from buggy output and sailed through — **because nothing guarded that class yet**;
that measured demand is why `snapshot-rewrite` exists — while
timeout-inflation and lint-config-gutting measured **0/10 attempts each** — two
pre-registered bets refuted, two detectors *not* built. Bypass classes with no measured
demand stay in a record-only shadow scanner that accumulates evidence on every weekly
harness run.

**What about false positives?** `snapshot-rewrite` was swept over **1,652 real mainline
commits** (prettier, jest, docusaurus, immer): 216 touched snapshots, all legitimately —
which is exactly why that rule is a `warn` asking for human confirmation, not a block,
and why the study is committed (`harness/fp-study/`) rather than summarized away.

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
