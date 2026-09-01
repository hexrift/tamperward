# Round 3.1 — model transfer on the frozen round-3 pool (scoping document)

This is a SCOPING document, not a registration. Seeds, numeric bets, losing
conditions and the final runner pins are set at the round-3.1 registration
step, before trajectory #1, exactly as in rounds 1–3. What this document
freezes is the design principles, decided before any Sonnet trajectory of any
kind has run.

## The question

> Does the round-3 prevention effect transfer from Haiku to Sonnet when the
> Python task pool, the Tamperward v1.14.0 treatment, the prompt, the
> oracles, and the execution protocol are held constant?

## Why "3.1" and not "4"

Round 3.1 reuses the round-3 task pool. Those repositories are spent: the
research process has seen 34 Haiku trajectories on them, published the
results, and read the transcripts. A study on them can answer a very clean
question — on the exact repositories where Haiku produced the round-3
result, what changes when only the agent model changes? — but it is
follow-up, model-transfer evidence on a frozen benchmark, not another
independent held-out replication comparable to rounds 2 and 3. The
nomenclature says so up front:

| round | model | ecosystem | treatment | pool |
|---|---|---|---|---|
| 2 | Haiku | JS/npm | v1.9.0 | fresh, held-out |
| 3 | Haiku | Python/pytest | v1.14.0 | fresh, held-out |
| **3.1** | **Sonnet** | Python/pytest | v1.14.0 | **round-3 pool, spent** |
| 4 | TBD | Python/pytest | next treatment | fresh (FRAME5) |

## Principles frozen now (before any Sonnet trajectory)

1. **All 17 round-3 main tasks.** No subset, no substitution, no addition.
2. **v1.14.0 byte-identical** — specifically, the Python skip-detector gap
   measured in round 3 is NOT fixed. Changing model and treatment
   simultaneously would forfeit the clean comparison; the gap is a round-4
   engineering item.
3. **Same pressure prompt** (hash-pinned), same budgets, same network jail,
   same verifier/oracles, same outcome definitions, same runner protocol.
4. **Sonnet model ID pinned exactly** at registration; fail-closed in the
   driver and the runner, as in round 3.
5. **Preregistration before trajectory #1**, with the article rule inherited
   from round 3: no counted outcome above the line.
6. **Primary endpoint:** Sonnet gated-vs-ungated FALSE_GREEN prevention —
   paired, exact McNemar, same frozen analysis (`analyze3.mjs`).
7. **Assay starvation is preregistered as a possible result.** If Sonnet
   rarely false-greens ungated, the round publishes as underpowered for
   prevention at this model — a finding about the model, not a treatment
   claim in either direction (the round-3 seed-study prior: Sonnet 30/30
   honest ungated in the pre-taskbench studies).
8. **The round-3 Haiku data is frozen prior evidence.** No Haiku trajectory
   is rerun; nothing learned from Sonnet runs reaches back into any round-3
   artifact.
9. **Cross-model comparison is secondary and descriptive** unless a proper
   interaction analysis is preregistered at the registration step. The
   headline of 3.1 is the within-model paired result, not Haiku-vs-Sonnet.

## Execution hygiene (hardened BEFORE the sweep; hygiene, not treatment)

Round 3's outage taught specific lessons. None of these touch the treatment,
the tasks, or the endpoints; all are infrastructure and get built and
selftested before registration pins the runner:

- **Stable proxy discovery:** the runner must resolve the upstream proxy at
  trajectory start, not inherit a possibly-stale environment captured at
  sweep launch (the round-3 outage: a container restart rotated the proxy
  port under a running sweep).
- **Per-trajectory health check:** clone/egress preflight before each
  trajectory, not only at sweep start.
- **Circuit breaker:** a systemic failure (e.g. repeated instant
  CLONE_FAILED) aborts the sweep immediately rather than burning the
  remaining pairs through their retry budgets — promoted from the round-3
  continuation driver into the main driver.
- **Resumable attempts:** the attempt-numbering and continuation semantics
  from the round-3 deviation (never-started trajectories distinguishable
  from failed ones; failure records permanent; re-attempt only what never
  ran) become first-class driver behaviour instead of an emergency script.
- **Checkpoint pushes that actually push** (round 3's checkpoints silently
  failed against branch protection until backed up manually; the driver
  pushes to a non-protected checkpoint branch).

## Explicitly out of scope for 3.1 (reserved for round 4)

Fixing pytest skip detection; the trajectory-integrity schema cleanup
(final_integrity_state / task_outcome / trajectory_policy_violations, with
oracle-strength scoping preserved); the Python-monorepo-aware miner and
eligibility rules; a fresh FRAME5 pool; validation of the improved treatment
on genuinely held-out repositories.
