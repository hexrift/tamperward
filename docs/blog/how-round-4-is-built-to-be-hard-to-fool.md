# How round 4 is built to be hard to fool (before any counted trajectory runs)

*September 6, 2026 · hexrift*

> *Series-wide caveats — sampling unit, historical controls, training
> contamination, model pinning, what the registration order proves, and what the
> verification layers cannot guarantee — are collected on the
> [limitations page](./limitations.md). Published corrections are on the
> [errata page](./errata.md).*

*Short answer: this post has no results, on purpose. Round 4 tests the hardened
Tamperward envelope on a fresh pool of real Python regressions, and the whole
round is built so that the eventual number is hard to fake in either direction —
including by us. This is the methodology: the frozen treatment, the burned
pools, the paired arms, the jail that is not the product, the pristine
adjudication, and the one distinction that turned out to matter most — a suite
that could not run is not a test that failed. The design is frozen; this post
explains it.*

This is a design post, not a result post. It exists so that when a round-4
numbers post arrives, the repository already records what was committed to
beforehand — the treatment, the pool, the endpoints, the randomization, and the
rules for what a result is allowed to change.

## 1. The problem, restated once

An AI agent writes code, and the same agent can usually edit the tests, configs
and CI that judge that code. When a pressured agent turns a failing suite green,
"green" is ambiguous between *the code got fixed* and *the check got weakened* —
and weakening is cheaper. Tamperward is a gate that tries to make the second one
hard: it refuses edits that delete tests, weaken assertions, or narrow what the
runner collects, unless a human signs off out of band. The research question is
narrow and empirical: **does the gate change what agents actually get away with,
on real regressions, measured without fooling ourselves?**

## 2. A frozen treatment and a frozen binding set

The thing under test is a specific release — round 4's candidate is `2.10.3` —
pinned not by a version string but by the SHA-256 of its packed artefact tree.
"The treatment" is that hash, deployed read-only, plus the exact wiring the gate
installs.

But the treatment is not the only thing that has to be fixed. The *measurement*
apparatus — the runner, the isolation jail, the observer, the neutral
adjudicator, the file that decides what a suite's exit status means — shapes the
outcome as directly as the gate does. So round 4 freezes a **binding set**: a
named list of files whose hash is pinned in the manifest, alongside the
treatment. Changing any of them changes what the round measures, and the freeze
check refuses to let a counted trajectory run against a tree that no longer
matches. Registration here is not a document you write; it is a derivation you
can re-run, and a check that fails loudly on drift.

## 3. Fresh pools, and why every repository is burned

The tasks are real: historically genuine regressions mined from public Python
repositories, each one a commit where a test that was failing became passing.
A task is only admitted if, from a clean clone, its parent is green, the added
test alone is red, and the fix makes it green again — checked independently, from
fresh clones, before anything is frozen.

The pools are **fresh and disposable**. The moment the pilot draws a repository,
that repository becomes development data — we may look at it, tune a release on
it, write about it — which is exactly why it can never be counted. So every
repository the pilot examines is *burned*: recorded in an exclusion set and
permanently removed from the frame the counted round will draw from. The counted
round mines from positions the pilot never touched. This costs yield — you burn
many repositories to bank a few tasks — but it buys the one thing a confirmatory
test cannot do without: a population the analysis has never seen.

## 4. Paired gated and ungated trajectories

The unit of evidence is a **pair**. Each task is run twice on the same frozen
model: once with the Tamperward gate live (gated) and once without it (ungated),
same task, same prompt, same jail, the arm order fixed by a published seed. The
agent is blind to its arm. Pairing is what lets the round ask the only question
that matters — *did the gate change the outcome on this task* — with each task as
its own control, rather than comparing two different samples of repositories.

## 5. The product is not the jail

Two different things are doing two different jobs, and conflating them is how
security research fools itself.

- **The product** is the Tamperward gate and its detectors — the thing a real
  user installs, the thing whose effect the round is trying to estimate.
- **The research jail** is everything the *experiment* needs and a user never
  sees: a network namespace that confines the agent's egress, a mount/PID jail
  that hides the oracle and the ledger from the agent, a neutral adjudicator that
  scores the outcome without trusting the treatment's own claim.

The jail exists so the measurement is trustworthy; the product exists to be
measured. When the jail's own credential isolation could not be made airtight in
this environment, that was recorded as a disclosed partial result of the
*harness*, not laundered into a claim about the product. The distinction is load
-bearing: a strong result about the product is only worth as much as the jail
that produced it, and the jail's limits are on the record.

## 6. Pristine adjudication: scoring the tree the agent left

The gate runs *in the loop*, at the agent's tool calls. But the score does not
trust the gate, and it does not trust the agent's own green. After the agent
stops, a **neutral adjudicator** takes the tree the agent left, restores the
protected verification surface (the test files, the suite config) to its
original state, and runs the suite over the agent's source. If the agent's
"green" survives an honest suite, it was a real fix. If it does not — if the
visible run is green but the pristine run is red — that is a **masked failure**:
the primary product-scoped outcome the whole round is built to catch. The
adjudicator is a separate component with its own isolation; it reads the agent's
result as untrusted input.

## 7. PASS, FAIL, and the third thing: INVALID_MEASUREMENT

This is the distinction round 4 had to get right, and getting it wrong would have
quietly corrupted the endpoint.

A test suite can end in more than two ways. It can pass. It can fail. Or it can
**not run** — a collection error, an interpreter that could not start, a process
killed by a timeout or the out-of-memory reaper, a plugin that tried to install
from the network mid-collection and could not. For a long time the harness
collapsed every non-zero exit into "red," so a suite that *could not be measured*
was scored as a suite that *failed* — and "visible green, pristine red" is a
masked failure. An execution failure could therefore manufacture the primary
endpoint.

Round 4 makes that impossible. One shared classifier is the single interpretation
of a suite's termination, used by the miner, the validator and the adjudicator
alike. It returns `PASS`, `FAIL`, or one of several non-measurement states, and
**only `PASS` and `FAIL` are admissible inputs to any outcome comparison.**
Everything else is `INVALID_MEASUREMENT`, carrying a `measured: false` flag that
excludes it from the denominator and from every masked-failure or false-green
tally, in both arms and in either position. A suite that did not run cannot become
evidence. This is proven end-to-end — every non-measurement exit, both arms, both
positions — and the rule is arm-symmetric, so an environmental failure can never
masquerade as a treatment effect in either direction.

## 8. Attrition is measured, not silently scored

The corollary of §7 is that a task or a trajectory that could not be measured is
**attrition**, not failure. When mining round 4's fresh ten, roughly forty
percent of the repositories examined attrited because their parent suite could
not run in the jail — heavy machine-learning suites, collection-time installs,
timeouts. That number is recorded, out in the open, as an operational
characteristic of the population; it is *not* folded into any success or failure
rate. It matters for planning the counted round's runtime and expected yield, and
it is honest precisely because the classifier stopped calling an unrunnable suite
an ordinary red.

## 9. The lifecycle: closed → between-iterations → frozen

The pilot is allowed to fail, and round 4's did. Its first candidate produced a
detector gap on a real trajectory, which forced a patched release — and once an
iteration closes on a result that changes the treatment, the registration must be
able to say so without lying about history. So the round models three explicit
states. A **closed** iteration keeps its own frozen pins forever, immutable, a
record of exactly what ran. **Between iterations**, no confirmatory object is
registered: development and mining are allowed, the tree is *expected* to drift
from the closed iteration, and trajectory execution is refused outright — a state
whose whole job is to stop "nothing is frozen" from being read as "anything may
run." A **frozen** iteration re-arms the strict binding assertion and pins the
current treatment and a fresh pool. The transition is one-way, and only an
explicit re-derivation moves the protocol back to runnable. When the second
iteration was frozen, the first iteration's manifest was archived unchanged
rather than overwritten, so the closed record and the newly armed one coexist
without either weakening the other.

## 10. Why the pilot may change the treatment and the counted round may not

This is the line the whole structure exists to hold. The **pilot is
exploratory**: it runs on burned, disclosed repositories, and it retains the
authority to force a new candidate release. A false positive or a detector gap
found in the pilot is a *fix*, and the fixed release becomes the new candidate
for another full pilot iteration. That is not p-hacking; it is exactly what a
sacrificial pilot is for, and every repository it spends is permanently excluded
from the counted frame.

The **counted round is confirmatory**: its treatment, pool, seeds, endpoints and
analysis are frozen before a single counted trajectory runs, and a counted result
*stands*. If the counted round finds against the product, that is the finding.
The pilot is where the design is allowed to learn; the counted round is where it
is not. Keeping those two on opposite sides of a hard, dated, hash-pinned line is
the reason a number from this round should be believed at all.

## What the counted round will estimate

The counted round is not yet frozen — that is a later, separate registration,
with its own committed sample size, endpoints, predictions and analysis script.
What it will estimate is a paired, product-scoped quantity: on the same tasks and
the same model, does the gate change the rate at which an agent produces a masked
failure or an envelope escape, gated versus ungated, over *admissible
measurements only*. This post commits to none of those numbers. It commits to the
shape of the thing that will produce them, and to the rule that the shape was
fixed first.

Not one counted trajectory has run. When one does, the manifest — not this post —
is the authority; this post only explains it.
