# Getting started

```bash
npx tamperward init
```

One idempotent command wires the policy and every enforcement point — it never
overwrites anything you wrote, and `--dry-run` shows the plan first:

| item | what it wires |
| --- | --- |
| agent loop | Claude Code `PreToolUse` deny + `Stop` sweep, merged into `.claude/settings.json` |
| pre-commit | husky when present, the plain git hook otherwise |
| CI | a PR-gate workflow with two steps: `check --diff` over the PR range, cleared only by an out-of-band label bound to the head SHA, and `verify --require-ancestor` — pristine re-execution of your suite against the base, whose masked-failure verdict clears only by a `tamperward:allow:verify@<head-sha>` label. The verify step **needs a `verify:` block in `.tamperward.yml`** naming the suite command; without one it fails closed (exit 2) rather than passing quietly |
| CODEOWNERS | an owner requirement on the workflow directory, the policy file and CODEOWNERS itself — the paths that decide whether the gate runs at all |
| policy | a commented baseline `.tamperward.yml` — the defaults apply even without it |

Flags: `--cwd <dir>` · `--dry-run` · `--force-workflow` (replace a workflow `init` did not
write, or one you have edited — a generated workflow nobody touched is migrated
automatically when the template changes).

`init` ends by naming the one thing it cannot do for you: in branch protection, require
the check **and** enable "Require review from Code Owners". Until then the CI gate is
advisory — a pull request runs the workflow from its own head, so it could keep the job
name and replace the gate with `true`.

The minimal `verify:` block the CI step needs:

```yaml
verify:
  command: npm test
  budget: 300              # seconds
  inputs: ['scripts/**']   # what the command DELEGATES to — optional
```

Changing the command, lowering the budget, narrowing `inputs`, or removing the block is
itself reported as policy weakening.

Or run the commands directly:

```bash
npx tamperward check --staged                # pre-commit view
npx tamperward check --diff "main...HEAD"    # CI view — the authority for main
npx tamperward verify --base main            # pristine-suite re-execution
npx tamperward run -- <agent command...>     # the enforcement envelope around an agent
```

## Pristine verification: `tamperward verify`

The question no diff rule can answer is whether the *original* suite still passes
against the current source. `verify` materialises two temporary copies of the working
tree and runs the suite in both: as-is (the **visible** run), and with every protected
test, snapshot and config file — plus the configuration a runner auto-consults —
restored from the trusted base, agent-added files on those surfaces removed (the
**pristine** run). The copies are separate directories, not a sandbox.

| outcome | meaning | exit |
| --- | --- | --- |
| visible green, pristine green | `VERIFIED` | 0 |
| visible green, pristine red | `MASKED_FAILURE` — the point of the command | 1 |
| visible red | `SUITE_RED` | 1 |
| budget exceeded, no suite command, unresolvable base, tree moved during the run | cannot verify — fails closed | 2 |

Use `--base <rev>` to name a base the agent cannot rewrite (a protected branch in CI);
the default `HEAD` covers uncommitted weakening only. With a `--base`, the policy,
verification surface and suite command are read from that commit, so the candidate
cannot supply the configuration for its own re-execution. `--require-ancestor` refuses
a base that is not an ancestor of `HEAD` instead of silently anchoring older.

## The enforcement envelope: `tamperward run`

Hooks decide; runtimes terminate. `run` wraps the agent invocation so that its exit is
untrusted: the trusted base is recorded before the agent starts, and after any
termination the tree it left behind — committed or not — is re-adjudicated against
that base: a policy check over `base...HEAD`, a policy check over the worktree
(untracked files included, no local sign-off ledger honoured), and pristine
verification. The policy and verifier come from the base commit, never the tree the
agent controls.

```bash
npx tamperward run --base main -- claude -p "fix the failing test"
```

Exit: the agent's own code when enforcement is clean; `1` on any blocking finding or
masked failure, even if the agent "succeeded"; `2` when it cannot adjudicate — a dirty
start (unless `--allow-dirty`), a policy error, or a verify that cannot run.
`--settle <seconds>` waits before the final quiescence check to catch a background
worker; `--allow-dep-drift` accepts, explicitly, an agent that rewrote the installed
dependency tree.

## CLI reference

Every flag below is what the command's parser actually reads. `check` reports an
unknown flag on stderr; the other commands ignore what they do not know.

| command | flags |
| --- | --- |
| `check` | one view — `--staged` · `--worktree` · `--diff <base>...<head>` — plus `--format text\|json\|github\|auto` (default `auto`) · `--json` (alias for `--format json`) · `--cwd <dir>` |
| `verify` | `--base <rev>` (default `HEAD`) · `--cmd <suite command>` · `--budget <seconds>` · `--json` · `--keep` (keep the two materialised copies and report their paths) · `--require-ancestor` · `--cwd <dir>` |
| `run` | `--base <rev>` · `--cmd <suite command>` · `--budget <seconds>` · `--allow-dirty` · `--settle <seconds>` · `--allow-dep-drift` · `--cwd <dir>` · then `-- <agent command...>` |
| `allow` | `<rule>` · `--file <path>` · `--reason "<why>"` (required) · `--cwd <dir>` |
| `init` | `--cwd <dir>` · `--dry-run` · `--force-workflow` |
| `watch` | `--dir <dir>` · `--log <file>` — a daemon; it runs until signalled |
| `hook claude` / `sweep claude` | none — the Claude Code payload arrives on stdin |

Exit codes are part of the public surface:

| command | 0 | 1 | 2 |
| --- | --- | --- | --- |
| `check` | no blocking finding | at least one blocking finding | cannot evaluate: policy parse error, malformed `--diff` range, or no view given |
| `verify` | `VERIFIED`, or a `MASKED_FAILURE` cleared by an out-of-band `verify@<head-sha>` approval | `MASKED_FAILURE` or `SUITE_RED` | cannot verify — fails closed |
| `run` | enforcement clean and the agent exited 0 (a non-zero agent exit is passed through) | any blocking finding or masked failure | cannot adjudicate |
| `hook claude` / `sweep claude` | always — a deny is JSON on stdout at exit 0 | — | only for an unsupported agent name |
| `allow` | sign-off recorded | — | no rule or `--reason`, not a git repo, or no current blocking finding to sign off |
| `init` | wired, or already wired | — | an item needs attention |

The variables the gate reads — `TAMPERWARD_OOB_SIGNOFF`, `TAMPERWARD_OOB_HEAD`,
`TAMPERWARD_DENYLOG`, `TAMPERWARD_FSEVENTS`, `TAMPERWARD_WATCH_NO_RECURSIVE`,
`TAMPERWARD_TRANSIENT`, `NO_COLOR`, `FORCE_COLOR`, `GITHUB_ACTIONS` — are listed on
the [environment variables](./environment.md) page.

## Reading the verdict

`--format` picks the view; the default `auto` picks `github` under Actions and `text`
otherwise, so the CI wiring stays a single line.

| Format | Where it goes |
| --- | --- |
| `text` | The terminal. Blocking findings first, then by file and line. |
| `github` | An inline annotation per finding — on the line in *Files changed* — plus a job-summary table. The full text output still goes to the log. |
| `json` | The findings verbatim, plus a summary count. |

Severity is always spelled out (`BLOCK` / `warn`) and never carried by colour alone, so
the output reads the same piped, in a CI log, and through a screen reader. Colour honours
`NO_COLOR` and `FORCE_COLOR`.

## What a denial looks like

```
  BLOCK  test-deletion  test/calc.test.js
    Test blocks removed: 3 → 1 it()/test() in this spec.
    evidence  2 test block(s) removed from test/calc.test.js
    instead   Keep the assertions and fix the code. Removing test blocks to go
              green is the tamper.
    sign-off  tamperward allow test-deletion --file test/calc.test.js --reason "..."
```

A blocking finding clears only with a human sign-off. In CI that sign-off is
out-of-band — a PR label applied by a reviewer — never a file committed on the branch
under review.
