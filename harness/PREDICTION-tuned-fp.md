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

## Outcome — to be written AFTER the sweeps, dated, bets above left intact.
