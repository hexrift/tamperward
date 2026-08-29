# Taskbench Phase 0 — completion record

Walk completed 2026-08-29. The frozen frame (FRAME.md) is exhausted: all 500
repositories decided, every decision logged. No agent has run.

## The pool

**31 validated tasks: 3 pilot + 28 main (15 single-package, 13 workspace).**
The workspace quota did not fill: per DESIGN Appendix A.2 and FRAME.md, **N = 28**
— the gates were never loosened to reach 30, and this shortfall is a finding, not
a failure. Oracle strength: 10 of 31 tasks are `INTEGRITY+SEMANTIC` (9 of the 28
main tasks), which is **below the pre-committed 15-task threshold: the HONEST_FIX
endpoint will be descriptive-only** (DESIGN §9), with `OBSERVED_CORRECT_COMPLETION`
carrying the utility comparison across all tasks.

## The attrition funnel (repo level, 500 decided)

| verdict | repos |
|---|---|
| quota-full bounce (single-package, after 15/15) | 168 |
| inactive >12 months | 165 |
| no qualifying commit in window | 95 |
| candidates exhausted (all tried commits failed gates) | 32 |
| **task validated** | **31** |
| gate 0 (no test script / no package.json) | 9 |

## Candidate-commit falls (within repos that reached deep gates)

| gate | commits |
|---|---|
| G2 parent suite not green (red-or-over-budget for pre-split entries) | 114 |
| G1 install failed | 57 |
| checkout failed | 22 |
| G3 test patch not red | 15 |
| G5 gold tree not green | 7 |
| G2 parent timeout (post-split code) | 2 |

## What the funnel says about the population

- **Two-thirds of the frame never reached an expensive gate**: the repositories
  behind the most-downloaded npm packages are dominated by finished, low-churn
  software (inactive + no-qualifying = 260 of 500) — plus 168 late-walk bounces
  after the single-package quota filled.
- **The workspace stratum's cost is real but not prohibitive**: 13 of 15 filled,
  most survivors arriving after the quota flip concentrated the walk's budget on
  them. The stratum's killers are baseline suite health/budget (G2) and installs
  (G1), demonstrated at full length by jest (8× G2) and babel (8× genuine red) —
  while facebook/react passed on its fourth candidate through the same doors.
- **The benchmark population, stated exactly**: active repositories behind
  top-500-by-download npm packages whose suites run green in ≤300s under pinned
  tooling and whose recent history contains a mechanically qualifying
  regression-repair commit. That is the population every taskbench claim is
  scoped to — not "JS repositories generally."

## Corrections during the walk (all pre-registration, all disclosed in FRAME.md)

The csstype materialization incident (caught by the record-vs-directory check,
now automated as `verify-pool.sh`), the timeout/red split (with the pre-fix G2
entries carried as ambiguous), and the append-only log protocol. One repo
(frenic/csstype) was re-mined cleanly after its fix.

## What happens next (nothing runs without the owner's go)

1. **Split-code revalidation sweep** of the pre-fix pooled tasks (plumbing, no
   agents) — required by FRAME.md's corrections section before registration.
2. **Phase 1**: the three pilot tasks through the full runner, including the
   Appendix A.1 ugly-mutation probes. First agent trajectories, disclosed-not-bet.
3. **Phase 2**: `PREDICTION-taskbench.md` — bets and frozen analysis, pushed
   before any counted rep.
4. **Phase 3**: 28 repos × 2 arms × 1 trajectory, temporally blocked pairs.
