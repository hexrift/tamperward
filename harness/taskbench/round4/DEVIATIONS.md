# Round 4 — protocol deviations (append-only)

`mine5.sh` carries the round-3 rule that a mid-walk edit to the miner is a
logged deviation. Each one is recorded here with what changed, why, and what it
touched.

## D1 — 2026-09-03, pilot walk, before any task validated

**What.** `mine5.sh` edited mid-walk: `TB_WORK` is now exported, and the task
emitter's hard-coded fallback work directory (`/tmp/tb-mine3`, inherited
verbatim from the round-3 miner) now derives from the pool.

**Why.** Round 3 set the bash work directory and the node task emitter's
fallback to the same literal, so they agreed without being tied together.
Round 4's work directory is pool-scoped (`/tmp/tb-mine5-<pool>`), which broke
that coincidence: the walk would have written to the pool directory while the
emitter read `/tmp/tb-mine3`. Introduced by the round-4 adaptation, not
inherited.

**What it touched.** Nothing counted, and nothing validated. The pilot walk had
decided three repositories (`Lightning-AI/pytorch-lightning`
CANDIDATES_EXHAUSTED, `latchset/jwcrypto` G0_NO_TESTS,
`Azure/msrestazure-for-python` EXCLUDED_INACTIVE) and emitted **zero** tasks
when the miner was stopped, so no task artefact was produced under the wrong
directory. The bug would have broken the first validated task rather than
corrupting an earlier one. The attrition already recorded stands; the walk
resumes from it.

**Pool status at the deviation.** Pilot pool only. The counted walk had not
started, and freeze 2 had not been reached.

## D2 — 2026-09-03, parallel mining driver added

**What.** `mine-parallel.sh` and `merge-shards.sh` added. The walk may now be
sharded round-robin across N workers, each with its own pool directory,
attrition ledger and work directory; the merge selects the first N validated
tasks in ORIGINAL walk order.

**Why.** Sequential mining measured at 5.5 hours for 20 tasks in round 3. Each
repository's verdict depends only on that repository, so the walk is
embarrassingly parallel; the only order-dependent element is the quota
short-circuit, which the walk-order selection at merge time restores exactly.

**What it changes.** How the walk is executed, not what any gate decides. No
gate, threshold, window or cap is touched; `mine5.sh` itself is unmodified by
this deviation. Thread-pool env vars are pinned to 1 per worker so concurrent
pytest runs do not oversubscribe the cores.

**What it touched.** Nothing counted. Sequential `mine5.sh` remains available
and is the reference behaviour.
