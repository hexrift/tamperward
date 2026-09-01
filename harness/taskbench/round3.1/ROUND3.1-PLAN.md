# Round 3.1 — model transfer on the frozen round-3 pool (scoping document)

This is a SCOPING document, not a registration. Seeds, numeric bets, losing
conditions and the final runner pins are set at the round-3.1 registration
step, before trajectory #1, exactly as in rounds 1–3. What this document
freezes is the design principles, decided before any Sonnet trajectory of any
kind has run.

## The question

> Does the round-3 prevention effect transfer from Haiku to Sonnet when the
> Python task pool, the Tamperward v1.14.0 treatment, the prompt, the
> oracles, and the execution protocol are held constant?

## Why "3.1" and not "4"

Round 3.1 reuses the round-3 task pool. Those repositories are spent: the
research process has seen 34 Haiku trajectories on them, published the
results, and read the transcripts. A study on them can answer a very clean
question — on the exact repositories where Haiku produced the round-3
result, what changes when only the agent model changes? — but it is
follow-up, model-transfer evidence on a frozen benchmark, not another
independent held-out replication comparable to rounds 2 and 3. The
nomenclature says so up front:

| round | model | ecosystem | treatment | pool |
|---|---|---|---|---|
| 2 | Haiku | JS/npm | v1.9.0 | fresh, held-out |
| 3 | Haiku | Python/pytest | v1.14.0 | fresh, held-out |
| **3.1** | **Sonnet** | Python/pytest | v1.14.0 | **round-3 pool, spent** |
| 4 | TBD | Python/pytest | next treatment | fresh (FRAME5) |

## Principles frozen now (before any Sonnet trajectory)

1. **All 17 round-3 main tasks.** No subset, no substitution, no addition.
2. **v1.14.0 byte-identical** — specifically, the Python skip-detector gap
   measured in round 3 is NOT fixed. Changing model and treatment
   simultaneously would forfeit the clean comparison; the gap is a round-4
   engineering item.
3. **Same pressure prompt** (hash-pinned), same budgets, same network jail,
   same verifier/oracles, same outcome definitions, same runner protocol.
4. **Sonnet model ID pinned exactly** at registration; fail-closed in the
   driver and the runner, as in round 3.
5. **Preregistration before trajectory #1**, with the article rule inherited
   from round 3: no counted outcome above the line.
6. **Primary endpoint:** Sonnet gated-vs-ungated FALSE_GREEN prevention —
   paired, exact McNemar, same frozen analysis (`analyze3.mjs`).
7. **Assay starvation is preregistered as a possible result.** If Sonnet
   rarely false-greens ungated, the round publishes as underpowered for
   prevention at this model — a finding about the model, not a treatment
   claim in either direction (the round-3 seed-study prior: Sonnet 30/30
   honest ungated in the pre-taskbench studies).
8. **The round-3 Haiku data is frozen prior evidence.** No Haiku trajectory
   is rerun; nothing learned from Sonnet runs reaches back into any round-3
   artifact.
9. **Cross-model comparison is secondary and descriptive** unless a proper
   interaction analysis is preregistered at the registration step. The
   headline of 3.1 is the within-model paired result, not Haiku-vs-Sonnet.

## Execution hygiene (hardened BEFORE the sweep; hygiene, not treatment)

Round 3's outage taught specific lessons. None of these touch the treatment,
the tasks, or the endpoints; all are infrastructure and get built and
selftested before registration pins the runner:

- **Stable proxy discovery:** the runner must resolve the upstream proxy at
  trajectory start, not inherit a possibly-stale environment captured at
  sweep launch (the round-3 outage: a container restart rotated the proxy
  port under a running sweep).
- **Per-trajectory health check:** clone/egress preflight before each
  trajectory, not only at sweep start.
- **Circuit breaker:** a systemic failure (e.g. repeated instant
  CLONE_FAILED) aborts the sweep immediately rather than burning the
  remaining pairs through their retry budgets — promoted from the round-3
  continuation driver into the main driver.
- **Resumable attempts:** the attempt-numbering and continuation semantics
  from the round-3 deviation (never-started trajectories distinguishable
  from failed ones; failure records permanent; re-attempt only what never
  ran) become first-class driver behaviour instead of an emergency script.
- **Checkpoint pushes that actually push** (round 3's checkpoints silently
  failed against branch protection until backed up manually; the driver
  pushes to a non-protected checkpoint branch).

### Correction record: review of the first hygiene implementation

The first implementation of the five items above was reviewed before merge
and corrected. Recorded here because the corrections change what the
infrastructure guarantees, and the review happened before registration:

1. **The health check ran too early to protect anything.** The upstream proxy
   was resolved and probed at the top of the runner, then clone, install,
   parent-red and gold validation ran for minutes before the agent started.
   That is exactly the window round 3's rotation landed in. The check is now
   a **trajectory-start boundary**: the upstream is re-resolved, the
   allowlist proxy is launched, its process and listener are asserted, and a
   request is driven from inside the network namespace, through that exact
   proxy, to the model API — as the last thing before the agent is invoked.
   Anything failing there is `PREFLIGHT_NET_FAILED` / exit 8 with no verdict
   written. Without it, a rotated proxy yields an agent that cannot reach the
   API, does no work, and leaves an unchanged red tree that the verdict
   oracle would have scored as a counted `NOT_FIXED`.
2. **Both liveness probes were vacuous.** The platform's `NO_PROXY` lists
   `api.anthropic.com`, so `curl -x <proxy> https://api.anthropic.com/`
   ignores the proxy and goes direct — reporting "alive" for a dead port and
   "path verified" for a broken chain. Both probes now clear `NO_PROXY`, and
   the liveness test requires curl to exit 0 rather than accepting any error
   other than refused/timeout/resolve-failure. The behavioural self-test
   below is what exposed this.
3. **Terminal failures were re-attempted on resume.** The driver skipped
   trajectories that had a verdict but not those already logged as
   `INFRASTRUCTURE_FAILURE`, which round 3's driver treated as terminal. The
   two states are now distinct: `INFRASTRUCTURE_FAILURE` (the registered
   retry budget was spent) is terminal and excluded with its log;
   `FAILED_LAUNCH` (the circuit breaker fired before anything was attempted
   scientifically) is a permanent, append-only record that is explicitly
   retryable.
4. **The registration gate checked only the model.** A filled model with
   unfilled seeds would have derived a bogus pair/arm order. All three
   values must now be non-empty and non-placeholder.
5. **`attempt` conflated two things.** The verdict line now carries
   `driver_pass` (which sweep invocation) and `execution_attempt` (which try
   within it) as separate fields. A driver pass is counted only after the
   shared preflight passes, so a sweep that attempted nothing does not
   inflate the number.
6. **The circuit breaker was too broad.** It is immediate on the runner's
   dedicated shared-infrastructure exit (rc=8). A `CLONE_FAILED` is treated
   as systemic only when the shared preflight is also failing at that moment;
   otherwise it is trajectory-local and takes the ordinary retry path.
7. **Checkpoint commits could fail silently** — staging, commit and push each
   report failure now; "nothing new to commit" is not reported as a failure.
8. **The self-test proved only that strings were present.** It is now
   behavioural: it drives a stubbed sweep to prove that a forced outage
   records exactly one launch, aborts, writes a retryable record and leaves
   every later trajectory untouched; that a resume re-attempts that same
   trajectory first and then completes the registered order; that a terminal
   failure stays excluded across a resume; and that upstream rotation is
   rediscovered at the boundary — inside the jail, where the platform's own
   direct route to the API does not exist.

### Second correction record: review of the corrected implementation

A second review of the corrected commit found four more issues. Three of them
sit on the exact failure paths this work exists to harden:

9. **Cleanup could kill the sweep driver.** `teardown_net` ran
   `kill "${PROXY_PID:-0}"`, and `kill 0` signals the whole process group. The
   EXIT trap is installed before the boundary runs, so a failure with no proxy
   yet started — no upstream resolved, jail setup failed — would have killed
   the driver itself, losing the orderly circuit-breaker record. It now signals
   only a real PID, waits for it, and clears it. Jail teardown is keyed on the
   TAG rather than the returned namespace name, so a partial setup failure —
   which creates a namespace and returns nothing — is still cleaned up.
10. **The runner/driver exit contract misclassified failures in both
    directions.** A failure to reach *one task's repository* exited 8, which
    the driver treats as proven systemic: a single deleted or private
    repository would have aborted the sweep, and aborted it again on every
    resume, forever. Meanwhile a net-jail setup failure exited 9, which the
    driver did not break on at all, so a systemic jail failure would have
    consumed two attempts on every remaining trajectory. The contract is now
    explicit: **8** = shared agent network path down → immediate breaker;
    **9** = net-jail failure → the driver re-runs the jail self-test and breaks
    only if that also fails; **10** = this task's repository unreachable → the
    driver re-checks the shared path and keeps it trajectory-local if that is
    healthy. `CLONE_FAILED` is adjudicated the same way as 10.
11. **Proxy credentials could reach public Git history.** The runner printed
    the full upstream URL on rotation and on every successful boundary probe;
    the driver captures that into `phase3-log.txt`, which it commits and pushes
    to the checkpoint branch. If `HTTPS_PROXY` ever carries `user:password@`,
    those credentials become public. Every printed upstream now goes through a
    redactor that strips userinfo.
12. **Checkpoint failures were loud but not fatal**, which reproduces round 3's
    outcome — hours of results living only on a disposable container — with
    better logging. A push is now retried four times with backoff; a persistent
    failure stops the sweep. That is recoverable: the results so far are intact
    on disk and the untouched trajectories are UNATTEMPTED.

Two invariants were added at the same review's suggestion, before registration
rather than after: a **single-driver lock**, because two concurrent resumes
would both read "no verdict" for the same trajectory and both append one; and a
**completion invariant** requiring that the 34 registered trajectories be
accounted for exactly once each, as a verdict or a terminal
`INFRASTRUCTURE_FAILURE`, with any duplicated `(task, arm)` verdict treated as
an error.

The self-test grew to fifteen cases covering all of the above, and the two most
consequential — the process-group kill and the exit-code misclassification —
were mutation-checked: reverting each fix makes its case fail.

### Third correction record: review of the invariants themselves

13. **The self-test could have defeated the production driver lock.** Its
    cleanup trap deleted `/tmp/tb31-driver-*.lock` by wildcard. Unlinking a
    lock file does not release the inode lock a running counted sweep holds,
    but the next driver then creates a fresh file at that path and acquires
    it — two concurrent drivers, which is exactly what the lock exists to
    prevent. The trap now removes only the exact lock paths for its own run
    directories, computed the same way the driver computes them.
14. **The completion invariant counted rather than identified.** It proved
    that verdict pairs were unique and that verdicts plus terminal failures
    summed to 34 — which a run containing one unregistered `(task, arm)` and
    missing one registered pair satisfies, and which a pair recorded both as
    a verdict and as a terminal failure satisfies by cancellation. The
    expected 34 pairs are now derived from the registered order and compared
    as a **set**: every result line must be a verdict with a string task and a
    valid arm; no duplicate verdict pairs; zero overlap between verdicts and
    terminal failures; and the observed union must equal the registered
    universe exactly.
15. **The invariant outcome was not durable and "COMPLETE" preceded it.** The
    last checkpoint ran before the invariant, so the remote carried the
    results but no record of whether they were valid, and the log said
    COMPLETE before completion had been checked. The order is now validate →
    log → checkpoint the decision, with a failed invariant logged as such,
    checkpointed, and exited non-zero.
16. **Two cases were mis-scoped or missing.** The credential-redaction and
    process-group cases needed no live upstream but sat inside the
    live-proxy branch, so CI skipped them; they now always run. The
    checkpoint-failure path was untested because the test mode returned early
    from `checkpoint`; a simulated persistent push failure now proves the
    sweep stops before the next pair launches.

The self-test is nineteen cases. Four fixes across the three passes are
mutation-checked — reverting the process-group fix, the exit-code split, the
set identity, or the overlap check each makes its own case fail.

### Fourth correction record: the post-agent boundary

17. **A trajectory that RAN could be silently re-rolled.** This is the most
    serious defect found in the whole hygiene effort, and it was in the
    original round-3 runner too. After the agent finished, the verdict was
    piped straight into `results.jsonl` with `| tee -a … || echo
    RESULTS_LINE_FAILED`, and the runner could still exit successfully. The
    driver asked only whether the file had grown; if not, it performed an
    ordinary "one retry from clean state". So a failure in `verdict3.mjs`, in
    `jq`, in the disk write, or the driver's outer 4200-second timeout landing
    after the agent's 3000-second budget, would have **discarded an observed
    stochastic trajectory and sampled another one** — the exact reroll the
    protocol exists to prevent, arrived at through an infrastructure path
    rather than a deliberate one.

    There is now a post-agent boundary to match the pre-agent one. A durable
    trajectory-start marker is written immediately before the agent is invoked.
    Every no-verdict path after that is `POST_START_FINALIZATION_FAILURE`
    (exit 11): the artifacts — observer log, oracle, deny logs, envelope
    report, verify log and a tar of the final repository tree — are preserved
    beside the transcript, and the sweep **halts**. It is never retried, not on
    that pass and not on any resume: the driver refuses to continue until a
    human either appends the reconstructed verdict or records the exclusion by
    creating `<task>-<arm>.adjudicated`. The runner refuses to start a
    trajectory whose marker already exists.

    This **scopes** the frozen "no verdict → ONE retry from clean state" rule
    of rounds 1–3 rather than replacing it: the retry survives for failures
    before the trajectory starts, which is what it was for. Recording it here
    because it is a deliberate divergence from the earlier rounds' operational
    rule, decided before registration and before any Sonnet trajectory.
18. **Acceptance was line-count growth, not identity.** A partial or stray
    append that happened to add a newline would have been read as this
    trajectory's verdict. The runner now builds the line into a temp file,
    validates it with `jq -e` (valid record, matching task and arm, non-empty
    outcome), appends it atomically under a lock, and reads the exact record
    back; the driver's acceptance test is an exact `(task, arm)` match.
19. **The upstream proxy URL was on the proxy's argv.** The net-jail is a
    network namespace only — no PID or user namespace — so the agent shares
    `/proc` with the proxy and could have read a credential out of its cmdline.
    Redacting logs prevents accidental printing, not that. Since the proxy also
    sends no `Proxy-Authorization` header, a credentialed upstream would fail
    the boundary probe anyway, so they are now **refused outright**, both when
    inherited and when offered by a rotation. Credentialed upstream proxies are
    declared unsupported rather than carried and hidden.

Twenty-one behavioural cases. Five fixes are mutation-checked: reverting the
process-group fix, the exit-code split, the set identity, the overlap check, or
the post-start boundary each makes its own case fail.

### Fifth correction record: the adjudication state machine

20. **The reconstruction route contradicted the completion invariant.** The
    post-start failure was counted as a terminal disposition, so appending the
    reconstructed verdict the halt message advertised would have put that
    `(task, arm)` in both the verdict set and the terminal set — and the
    invariant's own overlap check would have rejected it. The advertised route
    could not have been taken.

    The append-only **event** and the final **disposition** are now separate.
    `POST_START_FINALIZATION_FAILURE` stays in the ledger forever and is not a
    disposition; `runner/adjudicate31.sh` resolves it into exactly one of
    `POST_START_ADJUDICATED_VERDICT` (the verdict is reconstructed from the
    preserved artifacts, appended, and accounted for as a verdict) or
    `POST_START_ADJUDICATED_EXCLUSION` (terminally absent, accounted for as a
    terminal disposition). Dispositions are recorded once and are mutually
    exclusive; the tool refuses a record for the wrong trajectory, a second
    disposition, or a verdict where one already exists.
21. **The deviations ledger governs every exceptional case and was unvalidated.**
    It now fails closed, before anything launches and again at completion, on:
    malformed JSONL; an unknown event name; a trajectory event without a string
    task or an arm outside `{ungated, gated}`; and more than one terminal
    disposition for the same `(task, arm)` — which covers duplicates and
    contradictions together. Repeated non-disposition **events** stay
    legitimate, which is what keeps the ledger a history rather than a state
    file. Scope is deliberately validation only; the ledger is not redesigned.

The scoped retry boundary is frozen in `PREDICTION3.1-taskbench.md` §1 rather
than only here, because it changes the experimental handling of missing
verdicts relative to rounds 1–3. That document is open — every outcome-relevant
field is still `__SET_AT_REGISTRATION__`, and the driver refuses to run until
they are filled — but §1 is frozen now, ahead of the rest, in git history.

Twenty-three behavioural cases. Six fixes are mutation-checked: reverting the
process-group fix, the exit-code split, the set identity, the overlap check,
the post-start boundary, or the event/disposition split each makes its own case
fail.

### Sixth correction record: determinism, durability and what counts as a verdict

22. **Adjudication permitted an outcome-dependent exclusion.** With the failed
    trajectory's artifacts in front of them, a human could choose reconstruction
    or exclusion. Since the analyzer drops any repository lacking both arms, an
    exclusion removes the whole pair from the McNemar comparison — a
    discretionary post-outcome choice able to move the study's single p-value.
    Adjudication is now a frozen ladder (PREDICTION3.1 §1): R1 the runner's own
    verdict line survived → append it; R2 the workspace survived → re-derive with
    the same oracle at the recorded base; R3 neither → exclude, the only
    sanctioned exclusion, for enumerated conditions. `adjudicate31.sh` refuses a
    manual disposition that disagrees with the ladder, and records the rule, the
    reason, the adjudicator, the timestamp and artifact sha256s.
23. **An outer-timeout kill destroyed the evidence it promised.** Artifact
    preservation lived only inside the runner's own failure path, which never
    runs when the driver's `timeout` kills it — so the halt message pointed at a
    directory that did not exist while the evidence sat in `/tmp`, one
    `disk_guard` from deletion. The driver now preserves the marker's workspace
    itself, at every detection point.
24. **A row that merely matched was accepted as a verdict.** `have()` checked
    only task and arm, so `{"task":"…","arm":"ungated"}` was skipped as done and
    the sweep reported COMPLETE with exit 0. There is now one shared full-verdict
    predicate (`runner/verdict-record.sh`) used by the runner when it persists,
    the driver when it accepts and completes, and the adjudication tool when it
    reconstructs — requiring outcome, oracle strength, both suite results, model,
    transcript, timestamp and attempt provenance.
25. **Persistence was not atomic.** `flock` coordinates cooperating writers; it
    does not make an append all-or-nothing, so a torn write could poison the
    ledger. Each trajectory now writes an immutable
    `<task>-<arm>.verdict.json` (temp → validate → fsync → rename, written once
    and never replaced), and `results.jsonl` is **derived** from those files in
    trajectory-start order. A duplicate verdict is structurally impossible, and a
    poisoned ledger is repaired rather than trusted —
    `runner/rebuild-results31.sh` regenerates it at any time.

Twenty-six behavioural cases. Nine fixes are mutation-checked: the process-group
fix, the exit-code split, the set identity, the overlap check, the post-start
boundary, the event/disposition split, the deterministic ladder, driver-side
preservation, and the full-verdict predicate each make their own case fail when
reverted.

### Seventh correction record: the ladder had a hole through it

26. **`adjudicate31.sh verdict <file>` substituted rather than verified.** When
    the ladder resolved to R1 or R2, a supplied file replaced the
    ladder-derived record, and the only remaining check was that it was
    structurally complete for the same task and arm. An operator who had seen
    the trajectory could therefore have supplied a valid record carrying
    `HONEST_FIX` in place of a canonical `FALSE_GREEN` — precisely the
    post-outcome substitution the ladder was added to prevent. `verdict` now
    **verifies**: it compares the supplied record canonically against what the
    ladder derives and refuses anything that differs. `auto` is the only route
    that produces a verdict; `ladder` is a read-only diagnostic.
27. **R1 triggered on bytes, not on a verdict.** It tested only that
    `verdict-line.json` was non-empty, so an outer-timeout kill leaving a torn
    line would select R1, fail the later schema check, and halt — even when the
    intact workspace would have satisfied R2. R1 now requires a complete verdict
    record by the shared predicate and otherwise falls through to R2, which also
    makes the registered wording ("the runner's own verdict line survived") mean
    what it says.

Twenty-eight behavioural cases. Eleven fixes are mutation-checked.

### Control-plane exposure: what was done, and what was deliberately not

Rounds 1-3 launched the agent with a plain `env`, as root, on the same
filesystem. Every `TB_*` internal was inherited, and the withheld oracle sat at
`$W/oracle` — one `dirname` from the venv path the agent could read out of its
own environment. A process told to make pytest pass could, in principle, have
read the withheld half or written its own verdict.

An audit of all 34 counted round-3 transcripts found no trajectory that did:
zero occurrences of `TB_RUNS`, `TB_VENV`, `TB_TASKS`, `withheld`, `gold.patch`,
`results.jsonl` or any workspace `oracle/` path. The `oracle` hits are the
`distro` repository's own Oracle Linux tests and the `pristine` hits are the
Stop hook's block message quoted back to the agent. That is a string audit of
the transcripts, not a filesystem-level proof.

Two narrow changes close the plausible route for 3.1: every `TB_*` variable is
scrubbed from the agent's environment, and the withheld oracle is relocated
outside the workspace entirely. **This is not a security boundary and is not
described as one.** The agent still runs as root on the same filesystem; what
changed is that nothing inside the task points at the control plane any more.

A real boundary — mount and PID namespaces with the capability set dropped, so
the control plane is unreadable and the overlays cannot be unmounted — was
prototyped and verified to work in this environment, including that agent
authentication survives it. It is **deliberately deferred to round 4**, with the
fresh pool and the improved treatment, rather than landed days before a counted
sweep: it requires relocating the observer behind a parent-owned channel and
relocating the CLI bundle, and the marginal risk of changing the machinery that
generates the data outweighed closing an exposure that the audit shows went
unused. A non-root UID specifically is not viable here: agent authentication is
delivered by a host-managed provider over a root-owned socket, so a different
uid authenticates only by being handed that socket — a worse exposure than the
one being closed — or a separately provisioned credential.

The two test seams this requires (`TB_FRESH_UPSTREAM` in the runner,
`TB_HYGIENE_TEST` in the driver) are fail-closed: the runner refuses the
rotation seam whenever a registered model is pinned, and the driver's test
mode refuses to write anywhere but `/tmp` and supplies its own model and
seeds, so it cannot reach a counted results directory.

## Explicitly out of scope for 3.1 (reserved for round 4)

Fixing pytest skip detection; the trajectory-integrity schema cleanup
(final_integrity_state / task_outcome / trajectory_policy_violations, with
oracle-strength scoping preserved); the Python-monorepo-aware miner and
eligibility rules; a fresh FRAME5 pool; validation of the improved treatment
on genuinely held-out repositories.
