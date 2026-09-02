# Round 4 sample-size simulation

**Status: planning scaffolding.** This document and `power-sim.mjs` inform the
round 4 `PREDICTION`; they bind nothing. The `PREDICTION` freezes the script's
hash with the rest of the analysis, and any change to the script after that
commit is a new registration.

## What was simulated

SPEC §9.1 (row M2) requires the round 4 sample to be sized by an exact
simulation over the **full paired table** — false green in both arms, ungated
only (`b`), gated only (`c`), neither — not the ungated marginal. The reason is
arithmetic, not taste: McNemar's `b` is not the count of ungated opportunities.
An ungated false green whose gated twin also ends false green is a concordant
pair and contributes nothing to the test. Round 2 had four such pairs; sizing
on its thirteen ungated false greens would have overstated power. And an
expectation is not an occurrence: at a 10% opportunity rate and 60 pairs, six
discordances is only the mean — the chance of actually *obtaining* six is
barely better than a coin flip.

Each simulated round draws three quantities from posteriors over the observed
rounds, builds the joint table, draws `n` pairs, and applies the exact
conditional McNemar (two-sided binomial on `b + c`, the primary test of rounds
1–3.1):

| quantity | meaning | data behind the posterior |
| --- | --- | --- |
| `piU` | P(ungated arm produces a false green) | the opportunity rate |
| `prev` | P(gated twin clean, given an ungated false green) | the prevention rate |
| `piC` | P(gated-only false green) | gate harm |

Observed tables (repository as the unit; Jeffreys 0.5 added to every count):

| round | n | both | b | c | neither |
| --- | --- | --- | --- | --- | --- |
| 2 (JS/TS, v1.9.0) | 22 | 4 | 9 | 0 | 9 |
| 3 (Python, v1.14.0) | 17 | 2 | 6 | 0 | 9 |
| 3.1 (Python, v1.14.0, `claude-sonnet-5`) | 16 | 2 | 1 | 0 | 13 |

Round 3's cells are recomputed from `round3/runs-phase3/results.jsonl`
(ungated false greens 8, gated 2). Round 4's configuration matches round 3.1
(Python, `claude-sonnet-5`), so 3.1 anchors the opportunity rate; the pooled
rounds 2+3 prevention (15 of 21) stands in for the improved treatment, since
2.x closed the mechanisms behind rounds 2–3's concordant false greens.

## Results (seed `0x52344`, 20,000 simulated rounds per cell)

Power = P(exact McNemar p < .05 with `b > c`). `P(b>=6)` is the probability of
reaching the interpretation floor the 3.1 scorecard carried to round 4 — a
floor for reading the result, never a stopping rule.

| scenario | n=60 | n=80 | n=90 | n=100 | n=120 |
| --- | --- | --- | --- | --- | --- |
| A — 3.1 posterior as-is (prevention stays at 3.1's observed 1 of 3) | 0.22 | 0.30 | 0.32 | 0.35 | 0.40 |
| B — 3.1 opportunity rate, pooled prevention | 0.65 | 0.76 | **0.80** | 0.82 | 0.87 |
| C — pooled Python opportunity rate (rounds 3+3.1) | 0.94 | 0.98 | 0.99 | 0.99 | 0.99 |
| D — as B, with rare gate harm allowed (`piC` from 1.5/57) | 0.53 | 0.64 | 0.67 | 0.70 | 0.75 |

P(b ≥ 6) under scenario B: 0.71 at 60 pairs, 0.83 at 80, 0.87 at 90.
P(the round is underpowered, `b+c < 6`): 0.26 at 60, 0.11 at 90.

**Reading.** Scenario A says that if the 2.x treatment does not actually
improve prevention over what 3.1 observed, no affordable sample rescues the
round — which is correct behaviour for a confirmatory design: the round is
supposed to be able to fail. Under the plausible scenarios the recommendation
is:

- **60 pairs is marginal**: 65% power and a one-in-four chance of an
  underpowered round even when the treatment works.
- **90 pairs reaches 80% power** under scenario B and 67% under the
  pessimistic D.
- **120 pairs** buys 87% / 75% and halves the underpowered-round risk; whether
  the extra 60 trajectories are worth it is a budget call, not a statistical
  one.

The ~20% duplicate pairs for trajectory-instability estimation come **out of a
separate budget** and never enter the primary test.

## The completion endpoint is the real constraint

The compound claim's second condition — semantic completion (`HONEST_FIX` +
`CORRECT_PLUS_VIOLATION`) not worse under the gate by more than 10 points —
was simulated as a paired non-inferiority test (Wald 95% lower bound above
−10pp, within-pair odds ratio 3):

| ungated completion | true effect | n=60 | n=90 | n=120 |
| --- | --- | --- | --- | --- |
| 0.4 | 0pp | 0.27 | 0.36 | 0.45 |
| 0.4 | +5pp | 0.50 | 0.66 | 0.78 |
| 0.2 | 0pp | 0.35 | 0.47 | 0.60 |

At every affordable sample, a true zero-cost gate has **well under 50%**
probability of *demonstrating* non-inferiority at a −10pp margin. The
`PREDICTION` therefore has to choose, in writing, one of:

1. **One primary test.** Masked-failure discordance is the only inferential
   claim; the headline question is worded "…while *estimating* the effect on
   semantic completion", and completion is reported as a paired difference
   with its interval, no pass/fail.
2. **Compound claim.** Completion non-inferiority becomes a second required
   inferential condition — and the round must then either accept ~120+ pairs
   with a wider margin, or accept that the compound claim will often be
   "effect shown; completion inconclusive" even when the gate costs nothing.

This simulation recommends option 1. The margin can still be preregistered as
the *interpretive* threshold for the estimate.

## Reproduce

```
node harness/taskbench/round4/power/power-sim.mjs 20000
```

Deterministic (fixed seed), no dependencies, Node 20+. Full output from the
run behind the tables above is reproduced by that command verbatim.
