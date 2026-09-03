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
| `iproute2` | **required** — the trajectory jail uses `ip netns`; without it `net-jail.sh selftest` fails |
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
| Pilot: 10 tasks + 20 trajectories | ~5 h | ~2 h |
| Counted at N=110: mining + 220 trajectories | ~50 h | ~15–20 h |

Parallelise **mining** freely — it scales with cores. Keep **trajectories**
sequential or at most two-wide: they are bounded by model latency and rate
limits, not CPU, and heavy concurrency distorts the very timings the round
measures.

## Mining

```
cd harness/taskbench/round4
TB_POOL=pilot ./mine-parallel.sh 4        # shards the walk, 4 workers
./merge-shards.sh pilot 4 10              # first 10 validated IN WALK ORDER
```

Sharding changes how the walk is executed, never what a gate decides: each
repository's verdict is independent, and the merge restores the registered
order. Sequential mining is still available and is the reference behaviour:

```
TB_POOL=pilot ./mine5.sh
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
