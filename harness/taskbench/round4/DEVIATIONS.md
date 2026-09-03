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

### D3 second correction (append-only) — 2026-09-03, after review of the recovery

The recovery committed at `f8d2d3a` was itself incomplete. Independent review
found six defects in it, two of which could have recreated the runaway. All are
corrected here; nothing was resumed in between.

**Figures corrected.** The checkpoint carried **245 `CLONE_FAILED` lines across
127 clone-failed repositories**, while **154 unique repositories** appear
anywhere in the ledgers. The earlier entry blurred those two denominators.

**Affected interval corrected.** `21481b6..ff8b94b` omitted the first
contaminated checkpoint. The contaminated interval begins at `47980e9`;
expressed from the last clean checkpoint it is **`f2b48c6..ff8b94b`**.

**P0 — a pilot shard could have consumed the remaining 246.** The one-worker
driver defaulted `TB_PILOT_NEED=99`, and `mine5.sh` selected its defaults on
`$POOL` rather than `$BASE_POOL`, so `pilot-s0` was configured as **counted**
(need 0, quotas 55/55). Configuration now keys off `BASE_POOL`, a pilot need
above 20 is refused outright, and the pilot no longer goes through the sharding
driver at all: `launch-mine.sh pilot` runs `mine5.sh` directly with need 10.

**P0 — clone failures were still terminal.** The shim returned 1, `mine5.sh`
wrote `CLONE_FAILED` and continued, so a tripped breaker could poison every
remaining repository before any driver noticed. Clone exhaustion is now a
dedicated `INFRASTRUCTURE_FAILURE`: it emits no terminal verdict, records the
event, trips the breaker, and **kills the miner's process group immediately** so
no verdict can be written. Launchers refuse to start into a tripped breaker.

**P0 — worker status never propagated.** `if ! wait "$p"; then rc=$?` captures
the status of the *negation*, which is always 0. Reproduced directly: the buggy
form yields 0 where the fixed form yields 3. Status is now captured in the
`else` branch, and the first failure terminates the remaining workers.

**P1 — the launcher was not detached.** The claim of `setsid` was untrue; mining
ran from an ad-hoc `nohup` at a tool call, the supervision path round 3.1
recorded as unreliable. `launch-mine.sh` is committed, runs under `setsid`, and
writes PID and exit-status files.

**P1 — the merger could not prove completion.** An unlocked shard may simply
have crashed. `mine5.sh` now writes a per-shard `completion.json` bound to that
shard's walk hash, and the merger requires one from every shard. Stratum mode is
derived from the pool rather than an opt-in env var; a quota shortage, a
malformed manifest, a task naming a repository outside the walk, and a
repository producing tasks in two shards are each **hard failures**; the
destination is staged and published only after validation, replacing rather than
accumulating.

**P1 — incident evidence was incomplete.** The shard logs were on disk but never
committed (ignored by pattern), so 100 burn entries lacked committed source
evidence. The raw logs, the independent `pahaz/sshtunnel` clone control
(`rc=0` with every worker stopped), and `build-burn-list.py` — which regenerates
and `--check`s the burn list from that evidence — are now committed. The check
passes: committed 254, regenerated 254.

**P1 — the frozen walk had been overwritten.** `pools/pilot/walk.json` was a
**symlink** into `frame/`, so writing the 246-entry remainder through it
destroyed the registered 500-entry artefact. `frame/pilot-walk-order.json` is
restored byte-for-byte from the freeze-1 commit; the remainder now lives in
`frame/pilot-resume-walk.json`, and the active pool holds a real file, not a
link.

**Protocol — the pilot unit.** `PILOT4.md` froze "exactly 10 repositories" while
the miner and runbook sought 10 validated tasks. At round 3's yield those cannot
both hold. A freeze-1 correction now defines the unit as **the first 10
validated regression tasks, with every examined repository burned**; the
original wording is preserved beside it.

**Documentation.** The runbook no longer instructs `mine-parallel.sh 4` for the
pilot, its parallel pilot estimate is withdrawn, and it records that the
trajectory jail is Linux-only, so a Mac needs a Linux VM for trajectories while
mining runs natively.

### D3 third correction (append-only) — 2026-09-03, self-tests

Writing the self-tests found two more defects in the recovery itself, both in
the mechanism meant to stop a poisoning walk:

- **The shim killed its whole process group.** It terminated the interactive
  shell running the first self-test. A shim must never do that.
- **Matching the miner by command line was guesswork.** The replacement walked
  the parent chain looking for `mine5.sh` in a process's cmdline and matched an
  unrelated shell that merely *mentioned* the script, killing the wrong process.

`mine5.sh` now exports `TB_MINER_PID`, and the shim terminates exactly that pid
when one is live. With no miner named it exits 90 and kills nothing, which is
what makes the path safe to exercise in a test at all.

`selftest.sh` covers 18 cases, one per defect that actually occurred: `wait`
status propagation (with the buggy negated form kept as a regression sentinel),
the pilot need bound and that a shard name cannot dodge it, `BASE_POOL`
configuration, the refusal to shard a pilot from both entry points, breaker
refusals at launch and at merge, the shim raising an infrastructure failure
rather than a clone failure, the merger refusing a missing completion record, an
out-of-walk task and a malformed manifest, the frozen walk being a real file of
500 entries, and the burn list regenerating from committed evidence. All 18
pass. It runs no clone and touches no frame.

### D3 fourth correction (append-only) — 2026-09-03, the stated root cause is REFUTED

The gate before resuming was a clone stress test on already-spent repositories.
It was run, and it does **not** reproduce D3. The causal claim in the earlier
entries — that concurrent cloning through this environment's git proxy aborts —
is therefore **not established**, and is withdrawn.

**Pure clone stress** (8 spent round-3 repositories, the miner's exact clone
form, concurrency 1 → 4): `ok=8 failed=0` at **every** level, and concurrency
made it faster, 12s at 1 down to 4s at 4.

**Heavy stress, the actual D3 shape** (3 concurrent clone **and** `uv pip
install` pipelines over 9 spent repositories): `clone ok=9 clone_failed=0`,
with memory flat (15.4 GB available before, 15.3 GB after) and disk unchanged
at 21 GB.

**What survives as the explanation.** The one condition present during the
incident and absent from both tests is **process accumulation**. Relaunching the
miner without cleanly stopping the previous run left orphans: worker counts of
**5, then 6, then 8** were observed while three were intended. That matches the
independent finding of overlapping shard processes writing one ledger, and it
is a plausible source of the SIGABRTs that a controlled three-way run does not
produce. It is offered as the surviving hypothesis, not as a demonstrated cause
— the incident is over and cannot be re-run.

**Why the mitigations still stand.** They were justified on the wrong reasoning
but remain correct on better reasoning:

- the **per-shard lock** directly prevents the process accumulation that is now
  the leading explanation;
- the **no-terminal-verdict-on-infrastructure-failure** rule is
  **cause-independent**: whatever aborts a clone, the miner must not convert it
  into a permanent `CLONE_FAILED`. That is the defect that turned an
  infrastructure problem into 245 poisoned verdicts, and it is fixed regardless
  of what caused the aborts.

**Consequence for concurrency.** Clone concurrency up to 4 is measured clean for
the **counted** pool. The pilot remains sequential by protocol (D4), which is
unaffected either way.

Evidence: `incident-D3/clone-stress.txt`, `incident-D3/clone-stress-heavy.txt`,
reproducible via `clone-stress.sh` and `clone-stress-heavy.sh`.

### D3 fifth correction (append-only) — 2026-09-03, the burn set is two sets, not one

The third correction's self-test asserted that `frame/pilot-dedup.json`
regenerates unchanged from committed evidence. That assertion is wrong while the
pilot runs, and it failed for the right reason at the wrong time: the resumed
sequential pilot had legitimately burnt **12 further repositories**, so the
regenerated set was 266 against a committed 254 and the self-test reported a
defect where there was none. Nothing was lost or mis-accounted; the check was
holding a growing quantity to a constant.

Two sets follow from the burn rule and they are now kept apart:

- **`incident-D3/burnt-254.json` — the D3 episode's own burn set.** Reconstructed
  from incident evidence alone (the shard `[walk]` entries union the pre-purge
  ledgers); no live ledger is consulted. It is history: 254 repositories,
  frontier depth 396 of 500, and it must regenerate for ever. It is what the
  earlier corrections meant by "the 254", and it is unchanged by this entry.
- **`frame/pilot-dedup.json` — the pilot's full exclusion set.** The incident set
  union every repository the live pilot has since drawn. It **grows while the
  pilot runs**, by design, and its final value is the counted frame's
  `pilot_dedup`, republished before the counted draw.

`build-burn-list.py --check` now proves the two invariants that actually hold at
any moment: the incident set still regenerates exactly, and no repository has
ever **left** the burn set. Growth passes; a repository disappearing from the
published set, or incident evidence going missing, fails. Both directions are
pinned by self-tests, including a sentinel that appends a fresh ledger entry and
requires the check to pass.

No counted or pilot outcome depends on this entry: it corrects an accounting
check, not the accounting. The published exclusion set is unchanged in content
beyond the repositories the running pilot has drawn.
