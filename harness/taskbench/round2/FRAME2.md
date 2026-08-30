# Taskbench round 2 — frame and walk procedure (frozen before mining)

Purpose: the validation pool for the 1.9.0 stack (gate + effect layer +
verify). Round 1's pool is spent — its 53 trajectories are development
fixtures for the detectors under test now, and re-scoring on them would be
training on the test set (stated in PHASE3.md, the results post, and the
1.7.0 CHANGELOG). Everything below is frozen before the first repo is walked;
changes after this commit are protocol deviations and go in the corrections
appendix, append-only.

## Frame derivation (tranche continuation, fully mechanical)

- **Source, unchanged and pinned:** the identical `npm-high-impact@1.13.0`
  package list committed at round 1 (`../frame/npm-high-impact.json`, 17,338
  packages). No new snapshot: same population, same pin, zero fresh
  researcher degrees of freedom in source selection.
- **Round 1 consumed package ranks 1–607** (mapping log), admitting 500
  distinct repos. **Round 2 continues at rank 608**, mapping packages to
  GitHub repos exactly as round 1 did (registry metadata, same normalization,
  same monorepo dedup), with **every round-1 frame repo pre-seeded into the
  dedup set** — a package whose repo already appeared in round 1 is logged
  `round1_dedup` and skipped, because those repos' tasks and decisions are
  spent.
- Admit until **500 new repos** or list exhaustion; the mapping log
  (`frame/mapping-log.jsonl`) records every rank's outcome.
- **Walk order:** keyed-hash shuffle, seed `taskbench-v2-2026-08-30`
  (published here before the walk), `sha256(seed + ":" + repo)` ascending.

## Gates, strata, quotas, window — by reference, unchanged

The walk applies `../FRAME.md`'s procedure verbatim: gates G0–G5 with the
timeout split codes, candidate cap 8, 300s step budget, the single-package /
workspace stratum operationalization, and the same qualifying-commit window
(**2024-08-29 .. 2026-08-29** — unchanged from round 1 so the two pools draw
from the same commit era; nothing published after the round-1 cutoff can
enter a task). Quotas: **3 pilot + 15 single-package + 15 workspace**, same
as round 1. Attrition is a result, never a knob (DESIGN A.2): if the tranche
yields fewer, N is what it yields, published.

## What is decided later, and where

Pool size N, arm definitions, endpoints, analysis, and bets for the round-2
experiment belong to its registration (`PREDICTION2`), written after mining
and before any counted trajectory — the same order as round 1, provable the
same way. The only round-2 commitments made here are the frame derivation
and the walk procedure above.

## Corrections (append-only)

1. **2026-08-30, ~35 minutes into the walk — FP-corpus repos excluded as
   detector-development data.** The `test-content-removal` rule (1.7.0) was
   corpus-priced on the mainline histories of immer, zustand, zod, and
   prettier (`harness/fp-study/TCR-CORPUS.md`); its thresholds and the
   snapshot-jurisdiction exclusion were chosen partly from adjudicating those
   repos' commits. A round-2 task drawn from any of them is therefore not an
   independent test of that rule. zod and prettier were round-1 frame repos
   (already spent, never in frame2); **pmndrs/zustand and immerjs/immer are
   in frame2** and are hereby excluded from the round-2 pool. This was
   caught when zustand appeared in the walk (first corpus repo reached,
   logged `MATERIALIZATION_FAILED` on candidate 1) and recorded before any
   corpus-repo task was validated. Mechanically: the walk is not interrupted
   (the miner is never edited live); if it validates a task from either repo,
   the task moves to `tasks-excluded/` citing this correction, the
   semver-precedent path. Root cause of the gap: FRAME2.md was frozen before
   anyone cross-checked the frame against the FP corpus — the frame-1 overlap
   check existed, the development-data overlap check did not. It does now,
   in writing, for every future frame: **repos used to price or tune a
   detector are spent for validation pools of that detector.**

2. **2026-08-30, at the hono validation — the development-data exclusion
   extended to the complete FP-study set.** Correction 1 audited only the
   `test-content-removal` pricing corpus (immer, zustand, zod, prettier). The
   standing rule it stated is broader than the audit it ran: every repo whose
   mainline history priced or tuned ANY shipped detector is development data,
   and `harness/fp-study/` enumerates them — hono and nest (the original
   gate FP sweeps), docusaurus, immer, jest, prettier (the snapshot study),
   zod, zustand. Cross-checked against frame2: only **honojs/hono** is newly
   exposed (nest and docusaurus are in neither frame; jest, prettier, zod
   were round-1 repos; zustand and immer were already excluded). hono's
   validated task moves to `tasks-excluded/` citing this correction, the walk
   uninterrupted. Root cause: correction 1 fixed an instance and stated a
   rule but audited only the instance's corpus; this entry completes the
   audit and pins the full list. The standing rule now has its enumerated
   set, and any future FP corpus addition must name its repos in the same
   breath as its numbers.

3. **2026-08-30, at walk completion — two harness defects, decisions
   unaffected, disclosed.** (a) The relaunched miner briefly hardcoded its
   work directory, recorded as a `LOG_CORRECTION` in `attrition.jsonl` when
   found and fixed. (b) The miner's resume treated *any* attrition line for
   a repo as "decided", so four repos whose processing was interrupted at
   candidate level (pmndrs/zustand, TanStack/query,
   remarkablemark/inline-style-parser, cfware/get-package-type) were
   silently skipped on relaunch. Caught by 500-repo completeness arithmetic
   at walk end; closed by a scoped pass over exactly those four under the
   identical gates, budgets, and live quotas (`LOG_CORRECTION` in
   `attrition.jsonl` marks the appended decisions). zustand validated in
   that pass and was excluded per correction 1, as predicted when its
   earlier partial entries were invalidated. Standing rule: resume-decided
   status requires a repo-level verdict line, and walk completion is checked
   against the frozen order's full count, in writing, for every future walk.
