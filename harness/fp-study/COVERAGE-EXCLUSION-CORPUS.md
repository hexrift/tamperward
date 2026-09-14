# coverage-exclusion — live-fire rate on legitimate mainlines

This record is the durable measurement behind the severity decision for the
`coverage-exclusion` rule introduced for #438: an inline coverage exclusion —
`/* istanbul ignore … */`, `/* c8 ignore … */`, `/* v8 ignore … */`,
`/* node:coverage ignore … */`, `# pragma: no cover`, `#[coverage(off)]`, or a
`//go:build` constraint added to an existing Go source file — added to a non-test
source file. It is the per-function form of the `coverage-lowering` class: the
config dial is row 6's; this is the comment that takes the hard branch out of the
denominator one function at a time.

## Question

Not "is an inline exclusion malicious" — it is also the ordinary way to mark a
genuinely unreachable branch — but *how often does legitimate maintainer work add
one?* That is the "would this rule wrongly stop real work" measure
([`ADJUDICATION-RULE.md`](./ADJUDICATION-RULE.md)), and it decides whether any block
severity is deployable.

## Method

[`coverage-exclusion-fires.mjs`](./coverage-exclusion-fires.mjs) replays the
candidate CLI's `check --diff base...head --json` over the last N adjacent
first-parent pairs ending at a pinned head and records each `coverage-exclusion`
finding. Only pairs whose diff adds a line carrying one of the rule's raw spellings
are handed to the CLI: the rule fires on nothing else, so the skipped pairs are
non-fires by construction and the count is exact. The harness fails closed on CLI
spawn/exit/JSON errors, the same discipline as
[`test-skip-ast-delta.mjs`](./test-skip-ast-delta.mjs).

The corpora and the pair frame are the ones the `ts-cast-growth` study used
([`CAST-GROWTH-CORPUS.md`](./CAST-GROWTH-CORPUS.md)): the same four real
repositories at the same pinned heads, the same 137/100/100/123 first-parent pairs,
so the two warn rules are measured on one denominator. Replayed locally on
2026-09-14 against the built CLI of the `fix/coverage-gates-438` head.

## Pinned corpus and measured fire rate

| repository | pinned head | first-parent pairs | pairs touching eligible source | pairs adding a spelling | pairs with a fire | findings |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| immer | `061c2425e1c9dff89e4e4189d42af1b7839dfe0a` | 137 | 43 | 0 | 0 | 0 |
| zustand | `b57db4f86ef179285da216eeb291266da82c361c` | 100 | 22 | 0 | 0 | 0 |
| zod | `ca0229a404818290e6cdcfefcd7eb2d04bcbb543` | 100 | 75 | 0 | 0 | 0 |
| hono | `8755b17fbcfdee76511eeb460e18e94e6c9a8d30` | 123 | 100 | 0 | 0 | 0 |
| **total** | — | **460** | **240** | **0** | **0** | **0** |

"Eligible source" here is any JS/TS, Python, Go or Rust file the pair touches — a
denominator wider than the rule's (it includes tests and generated paths the rule
skips), so a rate on it would favour the rule; it is reported for scale only.

Fire rate on legitimate mainline maintenance: **0 / 460 = 0.0%** of all pairs.

```json
{"repo":"immer","corpus_head":"061c2425e1c9dff89e4e4189d42af1b7839dfe0a","pairs":137,"pairs_touching_eligible_source":43,"pairs_with_candidate_line":0,"pairs_with_fire":0,"fire_rate_all_pairs":0,"fire_rate_eligible_pairs":0,"findings":0,"files_flagged":0}
{"repo":"zustand","corpus_head":"b57db4f86ef179285da216eeb291266da82c361c","pairs":100,"pairs_touching_eligible_source":22,"pairs_with_candidate_line":0,"pairs_with_fire":0,"fire_rate_all_pairs":0,"fire_rate_eligible_pairs":0,"findings":0,"files_flagged":0}
{"repo":"zod","corpus_head":"ca0229a404818290e6cdcfefcd7eb2d04bcbb543","pairs":100,"pairs_touching_eligible_source":75,"pairs_with_candidate_line":0,"pairs_with_fire":0,"fire_rate_all_pairs":0,"fire_rate_eligible_pairs":0,"findings":0,"files_flagged":0}
{"repo":"hono","corpus_head":"8755b17fbcfdee76511eeb460e18e94e6c9a8d30","pairs":123,"pairs_touching_eligible_source":100,"pairs_with_candidate_line":0,"pairs_with_fire":0,"fire_rate_all_pairs":0,"fire_rate_eligible_pairs":0,"findings":0,"files_flagged":0}
```

## The deeper frame: what the real fires are

A zero on 460 pairs says the spellings are rare in ordinary maintenance; it says
nothing about what a fire looks like when one happens. So the same four clones were
deepened by 3,000 commits each and every first-parent commit reachable — **6,632**
— was scanned for an added line carrying any of the spellings. Four commits add
one, all in immer, all `/* istanbul ignore next */` in non-test library source:

| commit | subject | files | added marker lines |
| --- | --- | --- | ---: |
| `1913fe8` | feat: rewrote Map and Set implementation, code base cleanup | `src/common.ts`, `src/immer.ts`, `src/map.ts`, `src/patches.ts`, `src/set.ts` | 14 |
| `9f4711a` | fix: Map and Set instantions won't work on certain environments, fixes #502 | `src/map.ts`, `src/set.ts` | 2 |
| `f930ce1` | feat: general typing improvements for TS 3.7 and up | `src/extends.ts` | 1 |
| `0d87fc8` | Merge pull request #536 from immerjs/multi-bundle | `src/core/immerClass.ts`, `src/plugins/mapset.ts`, `src/plugins/patches.ts`, `src/utils/env.ts` | 7 |

Every one is a maintainer marking an environment-dependent branch (`typeof Map`,
`Object.getOwnPropertyNames` fallbacks, a `__DEV__` ternary arm) that the test
environment cannot reach. None is a tamper. The rule fires on all four by design —
they are exactly its spelling in exactly its scope — so on the only real fires the
histories hold, precision as a *tamper* signal is **0 / 4**. That is the finding
that decides the severity: the class is rare enough to warn on every time, and
honest often enough that a block would train people to override.

The rate on the deeper frame, for scale: 4 / 6,632 = 0.06% of first-parent commits.

## Decision rule and outcome

The rule below is the one the `ts-cast-growth` study stated and applied; it was
chosen before the histories were scanned.

- **block** requires a fire rate on legitimate mainline maintenance at or below
  **1%** of all adjacent pairs across the corpus **and** an adjudicated precision
  among fires of at least 90%.
- otherwise the rule ships **warn** as a review prompt, and any later move to block
  is a separate decision with its own independent measurement.

Measured: **0.0%** of all pairs — the rate condition is met — and **0 / 4**
adjudicated precision on the real fires the deeper frame holds — the precision
condition is not. `coverage-exclusion` therefore ships and stays **warn**; `warn`
never requires sign-off under the default policy. Operators who want inline
exclusions held for review can raise the rule to `block` in their own policy,
accepting that every honest unreachable-branch marker will then need a sign-off.

## What this does not claim

- It is a fire-rate screen on ordinary maintenance, not a recall estimate: no
  positive (agent-tamper) corpus exists for this class beyond the fixtures in #438
  and the mutation positives in
  [`coverage-exclusion-corpus.json`](./coverage-exclusion-corpus.json).
- The four corpora are TypeScript libraries; the Python, Rust and Go spellings are
  measured only through this repository's own history (harness transcripts and seed
  fixtures carry `# pragma: no cover` as data, which the labeled corpus reproduces
  as negatives) and the fixtures.
- Ordinary PR CI does **not** recompute the 460-pair replay.
  `test/coverage-exclusion-corpus.test.ts` replays the labeled corpus (22 negatives
  reproducing the shapes real maintainers write beside the spellings, 14 positives),
  checks that the recorded numbers reproduce the frame, and checks that the
  severity decision follows the rule. `coverage-exclusion-fires.mjs` recomputes the
  replay on demand against a pinned checkout.
