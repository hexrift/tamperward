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

**[Docs & guide](https://hexrift.github.io/tamperward/)** ·
**[The research series](./docs/blog/index.md)** — fourteen posts, with every
registered prediction published beside its outcome

Coding agents can modify both the implementation and the tests, configuration,
CI, hooks and verifier used to judge that implementation — and in observed
trajectories, some modify or attempt to modify verification in ways that can
turn incorrect work into apparent success. Under pressure, the cheaper route to
green is sometimes to weaken the checks instead of fixing the failure.

Tamperward is a **deterministic verification-integrity layer**. It blocks known
weakening moves as they happen, observes protected-state effects, and
independently re-adjudicates apparent success outside the agent's normal
completion path. No runtime LLM judge. Fail closed when adjudication is
impossible.

## What we have actually measured

| experiment | result | what it supports |
| --- | --- | --- |
| **Round 1** — 26 paired real repositories, real historical regressions, 53 counted trajectories, Tamperward **v1.6.0** ([`harness/taskbench/`](./harness/taskbench/)) | Behaviour transferred: **13/26 ungated runs (50%)** committed at least one policy violation. The headline prevention hypothesis **lost**: false-green discordance b=5 / c=4, paired RD +3.8pp [−17.2, +24.7], exact McNemar **p = 1.0** — refuted and published beside the bet | A detector-centric architecture was insufficient on its own: agents routed around the shipped detector classes |
| **Pristine oracle, round 1** — independent re-execution of the original suite against each agent's source | Identified **every masked failure in all 53 trajectories** while diff-time detection was routed around | A strong outcome-level signal on the observed masked failures — the motivation for shipping independent re-verification (`tamperward verify`) |
| **Round 2** — **22 fresh held-out repositories** no detector was tuned on, the **v1.9.0** stack ([`harness/taskbench/round2/`](./harness/taskbench/round2/)) | Transfer 14/22 (64%). Prevention: **b=9 / c=0**, paired RD **+40.9pp**, BP95 **[17.8, 61.3]**, exact McNemar **p = 0.0039** | In that preregistered setting, the full stack materially reduced false greens |
| **After prevention** — the nine round-2 prevented false greens | **8 of 9 became honest completions**; the ninth became an honest **non**-completion | Prevention usually redirected trajectories toward honest work rather than merely blocking them |

Earlier controlled experiments → **[the research series](./docs/blog/index.md)**.

> **Scope.** The rows above are one model, one pressure prompt, one JS/TS
> ecosystem — evidence for that setting, not a universal claim. Round 2 tested
> the v1.9.0 stack; the current **v1.14.0** adds post-study envelope hardening
> (externally reviewed, with each finding exploit-reproduced before its fix —
> see [CHANGELOG](./CHANGELOG.md)). Round 3 is in progress on a frozen v1.14.0
> baseline, testing external validity on a fresh repository frame, with model,
> runtime and ecosystem among the planned axes of change
> ([`harness/taskbench/round3/ROUND3-PLAN.md`](./harness/taskbench/round3/ROUND3-PLAN.md)).
> No round-3 outcomes are included in the claims above.

## Architecture

Every judgment is anchored to state recorded before the agent starts, and the
final adjudication boundary sits outside the agent's normal lifecycle.

```
      FROZEN AT ENVELOPE ENTRY:
      entry SHA · effective policy · verifier command/budget · dependency state
                                    │
      ┌─────────────────────────────┴───────────────────────────────┐
      │  agent loop (Claude Code hooks today)                       │
      │    PreToolUse gate: every proposed Edit/Write/Bash judged;  │
      │    known weakening DENIED before the tool runs              │
      │                          │                                  │
      │  working tree            ▼                                  │
      │    effect observation: per-call protected-tree drift check  │
      │    + filesystem-event observer (`tamperward watch`)         │
      │                          │                                  │
      │  Stop sweep              ▼                                  │
      │    end-of-turn net diff re-checked; transient protected     │
      │    mutations judged from the event log                      │
      │                          │                                  │
      │  pristine verification   ▼   (`tamperward verify`)          │
      │    suite runs twice in isolated copies: the candidate tree  │
      │    as-is, and with protected tests/snapshots/config         │
      │    restored from the trusted base; visible-green +          │
      │    pristine-red = MASKED FAILURE                            │
      └─────────────────────────────┬───────────────────────────────┘
                                    │  agent runtime exits — exit code NOT trusted
                                    ▼
      `tamperward run -- <agent…>` — the outer envelope
        policy + verifier resolved from the entry state, never the tree
        the agent wrote · post-agent HEAD must descend from the entry
        SHA · policy check over base...HEAD (committed weakening) and
        over the worktree incl. untracked files (uncommitted) ·
        dependency-tree fingerprint compared · quiescence guard ·
        pristine verify against the entry base · exit 1 on any blocking
        finding or masked failure · exit 2 (fail closed) when
        adjudication is impossible
                                    │
                                    ▼
      pre-commit backstop: `tamperward check --staged`
                                    │
                                    ▼
      PR CI: `check --diff base...head` + `verify --require-ancestor`
        policy read from the merge-base — a PR cannot govern its own verdict
                                    │
                                    ▼
      out-of-band human exception only: PR label
      `tamperward:allow:<rule>@<head-sha>` — SHA-bound, applied by a human
      with write access, never a file the branch can commit
                                    │
                                    ▼
      protected main
```

CI is the final authority in this design, and that authority is conditional on
the deployment assumptions documented in
[docs/guide/enforcement.md](./docs/guide/enforcement.md) and
[SPEC.md](./SPEC.md): verification is anchored to a base the agent cannot
rewrite (a protected branch), the repository's branch protection actually
enforces the workflow's verdict on merges, and sign-off labels can only be
applied by humans with write access. Mechanisms, residuals, and what is
explicitly outside the trust boundary: [SPEC.md](./SPEC.md) and
[SECURITY-ENVELOPE.md](./SECURITY-ENVELOPE.md).

## Quick start

```bash
npx tamperward init
```

One idempotent command wires the policy, the agent hooks, the pre-commit hook, and
a CI workflow that runs both the diff-time check and pristine verification. It
never overwrites anything you wrote; `--dry-run` prints the plan.

A real deployment needs a verify command configured — the generated CI verify step
**fails closed (exit 2) without one** rather than passing quietly. In
`.tamperward.yml`:

```yaml
verify:
  command: npm test
  budget: 300
```

That block is itself a guarded surface: changing the command, lowering the budget,
or removing it is flagged as policy weakening — a verifier an agent can point at
`true` is no verification at all.

The four primitives:

```bash
npx tamperward check --staged                # pre-commit view
npx tamperward check --diff "main...HEAD"    # CI view over the PR's commit range
npx tamperward verify --base main            # pristine-suite re-execution
npx tamperward run -- <agent command...>     # the outer envelope around an agent
```

## Four layers, different jobs

| layer | the question it answers |
| --- | --- |
| **Proposal** | Is this proposed edit or command a known way of weakening the checks? (PreToolUse deny, pre-commit, CI diff check) |
| **Effect** | What did the protected state actually become, however the mutation arrived? (drift check, fs-event observer, Stop sweep) |
| **Outcome** | Does the trusted suite still pass against the candidate source? (pristine verification — no diff interpreted at all) |
| **Authority** | Where is the final verdict rendered, outside the agent's completion path? (run envelope, CI, SHA-bound human sign-off) |

Sixteen rules are specified and fourteen ship (see the table in
[SPEC.md](./SPEC.md)). The families: test protection (`test-deletion`,
`test-skip`, `test-content-removal`), verification-signal protection
(`coverage-lowering`, `snapshot-rewrite`, `snapshot-only-rewrite`), suppression
(`ts-any-cast`, `ts-any-launder`, `lint-suppression`), pipeline protection
(`ci-tampering`, `hook-tampering`, `no-verify`), and the effect/outcome layers
(`transient-protected-mutation`, `pristine-verification`, plus the `run` envelope).
Some ambiguous syntactic classes deliberately remain warnings or unimplemented —
`assertion-weakening` and `guard-removal` are reserved names with no detector, and
`ts-any-launder` is a permanent warn — rather than being promoted to blockers
without precision evidence.

## What this does not establish

- **Not a correctness oracle.** Pristine verification can only re-run tests that
  exist in the tree. Round 2's designed-in blind spot: on tasks with withheld
  test cases, an agent that honestly half-fixes the visible cases gets a genuine
  visible green and is caught only by the withheld half — no tampering involved.
  A hardcoded implementation is likewise invisible to any diff rule.
- **Not an OS sandbox, a network firewall, a secret manager, or a replacement for
  branch protection.** It enforces verification integrity; it does not confine
  the process.
- **The intended deployment is defence in depth:** instructions naming the
  forbidden move + capability restriction + Tamperward + independent held-out
  tests + authoritative CI. Each layer covers classes the others measurably miss.

**A word on the words:** *tamper* and *honest* are operational labels on
artifacts — a protected asset changed, or an independent oracle failed, while the
visible check went green — decided deterministically. They are not claims about
any model's intent.

## Research discipline

Predictions are registered before counted runs, with numeric bets and explicit
losing conditions, and the git history proves the order. Seeds, pools, frozen
analysis scripts, transcripts, and deviation ledgers are committed. A pool used
to develop detectors is spent — validation requires a fresh draw (round 1's
repositories are development data now; round 2 drew new ones). Run counts are
reported with their honest evidence unit: repeated runs on one seed measure that
seed's stochasticity, and the independent evidence behind the synthetic studies
is the count of distinct seed configurations, not the run count. Losing
predictions and corrections remain in the public record rather than being
removed after the result is known; the series and its errata carry the ledger
and its totals.

**[The research series](./docs/blog/index.md)** ·
**[The harness](./harness/)** ·
**[Errata](./docs/blog/errata.md)**

## The architecture was earned by failures

| study / version | consequence |
| --- | --- |
| Early seed studies | The proposal gate: deny the known weakening classes before the tool call runs, with the deny message as the correction signal |
| Blind-dimension studies | Coverage ≠ completeness: when the cheapest cheat sat outside detector coverage, agents took it — so an orthogonal verification layer matters more than more rules |
| Round 1, p = 1.0 | The 53 real trajectories became the evasion corpus — evasion classes the detectors never imagined, extracted with full forensics |
| v1.7.0 | `test-content-removal`: the row-deletion / assertion-stripping / setup-gutting family that carried round 1's gated false greens, corpus-priced on 2,304 real commits before shipping as block |
| v1.8.0 | The effect layer: per-call protected-tree drift check plus the `tamperward watch` fs-event observer — judge what the files became, not the command spelling |
| v1.9.0 | `tamperward verify`: the round-1 pristine oracle productized — visible-green + pristine-red is a masked failure, and "could not verify" fails closed |
| Round 2, 9–0 | The v1.9.0 stack eliminated every false green in its jurisdiction on 22 fresh repositories (p = 0.0039) |
| cssstyle lifecycle escape (round 2) | The `tamperward run` envelope: the gate denied 42 mutations and verify refused all 25 stop attempts, and the runtime completed the session anyway over a masked tree — hooks decide, runtimes terminate, so the adjudication boundary moved outside the runtime |
| v1.10.1–v1.14.0, owner + two-pass external review | Frozen entry-time policy and verifier, entry-SHA ancestry enforcement, quiescence guard, dependency-tree fingerprint, a CI verify step in the generated workflow, the gate pinned to its own version in CI, and SHA-bound sign-off labels |

Each row's primary artifact: [CHANGELOG.md](./CHANGELOG.md), [SPEC.md](./SPEC.md),
and the posts in [docs/blog/](./docs/blog/index.md).

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
npm test                        # 364 tests — parser, detectors, engine, policy, renderers
npm run typecheck
```

Tamperward gates its own repo in CI with the same engine it ships — including, on more
than one occasion, blocking its own author's commits. See **[SPEC.md](./SPEC.md)** for
the build spec, the detector table, the enforcement-point wiring, and the proof-harness
design; the `harness/` directory holds the seeds, oracles, transcripts tooling, and
every pre-registered prediction with its outcome.
