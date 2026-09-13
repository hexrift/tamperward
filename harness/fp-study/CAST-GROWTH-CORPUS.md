# ts-cast-growth — live-fire rate on legitimate TypeScript mainlines

This record is the durable measurement behind the severity decision for the
`ts-cast-growth` rule introduced for #383: net growth of ordinary `as T` / `<T>x`
and non-null `x!` assertions in non-test source, counted on the TypeScript AST.

## Question

Not "is a new cast malicious" — a cast is a promise to the compiler and can be
honest — but *how often does legitimate maintainer work grow the assertion
surface?* That is the "would this rule wrongly stop real work" measure
([`ADJUDICATION-RULE.md`](./ADJUDICATION-RULE.md)), and it decides whether any
block severity is deployable.

## Method

[`cast-growth-fires.mjs`](./cast-growth-fires.mjs) replays the candidate CLI's
`check --diff base...head --json` over every adjacent first-parent pair of a
pinned corpus checkout and records each `ts-cast-growth` finding. The harness
fails closed on CLI spawn/exit/JSON errors, the same discipline as
[`test-skip-ast-delta.mjs`](./test-skip-ast-delta.mjs). The corpora are the four
real repositories pinned for the 2.17.1 test-skip study, fetched at the same
heads; pair counts differ slightly from that study because this replay walks
first-parent history.

Candidate head under study: the `sec/cast-growth-383` detector as committed in
this pull request (`src/detectors/ts-cast-growth.ts`). Replayed locally on
2026-09-13 against the built CLI.

## Pinned corpus and measured fire rate

| repository | pinned head | first-parent pairs | pairs touching `.ts` | pairs touching eligible source | pairs with a fire | findings | files flagged |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| immer | `061c2425e1c9dff89e4e4189d42af1b7839dfe0a` | 137 | 33 | 38 | 9 | 15 | 7 |
| zustand | `b57db4f86ef179285da216eeb291266da82c361c` | 100 | 21 | 15 | 1 | 1 | 1 |
| zod | `ca0229a404818290e6cdcfefcd7eb2d04bcbb543` | 100 | 74 | 73 | 24 | 34 | 22 |
| hono | `8755b17fbcfdee76511eeb460e18e94e6c9a8d30` | 123 | 100 | 94 | 6 | 11 | 8 |
| **total** | — | **460** | **228** | **220** | **40** | **61** | **38** |

"Eligible source" is the detector's own scope: a JS/TS code file that is not a
declaration, not on a generated/vendored path and not a protected test file under
the default policy — the files the rule actually runs on. "Touching `.ts`" is the
broader count the test-skip study used and is kept only for comparison; it includes
tests and generated paths the rule excludes, so a rate on it would flatter the rule.

Fire rate on legitimate mainline maintenance:

| measure | result |
| --- | ---: |
| pairs with ≥1 fire / all pairs (**the predeclared metric**) | **40 / 460 = 8.7%** |
| pairs with ≥1 fire / pairs touching eligible source (the rule's own scope) | **40 / 220 = 18.2%** |
| pairs with ≥1 fire / pairs touching any `.ts` (comparison only) | 40 / 228 = 17.5% |
| per-repository range (all pairs) | 1.0% (zustand) – 24.0% (zod) |
| per-repository range (eligible source) | 6.4% (hono) – 32.9% (zod) |

The per-repository workflow results were:

```json
{"repo":"immer","corpus_head":"061c2425e1c9dff89e4e4189d42af1b7839dfe0a","pairs":137,"pairs_touching_ts":33,"pairs_touching_eligible_source":38,"pairs_with_fire":9,"fire_rate_all_pairs":0.0657,"fire_rate_ts_pairs":0.2727,"fire_rate_eligible_pairs":0.2368,"findings":15,"files_flagged":7}
{"repo":"zustand","corpus_head":"b57db4f86ef179285da216eeb291266da82c361c","pairs":100,"pairs_touching_ts":21,"pairs_touching_eligible_source":15,"pairs_with_fire":1,"fire_rate_all_pairs":0.01,"fire_rate_ts_pairs":0.0476,"fire_rate_eligible_pairs":0.0667,"findings":1,"files_flagged":1}
{"repo":"zod","corpus_head":"ca0229a404818290e6cdcfefcd7eb2d04bcbb543","pairs":100,"pairs_touching_ts":74,"pairs_touching_eligible_source":73,"pairs_with_fire":24,"fire_rate_all_pairs":0.24,"fire_rate_ts_pairs":0.3243,"fire_rate_eligible_pairs":0.3288,"findings":34,"files_flagged":22}
{"repo":"hono","corpus_head":"8755b17fbcfdee76511eeb460e18e94e6c9a8d30","pairs":123,"pairs_touching_ts":100,"pairs_touching_eligible_source":94,"pairs_with_fire":6,"fire_rate_all_pairs":0.0488,"fire_rate_ts_pairs":0.06,"fire_rate_eligible_pairs":0.0638,"findings":11,"files_flagged":8}
```

The replay was run twice: once on the first detector head and again after review
closed the candidate-controlled generated-header exemption and the parenthesised
double cast; the fire counts were identical on both runs, so the numbers above are
those of the shipped detector.

Every fire, with its evidence line, is committed beside this record:
[`cast-growth-immer-fires.jsonl`](./cast-growth-immer-fires.jsonl),
[`cast-growth-zustand-fires.jsonl`](./cast-growth-zustand-fires.jsonl),
[`cast-growth-zod-fires.jsonl`](./cast-growth-zod-fires.jsonl),
[`cast-growth-hono-fires.jsonl`](./cast-growth-hono-fires.jsonl).

## What the fires are

Of the 61 findings, 49 point at a type assertion and 12 at a non-null
assertion. Eleven are in benchmark or script files, two in a docs application,
and the rest in library source. By construction none is a tamper crafted
against TamperWard: they are maintainers narrowing library-internal state
(`state as ProxyArrayState`, `def.shape as Record<string | symbol, SomeType>`,
`k as keyof HeaderRecord`), asserting invariants the type system cannot see
(`this.#tries!`, `Object.getOwnPropertyDescriptor(sh, key)!`), or reading
external JSON (`(await res.json()) as { versions: … }`). The last kind is exactly
the boundary the rule exists to make visible; the first two are ordinary
type-library plumbing. A rule that cannot distinguish them at the diff must not
block.

## Predeclared decision rule and outcome

Written before the replay, from the thresholds the project already applies:

- **block** requires a fire rate on legitimate mainline maintenance at or below
  **1%** of all adjacent pairs across the corpus **and** an adjudicated
  precision among fires of at least 90%. Row 13 (`ts-any-launder`) was closed to
  block at 10.5%, described in SPEC §4 as "4–10× any deployable block threshold";
  1% is the conservative end of that band.
- otherwise the rule ships **warn** as a review prompt, and any later move to
  block is a separate decision with its own independent measurement.

The all-pairs rate is the predeclared metric because it is the same basis on which
row 13 was closed; the eligible-source rate is reported beside it because it is the
rate on files where the rule actually runs, and it is the stricter of the two.
Measured: **8.7%** of all pairs, **18.2%** of eligible-source pairs. The block
condition is not met by a wide margin on either basis. `ts-cast-growth` therefore ships
and stays **warn**; `warn` never requires sign-off under the default policy.
Operators who want the budget enforced can raise the rule to `block` in their
own policy, accepting the measured cost.

## What this does not claim

- It is a fire-rate screen on ordinary maintenance, not a recall estimate: no
  positive (agent-tamper) corpus exists for this class beyond the mutation
  controls in [`cast-growth-corpus.json`](./cast-growth-corpus.json).
- The four corpora are type-heavy TypeScript libraries; application code with
  fewer casts would fire less often, which changes nothing about the decision.
- The committed labeled corpus that CI replays
  (`test/ts-cast-growth-corpus.test.ts`) covers the rule's exclusions and
  offsets and a small set of boundary-assertion positives; it is the regression
  surface for this record, not a second independent measurement.

## Companion: the repository's own cast surface

The same issue asked for TamperWard's own casts to be inventoried and removed.
[`cast-inventory.mjs`](./cast-inventory.mjs) counts assertions on the AST;
[`docs/CAST-INVENTORY.md`](../../docs/CAST-INVENTORY.md) classifies every site
that existed on `main` before this change and records what replaced it. The
production tree went from 60 `as T` and 14 `x!` assertions (no `as any`, no
double cast) to zero of each.
