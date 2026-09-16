# Exit codes

Exit codes are part of Tamperward's **public surface** and are the authoritative pass/fail
signal — a program should key on them even when it also parses [machine output](./machine-output.md),
because the exit code is the contract even if a document is truncated. The JSON schemas
describe data shape; the exit code describes process status. They agree.

## The four codes

| code | meaning |
| --- | --- |
| **0** | Clean — no blocking finding, verdict `VERIFIED`, or work already done. |
| **1** | A blocking finding, a masked failure, or a suite that is red. |
| **2** | Cannot evaluate — **fails closed**. Policy error, bad `--diff` range, no view, not a git repository, unresolvable base/revision, `--require-ancestor` refused, budget exceeded. Always one clean `tamperward: …` line on stderr, never a stack trace. |
| **124** | `run` only — `AGENT_TIMEOUT`: `--agent-budget` expired and post-timeout enforcement was clean. |

**Fail closed is the rule.** A crash is a verdict the gate could not reach, so anything
uncaught exits **2** (never 0, never 1) with one clean line — a bad `--diff` revision, a
`--worktree` outside a repository, an invalid policy reaching `allow`. The in-loop
`hook` / `sweep` surfaces are the deliberate exception: they emit a deny as JSON on
**stdout at exit 0**, because exit 2 would make Claude Code ignore the JSON and proceed.

## By command

| command | 0 | 1 | 2 | 124 |
| --- | --- | --- | --- | --- |
| `check` | no blocking finding | at least one blocking finding | cannot evaluate: policy parse error, malformed `--diff` range, no view given, not a git repository, or an unresolvable revision | — |
| `verify` | `VERIFIED`, or a `MASKED_FAILURE` cleared by an out-of-band `verify@<head-sha>` approval | `MASKED_FAILURE` or `SUITE_RED` | `CANNOT_VERIFY` / `BUDGET_EXCEEDED` — fails closed | — |
| `run` | enforcement clean and the agent exited 0 (a non-zero agent exit is passed through) | any blocking finding or masked failure, including a non-quiescent process after timeout | cannot adjudicate: dirty start, policy error, verify cannot run | `AGENT_TIMEOUT`: `--agent-budget` expired, post-timeout enforcement clean |
| `trace-verify` | every requested trace run completed green | one or more traced runs were non-zero/incomplete; report still emitted | unsupported platform, missing tooling, bad base/policy/options, or tracing failure | — |
| `doctor` | configured verify job(s) have sufficient static outer time for the trusted policy | — | missing/invalid workflow, no verify job, missing/malformed/insufficient timeout, or trusted policy cannot be loaded | — |
| `stats` | audit events validated and summary printed | — | explicit file missing, malformed/unknown event, bad `--since`, or no default store resolvable | — |
| `research run` / `research summarize` | every requested pair recorded (or already was); summary printed | — | cannot start or set a trajectory up (bad manifest, unknown adapter, root/unsupported platform, unclonable repo, invalid ledger) — the agent's own exit is data, never the research exit | — |
| `allow` | sign-off recorded | — | no rule or `--reason`, not a git repo, or no current blocking finding to sign off | — |
| `init` | wired, or already wired | — | an item needs attention (e.g. a symlink where a file was expected) | — |
| `onboard` | posture `READY` or `READY WITH WARNINGS` | posture `BROKEN` or `INCOMPLETE` | refused (not a git repo, non-interactive stdin without `--yes`, an uncontinued dirty tree) or aborted at a prompt | — |
| `hook claude` / `sweep claude` | always — a deny is JSON on stdout at exit 0 | — | only for an unsupported agent name | — |
| `hook-service` | started, stopped (or nothing to stop), or status printed | — | unsupported platform (Windows), a runtime directory another uid owns, or a service already listening | — |
| no or unknown command | help printed (no command) | — | unknown command; help printed | — |

## See also

- [CLI reference](./cli.md) — every command and its flags.
- [Machine output](./machine-output.md) — the verdict/reason enums the exit codes track.
- [Integrate](../integrate.md) — using the exit code as the CI pass/fail gate.
