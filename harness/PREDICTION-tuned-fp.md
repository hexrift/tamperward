# Pre-registration — the tuned-gate FP study (and the per-rule `exclude` feature)

Written 2026-08-29, before any tuned sweep ran.

## Why this exists

The baselines study published the gate's honest commit-layer number: **9.0% block-fires
on 1,227 legitimate merged commits, unconfigured** — with the promise that "a tuned
policy would fire less, but that number doesn't exist yet." This study makes it exist.

It also forces a build. The single largest fire source is `ts-any-cast` (56 of 111
fire-commits' rule hits), and the adjudicated zod FP study already named the fix:
*"scope the narrow `as any` block to non-test source."* That tuning is **not
expressible** in the current policy schema — `RuleConfig` is `{severity, enabled}`,
and the global `ignore` list would blind the *test-protection* rules on exactly the
files they exist for. Demand for per-rule path scoping is now measured twice (the
zod adjudication, today's corpus), which is the house bar for building it: `exclude`
globs per rule, shipping as 1.6.0.

The symmetry obligation ships with it, per the whole-class lesson: a per-rule
`exclude` is a brand-new policy-weakening surface, so `hook-tampering`'s policy-diff
detection must flag **added exclude globs** exactly as it flags added ignore globs —
otherwise this feature is a fresh invisible spelling of "switch the gate off."

## Disclosed before betting

The baseline by-rule totals are already published (ts-any-cast 56, lint-suppression
34, test-deletion 25, test-skip 23, ci-tampering 4, hook-tampering 2 across 111
firing commits). Per-commit rule overlap and the test-vs-src split of the ts-any
fires are NOT yet known; the bets ride on those unknowns.

## Design (deterministic; no agent runs)

Same 1,227 commits (immer 828, docusaurus 399). Because `check --diff` governs by
merge-base policy (trusted-base, by design — a historical clone's base has no
policy), the tuned sweeps drive the **engine directly**: build each consecutive-commit
diff, call `evaluate()` with the injected policy, count block-severity findings.
Three configs per repo, written down here before running:

1. **baseline** — default policy (must reproduce ~the published 111/1,227; sanity
   gate for the new sweep path).
2. **expressible tune** (today's schema): `ts-any-cast: { severity: warn }` — the
   only way a type-heavy library can currently stop the biggest block source, at the
   cost of demoting it everywhere.
3. **scoped tune** (the new feature): `ts-any-cast: { severity: block, exclude:
   ['**/*.{test,spec}.*', '**/*.test-d.ts', '**/tests/**', '**/__tests__/**'] }` —
   the adjudication's actual recommendation: casts stay blocked in application
   source, test/type-test files are the rule's blind spot, and every other rule
   keeps full coverage everywhere.

| # | bet | reasoning |
|---|---|---|
| tf-1 | the expressible tune leaves the pooled block-rate **above 4%** | demoting one rule can't fix a tax spread across five; the schema gap is material |
| tf-2 | the scoped tune lands pooled **<= 6%** AND at least one src-side ts-any-cast block-fire survives | the zod adjudication found the fires cluster in test/type-test files; scoping removes most of the tax while retaining the src protection a severity demotion throws away |
| tf-3 | after the scoped tune, **test-deletion + test-skip form the majority** of residual firing commits | what remains should be the sign-off-shaped rules — legitimately deleted/skipped obsolete tests are precisely what the one-label human flow exists for |

## Decision rules (pre-committed)

- The published deployed-cost framing becomes three numbers, not one: unconfigured
  (9.0%), expressibly-tuned, and scoped-tuned — plus "residual fires as sign-off
  decisions per N commits." The README carries all of them.
- tf-2's src-clause failing (zero src ts-any fires remain) would mean the scoped rule
  protected nothing in this corpus — reported as scoping the feature's value claim,
  not hidden.
- If the baseline config fails to reproduce ~111 firing commits, the engine-direct
  sweep path is broken and NOTHING publishes until the discrepancy is explained
  (the sweep-matcher lesson from this morning).

---

## Outcome (2026-08-29)

Sanity gate first: the initial engine-direct sweep failed it — baseline read 169
pooled against the published 111 — and per the pre-committed rule nothing published.
The discrepancy was the sweep's own diff construction (no rename detection, no blob
enrichment); rebuilt on the CLI's `diffRange`, the baseline reproduces **exactly**
(immer 88, docusaurus 23). Only then were the tuned configs read.

| config | immer (828) | docusaurus (399) | pooled | rate |
|---|---|---|---|---|
| baseline (default policy) | 88 | 23 | **111** | 9.0% |
| expressible tune (`ts-any-cast: warn`) | 57 | 17 | **74** | **6.0%** |
| scoped tune (exclude test paths, still block) | 88 | 23 | **111** | 9.0% |

**tf-1 HELD** (6.0% > 4%): one severity line helps but can't fix a tax spread across
five rules. **tf-2 REFUTED — and the refutation is the study's headline, at my own
feature's expense.** The scoped tune changed *nothing* on either repo: these corpora's
`as any` casts live overwhelmingly in library and application source (immer: 49 of 88
firing commits carry src-side cast fires even under scoping; docusaurus: 7 of 23),
so the test-path blind spot the zod adjudication recommended removes fires these
repos mostly don't have. The zod clustering did not generalize; immer-shaped repos
are the *lib-plumbing* FP category, which no path scoping can express. The feature I
built this morning on twice-measured demand measured **zero effect on the corpus it
was measured against, the day it shipped.** It ships anyway — the invariants are
sound, zod-shaped repos exist in the adjudicated record, and fixtures-style uses
remain — but its value claim now carries this null, published next to the bet.
(tf-2's src-clause held: the scoped rule retained real src-side protection — there
was just nothing for the scoping to remove.) **tf-3 REFUTED** by the finding-level
measure: residual scoped-config block findings pool to lint-suppression 177,
ts-any-cast 126, test-skip 66, test-deletion 51, ci-tampering 15, hook-tampering 2 —
the test rules are ~27%, not the majority; suppressions and casts are.

The deployed-cost trio the decision rule promised: **9.0% unconfigured → 6.0% with a
one-line severity tune → roughly one sign-off decision per 17 commits residual.**
The honest generalization: commit-layer FP tuning is repo-shaped — severity choices
help everywhere, path scoping helps only where the fires actually cluster in
scopeable paths, and the adjudication that recommends a tune must come from the
repo class it's applied to.

Ledger after these three bets (1 held, 2 refuted): **56 bets — 25 refuted, 29 held,
2 unresolvable.**
