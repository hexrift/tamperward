# Round 3 — mining funnel and structural audit (pool frozen at this commit)

The FRAME3-frozen walk (seed `taskbench-v3-2026-08-31`, procedure and miner
frozen in the FRAME3 commit before any mapping) exhausted all 500 frame
entries. During the walk an ENOSPC event corrupted one log line and lost two
terminal records; after the append-only corrections and a position-faithful
scoped re-pass (both recorded as `LOG_CORRECTION` entries in
`attrition.jsonl`), **all 500 frame entries carry a clean terminal verdict**,
checked by JSON-parse-based completeness over the frozen order — not the
grep-based check, whose corrupted-line substring vulnerability correction 1
documents as a standing fix for future miners.

Wall time: ≈7 h. Environment: Python 3.11.15, uv 0.8.17, single Linux
sandbox, per FRAME3.

## Repo-level funnel (one terminal verdict per frame entry; N=500)

| verdict | n |
| --- | --- |
| QUOTA_FULL (single-distribution quota already filled) | 220 |
| G0_NOT_PYTEST | 84 |
| CANDIDATES_EXHAUSTED | 62 |
| G0_NO_TESTS | 42 |
| EXCLUDED_INACTIVE | 41 |
| G0_NO_PYPROJECT | 22 |
| **TASK_VALIDATED** | **20** |
| CLONE_FAILED | 7 |
| NO_QUALIFYING_COMMITS | 2 |

## Candidate-level attrition (480 candidate deaths; NOT independent — up to 8 per repo)

G2_PARENT_RED 242 · G1_INSTALL_FAILED 102 · G2_PARENT_ERROR 94 ·
G2_PARENT_TIMEOUT 21 · G3_NOT_RED 14 · C_CHECKOUT_FAILED 4 ·
G5_COMMIT_RED 3.

357 of 480 candidate deaths (74%) occur at G2 — reproducing a green parent
suite — with installation (21%) a distant second. Because candidates within a
repo share its topology, these percentages describe the *mechanism* of
candidate attrition, not independent failure probabilities: the frozen Python
task constructor is overwhelmingly selecting on the ability to reproduce a
green parent suite under the frozen command.

## The pool

**20 validated tasks = 3 pilot (spent, never counted) + 17 main.**
**Main pool: 15 single-distribution + 2 workspace** (PyCQA/flake8,
celery/billiard). The workspace quota closed at 2/15 at frame exhaustion —
DESIGN A.2: N is what the frame yields; nothing was changed mid-walk to
manufacture the intended quota.

Oracle strength: over all 20 validated tasks, 6 INTEGRITY+SEMANTIC /
14 INTEGRITY; over the 17 main tasks, 5 INTEGRITY+SEMANTIC / 12 INTEGRITY
(the pilot set holds 1 INTEGRITY+SEMANTIC / 2 INTEGRITY).

All 20 validated tasks installed successfully on the first ladder rung
(`extras:test`) — a strikingly uniform property **of the selected pool**, not
of the population: the 102 G1_INSTALL_FAILED candidate deaths show the
opposite for the broader candidate population. The uniformity is itself
evidence of selection.

Confirmatory-analysis implication, recorded before registration: PREDICTION3
is written around the actual main N=17, not the 30-task quota ceiling.
Anything said about the two workspace tasks is descriptive only.

## Two-stage workspace attenuation (the structural audit)

The intended 15-workspace quota yielded 2 eligible tasks under the frozen
procedure. A **classification-only audit** was performed after frame
exhaustion — without changing eligibility, task selection, or treatment — to
quantify whether the under-fill arose from source-frame composition or from
interaction between Python repository topology and the root-oriented
eligibility/execution rules. Method: every frame repo was re-cloned at its
current default HEAD and the frozen stratum predicate plus the G0 marker
facts were computed (`audit/classify-one.sh`, one JSONL row per repo in
`audit/classification-sweep.jsonl`; no installs, no suite runs).

Structural classification of the 500: **418 single-distribution-shaped, 75
workspace-shaped, 7 classification-impossible** (clone failed).

The 75 workspace-shaped repos, by terminal verdict:

| stage | verdict | n |
| --- | --- | --- |
| eligibility (pre-classification in the walk) | G0_NO_PYPROJECT | 21 |
| eligibility | G0_NO_TESTS | 17 |
| eligibility | G0_NOT_PYTEST | 12 |
| execution | CANDIDATES_EXHAUSTED | 23 |
| execution | **TASK_VALIDATED** | **2** |

So workspace representation was attenuated at two successive stages. First,
the root-oriented eligibility definition eliminated **50 of 75 (67%)**
structurally workspace-shaped repositories before formal stratum
classification could occur — 21 lacking any root project marker at all (the
Python-monorepo signature: distributions live below the repository root, with
no npm-style root workspace declaration), 12 not pytest-shaped at the root,
17 with no tracked file matching the frozen test globs. Second, of the 25
that survived eligibility and reached candidate evaluation, 23 exhausted all
candidates — predominantly at installation and parent-green — and 2
validated. Zero workspace-shaped repos were quota-skipped (that quota never
filled), so no eligible workspace task was ever displaced by the mechanism.

This is a sampling-frame finding about how FRAME3's operational definition
maps onto Python repository topology, not a treatment result; it is frozen
and disclosed before any counted treatment outcome exists. Nested-project
discovery / monorepo-aware eligibility is future frame design (FRAME4), not a
round-3 repair.

## Deviations

Two `LOG_CORRECTION` entries in `attrition.jsonl` (append-only):

1. **ENOSPC window** — the session disk hit zero mid-walk (dependency-wheel
   cache growth); one fused/corrupted log line (line 932, preserved);
   beartype left undecided while grep-based completeness passed spuriously
   via substrings inside the corrupted line (standing fix: JSON-parse
   completeness); psf/black's verdict trapped in the fused line; narwhals'
   G2_PARENT_ERROR rc=3 verdicts disk-suspect and invalidated.
2. **Scoped re-pass** — beartype/beartype, psf/black, narwhals-dev/narwhals
   re-decided under the byte-identical frozen miner (sha256-verified) with
   quotas read from the live pool, verified position-faithful (all three were
   originally encountered at pilot=3/single=15/ws=2, per the walk log's
   per-repo quota stamps). Outcomes: beartype CANDIDATES_EXHAUSTED (genuine
   parent reds), black QUOTA_FULL (identical), narwhals CANDIDATES_EXHAUSTED
   with rc=3 reproduced identically on healthy disk (genuine). **Net pool
   effect of the event: zero.**

## What is decided later, and where

Revalidation (round-trip tree proofs, true-red, gold-green) precedes
registration. Arms, endpoints, analysis, numeric bets and losing conditions
belong to `PREDICTION3`, written after this freeze and before any counted
trajectory; the preregistration article publishes after `PREDICTION3` and
before trajectory #1, and both state that no counted round-3 trajectory
existed when they were frozen.
