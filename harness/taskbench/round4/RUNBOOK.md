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
./merge-shards.sh counted 4 110           # fills each stratum's registered quota
```

Both are resumable — rerun after any interruption and decided repositories are
skipped on their repo-level verdict line.

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

## What is NOT ready

- **The round-4 runner.** The trajectory runner is still round 3.1's. It needs
  the v2 deployment (init from the frozen package, `disableAllHooks: false`, no
  reachable sign-off) and the round-4 outcome schema. See PILOT4.md for the
  wiring constraint already established: a `PostToolUse` observer beside the
  init-written gate is clean, a second `Stop` entry is hook-tampering, so
  pristine verification runs parent-owned after the agent exits.
- **The frame, for the counted round only.** At round 3's measured yield —
  ~14 substantive repository decisions per task — the frozen 500 caps out near
  35 tasks against the 110 the power simulation asks for. The pilot is
  unaffected. Enlarging means re-running `fetch-frame5.sh` with a larger
  target; the builder walked only 1,305 of 15,000 ranked packages to admit 500,
  so the depth is there. That amends freeze 1 and must be logged.
