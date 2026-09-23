# Environment variables

Every variable the gate reads, who is expected to set it, and what it changes. None of
them can lower a severity or clear a finding on its own; the two that clear anything
(`TAMPERWARD_OOB_SIGNOFF` with `TAMPERWARD_OOB_HEAD`) are honoured only at the CI layer
— by `check --diff`, by `verify`, and by the `run` envelope's CI-layer re-adjudication —
and only for an approval a human granted out of band.

| variable | who sets it | what it does |
| --- | --- | --- |
| `TAMPERWARD_OOB_SIGNOFF` | the CI workflow, resolved from compact `tw1:<digest>` or legacy `tamperward:allow:…` labels | comma-separated out-of-band approvals. Compact tokens bind the exact rule/file/head tuple; legacy tokens may use `@<full-head-sha>`. `<rule>` or `<rule>:<file>` clears a blocking finding in `check --diff`; `verify` turns a `verify` MASKED_FAILURE into exit 0 (the verdict is still reported, and SUITE_RED or cannot-verify never clear). Honoured at the CI layer only; the agent hook never consults it and the committed ledger is never honoured in CI. |
| `TAMPERWARD_OOB_HEAD` | the CI workflow (`github.event.pull_request.head.sha`) | the full head SHA under adjudication. Compact tokens are recomputed against this exact 40- or 64-character object id; legacy approvals must name it exactly, so a label earned for one push cannot clear the next. If a workflow omits this variable, legacy unbound tokens retain their older behaviour; compact tokens never clear without a supplied head. |
| `TAMPERWARD_DENYLOG` | a harness or operator | a legacy compact file path; `hook claude` and `sweep claude` append rule ids (and some warning detail) best effort. Kept for harness compatibility; do not upload it to the public audit store. |
| `TAMPERWARD_AUDIT_LOG` | an operator who wants structured measurement | a privacy-safe audit-v1 JSONL path. `auto` writes under the repository git directory at `tamperward/audit.jsonl`. Only allowlisted rule/severity/surface metadata plus a hashed session id is recorded; prompts, command bodies, source/evidence, filenames, absolute paths and environment values are never serialised. Measurement only — failure to write cannot affect a verdict. See [Audit history & stats](./audit.md). |
| `TAMPERWARD_FSEVENTS` | operator or harness | overrides where `tamperward watch` writes its event log (default `.git/tamperward/fsevents.jsonl`). The Stop sweep reads the same variable to find the log. |
| `TAMPERWARD_HOOK_SERVICE` | the operator, in Claude Code's own environment (`=1`) | lets `hook claude` / `sweep claude` hand the payload to a running `tamperward hook-service` over its private socket instead of loading the engine themselves. Off by default. Before handoff, an unavailable/refusing service falls back to the in-process hook; after handoff, ambiguous transport failure fails closed rather than starting a concurrent second evaluation. The variable can never turn a deny into an allow. See [the persistent hook service](./enforcement.md#the-persistent-hook-service-opt-in-off-by-default). |
| `TAMPERWARD_HOOK_SERVICE_DIR` | the operator or tests | overrides the service's runtime directory (default `$XDG_RUNTIME_DIR/tamperward-hook`, else `<tmpdir>/tamperward-hook-<uid>`). The directory must be the hook's own uid at mode `0700`, the socket in it at `0600`, or the hook does not use it. |
| `TAMPERWARD_DIAGNOSTICS` | an operator or harness (`=1`) | includes dependency-environment snapshot counts and timing in machine-readable reports; it is diagnostic only and cannot alter a verdict. |
| `TAMPERWARD_CONTAINER_ENGINE` | an operator or harness | selects the requested isolated verifier engine; only `docker` is supported, and another value makes container verification unavailable and fail closed. |
| `TAMPERWARD_GITHUB_TOKEN` | TamperWard's doctor API helper | the token forwarded to the short-lived Node helper used by `doctor --github`; it is not read from repository policy. |
| `GH_TOKEN` / `GITHUB_TOKEN` | GitHub Actions or the operator | authenticates `doctor --github` when the public repository/rules endpoints require credentials. |
| `GITHUB_REPOSITORY` | GitHub Actions (`OWNER/REPO`) | supplies the repository identity for `doctor --github` when `--repo` is not provided. |
| `GITHUB_BASE_REF` | GitHub Actions | supplies the protected/base branch for `doctor --github` when `--branch` is not provided. |
| `CLAUDE_CONFIG_DIR` / `HOME` / `USERPROFILE` | Claude Code / the user's shell | determine the live Claude settings/home paths used by hook-wiring detection. When the hook service is enabled, the client forwards these request-time values (or their absence) so a warm service started from another environment cannot produce a different verdict. |
| `TAMPERWARD_WATCH_NO_RECURSIVE` | CI and tests (`=1`) | forces `tamperward watch` onto its per-directory fallback instead of recursive `fs.watch`, so the fallback is exercised on every platform and not only on those that lack the feature. |
| `TAMPERWARD_TRANSIENT` | a harness that owns restore semantics (`=block`) | raises `transient-protected-mutation` from its default `warn` to `block`. It is the one severity an environment variable may raise; nothing in the environment can lower one. |
| `NO_COLOR` | the user's shell | any non-empty value disables colour in the text renderer, whatever the value says (the no-color.org convention). |
| `FORCE_COLOR` | the user's shell | a non-empty value other than `0` enables colour even when stdout is not a terminal. |
| `GITHUB_ACTIONS` | GitHub Actions (`=true`) | `--format auto` selects the `github` renderer — an inline annotation per finding plus a job-summary table — instead of `text`. |

The shipped CI workflow (`tamperward init`) sets `TAMPERWARD_OOB_SIGNOFF` and
`TAMPERWARD_OOB_HEAD` for its check and verify steps; the `run` envelope passes the same
values to its CI-layer re-adjudication when it is used as the authority. See [Enforcement &
sign-off](./enforcement.md) for the trust model those two live in.
