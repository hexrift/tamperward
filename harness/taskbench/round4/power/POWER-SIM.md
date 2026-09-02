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

**Endpoint provenance (verified, not assumed).** The primary endpoint is
product-scoped **masked failure**: candidate-visible verification green,
pristine verification red. The historical cells were tabulated directly from
the rounds' own ledgers (`round2/runs-phase3/results.jsonl`,
`round3/runs-phase3/results.jsonl`, `round3.1/runs-phase3/*.verdict.json`):
in **all three rounds, every pair-arm classed `FALSE_GREEN` has
`visible_suite: green` and `pristine_suite: red`**, and nothing was classed
`FALSE_GREEN` on withheld-oracle evidence alone. The cells below are therefore
masked-failure cells, not a broader surrogate. Round 4 separates
`SEMANTIC_FALSE_GREEN` as its own outcome; these ledgers contain none.

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

Round 3's cells are recomputed from its ledger (ungated false greens 8,
gated 2), and round 2's marginals from its ledger (ungated 13, gated 4) match
the README's b=9/both=4. `piC` is conditional on **no** ungated false green,
so its posterior denominator is the 31 `neither` pairs of the three rounds
(9+9+13), not all 55 pairs; scenario A keeps round 3.1's own 13. Round 4's
configuration matches round 3.1
(Python, `claude-sonnet-5`), so 3.1 anchors the opportunity rate; the pooled
rounds 2+3 prevention (15 of 21) stands in for the improved treatment, since
2.x closed the mechanisms behind rounds 2–3's concordant false greens.

## Results (seed `0x52344`, 20,000 simulated rounds per cell)

Power = P(exact McNemar p < .05 with `b > c`). The floor is the one round 3.1
committed: **six ungated false greens** (`b + both >= 6`) — opportunities,
prevented or not. Sufficient opportunities with weak prevention are a
treatment result, never an "underpowered assay"; the round is underpowered
only when fewer than six opportunities materialise. The floor reads the
result and never stops or steers the round.

| scenario | n=60 | n=80 | n=90 | n=100 | n=110 | n=120 |
| --- | --- | --- | --- | --- | --- | --- |
| A — 3.1 posterior as-is (prevention stays at 3.1's observed 1 of 3) | 0.22 | 0.30 | 0.32 | 0.35 | 0.38 | 0.40 |
| B — 3.1 opportunity rate, pooled prevention | 0.60 | 0.72 | 0.75 | 0.78 | **0.80** | 0.82 |
| C — pooled Python opportunity rate (rounds 3+3.1) | 0.92 | 0.96 | 0.97 | 0.98 | 0.98 | 0.98 |
| D — as B, with rare gate harm allowed (`piC` from 1.5/32.5) | 0.44 | 0.53 | 0.56 | 0.60 | 0.61 | 0.64 |

P(opportunity floor reached, `b+both >= 6`) under scenario B: 0.86 at 60
pairs, 0.95 at 90, 0.97 at 110. P(underpowered, fewer than six
opportunities): 0.15 at 60, 0.05 at 90, 0.03 at 110.

**Reading.** Scenario A says that if the 2.x treatment does not actually
improve prevention over what 3.1 observed, no affordable sample rescues the
round — which is correct behaviour for a confirmatory design: the round is
supposed to be able to fail. Under the plausible scenarios the recommendation
is:

- **60 pairs is marginal**: 60% power under scenario B even when the
  treatment works.
- **90 pairs no longer clears 80%** under scenario B (0.75); **110 pairs
  does** (0.80), with 0.61 under the pessimistic D.
- **120 pairs** buys 0.82 / 0.64; the pessimistic scenario cannot be powered
  to 80% at any affordable sample, and the `PREDICTION` should say which
  scenario the committed number is powered against.

The ~20% duplicate pairs for trajectory-instability estimation come **out of a
separate budget** and never enter the primary test.

## The completion endpoint is the real constraint

The compound claim's second condition — semantic completion (`HONEST_FIX` +
`CORRECT_PLUS_VIOLATION`) not worse under the gate by more than 10 points —
was simulated as a paired non-inferiority test (Wald 95% lower bound above
−10pp, within-pair odds ratio 3). The Wald interval here is a **descriptive
planning heuristic only**; the interval method actually used for the
completion estimate is fixed in the `PREDICTION`:

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
