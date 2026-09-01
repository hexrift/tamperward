# PREDICTION3.1 — Taskbench round 3.1 registration

> **STATUS: NOT YET REGISTERED.** This document is OPEN. Every field marked
> `__SET_AT_REGISTRATION__` is filled in the registration commit, and *that
> commit is the freeze*. No counted round-3.1 trajectory may run before it.
> The sweep driver enforces this mechanically: `phase3-sweep31.sh` refuses to
> execute a single trajectory until the registered model and both seeds are
> non-placeholder.
>
> §1 below is frozen NOW, ahead of the rest, because it changes the
> experimental handling of missing verdicts relative to rounds 1–3 and was
> prompted by a real defect found before any round-3.1 outcome exists. Freezing
> it early, in git history, is the point.

## 1. Retry boundary — FROZEN (methodological, not implementation)

Rounds 1–3 registered one infrastructure rule for a trajectory that produced no
verdict: **one retry from a clean state; a second failure is recorded as
`INFRASTRUCTURE_FAILURE` and the sweep continues.** That rule was written for
failures during *setup* — clone, install, environment. Applied literally it also
covers failures *after the agent has run*, and there it is unsound: a
verdict-writing failure would discard an **observed** stochastic trajectory and
sample a fresh one in its place. The rule is therefore **scoped**, not replaced:

> **Retries belong to failed attempts to START an experiment, never to a
> stochastic experiment whose outcome has already been sampled.**

Operationally, the runner writes a durable trajectory-start marker immediately
before the agent is invoked, and that marker is the boundary:

| | before the marker | after the marker |
|---|---|---|
| what happened | no stochastic trajectory began | a trajectory ran; its outcome exists |
| on no verdict | the prespecified **one retry from a clean state** applies | **no retry, ever** — not on this pass, not on any resume |
| second failure | `INFRASTRUCTURE_FAILURE`, terminal, sweep continues | `POST_START_FINALIZATION_FAILURE`; artifacts preserved; sweep **halts** |
| resolution | excluded with its log | human adjudication, below |

A `POST_START_FINALIZATION_FAILURE` is an append-only **event**, never a final
disposition. It is resolved into exactly one of two **dispositions**, recorded
once, by `runner/adjudicate31.sh`:

```
POST_START_FINALIZATION_FAILURE
              |
       human adjudication
        /               \
POST_START_ADJUDICATED_  POST_START_ADJUDICATED_
      VERDICT                  EXCLUSION
 reconstructed from        terminally absent
 the preserved artifacts   from the analysis
 and counted ONCE
```

### The adjudication ladder — FROZEN

Which of the two dispositions applies is **a fact about which artifacts
survived, never a choice about the outcome**. This matters concretely: the
analyzer drops any repository lacking both arms, so an exclusion removes the
whole PAIR from the McNemar comparison. A discretionary post-outcome exclusion
would therefore be a researcher degree of freedom capable of moving the single
p-value in the study. The ladder is evaluated top-down by
`runner/adjudicate31.sh`, which refuses any manual disposition that disagrees
with it:

| rule | condition | disposition |
|---|---|---|
| **R1** | the runner's own verdict line survived in the preserved workspace | **reconstruct** — append it verbatim; nothing is recomputed, it is the verdict that trajectory already earned |
| **R2** | no verdict line, but the workspace survived with the final repository tree, the task venv, the oracle and the recorded base | **reconstruct** — re-derive with the same `verdict3.mjs` oracle over those artifacts, at that base |
| **R3** | neither of the above | **exclude** — the only sanctioned exclusion |

R1 means a **complete** verdict record survived, not merely a non-empty file: an
outer-timeout kill can leave a torn `verdict-line.json`, and that falls through
to R2 rather than dead-ending the ladder.

`adjudicate31.sh` has no way to substitute a verdict. `auto` derives and
persists; `ladder` only reports which rule applies; `verdict <file>` **verifies**
a supplied record against what the ladder derives and refuses anything that
differs, so an operator cannot supply a structurally valid record for the same
trajectory carrying a different outcome. A verdict is determined by the
trajectory, never chosen after seeing it.

R3 is reached only for the enumerated unrecoverable conditions: no preserved
verdict line **and** (no final repository tree, or no task venv, or no oracle,
or no recorded base). Reconstruction is a deterministic re-derivation from the
trajectory's own artifacts; it is never a re-run, and never a judgement about
what the agent "would have" done.

Every disposition is recorded structurally: the rule that produced it, a
reason, the adjudicator's identity, a UTC timestamp, and the sha256 of the
start marker, the preserved repository tree and the resulting verdict. Any
exclusion reached under R3 is reported in the results as attrition.

Both dispositions are counted in the completion ledger, which requires all 34
registered trajectories to be accounted for exactly once — as a verdict
(including a reconstructed one) or as a terminal disposition. Attrition remains
a result, never a knob.

## 2. Treatment, pool, model, seeds — SET AT REGISTRATION

| field | value |
|---|---|
| pool | the frozen round-3 17-task pool, verbatim, no subset or substitution |
| treatment | Tamperward v1.14.0, byte-identical to round 3 |
| model | `__SET_AT_REGISTRATION__` |
| pair-order seed | `__SET_AT_REGISTRATION__` |
| arm-order seed | `__SET_AT_REGISTRATION__` |
| agent budget | 3000 s, arm-neutral |
| prompt | round-3 pressure prompt, hash-pinned: `__SET_AT_REGISTRATION__` |
| runner hash | `__SET_AT_REGISTRATION__` |
| driver hash | `__SET_AT_REGISTRATION__` |

## 3. Endpoints, bets and losing conditions — SET AT REGISTRATION

`__SET_AT_REGISTRATION__` — the numeric bets and the conditions that would count
as Tamperward losing are written in the registration commit, before trajectory
#1, exactly as in rounds 1–3.

## 4. Analysis — SET AT REGISTRATION

`__SET_AT_REGISTRATION__` — the frozen analyzer and its sha256.
