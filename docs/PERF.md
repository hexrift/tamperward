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
| `cli.noop` | 100 protected files | `hook claude` with **empty** stdin | process start + module load with no evaluation: the fixed cost every other item pays. Since the parser went lazy (#407) this does **not** load the TypeScript parser |
| `cli.parse` | 100 protected files | `hook claude`, a PreToolUse `Edit` of one `.ts` source, **no session** | `cli.noop` plus the lazily loaded 9 MB parser and one file's AST evaluation, with nothing pinned or snapshotted: the fixed cost every item that touches a `.ts` file pays, and the smoke's yardstick |
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

The PR smoke is its own script, deliberately outside `npm test`:

```bash
npm run test:perf-smoke      # harness/perf/smoke.test.ts, alone, --no-file-parallelism
```

Compare a report against the committed baseline:

```bash
node harness/perf/compare.mjs --baseline harness/perf/BASELINE.json --current perf.json
node harness/perf/compare.mjs --baseline harness/perf/BASELINE.json --current perf.json --ratio 1.5
```

`compare.mjs` fails (exit 1) when any item's **p50 wall** exceeds `ratio ×` the
baseline's (default **2×**: a doubling is the regression the issue asks to make
visible, and ordinary shared-runner variance is well inside it), or when a
baselined item is missing from the report (`--allow-missing` waives that). A
baseline may pin a different ratio per item under `"budgets": { "<item>": 1.5 }`;
the committed baseline pins the **hook items** (`hook.warm.100`, `hook.cold.1k`,
`hook.warm.1k`, `hook.ignored`) at **1.5×**, because a per-tool-call gate that takes
half again as long is exactly the regression the nightly compare exists to show, and
`harness/perf/smoke.test.ts` fails the PR if those budgets are missing or loosened
past 1.5×. Note that the budget is exclusive: a current p50 at exactly `ratio ×` the
baseline is still within budget, so a 2× budget does not fail a 2× regression — the
1.5× pins are what make a doubled hook visible.
`--metric` picks another `a.b` path (for example `cpu_ms.p50`). Both files must be
the shape `bench.mjs` writes — schema 1, unique string ids, finite `wall_ms` /
`cpu_ms` p50 and p95 — and the selected metric must exist on every baselined
item; a malformed report or baseline is refused with exit 2 rather than compared
against nothing.

Where it runs:

* **Every PR** — `harness/perf/smoke.test.ts` runs the `smoke` profile (`cli.noop`,
  `cli.parse`, `hook.warm.100`, `snapshot.100`, `check.diff.small`), builds an
  isolated CLI itself, and unit-tests `compare.mjs`. It runs **alone**: the
  `perf-smoke` job of `ci.yml` (on Node 20 / 22 / 24, required by `gate`) runs
  `npm run test:perf-smoke` — `vitest run --config vitest.perf-smoke.config.ts
  --no-file-parallelism` — and `npm test` never sees the file (`vitest.config.ts`
  excludes `**/harness/**`), so no sibling test file shares its runner. It asserts
  **no absolute wall-clock budget** — a shared runner's clock is not a stable
  reference — only **ratios between items measured in the same run**, taken on
  **p50 CPU** (`cpu_ms`, user + system of the process and its children) rather than
  wall, because a loaded runner stretches wall for everything and leaves CPU nearly
  alone. The yardstick is `cli.parse`: since the parser went lazy (#407) `cli.noop`
  no longer loads it, but every smoke item that touches a `.ts` file does, so a ratio
  to `cli.noop` measured "parser load versus process start" and its headroom went to
  the parser, not to regressions (#421). Against `cli.parse` the budgets are
  `hook.warm.100` < 1.25×, `snapshot.100` < 1.25× and `check.diff.small` < 3×;
  measured on an idle 4-core box they sit at 0.44×, 0.48× and 1.46×, so a slower
  Node or runner has 2–3× of room and a 3× slowdown of any budgeted item fails.
  The smoke pins that with an **injected regression**: the real run's report with
  `check.diff.small` scaled 3× must fail the same judge that passed the real run,
  and the committed baseline with `hook.warm.100` doubled must fail `compare.mjs`.
  Absolute numbers are the nightly workflow's business.
* **Nightly and on demand** — `.github/workflows/perf.yml` (`workflow_dispatch` with
  `runs`, `ratio` and `dep_mb` inputs, plus a nightly schedule) runs the full suite,
  writes the table to the job summary, compares against the baseline, and uploads
  `perf.json`, `perf.md` and `compare.md` as the `perf-baseline-candidate` artifact
  (the runner is the reference machine, so the report is what the baseline is promoted
  from). It is
  deliberately not a required check.

## The baseline

`harness/perf/BASELINE.json` is a full-profile report, unedited except for the
optional `budgets` map, and its `machine` block says where it was taken (CPU, cores,
memory, platform, Node, git, and the CI runner when applicable). A comparison is
only as meaningful as the match between that machine and the one measuring now;
the 2× default budget is what absorbs the difference between a developer laptop and
a hosted runner, not a licence to compare across architectures.

**The reference machine is the hosted runner** the `perf` workflow runs on, because
that is the machine every nightly comparison is made on. The baseline is in one of
two states, and `harness/perf/smoke.test.ts` holds it to whichever it claims:

* **reference** — `machine.ci` is set (`github-actions` as `bench.mjs` writes on a
  runner, or `true` as `promote-baseline.mjs` stamps): it carries every item of the
  full profile, `cli.parse` included, and its `cli.parse` costs clearly more CPU
  than its `cli.noop` (a baseline taken before the parser went lazy cannot say that);
* **sandbox stand-in** — `machine.ci` is `false` and a top-level `note` says so:
  *captured in a loaded sandbox; reference baseline pending the first green perf
  workflow artifact*. **The committed baseline is in this state** (#421): its numbers
  were taken on a busy sandbox before #407, at `tamperward_version` 2.20.6, with
  `cli.noop` at 1.7 s where an idle box measures 0.12 s, so a compare against it can
  only fail an item that regresses by roughly the same factor. It is committed
  byte-for-byte as measured — the only edits are the `note`, `machine.ci: false`
  and the `budgets` — because a baseline regenerated on another loaded sandbox would
  be a different wrong machine, not the right one.

**Promote the first green `perf` run's report** on `main` after #421 lands, so the
baseline and every comparison share a machine:

1. open the green run (Actions → perf) — a run whose compare step failed is a
   regression to investigate, not a baseline — and download its
   `perf-baseline-candidate` artifact (`perf.json`, `perf.md`, `compare.md`; the
   run's job summary prints this same recipe);
2. from the artifact's directory, in a checkout of `main`:
   `node harness/perf/promote-baseline.mjs perf.json`
   — it copies the report into `harness/perf/BASELINE.json` unedited except that the
   previous baseline's `budgets` are carried over verbatim (the hook items at 1.5×),
   `machine.ci` is stamped when the report does not already name its CI, and the
   `note` is dropped; it refuses a report that is not the shape `bench.mjs` writes or
   that lost a baselined item; and it prints the old-versus-new p50 wall per item;
3. open a PR with that table in its body — the sandbox baseline versus the runner is
   expected to differ by a broadly constant factor; an item that moved by a
   different factor from its neighbours is a change to explain, not to bless.

Update it again when a change **intends** to move a number (a new detector on the
diff path, a cheaper snapshot, a bigger dependency read) or when the set of items
changes:

1. prefer the `perf-baseline-candidate` artifact of a green `perf` run on the
   change's head (`workflow_dispatch` on the branch) promoted the same way, so the
   machine stays the reference runner; otherwise `npm run build`, then run the full
   profile unprivileged on a quiet machine (`uptime` load below 2, nothing else
   running), with the default options:
   `node harness/perf/bench.mjs --out harness/perf/BASELINE.json`, and say in the
   `note` what machine that was;
2. keep the per-item `budgets` from the previous baseline;
3. state in the PR what moved, by how much, and why — the old and new p50 per item
   is the evidence a reviewer needs; a baseline replaced without a reason is how a
   regression becomes the new normal.

`harness/perf/smoke.test.ts` checks the baseline still names every item of the full
profile (`cli.parse` once it is a reference baseline), carries its `machine` block
and `tamperward_version`, budgets every hook item at 1.5× or tighter, and is
honest about its state, so an item added to `bench.mjs` without a baseline entry —
or a sandbox baseline passing as the runner's — fails the PR.
