# Round 4 — running it on your own machine

Written for a quad-core box with 16 GB and ample disk, which is what the timings
below were measured on. CPU and memory are not the constraint; **bandwidth is**,
because the dominant per-repository cost is a clone plus a `pip install`.

## What it needs

| | |
|---|---|
| Node | 20+ (22 used here) |
| Python | 3.11.x |
| `uv` | 0.8.x — round 3 pinned 0.8.17 |
| `git`, `jq` | any recent |
| `iproute2` | **required** — the trajectory jail uses `ip netns`; without it `net-jail.sh selftest` fails. **Linux only**: on macOS run trajectories inside a Linux VM (Docker/Colima with `--cap-add=NET_ADMIN`); mining itself runs natively on macOS |
| `nftables` | required by the same jail |
| `claude` CLI | for trajectories only, not for mining |

Prove the jail before anything else:

```
bash harness/taskbench/runner/net-jail.sh selftest
# expect: proxy port reachable; other host port blocked; numeric + DNS egress blocked
```

## Measured timings (rounds 3 and 3.1, real ledgers)

- Mining: 20 tasks in 5.5 h sequential; median 8 min between tasks, mean 17, max 97.
- Trajectories: 64 runs, median 2.4 min, mean 5.8, max 51.6.

| Phase | Sequential | 4 workers |
|---|---|---|
| Pilot: 10 tasks + 20 trajectories | ~5 h | **sequential only — see D4** |
| Counted at N=110: mining + 220 trajectories | ~50 h | ~15–20 h |

Parallelise **counted** mining freely — it scales with cores. Never parallelise
the **pilot**: it is sacrificial, and concurrency burns frame. Keep **trajectories**
sequential or at most two-wide: they are bounded by model latency and rate
limits, not CPU, and heavy concurrency distorts the very timings the round
measures.

## Mining

**The pilot is mined sequentially. This is a protocol rule, not a preference**
(DEVIATIONS.md D4): every repository a pilot worker touches is burnt, so
speculative sharding spends the frame on repositories no task will use. The
first parallel pilot run burned 254 of 500 producing five provisional tasks.

```
cd harness/taskbench/round4
./launch-mine.sh pilot                    # detached, sequential, PID + status files
```

Concurrency is available to the **counted** pool only, whose walk is not
sacrificial:

```
./launch-mine.sh counted 4
./merge-shards.sh counted 4 110           # first 110 validated tasks in walk order
```

Both are resumable — rerun after any interruption and decided repositories are
skipped on their repo-level verdict line.

## Checking and stopping a miner

```
./status.sh pilot                         # or counted
```

`mining sessions` is the number that matters: **1 is healthy, more than 1 is
accumulation** — stop everything. It counts distinct session ids, not command
lines: `pgrep -fc mine5.sh` also matches the launcher wrapper and the shell
doing the looking, and even exact-argv matching counts a miner's own subshells.
The `processes` line is reported only so those two numbers are never confused.

Monitoring detects accumulation after the fact; the **lock** prevents it.
`mine5.sh` holds an exclusive lock on its pool for its whole lifetime, so a
second launch on the same pool exits 7 rather than appending to the same ledger.

**Stop a miner by stopping its session**, not by killing the script. The pool lock
is held by a flock GUARDIAN, not by a descriptor of the miner shell, so descendants
no longer inherit it — that inheritance was the old design and is asserted against
in `selftest.sh`. Stopping the session is still the right move: it reaps the whole
tree, including a clone or a suite run that would otherwise keep working in a
directory the next miner is about to reuse.

The pid in the pid file is the miner's own, published by the session child itself
(and equal to its session id), not the launcher's `$!` — which setsid can leave
pointing at a process that has already exited.

```
sid=$(cat /tmp/tb-mine-pilot.pid)         # the launcher is its own session leader
pkill -TERM -s "$sid"; sleep 5; pkill -KILL -s "$sid"
./status.sh pilot                         # expect: mining sessions 0
```

## Surviving interruption

Everything is built for it, because round 3 lost eight pairs to a disposable
container:

- the miner resumes on repo-level verdicts;
- the sweep driver resumes by rerunning it, skipping trajectories that already
  carry a verdict, under a lock so two drivers cannot race;
- **H5**: the driver commits and pushes each verdict to a non-protected
  checkpoint branch, with backoff, and treats a persistent push failure as
  fatal.

Run it under `tmux` or `screen` and you can close the laptop.

## Disk

One worker holds ~200 MB steady state — the miner clears the repo and venv
between repositories. The peak is what bites: a repository pulling torch or
onnx builds a multi-gigabyte venv, and four workers can land on four heavy ones
at once. With ample disk this is a non-issue; on a tight allowance, drop to
two or three workers.

## Running the pilot

The pilot's registration is frozen in `PILOT-EXECUTION-MANIFEST.json` — the ten
fresh tasks, the trajectory order, the arm order, the treatment, the runner and
the recorded environment. `PILOT-EXECUTION-MANIFEST.md` is a rendering of it.

**Before trajectory one, every time:**

```
node harness/taskbench/round4/freeze-pilot-manifest.mjs --check
```

| exit | meaning |
|---|---|
| 0 | the frozen manifest describes this tree — proceed |
| 2 | **binding drift.** Something that shapes the measurement changed. Do not run |
| 3 | **environment drift.** Record it in `DEVIATIONS.md`, then proceed |
| 4 | the artefact is not deployed here, so the treatment could not be verified |

The order is derived from two registered seeds, so **which trajectory is the dry
run was fixed in advance**: seq 1 is `15-pydata-numexpr`, gated arm. Run it, then
the remaining 19 in manifest order. A task's two arms run adjacently.

Trajectories need a credential, which lives **outside the repository** —
short-lived and spending-limited, with only its fingerprint recorded (a one-way
sha256 prefix, per trajectory, by `run-task4.sh`). `run-task4.sh` also refuses a
real-agent trajectory unless `TB_RUNTASK4_READY=1`, which is set only once the
freeze checklist is complete and that credential is provisioned.

Re-freezing is a registered act: `--derive` refuses to overwrite a manifest that
differs unless `TB_PILOT_REFREEZE=1`, and the reason goes in `DEVIATIONS.md`,
append-only.

## What is NOT ready

- **A counted sweep driver.** `run-task4.sh` runs one trajectory; round 3.1's
  `phase3-sweep31.sh` is not wired to the round-4 manifest, so the pilot's 20
  trajectories are driven one at a time against the frozen order. A counted
  round at N=110 needs the driver (resume on verdicts, one driver per results
  directory under a lock, H5 checkpoint pushes) before it can start.
- **The frame, for the counted round only.** At round 3's measured yield —
  ~14 substantive repository decisions per task — the frozen 500 caps out near
  35 tasks against the 110 the power simulation asks for. The pilot is
  unaffected. Enlarging means re-running `fetch-frame5.sh` with a larger
  target; the builder walked only 1,305 of 15,000 ranked packages to admit 500,
  so the depth is there. That amends freeze 1 and must be logged.
