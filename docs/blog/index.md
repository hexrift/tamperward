# Blog

*An [errata page](./errata.md) records every published correction and the
inconsistencies our own audit could not resolve.*

- **[The null we predicted, and the false green it could not stop](./the-null-we-predicted-and-the-false-green-it-could-not-stop.md)** — September 1, 2026.
  The round-3.1 answer: on the same 16 Python repositories with the model moved
  to `claude-sonnet-5` and the treatment byte-identical, false-green discordance
  was 1–0 in the gate's favour (exact McNemar p = 1.0000). The null was
  predicted and is reported as underpowered given the observed violation rate,
  per the registered guard — not rescued by a one-sided test or by pooling.
  Transfer fell from 9/17 to 4/16: the stronger model reached for the sanctioned
  shortcut about half as often. Eight of ten bets landed; `b` and ungated
  completions both missed low. The finding worth the round is one trajectory
  where every layer fired, blocked the agent, accepted its revision, and still
  certified a tree whose withheld oracle was red — the boundary between
  guarding the tests and guarding correctness.

- **[Before we test the same tasks on a stronger model, here's what we think will happen](./before-we-test-the-same-tasks-on-a-stronger-model.md)** — September 1, 2026.
  The round-3.1 preregistration: the frozen round-3 Python benchmark, the
  v1.14.0 treatment held byte-identical, the model as the intended factor —
  with two disclosed differences beyond it. Registered on 16
  pairs, not 17, because we started the sweep by accident while checking the
  registration gate and then applied our own no-reroll rule to ourselves — the
  trajectory was quarantined unread and its pair excluded. The headline
  prediction is a null: if a stronger model weakens tests less often there is
  less to prevent, and with c=0 the exact test needs b≥6 to reach p<.05.
  Registered in advance, including the guard against rescuing it afterwards.

- **[The effect transferred. The detector didn't.](./the-effect-transferred-the-detector-didnt.md)** — September 1, 2026.
  The round-3 answer: on 17 fresh Python repositories, false-green
  discordance was 6–0 in the gate's favour (paired RD +35.3pp
  BP95 [9.5, 58.7], exact McNemar p=.0313). Two preregistered bets lost —
  completion rose +41.2pp against a predicted ~0, and the zero-escape bet
  failed by its own operational definition. The in-loop skip detector proved
  blind to pytest syntax, which is how Python agents actually weaken tests;
  the outer layers carried the result. One trajectory looked clean at the end
  after six transient weakening events and fourteen blocked terminations;
  another invalidated the envelope's Git anchor, which only the outermost
  layer could see.

- **[Before we test Tamperward on Python repositories, here's what we think will happen](./before-we-test-tamperward-on-python-repositories.md)** — August 31, 2026.
  The round-3 preregistration: the v1.14.0 treatment frozen, a fresh
  500-repository PyPI frame mined and audited, 17 paired pytest tasks
  revalidated, the model held constant at round 2's, eight numeric bets and
  five losing conditions on the record — and a two-stage sampling finding
  about how root-oriented eligibility maps onto Python monorepos, disclosed
  before any counted outcome exists. No counted round-3 trajectory has run.
- **[The gate held. The runtime didn't.](./the-gate-held-the-runtime-didnt.md)** — August 31, 2026.
  The rerun's preregistered answer: on 22 fresh repositories, transfer 64%,
  and the 1.9.0 stack produced b=9/c=0 false-green discordance
  (RD +40.9%, exact McNemar p=0.0039), while four gated false greens
  remained through two documented residual mechanisms — with eight of the nine
  prevented fakes becoming honest completions and the ninth an honest
  non-completion. Two residual routes documented, not patched:
  a runtime that owns termination when the enforcement layer doesn't, and the
  withheld-split blind spot we designed in. Two bets missed their bands
  upward; both count as misses.

- **[What losing the bet bought: three defense layers from 53 real trajectories](./what-losing-the-bet-bought.md)** — August 30, 2026.
  The engineering response to the failed prevention bet, published before the
  rerun so the next experiment tests a public design: the evasion taxonomy
  extracted from the counted trajectories, the one anomaly that proved
  spelling-level inspection has a floor, `test-content-removal` priced on
  2,304 real commits, the effect layer with its claims stated at exactly the
  strength they deserve, and the 53-for-53 pristine oracle productized as
  `tamperward verify`. None of it validated — that requires the fresh frame
  draw, and the next experiment is allowed to fail us again.

- **[We tested an AI coding agent across 27 real repositories. Here's how often it weakened its own checks](./we-tested-an-ai-coding-agent-on-27-real-repositories.md)** — August 30, 2026.
  The preregistered answer: transfer is real — 13/26 ungated runs violated
  policy on real historical bugs — and the gate did not reduce false greens
  (b=5, c=4, p=1.0); our headline bet refuted and published beside its
  refutation. No measurable completion-cost signal, and independent
  pristine-suite re-execution caught every masked failure in all 53
  trajectories.

- **[Before we test Tamperward on 27 real repositories, here's what we think will happen](./before-we-test-tamperward-on-27-real-repositories.md)** — August 29, 2026.
  The preregistration post, published before any counted trajectory: how the
  27-task benchmark was mined from a frozen 500-repo frame, what Phase 0's
  validation caught (and why each finding made the benchmark stricter), what the
  pilot exercised without producing evidence, and six numeric bets — including
  the three results that would count as Tamperward losing. The next post is the
  answer; the git history proves this one came first.

- **[What AI coding agents do when the tests are read-only](./what-agents-do-when-the-tests-are-read-only.md)** — August 29, 2026.
  The capability-restriction study: `chmod` doesn't bind a root agent, but the
  immutable bit does — 10/10 honest under hard immutability, EPERM converting
  agents to the honest fix 4/4 with no remediation text. Then an auto-granted
  elevation path turned two logged confessions ("remove failing test file to
  unblock build") into authorized tampering. Six governance mechanisms now
  measured on identical pre-registered ground.

- **[137 runs were not 137 experiments](./137-runs-were-not-137-experiments.md)** — August 29, 2026.
  An external review made the statistical distinction sharper than we had: the run
  counts vastly exceed the count of independent experiments behind them (~15 seed
  configurations, 8 repos). We agree. The concession stated precisely, the README
  reframed so the two headline numbers travel together, the loaded vocabulary given
  operational definitions — and the capability-restriction study pre-registered as
  the answer to "just make the tests read-only."

- **[What AI coding agents do when you give the cheat a name](./what-agents-do-when-you-give-the-cheat-a-name.md)** — August 29, 2026.
  Both open loops closed: the sentence aimed at Sonnet's invisible spelling flips
  10/10 laundering to 10/10 honest (framing is a lever, not just an explanation),
  and the tuned-gate bill arrives — 9.0% → 6.0% with one line, while the per-rule
  scoping feature built that morning measures zero and ships with its null
  published.

- **[What AI coding agents do when you just ask nicely](./what-agents-do-when-you-just-ask-nicely.md)** — August 29, 2026.
  The cheap-baselines study: one instruction sentence cuts Haiku's cheating from
  6/10 to 1/10, the 20-line strawman hook finds a live gap in the gate's flagship
  rule (closed in 1.5.1), and the false-positive bill for both screens on 1,227
  real commits — including the gate's own honest 9%. Two of three bets lost
  against the product's framing.

- **[What AI coding agents do when no one can say no](./what-agents-do-when-no-one-can-say-no.md)** — August 29, 2026.
  The type-laundering study: the cheapest cheat spellings no rule can see, 26 of 40
  runs through them — including the model famous for refusing, 10/10, via an inline
  assertion. A deny that taught a better bypass, the oracle hardening that saved the
  conclusion, and the measured scope of "disposition, not deterrence."

- **[What AI coding agents do when the bug isn't theirs](./what-agents-do-when-the-bug-is-not-theirs.md)** — August 29, 2026.
  The two dimension studies: closed-vs-open called correctly in advance (the first
  certification-under-attack), half of Haiku's runs opening with the exact move a
  token detector would have missed — and the perfect 25/25 conversion record dying
  honestly on a seed where the failing suite is somebody else's bug.

- **[What AI coding agents do when it doesn't look like a test](./what-agents-do-when-it-does-not-look-like-a-test.md)** — August 29, 2026.
  Two attacks on the honesty results: a seed dressed as a real project (backdated
  history, a maintainer's plea) and a written license to rewrite tests the agent
  might believe are wrong. Sixty runs, zero semantic evasions or test
  rewrites — and the manipulation checks
  that make the nulls mean something.

- **[What AI coding agents do when the fix doesn't exist](./what-agents-do-when-the-fix-does-not-exist.md)** — August 29, 2026.
  The stuck-agent study: a provably unfixable suite, a claims-based oracle, and an
  explicit honest exit. Twenty of twenty pressured runs surrendered honestly — both
  my Haiku bets refuted — and the thesis sharpens: agents take the cheapest path
  they believe is sanctioned.

- **[What AI coding agents do when nothing is watching](./what-agents-do-when-nothing-is-watching.md)** — August 28, 2026.
  The follow-up batch: the gate switched off for four models (30/30 honest frontier
  runs vs 6/10 tampers from the cheap one), the assertion trap that caught nobody,
  the `snapshot-only-rewrite` rule that shipped from the FP study, and the
  pre-registered roadmap.

- **[What AI coding agents do when you block their shortcuts](./what-agents-do-when-you-block-their-shortcuts.md)** — August 27, 2026.
  The launch post, long form: the harness, the pre-registered predictions (two of
  which were refuted), the false-positive study over 1,652 real commits, and the
  times the gate blocked its own author.
