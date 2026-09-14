# Pending audit events

`pending.jsonl` is the staging area for TamperWard's own self-hosting audit
evidence. It is **human-curated**: you add events here through a normal, reviewed
pull request, and on merge to `main` the `tamperward-audit` workflow ingests any
new event ids into the separate `tamperward-audit` evidence branch (its sole
writer). The workflow re-validates every line against the strict `audit-v1`
schema before touching that branch, and deduplicates by event `id`, so
re-ingesting the same lines is a no-op.

## What goes here

- **Only `audit-v1` events** — the privacy-safe records defined by
  [`schemas/audit-v1.schema.json`](../schemas/audit-v1.schema.json), one JSON
  object per line. Each event carries a generated id, timestamp, enforcement
  surface, fixed agent id, rule, severity/decision and an optional one-way
  hashed session id — and nothing else.
- **Never `TAMPERWARD_DENYLOG`.** The compact harness trace is not privacy-safe
  and must not be committed here. See [`docs/guide/audit.md`](../docs/guide/audit.md).

## How it flows

1. Produce audit-v1 records from a run with `TAMPERWARD_AUDIT_LOG` set
   (`tamperward stats --file <log>` validates them locally first).
2. Append the new lines to `pending.jsonl` in a pull request; review is the
   curation step.
3. On merge to `main`, the workflow validates, deduplicates and appends the new
   ids to the `tamperward-audit` branch, then regenerates its summaries.

An empty `pending.jsonl`, or a merge that does not change it, is a clean no-op:
the workflow skips the build and ingest steps entirely. An operator can still
dispatch a one-off batch by hand via the workflow's `workflow_dispatch` input.

Ingestion never rewrites history and never writes `main`: it only ever appends to
the dedicated `tamperward-audit` branch. Because ingestion deduplicates by id,
lines already ingested can stay in `pending.jsonl` harmlessly, or be trimmed in a
later PR.
