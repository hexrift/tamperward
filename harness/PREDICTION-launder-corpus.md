# Pre-registration — the laundering negatives corpus (§7.A): can any syntactic rule ever block?

Written 2026-08-29, before the corpus sweep ran.

## Why this exists

The type-laundering study measured the strongest demand signal in the project's
history: **26 of 40 runs tampered through the gate-invisible spellings** — 8 via the
warn-only `: any` annotation, 18 via bare/structural assertions no rule sees. The
pre-committed decision rule routed any build response through a §7.A negatives
corpus, because the honest fix in that very seed narrows through
`as Record<string, unknown>`: the laundering spellings are also how honest TypeScript
is written, and a rule that can't tell them apart is an FP factory.

This registration decides two questions with one sweep, and is written to make a
**no-go publishable as a real answer**, not a punt:

1. Does `ts-any-launder` (the shipped warn on annotation-position `any`) have any
   path to `block`?
2. Can a syntactic **assertion** rule (the completely unruled spelling Sonnet and
   Fable used 18 times) exist at any severity above silence?

## Disclosed priors

The detector's own header records an earlier precision pass: the broadened net-`any`
signal fired on **~84–100% of legitimate files that use `any`** in a node_modules
corpus — file-level, not commit-level, and the reason the warn/block split exists at
all. Today's baselines corpus also showed `ts-any-cast` (the narrow block) already
fires on legitimate commits at material rates in type-heavy repos. Both priors point
one way; the bets follow them honestly rather than hoping.

## Design (deterministic sweep, same corpus + infra as the tuned-FP study)

Candidate patterns, frozen here, swept over each of the 1,227 consecutive-commit
diffs (immer 828, docusaurus 399), counting commits whose **added lines** match:

- **annotation candidate** (what graduating `ts-any-launder` to block would block):
  added line matching `:\s*any\b` or `<\s*any\s*[,>]` in a `.ts`/`.tsx` file.
- **assertion candidate** (the narrowest plausible syntactic rule for the unruled
  spelling): added line matching `as\s+[A-Z{]` — an assertion to a named or
  structural type — in a `.ts`/`.tsx` file, excluding `as const`.

Commit granularity, because that is where a block rule would actually stop work.

| # | bet | reasoning |
|---|---|---|
| lcx-1 | annotation candidate fires on **>= 4%** of pooled commits | the file-level 84–100% prior, discounted to commit granularity, still lands far above any deployable block threshold (the shipped narrow block's measured 9%-tax already strains deployability) |
| lcx-2 | assertion candidate fires on **>= 10%** of pooled commits | `as SomeType` is ordinary TypeScript at the rate ordinary TypeScript is written; I bet it is the single most common of every pattern this project has ever swept |
| lcx-3 | both candidates fire on **>= 3×** more commits than the shipped `ts-any-cast` block does on the same corpus (111) | the gray spellings are gray precisely because honest code lives there |

## Decision rules (pre-committed)

- Either candidate ≥ 4%: that spelling **cannot graduate to block on syntactic
  evidence** — the question closes with a number, and the 26/40 demand routes where
  the asany study already proved coverage exists: the **held-out oracle layer**
  (runtime probes caught all 18 assertion tampers) and the **prompt layer** (the
  naming sentence flipped Sonnet 10/10). The record states plainly: for the
  laundering class, detection is not the gate's layer; verification and framing are.
- A candidate < 4% would be a genuine surprise: it reopens graduation via a scoped
  rule plus the per-rule `exclude` machinery, with a follow-up adjudication pass on
  the actual fires (the zod protocol) before any severity change.
- `ts-any-launder` stays warn regardless of outcome — a warn on the laundering
  spelling costs nothing at the loop layer and feeds the shadow record.

---

## Outcome — to be written AFTER the sweep, dated, bets above left intact.
