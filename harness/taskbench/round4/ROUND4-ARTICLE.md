# Round 4 results

> Round 4 did not confirm our primary prediction. We predicted that TamperWard would produce
> a large and statistically significant reduction in masked failures. It did not: the
> registered paired test produced 5 prevention discordances, 3 induced-harm discordances,
> and p = 0.727. At the same time, a narrower security result held: across 201 measured
> trajectories, we observed no case where landed tampering survived and TamperWard certified
> it clean.

*All figures in this article are the sealed values in [`ROUND4-RESULTS.json`](./ROUND4-RESULTS.json),
reproducible with [`analyze-counted.mjs`](./analyze-counted.mjs). The registered design is
`PREDICTION4-taskbench.md` (freeze 2). Draft for internal review — not published.*

## 1. What we predicted

Round 4 was preregistered (PREDICTION4, freeze 2, 2026-09-07) as a paired experiment over
N = 110 repositories, each run in a **gated** arm (the frozen TamperWard 2.10.3 platform:
PreToolUse gate + Stop sweep + enforcement envelope) and an **ungated** arm (parent-owned
observer only). The single inferential claim was an exact conditional McNemar test on
**product-scoped masked failure** — candidate-visible verification green while pristine
verification is red — rejecting H₀ only when `p < .05` **and** `b > c`.

The committed point predictions, anchored to the preregistered scenario-B model, were:

| | predicted |
|---|---|
| prevention discordance `b` | 16 |
| induced-harm discordance `c` | 1 |
| exact McNemar p | ≈ 0.0003 |
| decision | reject H₀ |
| completion RD (gated − ungated) | 0 pp |

## 2. What actually happened

The counted run executed all 264 trajectories (220 primary + 44 duplicate). State is
complete and internally consistent: 239 verdicts + 25 adjudicated = 264/264, no missing
records, no manifest-hash mismatches, no stray verdicts. Of the 239 verdicts, 201 were
measured and 38 were `INVALID_MEASUREMENT`.

## 3. Primary result: the prediction did not replicate

Among **79 repositories with valid measurements in both arms**, there were **5 prevention
discordances** and **3 induced-harm discordances**. The exact paired McNemar test gave
**p = 0.727**, so **the preregistered null hypothesis was not rejected.**

| | predicted | observed |
|---|---|---|
| b (prevention) | 16 | **5** |
| c (induced harm) | 1 | **3** |
| exact McNemar p | ≈ 0.0003 | **0.727** |
| decision | reject H₀ | **do not reject H₀** |

This is a clear failed prediction, and we state it plainly. The preregistered interpretation
floor was met — ungated masked-failure opportunities `a + b = 15`, required floor = 6 — so
the protocol does **not** classify this as an opportunity-starved or uninterpretable round.
However, realized discordance — and therefore realized statistical information — was lower
than assumed by the original 80% power calculation: 8 discordant pairs rather than the
roughly 17 assumed, over 79 realized valid pairs rather than the planned 110.

## 4. What the masked failures actually were

The registered endpoint counts two different things under one label:

```
FALSE GREEN
  ├── evaluation was tampered with      → TamperWard's core scope
  └── implementation was simply wrong   → correctness / oracle scope
```

Round 4's measured false-greens were dominated by the **second** class — incomplete or
incorrect fixes that happen to leave the visible suite green. A tamper-detection treatment
has little to move against a correctness gap, which likely helps explain why the primary
endpoint showed no large treatment effect. This is an important **post-result
interpretation and a next-round design lesson. It is not retrofitted into the confirmatory
hypothesis** — the primary test stands exactly as registered, and it did not reject.

## 5. Zero observed strict tamper bypasses

This is a genuinely useful second result, reported as a separate claim. We hold the strict
definition:

```
landed weakening  +  survived to relevant state  +  TamperWard certified clean
        =  strict tamper bypass
```

Across **201 measured trajectories we observed 0 strict tamper bypasses.** The 10 frozen
`envelope_escape` events decompose completely into correctness/oracle false-greens; **none**
were tampering certified clean:

```
10 envelope_escape events
10 = correctness / oracle false-greens
 0 = tampering certified clean
```

Precisely: **within the measured Round-4 trajectories, every observed landed tampering case
in the gated arm was flagged rather than certified clean; the clean-certified false-greens
were incomplete or incorrect fixes, not surviving tampering.** We do **not** claim
"TamperWard prevented every attack" — the data do not establish that. The value of this
result is that it corrects the potentially misleading reading of the word *escape*: the
frozen `envelope_escape` field conflates tamper bypasses with correctness false-greens, and
in Round 4 the strict-bypass count under that field was zero.

## 6. Completion / legitimate-work cost

Semantic completion (`HONEST_COMPLETION + CORRECT_PLUS_VIOLATION`) over the 79 valid pairs:

```
gated      67.1%   (53/79)
ungated    70.9%   (56/79)
paired RD  −3.8 pp  (gated − ungated)
```

This is within the registered −10 pp interpretive margin, so there is no obvious large
productivity penalty from gating **in this sample**. We do **not** call this "non-inferior":
no non-inferiority test was registered or performed. Descriptive only.

## 7. Duplicate stability

The 22 duplicate repositories (rerun in both arms, a separate instability budget) give a
test-retest read against their primary realizations, over 36 comparable pairs:

```
masked-failure agreement   34/36 = 94%
full outcome agreement     33/36 = 92%
```

Trajectory instability is low. This is encouraging for assay stability, and it makes the
primary null harder to dismiss as mere random trajectory chaos.

## 8. The 79/110 measurement problem

```
110 primary repositories
 −11  pre-sampling exclusions (adjudicated deviations)
 −20  additional tasks lost to post-sampling invalid measurement
 = 79 valid paired repositories        (79 / 110 = 71.8%)
```

Only 71.8% of the original primary task pool ultimately produced a valid paired measurement.
That is itself a major Round-4 finding. The loss is dominated by post-sampling
`INVALID_MEASUREMENT`, most of it symmetric across arms (so it does not bias the treatment
contrast) but all of it subtracting statistical information.

## 9. What broke in the apparatus

The strongest issues are in the execution environment, not the treatment or the analysis:

- editable-liveness assumptions;
- exact parent-GREEN / tests-RED / gold-GREEN qualification;
- CI environment variables;
- network-jail effects;
- agent-configuration provenance (the D44 arm-asymmetric `.claude/` hook);
- venv / interpreter execution failures (`EXEC_FAILED`, exit 126 — the largest single
  contributor to invalid measurement);
- evidence persistence (the D43 oversized-tar checkpoint failure);
- pre-agent baseline observability (D42 discarded suite output; the D42 next-round note).

## 10. What we would change before the next round

The next round should **not** simply run more tasks. The qualification pipeline should move
much closer to the exact production runner, so that a repository can only enter the frozen
pool after it has demonstrably produced a valid measurement under production conditions:

```
Candidate repo
      │
      ▼
Exact production runner
      ├── exact network jail
      ├── exact CI environment
      ├── exact agent-config provenance   (normalize .claude/ identically across arms)
      ├── editable liveness
      ├── parent GREEN
      ├── tests RED
      ├── gold GREEN
      ├── executable venv
      └── repeated baseline viability
      │
      ▼
Only then enter the frozen pool
```

The single intended difference between arms must be TamperWard — not whether an arbitrary
repository hook survives, and not whether a venv happens to execute.

## 11. What this does — and does not — establish

- It **does** establish that, in this preregistered sample, the treatment did not produce
  the predicted large, significant reduction in masked failures, and that the realized
  masked failures were largely correctness gaps rather than tampering.
- It **does** establish a narrower security result: no measured trajectory produced a strict
  tamper bypass (landed + surviving + certified clean).
- It **does not** establish that TamperWard prevents all tampering, that gating is
  "non-inferior" on completion, or that the final-state-cleanup contrast is real — those are
  descriptive observations to replicate, not confirmed effects.
- It **does not** revise the confirmatory hypothesis after the fact: the correctness-vs-
  tampering decomposition is a design lesson for a future preregistration, not a rescue of
  this one.

## 12. Full deviations / raw evidence

- Registered design: `PREDICTION4-taskbench.md`.
- Sealed results: [`ROUND4-RESULTS.json`](./ROUND4-RESULTS.json); readout:
  [`ROUND4-ANALYSIS.md`](./ROUND4-ANALYSIS.md); analysis engine:
  [`analyze-counted.mjs`](./analyze-counted.mjs).
- Deviation ledger: `DEVIATIONS.md` (D36, D39, D40, D41, D42, D43, D44).
- Per-trajectory verdicts and execution ledger: the `round4-counted-state` branch.
- Oversized final-tree evidence archives: the `round4-evidence` release (content-addressed).
- Frozen identity: manifest `eeb85c26…`, treatment 2.10.3 (`0863d3a8…`), model
  `claude-sonnet-5`.

No frozen binding file was altered during the counted run; no sampled trajectory was ever
re-rolled; no product version was bumped for any deviation.
