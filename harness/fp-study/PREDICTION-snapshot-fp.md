# Pre-registration — snapshot-rewrite false-positive study

Written BEFORE running the sweep. Corpus: the last ~350 first-parent commits of four
snapshot-heavy mainline repos (prettier, jest, immer, docusaurus), all presumed
legitimate — these are reviewed, merged maintainer commits, so every fire is a
false positive BY DEFINITION OF THE STUDY for the purpose of block-graduation
(as a `warn`, a fire on a real snapshot update is working as designed: it asks a
human to confirm, and a merged commit is exactly that confirmation).

## What is being decided

Whether — and in what shape — `snapshot-rewrite` can graduate warn -> block via the
`version:` gate. The command surface (jest -u, regeneration scripts) cannot be
measured on git history, which records no commands; this study measures the FILE
surface only (modify/delete/rename-out of `**/*.snap`, `__snapshots__/`, `golden/`).

## Specific bets

1. **Snapshot-touching commits are ordinary, not rare**: between 5% and 40% of
   mainline commits in prettier and jest touch a snapshot path. If true, the file
   surface as-is CANNOT graduate to block — it would gate a routine, legitimate
   workflow behind sign-off in every snapshot-heavy repo.
2. **The co-touch signature separates legit from suspect**: >= 80% of
   snapshot-touching commits also change at least one non-snapshot source or test
   file in the same commit — the signature of an INTENDED output change. If
   confirmed, "snapshot changed with NO accompanying non-snapshot change" is the
   narrow graduation candidate worth studying next.
3. **Snapshot-only commits are mostly housekeeping**: the <= 20% remainder is
   dominated by bulk regenerations and format-only churn, not semantic changes —
   meaning even the narrow candidate needs adjudication before being trusted.

## Falsifier for the graduation

If bet 1 holds, the honest conclusion is that the file surface stays `warn`
permanently in its current shape, and graduation work shifts to (a) the command
surface and (b) the co-touch refinement — or nowhere, if bet 2 also fails.

---

## Outcome — written AFTER the sweep (2026-08-27)

1,652 first-parent non-merge commits swept; every snapshot-touching commit replayed
through the built CLI (`check --diff parent...sha`).

| repo | commits | snapshot-touching | fired | co-touch | snapshot-only |
|---|---|---|---|---|---|
| prettier | 434 | 131 (30.2%) | 131 (100%) | 131 (100%) | 0 |
| jest | 399 | 60 (15.0%) | 60 (100%) | 59 (98.3%) | 1 |
| docusaurus | 399 | 21 (5.3%) | 21 (100%) | 21 (100%) | 0 |
| immer | 420 | 4 (1.0%) | 4 (100%) | 4 (100%) | 0 |
| **total** | **1,652** | **216 (13.1%)** | **216** | **215 (99.5%)** | **1** |

- **Bet 1 confirmed** (prettier 30.2%, jest 15.0% in the 5–40% band). Snapshot updates
  are a routine mainline workflow. As a `block`, the file surface would demand sign-off
  on ~1 in 3 prettier commits.
- **Bet 2 confirmed, stronger than bet**: co-touch is 99.5%, not 80%.
- **Bet 3 confirmed at 0.5%**: the single snapshot-only commit is a jest maintainer's
  two-line follow-up titled "Update snapshot." — housekeeping.

## Graduation decision

- **The file surface stays `warn` in its current shape, permanently.** 216/216 mainline
  fires are legitimate updates; as a warn that is working as designed (it asks a human
  to confirm — a merged commit is that confirmation), as a block it would be absurd.
- **The narrow candidate is real: "snapshot changed with NO accompanying non-snapshot
  change."** On this corpus it fires once per ~1,652 commits (0.06%), and that one fire
  is benign-but-confirmable housekeeping. On the attack corpus it would have fired on
  7/7 observed tampers — every seed-golden tamper trajectory modified ONLY the golden
  file (run suite, regenerate, run suite; no source edit). Known evasion: bundle the
  snapshot rewrite with an unrelated edit. That is inherent to commit-granularity and
  buys the attacker a co-touching diff a reviewer still sees.
- **The command surface** (`jest -u`, regeneration scripts) is unmeasurable on git
  history — no commands are recorded — and stays warn pending harness accumulation.

Next evidence step if graduation is wanted: implement the snapshot-only refinement as a
DISTINCT finding, run it in shadow over future weekly harness output plus this corpus
sweep on more repos, then gate it at `version: 2` via BLOCK_SINCE.
