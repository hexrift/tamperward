# Running round-4 mining on a Mac

The remote container reaps detached background processes: the pilot was killed
outright twice — no exit status, no signal, ~14 seconds into a resumed run —
which is the supervision failure round 3.1 already recorded and `setsid` does not
fix. Mining is long-running and must outlive whoever started it, so it runs
better on a real machine.

Nothing about the protocol changes. The ledger is committed, the walk is frozen,
and the miner resumes from repository-level verdicts, so a local run continues
exactly where the remote one stopped.

## One-time setup

```bash
# GNU tools the miner needs: flock, setsid, timeout
brew install util-linux coreutils git node python@3.12 uv

# util-linux and coreutils are keg-only — put them ahead of the BSD versions
echo 'export PATH="/opt/homebrew/opt/util-linux/bin:/opt/homebrew/opt/util-linux/sbin:/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH"' >> ~/.zshrc
exec zsh -l

# verify — all three must resolve under /opt/homebrew
command -v flock setsid timeout
```

On an Intel Mac use `/usr/local/opt/...` instead of `/opt/homebrew/opt/...`.

## Get the repository

```bash
git clone https://github.com/hexrift/tamperward.git
cd tamperward
git checkout round4/miner
npm ci
cd harness/taskbench/round4
```

## Run the pilot

```bash
./launch-mine.sh pilot          # detached, sequential — the only pilot mode
./status.sh pilot               # check any time
```

`launch-mine.sh` refuses to start a second miner, and `mine5.sh` holds an
exclusive lock on the pool for its whole lifetime, so a stray second launch
exits 7 rather than corrupting the ledger.

Expect **roughly 140 repositories** for the pilot's 10 validated tasks, at round
3's measured yield of 14.0 repositories per task. Each repository is a shallow
clone, a virtualenv, and up to 8 candidate commits each running the suite under
a 300 s timeout, so a few minutes per repository is normal and a large
repository can be silent for much longer. Sequential is a protocol rule, not a
performance choice: every repository the pilot touches is burnt.

## Reading `status.sh`

| line | what it means |
| --- | --- |
| `mining sessions` | **1 is healthy.** 0 with an exit status = finished; 0 without = it was killed. More than 1 is accumulation — stop everything. |
| `processes` | parent plus subshells. Never a miner count; it is printed only so the two are not confused. |
| `heartbeat` | seconds since the last repository started. Distinguishes *working slowly* from *dead*, which the log alone cannot. |
| `CLONE_FAILED` | must stay **0**. Non-zero is the D3 regression. |
| `breaker` | `clear`. If it trips, the clone path failed and the miner stopped itself before writing a terminal verdict. |
| `exit status` | `signal:TERM` etc. if trapped; "killed outright" if the process vanished. |

## Stopping

Stop the **session**, not the script — descendants inherit the lock descriptor:

```bash
sid=$(cat /tmp/tb-mine-pilot.pid)
pkill -TERM -g "$sid"; sleep 5; pkill -KILL -g "$sid"
./status.sh pilot               # expect: mining sessions 0
```

(`-g` is the process group; on Linux `pkill -s` for the session works too.)

## When it finishes

`status.sh` shows `tasks 10` and an exit status of 0. Then:

```bash
python3 incident-D3/build-burn-list.py     # republish the cumulative burn set
git add -A . && git commit && git push     # the ledger, tasks and burn set
```

Push the branch and I will take it from there — the freeze checklist against
v2.10.1, then the FRAME5-AMENDMENT-2 mapping, then freeze 2.

## Counted mining, later

Only after the pilot and the amendment-2 mapping. The counted pool is not
sacrificial and parallelises:

```bash
./launch-mine.sh counted 4
./merge-shards.sh counted 4 110            # first 110 validated tasks in walk order
```

Four workers is the measured-clean concurrency for cloning; on a quad-core Mac
it is also about the point where the suite runs stop scaling.
