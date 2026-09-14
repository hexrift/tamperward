# Audit history and `tamperward stats`

TamperWard can keep a privacy-minimised record of the integrity findings raised while
an agent works. The record is for **measurement and dogfooding**, not enforcement:
a same-identity agent can delete or forge local telemetry, so absence of an audit event
is never evidence that no weakening was attempted and the audit log can never clear or
create an enforcement verdict.

## Local structured audit

`hook claude` and `sweep claude` write finding events by default to the repository's
real git directory:

```text
.git/tamperward/audit-v1.jsonl
```

Linked worktrees use Git's own `--git-path` resolution rather than assuming a literal
`.git/` directory. Override the location with `TAMPERWARD_AUDITLOG=/path/to/file`,
or set `TAMPERWARD_AUDITLOG=off` (or `0`) to disable this observational channel.

The older `TAMPERWARD_DENYLOG` stays unchanged for harnesses and scripts that depend
on its compact rule-id format. The structured audit is additive.

Each JSONL row is schema v1 and intentionally small:

```json
{
  "schema_version": 1,
  "id": "9cfb1c6e-…",
  "recorded_at": "2026-09-14T14:52:11.000Z",
  "event": "finding",
  "agent": "claude-code",
  "source": "pretooluse",
  "rule": "test-skip",
  "severity": "block",
  "decision": "deny",
  "session_hash": "1e3c6c4a84af93d22f53",
  "head": "8be59edccc404d4e6f6a772a4b65782d3392ac6d"
}
```

The schema deliberately has **no fields for prompt text, command text, source/evidence
snippets, file paths, environment values, raw session ids, or sign-off reasons**.
The session value is a one-way truncated SHA-256 correlation token, and `head` is only
the Git object id. See
[`schemas/audit-event-v1.schema.json`](../../schemas/audit-event-v1.schema.json).

## Read the local history

```bash
tamperward stats
tamperward stats --since 30d
tamperward stats --since 12w --json
```

The text report counts findings, blocked findings, warnings, sessions *with findings*,
rules and hook surfaces. It deliberately says **integrity findings**, not "cheating
attempts": a legitimate workflow refactor can trigger the same detector as a real
weakening and may need human sign-off.

The JSON document is versioned by
[`schemas/stats-v1.schema.json`](../../schemas/stats-v1.schema.json).

## Keep the durable history in GitHub

Publishing is explicit. Nothing is uploaded merely because the hook ran:

```bash
GH_TOKEN=... tamperward audit publish --github OWNER/REPO
```

By default TamperWard creates/uses the dedicated `tamperward-audit` branch and writes
append-only bundles under:

```text
audit/v1/events/YYYY-MM/<first-event-id>--<last-event-id>.jsonl
```

A local publish cursor prevents routine re-upload; `stats` also deduplicates by event
id, so a lost cursor cannot inflate counts. A custom branch or root is available:

```bash
tamperward audit publish \
  --github OWNER/REPO \
  --branch tamperward-audit \
  --path audit/v1/events
```

The publisher requires `GH_TOKEN` or `GITHUB_TOKEN` with **Contents write** access.
The audit branch is created from the repository's default branch if it does not exist.
Protect that branch if the history is meant to be a durable organisational record.

For stronger provenance, **do not expose the publishing token to the agent being
measured**. Run `tamperward audit publish` after the agent session from an operator
shell or another trusted automation context. If the same agent can use the write token,
the GitHub copy is still useful observational history, but it is self-reported evidence,
not an independent audit authority.

Read the GitHub-backed history without checking out the branch:

```bash
tamperward stats --github OWNER/REPO
tamperward stats --github OWNER/REPO --since 30d
tamperward stats --github OWNER/REPO --branch tamperward-audit --json
```

Public repositories need no token for reads. Private repositories can use
`GH_TOKEN` / `GITHUB_TOKEN` with Contents read access.

## What the numbers do and do not mean

Good claims:

- "TamperWard raised 31 integrity findings in the last 30 days."
- "24 were blocking findings; 7 were warnings."
- "The most frequent rule was `test-skip`."
- "19 distinct hashed sessions had at least one finding."

Claims the audit stream alone does **not** justify:

- "Agents tried to cheat 31 times."
- "No audit event means no weakening happened."
- "The GitHub audit branch is enforcement authority."
- "A blocked finding proves malicious intent."

Outcome classification — for example, deny → honest correction, another finding,
abandonment, or human sign-off — is intentionally a separate layer. The v1 event
stream preserves enough session correlation to add that analysis without inventing
intent from the detector firing itself.
