# Environment variables

Every variable the gate reads, who is expected to set it, and what it changes. None of
them can lower a severity or clear a finding on its own; the two that clear anything
(`TAMPERWARD_OOB_SIGNOFF` with `TAMPERWARD_OOB_HEAD`) are honoured only at the CI layer
— by `check --diff` and by `verify` — and only for an approval a human granted out of band.

| variable | who sets it | what it does |
| --- | --- | --- |
| `TAMPERWARD_OOB_SIGNOFF` | the CI workflow, resolved from the PR's `tamperward:allow:…` labels | comma-separated out-of-band approvals, optionally suffixed `@<head-sha>`. `<rule>` or `<rule>:<file>` clears a blocking finding in `check --diff`; `verify` turns a `verify` MASKED_FAILURE into exit 0 (the verdict is still reported, and SUITE_RED or cannot-verify never clear). Honoured at the CI layer only; the agent hook never consults it and the committed ledger is never honoured in CI. |
| `TAMPERWARD_OOB_HEAD` | the CI workflow (`github.event.pull_request.head.sha`) | the head SHA under adjudication. Once it is set, an approval clears anything only if it names that commit (`@<sha>`, at least seven characters), so a label earned for one push cannot clear the next. Workflows that do not set it keep the older, unbound behaviour. |
| `TAMPERWARD_DENYLOG` | a harness or operator | a file path; `hook claude` and `sweep claude` append the rule ids of every deny to it, one line per verdict, best effort — a measurement channel, not an enforcement one. |
| `TAMPERWARD_FSEVENTS` | operator or harness | overrides where `tamperward watch` writes its event log (default `.git/tamperward/fsevents.jsonl`). The Stop sweep reads the same variable to find the log. |
| `TAMPERWARD_WATCH_NO_RECURSIVE` | CI and tests (`=1`) | forces `tamperward watch` onto its per-directory fallback instead of recursive `fs.watch`, so the fallback is exercised on every platform and not only on those that lack the feature. |
| `TAMPERWARD_TRANSIENT` | a harness that owns restore semantics (`=block`) | raises `transient-protected-mutation` from its default `warn` to `block`. It is the one severity an environment variable may raise; nothing in the environment can lower one. |
| `NO_COLOR` | the user's shell | any non-empty value disables colour in the text renderer, whatever the value says (the no-color.org convention). |
| `FORCE_COLOR` | the user's shell | a non-empty value other than `0` enables colour even when stdout is not a terminal. |
| `GITHUB_ACTIONS` | GitHub Actions (`=true`) | `--format auto` selects the `github` renderer — an inline annotation per finding plus a job-summary table — instead of `text`. |

The shipped CI workflow (`tamperward init`) sets `TAMPERWARD_OOB_SIGNOFF` and
`TAMPERWARD_OOB_HEAD` for both steps; see [Enforcement & sign-off](./enforcement.md) for the
trust model those two live in.
