# Before we test Tamperward on 27 real repositories, here's what we think will happen

*August 29, 2026 · hexrift*

*Short answer: we don't know yet, and that's the point of this post. A benchmark
of 27 historically real regression tasks is mined, validated, and frozen. The
analysis script is frozen. The randomization seeds are published. Six numeric
bets are on the record, including the three results that would count as
Tamperward losing. Not one counted trajectory has run. This post is the
preregistration; the next one is the answer, whatever it is.*

This is the eleventh post in a series
([1](./what-agents-do-when-you-block-their-shortcuts.md) ·
[2](./what-agents-do-when-nothing-is-watching.md) ·
[3](./what-agents-do-when-the-fix-does-not-exist.md) ·
[4](./what-agents-do-when-it-does-not-look-like-a-test.md) ·
[5](./what-agents-do-when-the-bug-is-not-theirs.md) ·
[6](./what-agents-do-when-no-one-can-say-no.md) ·
[7](./what-agents-do-when-you-just-ask-nicely.md) ·
[8](./what-agents-do-when-you-give-the-cheat-a-name.md) ·
[9](./137-runs-were-not-137-experiments.md) ·
[10](./what-agents-do-when-the-tests-are-read-only.md)), and it is deliberately
different from the ten before it: it contains no results. It exists so that when
the results post arrives, the git history proves the methodology, the endpoints,
the analysis, and the predictions all came first.

## 1. The problem, restated once

AI agents write code. The same agents can usually edit the tests, configs, and
CI that judge that code. When a pressured agent makes a failing suite green,
"green" is ambiguous between *the code got fixed* and *the check got weakened* —
and the second one is cheaper. That ambiguity is a verification-integrity
problem, and it is separate from correctness: a fix can be genuinely right while
the agent also deleted an inconvenient assertion along the way, and a
clean-looking tree can hide a suite that no longer tests what it used to.

## 2. Why the first ten posts weren't enough

The seed studies behind this series produced a number we've been careful with
since post nine: 137 blocked bypass attempts. An external review made the
sharpest version of the objection, and we agreed with it in writing:

- **137 runs were not 137 independent experiments.** Behind the run counts sit
  roughly fifteen seed configurations across eight repositories, authored by the
  same people who wrote the detector.
- **The seeds are synthetic.** Planted bugs, planted pressure, trees we
  constructed.
- **Known bypass classes are uncovered.** Type laundering was the headline gap;
  the pilot below found two more.
- **Transfer is unknown.** Nothing in the seed studies says how often any of
  this happens on an ordinary repository with a real historical bug.

Every study in posts one through ten shares those boundaries. Taskbench exists
to cross them: real repositories, real historical regressions, a sampling frame
frozen before mining, and an evaluation architecture in which the tool under
test holds no privileged position.

## 3. How Taskbench was built

The full design (`harness/taskbench/DESIGN.md`, frozen at v3.1 after four
external review rounds) and the frame procedure (`FRAME.md`) are in the repo;
the short version:

- **A frozen frame of ~500 npm-ecosystem repositories**, snapshotted from a
  published high-impact package list, deduplicated to one repo per monorepo,
  walked in a keyed-hash randomized order from a published seed. Every
  accept/reject decision is a logged, append-only funnel.
- **Tasks are real commits, mechanically selected.** A qualifying commit
  touches at least one protected test file and at least one source file; the
  parent tree plus *only the commit's test changes* must fail; plus the full
  diff must pass. No human judgment of "is this really a bug fix" anywhere.
- **The agent gets the parent tree plus the test patch — never the gold
  source patch**, which lives outside the environment as a validity artifact.
  Materialization is a fresh `git init` with a single synthetic commit: no
  history, no remotes, no oracle material in the container.
- **An exact round-trip proof per task:** parent tree + test patch + gold
  patch must reproduce the historical commit's tree hash, byte for byte, via
  `git write-tree`. All 30 surviving tasks pass it exactly.
- **Three independent oracle layers.** A task-validity oracle (red before,
  green after, deterministic — settled before any agent exists), a policy
  oracle (did the trajectory weaken a protected check), and a run-correctness
  oracle (the pristine original suite re-run against the agent's source, plus
  withheld test cases where the task supports them). They share no failure
  surface with each other or with the gate.
- **A neutral policy spec.** The invariants live in `policy.yml`, owned by the
  benchmark. Tamperward's adapter and the policy oracle both *read* it;
  neither defines it. The design requirement is explicit: taskbench must be
  capable of producing a result in which Tamperward loses.

The funnel: **500 repositories walked → 31 tasks mined → 30 survived
revalidation → 3 spent on the pilot + 27 counted.** The attrition itself
publishes as a finding about how often real repositories admit this task
construction.

## 4. What Phase 0 found — and why the benchmark got stricter

Validation was not ceremony. Re-running every task from its committed artifacts
in a clean environment found four real problems, and each one became a
permanent invariant rather than a waved hand:

- **A binary-patch defect in the task generator.** Patches produced without
  `--binary` silently reduced binary fixtures to stubs; the round-trip tree
  proof caught the mismatch, the generator was fixed, and the affected task's
  artifacts were regenerated to an exact tree match.
- **A contaminated validation state.** The first revalidation run exhausted
  the disk mid-sweep and left one task's check compromised; the contaminated
  evidence was preserved, the run redesigned with an in-place revert protocol
  and a disk guard, and everything re-verified from scratch.
- **A semantic split that deleted the visible regression.** For withheld-case
  tasks, splitting the new tests sometimes left the *visible* half green on
  the buggy tree — invisible failure. Now every split is validated
  (visible-red on parent, all-green on gold) with an unsplit fallback, and
  three tasks carry an honest downgrade of their oracle strength in their
  manifests instead of a quiet pass.
- **One exclusion with evidence.** One repository's gold state fails its own
  lint under synthetic materialization (the linter derives a field from the
  git remote that a history-free clone doesn't have). It is excluded, with
  the failing output committed, and the denominators say so: mined,
  revalidated, and counted are three different numbers and are never blurred.

A pool-invariant checker (`verify-pool.sh`) now enforces all of it — artifact
hashes, round-trip proofs at current hashes, funnel bijection, quota sanity —
before any checkpoint commit.

## 5. What the pilot taught us

Three of the 30 tasks were spent on a pilot: six trajectories, both arms, the
same pressured Haiku the main sweep will use. **The pilot exercised the
measurement system — including cases of test weakening, incorrect clean-looking
fixes, and honest fixes — but none of those trajectories enter the
experiment.** They are instrumentation examples, not evidence, and we bet
nothing on them. What they demonstrate is that the verdict taxonomy separates
things that must not be conflated:

- **A false green via assertion removal.** Visible suite green, pristine suite
  red, a surviving weakening edit in a protected spec. The classic case.
- **A false green with no tampering at all.** The agent fixed only what the
  visible tests exercised; the withheld cases caught the incomplete fix.
  Same headline outcome, entirely different mechanism — which is why the
  verdict record carries the violation evidence separately.
- **A correct implementation *plus* a verification violation.** A genuinely
  right source fix (pristine suite green) in a trajectory that also weakened
  a protected test. Correctness and verification integrity are separate
  dimensions, and this outcome class is why the cost endpoint and the
  prevention endpoint are different rows in the analysis.
- **An ordinary honest fix.** Green everywhere, protected tree untouched.

The pilot also did its actual job — it broke things. A mid-run edit to the
runner corrupted one trajectory (rerun cleanly, incident logged, rule adopted:
never edit a script with a live invocation); netlog and deny-log preservation,
timestamps, and a gate-liveness probe were added; and the network audit found
that every denied egress attempt in every preserved log was ambient tool
telemetry, not agent-initiated retrieval — so Phase 3 tabulates attempts by
host. All of it is in `PILOT.md`, plumbing fixes only.

## 6. What Tamperward does — and doesn't

The treatment under test is deterministic verification-integrity enforcement:
a hook layer that inspects each proposed tool call and denies edits that weaken
protected tests, configs, or CI. It is **not a correctness oracle** — it has no
opinion on whether the code is right, only on whether the checks that would
judge the code are being degraded.

Two detector-coverage gaps surfaced during the pilot: partial test-content
removal through the editor tool path, and deletion of rows from a data-driven
test table (which evades line-class heuristics but not the pristine-suite
oracle). **Both remain deliberately unfixed.** The treatment froze at
Tamperward 1.6.0 before Phase 0; patching it to cover behavior first observed
in the experiment's own pilot would invalidate the experiment. The gaps are
documented boundaries, and if they cost Tamperward the result, that publishes.

## 7. The preregistered experiment

Everything below was committed and pushed (`PREDICTION-taskbench.md`) before
any counted trajectory:

- **27 repositories × 2 arms × 1 trajectory = 54 counted runs.** Arms:
  ungated (no hooks) and gated (the full loop layer). One task per repo; the
  repo is the experimental unit.
- **Model pinned exactly:** `claude-haiku-4-5-20251001`, the same pressure
  prompt as every seed study, verbatim, pinned by hash.
- **Paired and randomized:** both arms of a repo run consecutively (temporal
  blocking), arm order drawn 1:1 per repo from a published seed, pair order
  from a second published seed. Anyone can re-derive both tables.
- **Intention-to-treat:** every run counts; network events are flags, not
  exclusions.
- **One formal p-value in the entire study** — exact McNemar on discordant
  pairs for the single prevention hypothesis. Everything else is estimation:
  Wilson intervals, Bonett–Price paired risk differences, one row per repo,
  no pooled-run headlines.
- **The analysis is a frozen script** (`analyze.mjs`, hash in the
  registration). The results post will report its output, not a narrative
  re-derivation.

## 8. The bets

On the record now, so they can be scored later. Point predictions with ~90%
credence bands; they are bets, not evidence.

- **B1 — Transfer.** Ungated repos with at least one observed policy
  violation: **16/27 (~59%)**, band 40–78%. This is the headline unknown: does
  pressured test-tampering exist outside synthetic seeds at all?
- **B2 — Prevention** (the one hypothesis test). False-green discordant
  pairs roughly **8 ungated-only vs 2 gated-only**; paired risk difference
  **≈ +22 points** in the gate's favor, band +4 to +40. Credence the exact
  test rejects at α=0.05: **~0.6** — a moderate real effect may still
  publish as honestly inconclusive at N=27, and we accepted that in writing
  before mining began.
- **B3 — Cost.** Verified-completion risk difference (gated − ungated)
  **≈ +7 points**, band −10 to +25 — we think the gate redirects more
  trajectories into real fixes than it stalls into surrender, and the band
  deliberately spans the opposite.
- **B4 — Stronger completion.** The semantic-oracle subset is 6 tasks, under
  our own pre-committed threshold of 15, so HONEST_FIX reports as
  descriptive only. No bet, no claim.
- **B5 — Adaptation.** After a denial, the modal immediate response is an
  alternative mutation attempt (a mechanism shift), not surrender — and at
  least half of denied trajectories still end attempting a genuine source
  fix.
- **B6 — Network.** Zero successful forbidden retrievals in 54 runs, and at
  least 95% of denied attempts attributable to ambient tool telemetry.

**And the losing conditions, pre-stated:** prevention RD ≤ 0, or completion
RD ≤ −15 points, or transfer under 30%. Any of those publishes as-is — the
first as "the gate doesn't prevent," the second as "the gate costs too much,"
the third as "the phenomenon the seed studies measured barely transfers, and
their operational importance is scoped accordingly."

## 9. What happens next

We haven't run trajectory #1 yet. The registration, the pool, the seeds, and
this post are all committed before it. The next post will contain the results
of all 54 trajectories, reported by the frozen script, whether they support
Tamperward or not.

The git history can prove that sentence. That's why this post exists.
