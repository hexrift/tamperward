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

## D3 — 2026-09-03, concurrent clones poisoned 412 repo-level verdicts

**What.** Running three mining workers concurrently made `git clone` abort
under this environment's git proxy. The miner records a failed clone as
`CLONE_FAILED`, which is a **terminal repo-level verdict**: on resume those
repositories are skipped for good. 412 such verdicts were written across the
three shards before it was caught.

**How it was caught.** The shards' yields diverged implausibly — 42 and 109
repositories decided with zero tasks against round 3's measured ~14
substantive decisions per task, while a third shard produced two tasks. The
verdict mix showed `CLONE_FAILED` dominating every shard, which the sequential
walk had never produced. `pahaz/sshtunnel`, recorded as `CLONE_FAILED`, cloned
cleanly (rc=0) once the workers were stopped, proving the failures were an
artefact of concurrency and not a property of the repositories.

**Correction.** All 412 `CLONE_FAILED` lines were purged from the shard
ledgers, so those repositories re-enter the walk on the next pass. Every other
verdict was kept, and the two validated tasks (`01-aio-libs-aiodns`,
`02-pallets-eco-flask-wtf`) are unaffected — they were mined from successful
clones.

**Prevention.** `shim/git` serialises `git clone` across workers with `flock`
and passes every other git subcommand straight through; `mine-parallel.sh`
prepends it to `PATH`. Cloning is network-bound, so serialising it costs
little, while the install and pytest steps that dominate stay parallel.
`mine5.sh` is untouched by this fix.

**Scope.** Pilot pool only. Nothing counted; freeze 2 not reached. The
poisoned verdicts never reached a task artefact.

**Note for other environments.** The abort is likely specific to this
container's git proxy. On a machine cloning directly, concurrent clones may
be fine — but the shim is cheap insurance and stays on by default.

### D3 correction (append-only) — 2026-09-03, after independent review

The first D3 entry above understated the incident and its remedy was wrong in
kind: purging the poisoned lines made them *disappear* rather than become
retryable, and it left three further defects unaddressed. Independent review of
the pushed checkpoint found, and this correction confirms:

- **245 `CLONE_FAILED` lines over only 154 unique repositories** — the duplicate
  count is itself evidence of **overlapping shard processes**, not merely a
  failing clone path. Relaunching without a per-shard lock left more than one
  writer on the same ledger.
- **123 repositories carried duplicate terminal verdicts**, and some changed
  verdict between concurrent attempts.
- **The walk reached rank 258 while producing two tasks** — later measured at a
  frontier of **rank 396 with 254 repositories touched**, against round 3's
  measured ~14 substantive decisions per task. That is a runaway, not attrition.

**Affected commit range:** `21481b6..ff8b94b` on `round4/miner`. The pre-purge
ledgers and all shard logs are preserved verbatim under `incident-D3/`.

**Independent control.** With every worker stopped, `pahaz/sshtunnel` —
recorded `CLONE_FAILED` — cloned cleanly, `rc=0`. The failures were an artefact
of concurrency, not a property of the repositories.

**Root cause of the runaway (D4).** `mine5.sh` inherited round 3's
`role: pilot<3?'pilot':'main'`, a hardcoded count. The shard's stop condition
counts tasks whose role is `pilot`, so with `PILOT_NEED=6` the counter could
never exceed 3 and **no shard could ever reach its need**. The walk could not
terminate; it simply consumed frame until killed. Role now derives from the base
pool (`pilot-sN` → pilot), never from a count.

**Burn accounting.** FRAME5.md makes a repository development data the moment
the pilot draws it. That covers repositories attrited or abandoned
mid-processing, not only those reaching a verdict, so the burn list is built
from the shard logs' `[walk]` entries **union** every repository named in any
ledger: **254 repositories**, frontier depth 396 of 500, leaving **246
unburnt**. Written to `frame/pilot-dedup.json`, which `fetch-frame5.sh` already
consults.

**Ledger rebuild.** The active shard ledgers are reset rather than patched: every
repository they described is burnt, so none can be re-walked and a partially
purged ledger would only be misleading. The pilot resumes on a walk derived as
*the registered pilot order with burnt repositories removed, relative order
untouched* (`pools/pilot/walk.json`, 246 entries). The poisoned originals remain
in `incident-D3/` and in git history for audit.

**The five validated tasks are PROVISIONAL.** They are preserved in
`incident-D3/provisional-tasks/` at ranks 8, 11, 28, 32 and 46, and are **not**
declared part of the final ten. The raced walk cannot establish that no
earlier-ranked repository was wrongly skipped, so eligibility must be re-earned
against a clean ordered frontier.

**Remaining fixes shipped with this correction:** retries and a circuit breaker
replace the single-attempt terminal `CLONE_FAILED` (`shim/git`); one lock per
shard; worker exit statuses propagate instead of being swallowed; the merger
refuses raced or incomplete shards; the counted merger fills each stratum's
registered quota in walk order rather than taking the first N overall.

## D4 — 2026-09-03, the pilot is mined sequentially

**What.** `mine-parallel.sh` now refuses to shard the pilot pool: `workers` must
be 1.

**Why.** Sharding the pilot is a protocol violation, not a performance choice.
Every repository a pilot worker touches becomes development data, so speculative
concurrency spends the frame on repositories no task will ever use. The first
parallel pilot run burned 254 of 500 to produce five provisional tasks.
Concurrency remains available to the **counted** pool, whose walk is not
sacrificial.

**Resume posture.** The pilot resumes with **one** worker. Concurrency is not
raised again until a repeated clone stress test on already-spent repositories
passes.
