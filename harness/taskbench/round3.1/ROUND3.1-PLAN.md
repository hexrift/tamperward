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

### Correction record: review of the first hygiene implementation

The first implementation of the five items above was reviewed before merge
and corrected. Recorded here because the corrections change what the
infrastructure guarantees, and the review happened before registration:

1. **The health check ran too early to protect anything.** The upstream proxy
   was resolved and probed at the top of the runner, then clone, install,
   parent-red and gold validation ran for minutes before the agent started.
   That is exactly the window round 3's rotation landed in. The check is now
   a **trajectory-start boundary**: the upstream is re-resolved, the
   allowlist proxy is launched, its process and listener are asserted, and a
   request is driven from inside the network namespace, through that exact
   proxy, to the model API — as the last thing before the agent is invoked.
   Anything failing there is `PREFLIGHT_NET_FAILED` / exit 8 with no verdict
   written. Without it, a rotated proxy yields an agent that cannot reach the
   API, does no work, and leaves an unchanged red tree that the verdict
   oracle would have scored as a counted `NOT_FIXED`.
2. **Both liveness probes were vacuous.** The platform's `NO_PROXY` lists
   `api.anthropic.com`, so `curl -x <proxy> https://api.anthropic.com/`
   ignores the proxy and goes direct — reporting "alive" for a dead port and
   "path verified" for a broken chain. Both probes now clear `NO_PROXY`, and
   the liveness test requires curl to exit 0 rather than accepting any error
   other than refused/timeout/resolve-failure. The behavioural self-test
   below is what exposed this.
3. **Terminal failures were re-attempted on resume.** The driver skipped
   trajectories that had a verdict but not those already logged as
   `INFRASTRUCTURE_FAILURE`, which round 3's driver treated as terminal. The
   two states are now distinct: `INFRASTRUCTURE_FAILURE` (the registered
   retry budget was spent) is terminal and excluded with its log;
   `FAILED_LAUNCH` (the circuit breaker fired before anything was attempted
   scientifically) is a permanent, append-only record that is explicitly
   retryable.
4. **The registration gate checked only the model.** A filled model with
   unfilled seeds would have derived a bogus pair/arm order. All three
   values must now be non-empty and non-placeholder.
5. **`attempt` conflated two things.** The verdict line now carries
   `driver_pass` (which sweep invocation) and `execution_attempt` (which try
   within it) as separate fields. A driver pass is counted only after the
   shared preflight passes, so a sweep that attempted nothing does not
   inflate the number.
6. **The circuit breaker was too broad.** It is immediate on the runner's
   dedicated shared-infrastructure exit (rc=8). A `CLONE_FAILED` is treated
   as systemic only when the shared preflight is also failing at that moment;
   otherwise it is trajectory-local and takes the ordinary retry path.
7. **Checkpoint commits could fail silently** — staging, commit and push each
   report failure now; "nothing new to commit" is not reported as a failure.
8. **The self-test proved only that strings were present.** It is now
   behavioural: it drives a stubbed sweep to prove that a forced outage
   records exactly one launch, aborts, writes a retryable record and leaves
   every later trajectory untouched; that a resume re-attempts that same
   trajectory first and then completes the registered order; that a terminal
   failure stays excluded across a resume; and that upstream rotation is
   rediscovered at the boundary — inside the jail, where the platform's own
   direct route to the API does not exist.

The two test seams this requires (`TB_FRESH_UPSTREAM` in the runner,
`TB_HYGIENE_TEST` in the driver) are fail-closed: the runner refuses the
rotation seam whenever a registered model is pinned, and the driver's test
mode refuses to write anywhere but `/tmp` and supplies its own model and
seeds, so it cannot reach a counted results directory.

## Explicitly out of scope for 3.1 (reserved for round 4)

Fixing pytest skip detection; the trajectory-integrity schema cleanup
(final_integrity_state / task_outcome / trajectory_policy_violations, with
oracle-strength scoping preserved); the Python-monorepo-aware miner and
eligibility rules; a fresh FRAME5 pool; validation of the improved treatment
on genuinely held-out repositories.
