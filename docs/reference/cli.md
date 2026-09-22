# CLI reference

Every command Tamperward ships, grouped by the enforcement surface it serves, with the
exact flags its parser reads. This page is the reference; the
[Quickstart](../guide/quickstart.md) and [Getting started](../guide/getting-started.md)
pages are the tutorial.

Since **2.13.1** malformed argv is rejected *before* the selected command touches git,
files, the verifier, or an agent: unknown options, missing values, invalid numeric
budgets, conflicting `check` views, duplicate flags, and stray positionals all return
**exit 2** with one `tamperward: …` diagnostic on stderr. Run `tamperward --help` for the
built-in summary.

Invocation is `npx tamperward <command>` (or `tamperward <command>` once installed). All
commands accept `--cwd <dir>`; every command that reads the working tree operates on the
**repository root** from any subdirectory — see
[the enforcement guide](../guide/enforcement.md#the-repository-root-from-any-subdirectory).

[[toc]]

## The gate: `check`

The core adjudicator over a diff. Choose **exactly one** view.

```bash
tamperward check --staged                  # pre-commit view (staged diff)
tamperward check --worktree                # working-tree view (Stop sweep)
tamperward check --diff "main...HEAD"      # commit-range view (CI authority)
```

| flag | meaning |
| --- | --- |
| `--staged` | Judge the staged diff. The pre-commit surface. |
| `--worktree` | Judge working-tree changes (untracked protected files included). |
| `--diff <base>...<head>` | Judge a commit range. The CI authority; reads policy from the base. |
| `--format <fmt>` | `text` · `json` · `github` · `auto` (default). See [Machine output](./machine-output.md). |
| `--json` | Alias for `--format json`. Cannot be combined with `--format`. |
| `--cwd <dir>` | Run as if from `<dir>`; the repository root is still used. |

Exactly one of `--staged` / `--worktree` / `--diff` is required; naming two is rejected.
Exit codes: **0** clean · **1** a blocking finding · **2** cannot evaluate (fails closed).

## The in-loop hooks: `hook`, `sweep`

The two Claude Code surfaces. They read the runtime's JSON payload on **stdin** and take
no flags; the agent name (`claude`) is the only argument.

```bash
tamperward hook claude     # PreToolUse: deny a weakening tool call before it runs
tamperward sweep claude    # Stop: re-scan the turn's working tree at end of turn
```

A deny is emitted as JSON on **stdout at exit 0** — exit 2 would make Claude Code ignore
the JSON and proceed, so these surfaces never exit non-zero for a finding. Exit 2 is
reserved for an unsupported agent name. `tamperward init` wires both into
`.claude/settings.json`. See [Runtime adapters](../guide/runtime-adapters.md) for the
vendor-neutral steering contract.

## The pristine-suite adjudicator: `verify`

Runs the suite twice in two separate copies of the working tree: as-is (the **visible**
run) and with every protected test, snapshot and config file restored from the trusted
base (the **pristine** run). Visible-green / pristine-red is a **masked failure** — the
move this tool exists to catch.

```bash
tamperward verify --base main
```

| flag | meaning |
| --- | --- |
| `--base <rev>` | Trusted base the agent cannot rewrite (default `HEAD`). Policy, verification surface and suite command are read from it. |
| `--cmd <command>` | Override the suite command for this run. |
| `--budget <seconds>` | Per-stage time budget (positive number). |
| `--json` | Emit one versioned `verify` verdict document; never falls back to prose. |
| `--keep` | Keep the two materialised copies and report their paths. |
| `--require-ancestor` | Refuse a `--base` that is not an ancestor of `HEAD` (fail closed rather than silently anchoring older). |
| `--cwd <dir>` | Run as if from `<dir>`. |

Verdicts: `VERIFIED`, `MASKED_FAILURE`, `SUITE_RED`, `BUDGET_EXCEEDED`, `CANNOT_VERIFY`.
Exit: **0** `VERIFIED` (or a `MASKED_FAILURE` cleared by an out-of-band
`verify@<head-sha>` approval) · **1** `MASKED_FAILURE` / `SUITE_RED` · **2**
`CANNOT_VERIFY`. Full envelope and reason enums: [Machine output](./machine-output.md).
Background: [Pristine verification](../guide/getting-started.md#pristine-verification-tamperward-verify).

## The enforcement envelope: `run` (Linux)

Wraps an agent invocation so its exit is untrusted: records the trusted base, runs the
agent, then re-adjudicates the tree it left — `check` over `base...HEAD`, `check` over the
worktree, and `verify` — with policy and verifier taken from the base. Requires an
explicit `--` before the wrapped command.

```bash
tamperward run --base main -- claude -p "fix the failing test"
```

| flag | meaning |
| --- | --- |
| `--base <rev>` | Trusted base recorded before the agent starts. |
| `--cmd <command>` | Suite command for the verify stage. |
| `--budget <seconds>` | Per verifier suite budget. |
| `--agent-budget <seconds>` | Bound the wrapped agent's wall-clock; still adjudicates after a timeout. |
| `--observe-transients` | Start a session-scoped transient observer and report temporal evidence/health. |
| `--allow-dirty` | Permit a dirty start tree (otherwise fails closed). |
| `--allow-dep-drift` | Explicitly accept an agent that rewrote the installed dependency tree. |
| `--settle <seconds>` | Wait before the final quiescence check to catch a background worker. |
| `--json` | Emit one final versioned `run` verdict document after adjudication. |
| `--cwd <dir>` | Run as if from `<dir>`. |

Exit: the **agent's own code** when enforcement is clean (a non-zero agent exit is passed
through) · **1** any blocking finding or masked failure · **2** cannot adjudicate (dirty
start, policy error, verify cannot run) · **124** `AGENT_TIMEOUT` — `--agent-budget`
expired and post-timeout enforcement was clean. The container verifier is intentionally
**not** available through `run`. Verdicts: [Machine output](./machine-output.md#run-json).

## Setup: `onboard`, `init`, `doctor`

### `onboard`

The guided first run: preflight, an init plan with confirmation before any write, verifier
acceptance, the first `verify` explained, an optional demo on a disposable worktree, and a
`doctor` posture at the end.

```bash
tamperward onboard
```

| flag | meaning |
| --- | --- |
| `--cwd <dir>` | Repository directory (must be the git root). |
| `--base <rev>` | Trusted base for the first verify / demo. |
| `--repo <owner/repo>` | Repository slug for the GitHub-authority check. |
| `--branch <name>` | Protected branch to inspect. |
| `--verify-command "<cmd>"` | Configure the trusted suite command (the only way to set it in scripted mode). |
| `--demo` / `--skip-demo` | Force or skip the disposable-worktree demonstration (mutually exclusive). |
| `--no-github` | Skip the GitHub-authority section. |
| `--yes` | Apply the local setup without prompts (non-interactive). |

Exit: **0** `READY` / `READY WITH WARNINGS` · **1** `BROKEN` / `INCOMPLETE` · **2** refused
or aborted.

### `init`

The deterministic, idempotent primitive `onboard` drives: wires the policy file, Claude
Code hooks, pre-commit, CI, and CODEOWNERS. Never overwrites files you wrote.

```bash
tamperward init --dry-run     # print the plan and exit
```

| flag | meaning |
| --- | --- |
| `--dry-run` | Print the plan without writing. |
| `--force-workflow` | Replace a workflow `init` did not write, or one you edited. |
| `--cwd <dir>` | Repository directory. |

Exit: **0** wired (or already wired) · **2** an item needs attention (e.g. a symlink where
a file was expected). What each item wires is detailed in
[Getting started](../guide/getting-started.md).

### `doctor`

Read-only installation + authority posture, and validation of the CI verifier's
outer-time envelope against the trusted policy.

```bash
tamperward doctor
tamperward doctor --github --repo owner/repo --branch main
```

| flag | meaning |
| --- | --- |
| `--base <rev>` | Trusted policy revision to validate against. |
| `--workflow <path>` | Validate a custom workflow's time envelope. |
| `--github` | Also validate live repository authority (required check, Code Owner review, stale-review dismissal). |
| `--repo <owner/repo>` | Repository slug for `--github`. |
| `--branch <name>` | Protected branch for `--github`. |
| `--json` | Emit the `doctor` document. |
| `--cwd <dir>` | Repository directory. |

Postures: `READY`, `READY WITH WARNINGS`, `INCOMPLETE`, `BROKEN`. Set `GH_TOKEN` /
`GITHUB_TOKEN` when GitHub requires authentication.

## Observation & audit: `watch`, `stats`

### `watch`

A filesystem-event observer daemon that records protected-file events so the Stop sweep
can observe supported transient effects. Runs until signalled.

```bash
tamperward watch --dir . --log .git/tamperward/fsevents.jsonl
```

| flag | meaning |
| --- | --- |
| `--dir <dir>` | Directory to observe. |
| `--log <file>` | Event-log path (also read via `TAMPERWARD_FSEVENTS`). |
| `--base <rev>` | Freeze observer policy to a trusted revision. |

### `stats`

Aggregate the privacy-safe hook/sweep audit events by rule and enforcement surface.

```bash
tamperward stats --since 30d --json
```

| flag | meaning |
| --- | --- |
| `--file <audit.jsonl>` | Explicit audit log (default: `.git/tamperward/audit.jsonl` or `TAMPERWARD_AUDIT_LOG`). |
| `--since <window>` | `30d` / `12h` / `90m` / an ISO time. |
| `--json` | Emit the aggregate `stats` document. |
| `--cwd <dir>` | Repository directory. |

A finding is an integrity signal, not proof of intent. See
[Audit history & stats](../guide/audit.md).

## Sign-off: `allow`

Record a human sign-off in the local audit ledger, clearing a current blocking finding.

```bash
tamperward allow test-deletion --file test/calc.test.js --reason "intentional: moved to e2e"
```

| flag | meaning |
| --- | --- |
| `<rule>` | The rule id to sign off (positional, required). |
| `--reason "<why>"` | Required justification. |
| `--file <path>` | Scope the sign-off to a file. |
| `--cwd <dir>` | Repository directory. |

Exit **2** when there is no rule, no `--reason`, it is not a git repo, or there is no
current blocking finding to sign off. In CI the sign-off is **out-of-band** — a PR label
applied by a reviewer, never a file committed on the branch under review. See
[the sign-off model](../guide/enforcement.md#the-sign-off-model).

## Sign-off labels: `signoff-label`

Print a compact GitHub label bound to the exact rule, optional file, and full PR head SHA:

```bash
tamperward signoff-label --rule test-deletion --file test/calc.test.js --head "$GITHUB_SHA"
```

The output is a `tw1:<digest>` label that fits GitHub's label-name limit. It is valid only
for the supplied full head SHA and exact rule/file; malformed, foreign, or abbreviated
heads are rejected. Existing `tamperward:allow:<rule>@<head-sha>` labels remain compatible.

## The persistent hook service: `hook-service` (opt-in)

One warm process per user and repository that evaluates hook/sweep requests over a private
unix socket, so each tool call skips Node + bundle startup. Hooks consult it **only** with
`TAMPERWARD_HOOK_SERVICE=1` in the runtime's environment, and fall back to in-process
evaluation (the same verdict) when it is absent, stale, another version, or its socket
fails the ownership/mode checks. Not available on Windows.

```bash
tamperward hook-service start --dir .    # foreground; runs until signalled
tamperward hook-service status
tamperward hook-service stop
```

| subcommand | flag | meaning |
| --- | --- | --- |
| `start` | `--dir <repo>` | Serve requests for this repository. |
| `status` | — | Report whether a service is listening. |
| `stop` | — | Stop the service (or report nothing to stop). |

See [the persistent hook service](../guide/enforcement.md#the-persistent-hook-service-opt-in-off-by-default).

## Advisory verifier-input discovery: `trace-verify` (Linux)

An **advisory**, non-mutating discovery tool for verifier inputs a command delegates to
that Tamperward cannot infer statically. It traces a trusted, known-good base with
`strace`, unions repeated runs, and suggests uncovered exact paths for a human to review
as `verify.inputs`. It never edits policy.

```bash
tamperward trace-verify --base main --cmd "npm test" --runs 3
```

| flag | meaning |
| --- | --- |
| `--base <rev>` | Trusted base to trace. |
| `--cmd <command>` | Suite command to observe. |
| `--budget <seconds>` | Per-run budget. |
| `--runs <N>` | Number of trace runs to union (positive integer, default 2). |
| `--json` | Emit the trace report as JSON. |
| `--cwd <dir>` | Repository directory. |

macOS and Windows report this mode unsupported and fail closed. Background:
[Discovering delegated verifier inputs](../guide/getting-started.md#discovering-delegated-verifier-inputs-tamperward-trace-verify).

## Model evaluation: `research`

Bring-your-own-model evaluation that runs each task ungated and under the `run` envelope
and observes both with `verify` + `check`. Two subcommands; the `run` subcommand takes an
explicit `--` before the agent command, like the top-level `run`.

```bash
tamperward research run --manifest tasks.yml --out ledger/ --adapter command -- ./my-agent.sh
tamperward research summarize --ledger ledger/
```

| subcommand | flags |
| --- | --- |
| `research run` | `--manifest <file>` · `--out <dir>` · `--adapter <name>` (all three required) · `--pairs <N>` · `--model <M>` · `--agent-budget <seconds>` · `--json` · then `-- <agent command…>` |
| `research summarize` | `--ledger <dir>` (required) |

Records are resumable by full experiment identity. Flags and record schema:
[Research: evaluate a model](../guide/research.md#flags).

## See also

- [Machine output](./machine-output.md) — the `--json` envelopes, verdict/reason enums, and schemas.
- [Policy reference](./policy.md) — the full `.tamperward.yml` contract.
- [Exit codes](./exit-codes.md) — the single table for `0` / `1` / `2` / `124`.
- [Environment variables](../guide/environment.md) — every variable the gate reads.
