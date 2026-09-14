# Audit history and `tamperward stats`

TamperWard can keep a privacy-safe record of the integrity findings its Claude Code
hooks raise. This is **measurement**, not enforcement: failing to write an audit event
never changes an allow/deny decision, and the audit history is never read as an
authority input by `check`, `verify`, `run`, the hook, or CI.

This is useful for dogfooding questions such as:

- which rules fire most often while agents work;
- whether findings are coming from PreToolUse or the Stop sweep;
- how the mix changes over time;
- how much enforcement activity a repository actually sees.

A finding is **not proof of intent**. Legitimate refactors can trip an integrity rule,
and a count of findings must not be described as a count of deliberate weakening
attempts.

## Enable the structured local audit

Set `TAMPERWARD_AUDIT_LOG` in the environment Claude Code inherits:

```bash
export TAMPERWARD_AUDIT_LOG=auto
```

`auto` writes to the repository's Git directory:

```text
.git/tamperward/audit.jsonl
```

For linked worktrees it uses that worktree's actual Git directory rather than assuming
`.git` is a directory. An explicit file path is also accepted.

The v1 event is intentionally small:

```json
{
  "schema_version": 1,
  "id": "sha256:…",
  "timestamp": "2026-09-14T14:52:11.000Z",
  "surface": "pretooluse",
  "agent": "claude-code",
  "rule": "test-skip",
  "severity": "block",
  "decision": "deny",
  "session": "sha256:…"
}
```

The writer is allowlist-only. It does **not** serialise prompts, tool command bodies,
source/evidence text, filenames, absolute paths, environment values, credentials, or
the raw Claude session id. The session identifier is one-way hashed before it leaves
the hook.

The published event schema is
[`schemas/audit-v1.schema.json`](https://github.com/hexrift/tamperward/blob/main/schemas/audit-v1.schema.json).
The `stats --json` aggregate has its own
[`schemas/stats-v1.schema.json`](https://github.com/hexrift/tamperward/blob/main/schemas/stats-v1.schema.json).

### The older deny log

`TAMPERWARD_DENYLOG` remains supported for harness compatibility. It is a compact,
best-effort rule-id trace and some warning records can contain filenames or diagnostic
detail. Do **not** upload a deny log to the public GitHub audit store.

Use `TAMPERWARD_AUDIT_LOG` for durable statistics.

## Read the statistics

From the repository:

```bash
npx tamperward stats
npx tamperward stats --since 30d
npx tamperward stats --since 12h
npx tamperward stats --json
```

By default `stats` reads the auto audit path. Use `--file` for an exported or
downloaded JSONL file:

```bash
npx tamperward stats --file ./events.jsonl
```

The text view reports event, block, warning and hashed-session counts, followed by
counts by rule and enforcement surface. `--json` emits the same deterministic
aggregate as one JSON document.

`--since` accepts `m`, `h`, and `d` relative windows (`90m`, `12h`, `30d`)
or an ISO timestamp.

## Keep the durable history in GitHub

TamperWard itself ships
[`.github/workflows/tamperward-audit.yml`](https://github.com/hexrift/tamperward/blob/main/.github/workflows/tamperward-audit.yml).
The hook does **not** push anything to GitHub. Publishing is always a
human-curated action, and GitHub Actions is the writer. There are two curated
entry points, and both run only from the trusted copy on `main`:

- an operator **dispatches** a validated batch by hand (`workflow_dispatch`), or
- a reviewed PR appends validated audit-v1 lines to
  [`audit/pending.jsonl`](https://github.com/hexrift/tamperward/blob/main/audit/pending.jsonl)
  and, **on merge to `main`**, the workflow ingests the new event ids.

There is deliberately no `pull_request` / `pull_request_target` trigger: an
untrusted fork PR must never run the workflow that writes the evidence branch.
The post-merge `push` fires only after a merge, is gated again by
`if: github.ref == 'refs/heads/main'`, and re-validates the schema before
touching the branch. An empty `pending.jsonl`, or a merge that does not change
it, is a clean no-op.

The workflow:

1. runs only from the copy committed on `main`, whether dispatched by hand or
   fired by a post-merge push;
2. validates every submitted line with TamperWard's strict audit-v1 parser;
3. rejects unknown fields rather than trying to redact them after upload;
4. creates or updates a separate `tamperward-audit` branch;
5. deduplicates records by event id;
6. writes `events/all.jsonl`;
7. regenerates `summaries/all-time.json` and a human-readable branch `README.md`.

### On merge to `main` (the reviewed-file path)

Append the validated lines to `audit/pending.jsonl` in a pull request — review is
the curation step — and merge. See
[`audit/README.md`](https://github.com/hexrift/tamperward/blob/main/audit/README.md).
Because ingestion deduplicates by id, lines already ingested can stay in the
pending file harmlessly or be trimmed in a later PR. Ingestion never writes
`main`; it only ever appends to the dedicated `tamperward-audit` branch.

### By hand (the dispatch path)

A typical bounded upload is:

```bash
AUDIT="$(git rev-parse --absolute-git-dir)/tamperward/audit.jsonl"

# Validate locally first.
npx tamperward stats --file "$AUDIT" --json >/dev/null

# GitHub workflow inputs are bounded, so send a recent batch. Re-sending records is
# safe: the store deduplicates by audit event id.
gh workflow run tamperward-audit.yml --ref main \
  -f batch="$(tail -n 100 "$AUDIT")"
```

Only submit the structured `TAMPERWARD_AUDIT_LOG`. Workflow-dispatch inputs become
GitHub data before the job can validate them, so the workflow cannot make an unsafe
input private after the fact.

The `tamperward-audit` branch is historical evidence only. It should be protected
from ordinary developer/agent pushes, but even an altered audit branch cannot clear a
finding, approve a PR, change a policy, or make an enforcement verdict green.

## Interpreting dogfooding numbers

Prefer wording such as:

> TamperWard raised 31 integrity findings in 84 recorded agent sessions.

Do not automatically rewrite that as:

> Agents tried to cheat 31 times.

To make claims about behaviour after a finding, correlate the audit events with a
separate, explicit outcome classification. The v1 audit deliberately does not infer
`honest correction`, `repeated weakening`, `abandoned`, `legitimate refactor`,
or `human sign-off` from timing alone.
