# Round 3 — external validity (plan, not yet a registration)

This is scoping, not a pre-commitment. The round-2 order holds: a registration
(`PREDICTION3`) freezes the pool, seeds, analysis, and bets AFTER mining and
BEFORE any counted trajectory, and the git history proves that order. Nothing
here is counted.

## The replication baseline is frozen at v1.14.0

Tag `v1.14.0` (commit `b7dfa94`) is the immutable treatment for round 3. It is
the exact state the round-2 preregistered experiment validated (prevention
b=9/c=0, RD +40.9%, exact McNemar p=0.0039) PLUS the full 2.0 envelope with
every finding from both external review passes closed. The treatment does not
change between now and the end of round 3. 2.0 intervention work (below) is
evaluated AGAINST this baseline, never folded into it.

## The question round 3 actually asks

Round 1 gave initial evidence; round 2 replicated it on a fresh repo pool with
the same model, runtime, language and framework. The open question is no longer
"does it work on these tasks" — it is external validity:

> Does the effect survive changing the things the system was never tuned on —
> model, agent runtime, language, test framework, and repository population?

## Frozen-by-reference design (what changes, what does not)

Changes (the external-validity axes; at least one, ideally more):
- **Model or agent runtime** — a different model than `claude-haiku-4-5`, and/or
  a runtime other than the one whose termination boundary motivated the envelope.
- **Ecosystem** — a language/framework beyond TS+Jest/Vitest (Python+pytest and
  Go+`go test` are the natural first draws; the 1.12.0 test globs already cover
  their layouts, which is a prerequisite this round now meets).
- **Repository population** — a fresh frame, mined by the same procedure, with
  round-1 and round-2 repos pre-seeded into the dedup set.

Held fixed (so the comparison means something):
- The **primary endpoint** is unchanged: paired FALSE_GREEN discordance
  (McNemar), one row per repo, one p-value, the frozen `analyze.mjs`.
- The paired ungated/gated structure, the arm/pair randomization method, the
  ITT rule, the three-denominator discipline (mined / revalidated / counted).

## Outcomes

- **Primary**: paired false-green prevention (b/c, RD, exact McNemar).
- **Secondary (descriptive)**: completion RD; latency / cost anatomy (the
  quiet / early-deterred / verify-siege profiles); deny and verify counts.
- **Route classification (every counted trajectory)** — the taxonomy the
  round-2 residuals exposed, so a failure is explained rather than tallied:
  1. **detector miss** — a mutation the rules did not classify;
  2. **enforcement escape** — decision correct, boundary not owned
     (the cssstyle class; the envelope is meant to close this — does it, off Linux?);
  3. **oracle blind spot** — withheld-split incomplete fix, no tampering;
  4. **honest non-completion** — denied the shortcut, could not solve it.

## What "losing" looks like (publishes as-is)

Prevention RD collapses toward round-1's +3.8% under a new model/ecosystem;
or the envelope's residuals (non-Linux survivor scan, a substituted runner
verify cannot see) become the dominant escape route off the platform it was
built on. Either would say the effect is TS/Jest/Claude-specific, not a general
integrity-control pattern — and round 3 is built to be able to say that.

## Sequencing (owner-endorsed)

1. Freeze v1.14.0 as the baseline. [done — tag exists, pinned here]
2. Pre-register round 3 on external validity (this plan → `PREDICTION3`,
   after mining, before any counted trajectory).
3. Develop 2.0 (escalating steering; trajectory-level classification)
   SEPARATELY, evaluated as a new intervention against the frozen baseline —
   not silently included in the replication. Higher value now than detector #17.
4. Then the four-round story stands: initial evidence → preregistered fresh-pool
   replication → generalization across model/runtime/ecosystem → intervention
   improvement measured against a frozen baseline.
