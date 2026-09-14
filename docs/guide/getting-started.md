# Getting started

```bash
npx tamperward onboard
```

The guided first run is deliberately short. It uses colour on a terminal (while
keeping every state spelled out as `OK`, `ACTION`, `LIMITED`, `ERROR` or
`READY`) and honours `NO_COLOR` / `FORCE_COLOR`.

It has five sections:

1. **Environment** — repository root, working-tree state and platform capability. On
   macOS the message is simply that `check` + local `verify` work while the
   lifecycle-owning `run` envelope requires Linux; the low-level subreaper/ECHILD
   explanation stays in `doctor`, where it belongs.
2. **Local protection** — compact lines for policy, Claude hooks, pre-commit,
   CI and CODEOWNERS, plus a `Git ignore` item when an installed `node_modules/`
   tree would otherwise be staged as repository source. The plan is still the
   canonical `init` plan; Enter applies the displayed non-destructive changes.
   Existing `.gitignore` content is preserved, and TamperWard does not hide a
   `node_modules` tree that is already tracked/staged or explicitly re-included.
   No second copy of init's long explanation is printed inside onboarding.
3. **Verification** — choose the test command TamperWard should trust, optionally run
   the first visible/pristine verification, and optionally run the disposable-worktree
   demo. The verifier is never inferred silently: a detected command still needs
   explicit acceptance (or `--verify-command` in scripted mode).
4. **GitHub protection** — optionally inspect the live protected-branch controls.
5. **Summary** — only the items that need attention, the verified GitHub state, and
   the next action. Successful doctor checks are not replayed line by line.

A repository with no first commit is a special first-run state, not a normal dirty
working tree. Onboarding does not ask you to approve hundreds of "changed/untracked"
paths in that case; it tells you to create the initial commit before pristine
verification or the safe demo. The demo is skipped without a prompt until `HEAD`
exists. A missing trusted verifier remains fail-closed and keeps the final posture
`INCOMPLETE`, but onboarding presents it as an action to finish rather than a runtime
error.

If no github.com origin can be inferred, the GitHub section is also conditional: it
shows the `doctor --github --repo OWNER/REPO` command and the three required controls
only as guidance for repositories that will use GitHub as their repository authority.

Onboarding must run at the **Git repository root**. If the current directory is merely
inside a parent repository, it refuses before writing anything and prints both paths.
This prevents a child folder from receiving `.tamperward.yml` / CI files while the
pre-commit hook and GitHub remote belong to the parent repository. Run from the parent
root, or run `git init` in the child first if it is meant to be an independent project.

Flags: `--cwd <dir>` · `--base <rev>` · `--repo OWNER/REPO` · `--branch <branch>` ·
`--skip-demo` / `--demo` · `--no-github` · `--yes` · `--verify-command "<cmd>"`.
A non-interactive stdin or CI environment refuses instead of hanging; `--yes` applies
the local setup without prompts, still never trusts a detected verifier command unless
`--verify-command` is supplied, and runs the demo only with `--demo`. Re-running is
idempotent. Exit `0` means the supported onboarding surfaces are ready (possibly with
a clearly printed platform limitation), `1` means setup still needs action, and `2`
means onboarding was refused or cancelled.

The deterministic, non-interactive primitive it drives is still the one to script:

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

`init` wires the **repository root** from any subdirectory: run from `packages/x`, it
writes the same files to the same places as from the root and says so on stderr
(2.23.6; before that it planned the policy and CI files under the subdirectory while
wiring the parent's `.git/hooks`). The same rooting applies to every command that
reads the working tree — see [the enforcement guide](./enforcement.md#the-repository-root-from-any-subdirectory).

`init` ends by naming the GitHub-side controls it cannot set for you. On the
protected branch, configure **all three**:

1. require the **`tamperward`** status check;
2. enable **Require review from Code Owners**; and
3. enable **Dismiss stale pull request approvals when new commits are pushed**.

The freshness setting makes the Code Owner approval bind to the current gate-critical
diff. "Require approval of the most recent reviewable push" is not a substitute for
this boundary because its fresh approver need not be the Code Owner for the changed
gate path. Until all three controls are enforced the CI gate is advisory — a pull
request runs the workflow from its own head, so it could keep the job name and replace
the gate with `true`.

Verify the live GitHub configuration with:

```bash
npx tamperward doctor --github --repo OWNER/REPO --branch main
```

Set `GH_TOKEN` or `GITHUB_TOKEN` if GitHub requires authentication for the
repository/settings being inspected.

Every init run now prints a separate **VERIFICATION SETUP** status. If the loaded
policy already names `verify.command`, it prints `verification configured — <command>`.
Otherwise it prints **INCOMPLETE: verification not configured — CI will fail closed**
and the exact YAML shape to add. A single high-confidence detected suite is suggested
for review; if several are detected they are listed without choosing one. Detection is
advisory and non-mutating — init never writes an inferred verifier command, including
during a non-dry run, because the verifier is part of the trust anchor.

The minimal `verify:` block the CI step needs:

```yaml
verify:
  command: npm test
  budget: 300              # seconds
  inputs: ['scripts/**']   # what the command DELEGATES to — optional
  # backend: container
  # image: ghcr.io/acme/verifier@sha256:<64-hex-digest>
```

The default `local` backend is checkpointed same-host verification. The optional
`container` backend is a stronger frozen-artifact boundary: its digest-pinned image
must already be provisioned, Docker is never allowed to pull during adjudication, the
candidate/pristine input is read-only, runtime/dependencies belong to the image, network
is disabled, and HOME/tmp/output are private to the container. Images with Dockerfile
`VOLUME` declarations are rejected because those mount points would remain writable
despite `--read-only`. Image `ENTRYPOINT` is overridden so the trusted
`verify.command`, not an image startup default, controls suite execution. Write suite
artifacts to `$TAMPERWARD_OUTPUT_DIR` if needed.

Changing the command, lowering the budget, narrowing `inputs`, removing an isolated
backend, or changing its image is itself reported as policy weakening.

The generated CI job has a 360-minute outer timeout. Before `verify`, it runs
`tamperward doctor --base <trusted-base-sha>`, which requires enough static job time
for **two full verifier budgets plus a 60-minute authority reserve**. The standard
template therefore accommodates `verify.budget <= 9000` seconds per stage. This is
not a policy-schema limit: larger positive finite budgets remain valid for custom
runners/workflows with sufficient outer time. Re-running `init` migrates an untouched
stamped older TamperWard workflow to the current template; an operator-edited workflow
is left untouched unless `--force-workflow` is explicit. For a custom workflow, run
`tamperward doctor --workflow <path> --base <trusted-rev>` to validate its envelope.

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

## Discovering delegated verifier inputs: `tamperward trace-verify`

On Linux, `trace-verify` is an **advisory** discovery tool for the gap that remains
when a command delegates to files TamperWard cannot infer statically:

```bash
npx tamperward trace-verify --base main --cmd "npm test" --runs 3
```

It materialises the trusted base and observes the known-good verifier with `strace`.
Repeated runs are unioned; inputs that appear in only some runs are marked dynamic.
The report separates tracked repository inputs, likely runner/config inputs, and
external runtime/dependency paths. Each tracked input is compared with the same
pristine-verification surface used by `verify`, and uncovered exact paths are printed
as candidate `verify.inputs` entries for a maintainer to review.

It never writes `.tamperward.yml` and never broadens an exact path into a glob. An
unobserved path is **not** proof that the verifier can never read it: tracing is evidence
from the executions you ran, not a completeness proof. Use a base you already trust.
macOS and Windows explicitly report this mode unsupported in 2.18.0.

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
dependency tree. The container verifier is intentionally **not** available through
`tamperward run`: a same-identity host agent could control the Docker authority itself,
so `run` fails closed before starting that agent. Use container verification as the
final frozen-artifact step in trusted CI or after external agent isolation.

## CLI reference

Every flag below is what the command parser actually reads. Since **2.13.1**,
malformed argv is rejected before the selected command can touch git, files, the
verifier, or an agent: unknown options, missing values, invalid numeric
budgets/timeouts, conflicting `check` views, and extra positionals all return exit 2
with one `tamperward: ...` diagnostic. `run` requires the explicit `--` delimiter
before the wrapped command.

| command | flags |
| --- | --- |
| `check` | one view — `--staged` · `--worktree` · `--diff <base>...<head>` — plus `--format text\|json\|github\|auto` (default `auto`) · `--json` (alias for `--format json`) · `--cwd <dir>` |
| `verify` | `--base <rev>` (default `HEAD`) · `--cmd <suite command>` · `--budget <seconds>` · `--json` · `--keep` (keep the two materialised copies and report their paths) · `--require-ancestor` · `--cwd <dir>` |
| `trace-verify` | Linux-only advisory discovery: `--base <rev>` · `--cmd <suite command>` · `--budget <seconds>` · `--runs <N>` (default 2) · `--json` · `--cwd <dir>` |
| `run` | `--base <rev>` · `--cmd <suite command>` · `--budget <seconds>` · `--allow-dirty` · `--settle <seconds>` · `--allow-dep-drift` · `--cwd <dir>` · then `-- <agent command...>` |
| `allow` | `<rule>` · `--file <path>` · `--reason "<why>"` (required) · `--cwd <dir>` |
| `init` | `--cwd <dir>` · `--dry-run` · `--force-workflow` |
| `onboard` | `--cwd <dir>` · `--base <rev>` · `--repo <owner/repo>` · `--branch <name>` · `--skip-demo` / `--demo` · `--no-github` · `--yes` · `--verify-command "<suite command>"` |
| `watch` | `--dir <dir>` · `--log <file>` — a daemon; it runs until signalled |
| `hook-service` | `start [--dir <repo>]` (foreground; runs until signalled) · `stop` · `status` — the opt-in persistent hook service; hooks consult it only under `TAMPERWARD_HOOK_SERVICE=1` and fall back to in-process evaluation otherwise ([enforcement](./enforcement.md#the-persistent-hook-service-opt-in-off-by-default)) |
| `hook claude` / `sweep claude` | none — the Claude Code payload arrives on stdin |

Exit codes are part of the public surface:

| command | 0 | 1 | 2 |
| --- | --- | --- | --- |
| `check` | no blocking finding | at least one blocking finding | cannot evaluate: policy parse error, malformed `--diff` range, no view given, not a git repository, or an unresolvable revision — any failure the gate cannot recover from is one clean `tamperward: …` line on stderr at exit 2, never a stack trace at exit 1 |
| `verify` | `VERIFIED`, or a `MASKED_FAILURE` cleared by an out-of-band `verify@<head-sha>` approval | `MASKED_FAILURE` or `SUITE_RED` | cannot verify — fails closed |
| `trace-verify` | every requested trace run completed green | one or more traced verifier runs were non-zero/incomplete; report still emitted | unsupported platform, missing tooling, bad trusted base/policy/options, or tracing failure |
| `run` | enforcement clean and the agent exited 0 (a non-zero agent exit is passed through) | any blocking finding or masked failure | cannot adjudicate |
| `hook claude` / `sweep claude` | always — a deny is JSON on stdout at exit 0 | — | only for an unsupported agent name |
| `hook-service` | started, stopped (or nothing to stop), or status printed | — | unsupported platform (Windows), a runtime directory another uid owns, or a service already listening |
| `allow` | sign-off recorded | — | no rule or `--reason`, not a git repo, or no current blocking finding to sign off |
| `init` | wired, or already wired | — | an item needs attention |
| `onboard` | posture `READY` or `READY WITH WARNINGS` | posture `BROKEN` or `INCOMPLETE` (a declined write or an unconfigured verifier included) | refused — not a git repository, non-interactive stdin without `--yes`, a dirty tree not continued — or aborted at a prompt |

The variables the gate reads — `TAMPERWARD_OOB_SIGNOFF`, `TAMPERWARD_OOB_HEAD`,
`TAMPERWARD_DENYLOG`, `TAMPERWARD_FSEVENTS`, `TAMPERWARD_HOOK_SERVICE`,
`TAMPERWARD_HOOK_SERVICE_DIR`, `TAMPERWARD_WATCH_NO_RECURSIVE`,
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
