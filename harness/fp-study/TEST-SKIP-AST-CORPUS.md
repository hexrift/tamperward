# test-skip AST precision delta — 2.17.1

This record is the durable adjudication for the AST-backed JS/TS extension to the
mechanical `test-skip` rule in #330.

## Method

The study compares the released/trusted-base detector with the candidate detector over
adjacent mainline diffs from four real repositories. The harness fails closed on CLI
spawn/exit/JSON errors and each corpus is pinned by commit SHA.

The measured quantity is deliberately narrow: **newly introduced `test-skip`
findings produced by the candidate that the trusted-base detector did not produce**.
This is a precision-delta screen, not a recall estimate.

Final implementation head under study:

`47a4477625a54d653d49dfbaf5304095a24e23a1`

GitHub Actions run:

`34777413883`

## Pinned corpus

| repository | pinned head | adjacent diff pairs | new findings |
| --- | --- | ---: | ---: |
| immer | `061c2425e1c9dff89e4e4189d42af1b7839dfe0a` | 137 | 0 |
| zustand | `b57db4f86ef179285da216eeb291266da82c361c` | 100 | 0 |
| zod | `ca0229a404818290e6cdcfefcd7eb2d04bcbb543` | 100 | 0 |
| hono | `8755b17fbcfdee76511eeb460e18e94e6c9a8d30` | 123 | 0 |
| **total** | — | **460** | **0** |

The per-repository workflow results were:

```json
{"repo":"immer","corpus_head":"061c2425e1c9dff89e4e4189d42af1b7839dfe0a","pairs":137,"new_findings":0,"findings":[]}
{"repo":"zustand","corpus_head":"b57db4f86ef179285da216eeb291266da82c361c","pairs":100,"new_findings":0,"findings":[]}
{"repo":"zod","corpus_head":"ca0229a404818290e6cdcfefcd7eb2d04bcbb543","pairs":100,"new_findings":0,"findings":[]}
{"repo":"hono","corpus_head":"8755b17fbcfdee76511eeb460e18e94e6c9a8d30","pairs":123,"new_findings":0,"findings":[]}
```

## Adjudication

**0/460 newly introduced findings** were observed on this pinned precision-delta frame.

That result supports the conservative AST extension shipped in 2.17.1, but it is not a
claim of universal zero false positives. The detector remains intentionally bounded:

- AST enrichment applies only when full JS/TS BEFORE/AFTER content is available and
  parses cleanly;
- lexical runner/property bindings are resolved by TypeScript symbol identity;
- dynamic computed properties are not guessed;
- formatting-only rewrites of pre-existing AST-only skip/focus semantics are suppressed
  through trivia-free structural BEFORE/AFTER identity;
- shorthand `skip` / `todo` / `only` values that are statically proven `false` or
  `0` are not reported;
- binding-only changes can be attributed when they newly make an unchanged call site a
  skip/focus operation;
- diff-only producers and non-JS ecosystems retain the established regex path.

The study therefore supports shipping the bypass fix at the rule's existing **block**
severity, while keeping genuinely ambiguous/dynamic forms outside the AST-only claim.

## Workflow performance note

The one-time study workflow initially ran all four corpora serially and took roughly ten
minutes. During review it was converted to four independent matrix jobs (#386); the final
run completed all four in about 3m16s wall-clock. The workflow was temporary evidence
machinery and is removed before merge.

## Re-run for #428 (2.23.5) — runner-binding fix

The #428 change moves the AST path from "authoritative for every call it parsed" to
"authoritative only for a call whose chain root it PROVES is a runner or a non-runner";
an unclassifiable root now falls through to the line matcher, and runner bindings are
followed through namespace imports, `X.extend(...)` and relative fixture modules. Both
directions can move precision, so the same delta harness was replayed with the
2.23.4 `main` CLI (`57c98bb`) as the base and the #428 head as the candidate, over the
same four pinned corpus heads. The corpora were fetched with the `--depth` values the
`cast-growth-evidence` workflow uses (138 / 101 / 101 / 124); `rev-list` over a shallow
fetch walks every parent, so immer and hono yield more adjacent pairs than the 2.17.1
run counted — a superset of that frame, not a different one.

| repository | pinned head | adjacent diff pairs | new findings |
| --- | --- | ---: | ---: |
| immer | `061c2425e1c9dff89e4e4189d42af1b7839dfe0a` | 178 | 0 |
| zustand | `b57db4f86ef179285da216eeb291266da82c361c` | 100 | 0 |
| zod | `ca0229a404818290e6cdcfefcd7eb2d04bcbb543` | 100 | 0 |
| hono | `8755b17fbcfdee76511eeb460e18e94e6c9a8d30` | 146 | 0 |
| **total** | — | **524** | **0** |

```json
{"repo":"immer","corpus_head":"061c2425e1c9dff89e4e4189d42af1b7839dfe0a","pairs":178,"new_findings":0,"findings":[]}
{"repo":"zustand","corpus_head":"b57db4f86ef179285da216eeb291266da82c361c","pairs":100,"new_findings":0,"findings":[]}
{"repo":"zod","corpus_head":"ca0229a404818290e6cdcfefcd7eb2d04bcbb543","pairs":100,"new_findings":0,"findings":[]}
{"repo":"hono","corpus_head":"8755b17fbcfdee76511eeb460e18e94e6c9a8d30","pairs":146,"new_findings":0,"findings":[]}
```

**0/524 newly introduced findings.** The negative set is unchanged by the fix; the
detector now also blocks the four fixtures from #428 (namespace import, unreadable
fixture module, `base.extend({})` from `@playwright/test` and from `vitest`) on the
full-content path, where 2.17.1–2.23.4 reported nothing.
