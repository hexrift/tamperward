# Performance budgets

TamperWard sits on the agent's hot path: every tool call pays for a `PreToolUse`
hook, every turn for a Stop sweep, every PR for `check --diff`, and every `verify`
for two materialised copies of the tree. The one-off measurements that justified
those designs live in code comments (the protected-tree hash, the collapsed
ignored-directory walk, the positioned event-log read). This suite makes them
**repeatable**: a committed baseline, a budget per item, and a job that goes red when
a change multiplies one of them.

Everything under `harness/perf/` uses Node built-ins only and measures the **built
CLI** (`dist/cli/index.js`) the way a user pays for it — one fresh process per run.

## What is measured

Each item is a command run against a synthetic repository that
`harness/perf/fixtures.mjs` generates **deterministically** from a fixed seed (the
same bytes on every machine, so the machine is the only variable). One untimed
warm-up run precedes each item; then `--runs` timed runs (7 by default, 3 in the
smoke profile). Per item the report carries **p50 / p95 / min / max / mean** of:

* **wall** — milliseconds around the whole process (a few ms of `bash` start-up are
  included in every item alike, see below);
* **cpu** — user + system CPU of the process and its children, from bash's `times`
  builtin after the command exits (portable to Linux and macOS with no
  `/usr/bin/time` dependency).

| item | fixture | command | what it stands for |
| --- | --- | --- | --- |
| `cli.noop` | 100 protected files | `hook claude` with **empty** stdin | process start + module load with no evaluation: the fixed cost every other item pays (the bundled TypeScript parser dominates it) |
| `hook.warm.100` | 100 protected files | `hook claude`, established session | a per-tool-call `PreToolUse` deny/allow on a small tree |
| `hook.cold.1k` | 1k protected files | `hook claude`, **new session every run** | the first call of a session: pins the turn baseline and takes the first protected-tree snapshot |
| `hook.warm.1k` | 1k protected files | `hook claude`, established session | the steady-state per-tool-call cost: policy load, full protected-tree re-hash (no stat fast path, by design), drift compare, evaluation |
| `snapshot.100` / `.1k` / `.10k` | 100 / 1k / 10k protected files | `sweep claude` (Stop), established session | the per-turn cost: turn view (tracked diff + untracked + ignored + hidden-tracked probes) plus the protected-tree snapshot at each size |
| `check.diff.small` | 100 files | `check --diff perf-base...perf-small` | a 3-file PR range (2 spec additions, 1 source rewrite) |
| `check.diff.large` | 1k files | `check --diff perf-base...perf-large` | a 500-file PR range (400 spec additions, 100 source rewrites), the AST detectors on every one |
| `hook.ignored` | 1k files + a wholly-ignored `dist/` of `--ignored-files` (20k) files + untracked scratch | `hook claude`, established session | the snapshot walk pruned by git's `--directory` collapse of the build tree |
| `sweep.ignored` | same | `sweep claude` | ignored/untracked enumeration: the two-pass ignored listing, including one protected file hidden inside the ignored tree |
| `deps.fingerprint` | 100 files + a synthetic `node_modules` of `--dep-mb` MB (8 by default) | `verify --cmd true --json` with `TAMPERWARD_DIAGNOSTICS=1` | the dependency-environment fingerprint; `inner_ms` is the fingerprint alone (`dependency_environment.diagnostics.total_ms`, the sum of every full snapshot the verify takes), wall is the whole verify |
| `verify.materialize` | 1k files, no dependency tree | `verify --cmd true` | visible + pristine materialisation and adjudication with a ~1 ms suite: the overhead **excluding** the suite |
| `run.envelope` | 1k files | `run --cmd true -- true` | the whole enforcement envelope (entry pin, committed and worktree checks, verify, quiescence) around a trivial agent |
| `sweep.longlog` | 1k files + a `--log-mb` (8) MB watcher event log of churn on 200 protected paths | `sweep claude` with `TAMPERWARD_FSEVENTS` set and the cursor reset before every run | Stop consumption of a long historical log from offset 0, under the 4 MiB per-read / 16 MiB per-decision caps |

The synthetic dependency tree is shaped like an install (nested packages,
`package.json` files, JS sources, one larger blob per package, a store-style
symlinked package) and sized by bytes at roughly 6 KB per file; the issue's
representative 100 MB and 1 GB trees are `--dep-mb 100` and `--dep-mb 1000`, which
are a workflow input rather than the default so a CI smoke stays cheap.

Not measured: process-cold start from an empty page cache (the warm-up run defeats
it deliberately, so p50 is the steady state), container-backend verification, and
Windows (the harness needs `bash`).

## How to run

```bash
npm run build
node harness/perf/bench.mjs                       # full profile, 7 runs, JSON on stdout
node harness/perf/bench.mjs --out perf.json --md perf.md
node harness/perf/bench.mjs --profile smoke --runs 3
node harness/perf/bench.mjs --items hook.warm.1k,snapshot.10k
node harness/perf/bench.mjs --dep-mb 100 --ignored-files 50000 --log-mb 15 --keep --work /tmp/perf
```

`--keep` leaves the fixtures under `--work` for inspection (they are deleted
otherwise). `run.envelope` refuses to run as root (Linux lifecycle supervision needs
a real UID), so run the suite unprivileged.

Compare a report against the committed baseline:

```bash
node harness/perf/compare.mjs --baseline harness/perf/BASELINE.json --current perf.json
node harness/perf/compare.mjs --baseline harness/perf/BASELINE.json --current perf.json --ratio 1.5
```

`compare.mjs` fails (exit 1) when any item's **p50 wall** exceeds `ratio ×` the
baseline's (default **2×**: a doubling is the regression the issue asks to make
visible, and ordinary shared-runner variance is well inside it), or when a
baselined item is missing from the report (`--allow-missing` waives that). A
baseline may pin a different ratio per item under `"budgets": { "<item>": 1.5 }`.
`--metric` picks another `a.b` path (for example `cpu_ms.p50`).

Where it runs:

* **Every PR** — `test/perf-smoke.test.ts` runs the `smoke` profile (`cli.noop`,
  `hook.warm.100`, `snapshot.100`, `check.diff.small`), builds an isolated CLI
  itself, and unit-tests `compare.mjs`. It asserts **no absolute wall-clock
  budget** — a shared runner's clock is not a stable reference — only **ratios
  between items measured in the same run**: each of the three work items must stay
  under 4× `cli.noop`, the process-start-plus-module-load cost with no evaluation.
  Measured on the baseline machine they sit at 1.2–1.4×, so the smoke stays quiet on
  a slow runner and still catches an order-of-magnitude regression in the work a
  tool call does. Absolute numbers are the nightly workflow's business.
* **Nightly and on demand** — `.github/workflows/perf.yml` (`workflow_dispatch` with
  `runs`, `ratio` and `dep_mb` inputs, plus a nightly schedule) runs the full suite,
  writes the table to the job summary, compares against the baseline, and uploads
  `perf.json`, `perf.md` and `compare.md` as the `perf-report` artifact. It is
  deliberately not a required check.

## The baseline

`harness/perf/BASELINE.json` is a full-profile report, unedited except for the
optional `budgets` map, and its `machine` block says where it was taken (CPU, cores,
memory, platform, Node, git, and the CI runner when applicable). A comparison is
only as meaningful as the match between that machine and the one measuring now;
the 2× default budget is what absorbs the difference between a developer laptop and
a hosted runner, not a licence to compare across architectures.

Update it when a change **intends** to move a number (a new detector on the diff
path, a cheaper snapshot, a bigger dependency read) or when the set of items
changes:

1. `npm run build`, then run the full profile unprivileged on a quiet machine, with
   the default options:
   `node harness/perf/bench.mjs --out harness/perf/BASELINE.json`
   (or download `perf.json` from a green `perf` workflow run and copy it there when
   the runner is the reference machine);
2. keep any per-item `budgets` you want from the previous baseline;
3. state in the PR what moved, by how much, and why — the old and new p50 per item
   is the evidence a reviewer needs; a baseline replaced without a reason is how a
   regression becomes the new normal.

`test/perf-smoke.test.ts` checks the baseline still names every item of the full
profile, so an item added to `bench.mjs` without a baseline entry fails the PR.
