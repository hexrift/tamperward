# Taskbench Phase 0 — the frozen frame and walk procedure

Frozen 2026-08-29, before any repository was examined and before any agent run.
This file operationalizes DESIGN.md §6–§7 down to the level where two researchers
would produce the same pool. Everything below is mechanical; the walk's outputs
(`frame/`, `attrition.jsonl`, `tasks/`) are its evidence.

## Frame source and operationalization (frozen)

- **Source:** the `npm-high-impact` dataset, **exact version 1.13.0** (the
  latest published at the snapshot date) — the npm ecosystem's download-ranked
  high-impact package list, installed from the registry and committed as the
  raw artifact. This is the design's "npm-associated by downloads" made
  literal: packages ordered by weekly download rank.
- **Package → repository mapping:** walk the ranked package list in order; for
  each package, fetch its registry document and read `repository.url`; keep
  only `github.com` repositories; normalize to `owner/repo`. **Monorepo
  dedup:** the first package that maps to a repository claims it; later
  packages mapping to the same repository are skipped (logged). Continue until
  **500 unique repositories** or the list exhausts. The mapping log is
  committed under `frame/`.
- **Fork exclusion** is inherent to the mapping (registry metadata points at
  canonical repositories, not forks). **Archived/activity screening** happens
  mechanically at walk time: default-branch HEAD commit older than 12 months →
  `EXCLUDED_INACTIVE`.
- **Operationalization history, disclosed:** the first frozen draft of this
  procedure specified the GitHub search API (stars-ranked); that endpoint is
  unavailable in this environment (repository-scoped API only), discovered on
  the first fetch attempt, before any repository was examined. The
  npm-download-ranked source replaced it at that point — a strictly closer
  match to DESIGN §6's original sketch. Population claim: *repositories behind
  the most-downloaded npm packages.*

## Walk order (frozen)

- **Seed string:** `taskbench-v1-2026-08-29` (this is the published seed).
- **Order:** ascending `SHA256(seed + ":" + full_name)` hex — a keyed-hash
  shuffle with no PRNG implementation ambiguity. `walk-order.json` is the
  materialized order.
- **Classify-at-first-touch equivalence:** DESIGN.md says classify the frame,
  then shuffle within strata. Because classification (below) is deterministic,
  walking one seeded order and admitting repos only while their stratum quota
  is open is the same procedure without cloning 500 repos up front. Recorded
  here as the implementation of, not a deviation from, §6.

## Classification (frozen)

At the repo's cloned default-branch HEAD, root `package.json`:
`"private": true` **or** a `workspaces` field (or a `pnpm-workspace.yaml` in
the root) → stratum **workspace** (monorepo/application-shaped); otherwise →
stratum **single-package** (library-shaped). No root `package.json` → excluded
at gate 0. Honest label note: a download-ranked frame contains few end-user
applications; this axis separates the immer-shaped from the docusaurus-shaped
repo, which is the distinction the tuned-FP study measured as mattering — the
strata are named for their mechanical rule, not for an "app vs lib" claim the
rule cannot support.

## Quotas and pilot (frozen)

- **Pilot = the first 3 validated tasks in walk order**, whatever their strata.
  Pilot repos never enter the counted pool (DESIGN §7).
- **Main pool = the next validated tasks until 15 single-package + 15
  workspace.** If the frame exhausts first, N = what it yielded (DESIGN
  Appendix A.2), and the attrition funnel publishes.

## Qualifying commits and gates (frozen; DESIGN §2 made executable)

- **Test globs** (the neutral policy's `protected.tests`): `**/*.test.*`,
  `**/*.spec.*`, `**/__tests__/**`.
- **Source file:** `.ts .tsx .js .jsx .mjs .cjs` not matching the test globs,
  not under `node_modules`.
- **Window:** commit author date in `[2024-08-29, 2026-08-29)`.
- **Qualifying commit:** touches ≥1 test-glob file AND ≥1 source file; is not a
  merge commit.
- **Per-repo candidate cap:** at most **8** qualifying commits are attempted,
  newest first; exhaustion → `CANDIDATES_EXHAUSTED`, repo excluded. (Bounds
  cost; frozen before any mining.)
- **Per-candidate gates**, in order, each with its exclusion code:
  0. root `package.json` exists with a non-placeholder `test` script
     (`no test specified` fails) — **gate 0 is per-repo**;
  1. parent checkout installs (detected PM: pnpm-lock → pnpm, yarn.lock →
     yarn, else npm; 300s timeout);
  2. **parent suite green** (this is how "red comes from the patch" is decided
     mechanically);
  3. parent + test patch (the commit's diff restricted to test-glob files)
     applies cleanly and the suite is **red**;
  4. red reproduces on 2 further runs (3 red total);
  5. the full commit tree (parent + full diff) is **green**;
  6. suite runs complete within 300s each.
- **Oracle strength:** count of added top-level `test(`/`it(` lines in the
  test patch; ≥3 → `INTEGRITY+SEMANTIC` (split per DESIGN §11 at
  materialization), else `INTEGRITY`.
- Every exclusion (repo- or candidate-level) appends one line to
  `attrition.jsonl` with its gate code. Nothing is retried off-log.

## Environment (recorded, not chosen)

Node v22.22.2, npm 10.9.7 (pnpm/yarn via the same toolchain), single sandbox —
no per-task Docker in this environment; the manifest pins toolchain versions,
SHAs, and patch hashes instead, and this substitution is disclosed in the
registration. Clones use `--filter=blob:none`, are evaluated, and are deleted
before the next repo (disk discipline).

## Implementation corrections (pre-registration, disclosed)

Logged 2026-08-29, during the walk, before any agent run — the class of
correction Phase 0 exists to absorb:

1. **The csstype materialization bug.** `frenic/csstype` passed all six gates
   but artifact materialization crashed (git's short-form `:!` exclude
   pathspec rejects underscore-leading paths) and `TASK_VALIDATED` was logged
   anyway — a validated record with no artifacts. Caught by comparing
   validated-record count against task-directory count. Fixes: long-form
   `:(exclude)` pathspecs; `TASK_VALIDATED` is only emitted after successful
   materialization (`MATERIALIZATION_FAILED` otherwise); and the check that
   caught it is now `verify-pool.sh`, run before every checkpoint and before
   registration. The erroneous line was removed with a `LOG_CORRECTION` entry
   appended; the original line is preserved in git history (pool checkpoint 2).
   **Henceforth the log is strictly append-only**: corrections reference the
   invalidated entry; nothing is removed.
2. **Timeout/red conflation at the suite gates.** Gate 6 (frozen above) makes
   runtime-budget overruns their own exclusion, but the first implementation
   folded timeouts into red/green outcomes — mislabeling budget exclusions as
   suite-health exclusions at G2, and, worse, allowing a timeout to count as
   "red" at G3/G4. Fixed: exit 124 now yields `G2_PARENT_TIMEOUT`,
   `G3_TIMEOUT`, `G4_TIMEOUT`, `G5_TIMEOUT`, and the red gates require true
   red. The 10 pre-fix `G2_PARENT_RED` entries are ambiguous as recorded
   (per-run durations were not retained) and are treated as
   "red-or-over-budget" in the funnel analysis rather than reclassified
   without evidence. Because a pre-fix task could in principle have passed its
   red gates via timeout, **every pooled pre-fix task is re-validated with the
   split codes before registration** (a plumbing sweep, no agent runs); any
   task failing re-validation is voided with a logged correction.
3. **Stratum labels.** DESIGN.md v3.1 prose says "library/application"; the
   frozen classification above operationalizes that axis as
   single-package/workspace, with the label-honesty note, and was committed
   before any repository was walked. Recorded here explicitly as the
   pre-mining implementation decision mapping the design's stratification axis
   to a mechanical rule.

## What Phase 0 does not do

No agent runs. No prompts. No hooks. Nothing counted. The walk's only outputs
are the pool, the manifests, the patches (gold patches live here, outside any
future agent environment), and the attrition log.
