# Taskbench Phase 0 — completion record

Walk completed 2026-08-29. The frozen frame (FRAME.md) is exhausted: all 500
repositories decided, every decision logged. No agent has run.

## The denominators, unambiguously (final, post-revalidation)

```
Eligible frozen frame:            500 repositories
Repos walked (decided):           500 (frame exhausted)
Mined artifacts:                  31
Independently revalidated:        30 (v3 from-scratch proof; see below)
Excluded:                         1  (10-npm-node-semver — suite consults the
                                      git remote via template-oss lint, which is
                                      absent by design in the frozen synthetic
                                      materialization; deterministic GOLD_RED
                                      across run 2 + clean-state retry; frozen
                                      retry spent; evidence in
                                      tasks-excluded/.../gold-failure-output.txt)
Pilot tasks:                      3   (first 3 validated in walk order)
Main counted tasks:               27
  Single-package stratum:         14  (15 mined − semver)
  Workspace stratum:              13
Effective INTEGRITY+SEMANTIC:     7 of 30 (6 of the 27 main) — three mined
                                  semantic tasks downgraded by revalidation
                                  (split-withheld-the-red ×1, gold-red-under-
                                  split ×2), recorded per-manifest with reasons
Effective INTEGRITY:              23 of 30
Final planned Phase-3 N:          27  (27 repos × 2 arms × 1 trajectory)
HONEST_FIX endpoint:              descriptive-only (semantic subset < 15,
                                  per the pre-committed DESIGN §9 rule)
```

## Revalidation (the from-scratch proof, run after mining)

Every artifact re-proved itself with nothing trusted from mining: manifest
hashes → clean materialization → **round-trip invariant** (parent + test.patch
+ gold.patch must `write-tree` to exactly the historical commit tree) → install
→ true-red → gold-on-visible green → semantic-oracle behavior. Results:
**30 of 31 clean; 1 excluded** (above). Four laboratory defects were found and
fixed as permanent invariants before any agent ran — a generator
representation bug (binary-stub patches; `--binary --full-index` now default,
task 14's artifact regenerated from the same frozen SHAs and tree-proven), a
validation-stage contamination bug (suite runs mutate trees; restore-before-
gold now everywhere, including the runner), the §8 split fallbacks
(NOT_RED-under-split), and the round-trip gate itself. Run 1 was disk-
contaminated and is preserved as revalidation-run1-diskcontaminated.jsonl;
run 2 + the five-task re-judge are the record. No task was swapped, no
selection rule changed, no prompt or endpoint touched, and zero agent
trajectories existed throughout.

## The pool (mining-time numbers; the denominator block above is the final word)

Mining produced **31 artifacts: 3 pilot + 28 main (15 single-package, 13
workspace)** — the workspace quota did not fill (frame exhausted at 13/15; per
DESIGN Appendix A.2 the gates were never loosened, and the shortfall is a
finding, not a failure). Revalidation then excluded one task and downgraded
three oracle strengths, giving the final counted pool above: **N = 27**, with
`OBSERVED_CORRECT_COMPLETION` carrying the utility comparison across all tasks
and HONEST_FIX descriptive-only.

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
