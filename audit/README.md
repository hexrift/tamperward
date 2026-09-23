# Audit batches

This directory is how TamperWard's own self-hosting audit evidence enters the
repository. Evidence is added through a **pull request** and, on merge to `main`,
automation performs deterministic, idempotent ingestion. The invariant is not
"nothing automatic ever writes the evidence branch" but:

> Nothing unreviewed or candidate-controlled may cause evidence to enter the
> `tamperward-audit` branch. Automation only ingests, deterministically, what
> reached `main` through a pull request.

**Enforcement.** How strong "reviewed" is depends on the repository's branch
protection, which this file cannot set. A `CODEOWNERS` entry requires a code
owner on `audit/` and on the workflow, but that is binding only where branch
protection enables "Require review from Code Owners" and a minimum approving
review count — turn those on for the strongest guarantee. Independently of
review settings, two mechanisms are always enforced by the code here: every
committed batch is validated pre-merge by CI (`test/audit-pending-batches.test.ts`),
and the write-capable ingestion job runs no candidate/dependency code (see below).

## Immutable batches

Add each set of events as its own **immutable** file:

```
audit/pending/<batch-id>.jsonl
```

- `<batch-id>` is any stable, unique name (e.g. a date plus a short random
  suffix, `2026-09-14-a1b2c3`). It is the batch's identity in the ingestion
  ledger.
- One JSON object per line, each a privacy-safe `audit-v1` event as defined by
  [`schemas/audit-v1.schema.json`](../schemas/audit-v1.schema.json): a generated
  id, timestamp, enforcement surface, fixed agent id, rule, severity/decision and
  an optional one-way hashed session id — and nothing else.
- **Never `TAMPERWARD_DENYLOG`.** The compact harness trace is not privacy-safe
  and must not be committed here. See [`docs/guide/audit.md`](../docs/guide/audit.md).
- **Do not edit a batch file after it merges.** Batches are immutable: the
  ingestion workflow records each batch's content hash and fails closed if an
  already-ingested batch id reappears with changed content. To correct evidence,
  add a new batch; never rewrite an old one.

## How ingestion works

On merge to `main`, the [`tamperward-audit`](../.github/workflows/tamperward-audit.yml)
workflow:

1. hashes every `audit/pending/<batch-id>.jsonl` and compares it against the
   ingestion ledger on the `tamperward-audit` branch;
2. ingests only batches whose id/content hash is not already recorded — so
   repeated runs and unrelated merges are clean no-ops that never touch the
   evidence branch;
3. re-validates each new batch against the strict `audit-v1` schema;
4. writes the batch's new events (deduplicated by event id) to their own
   immutable partition file `events/<YYYY>/<MM>/<batch-id>.jsonl` and records a
   ledger entry in `ingested/batches.jsonl` — `{batch_id, source_sha,
   content_sha256, schema, ingested_at, event_count, partition, stored_events,
   stored_sha256}`;
5. updates only the id and session index shards those events hash into and folds
   them into the branch summaries — no historical partition is read or rewritten.

Limits: one event line is at most 16 KiB, one batch at most 16 MiB and 50,000
events, one month at most 4,096 batch files; exceeding one fails the run at exit 2
with the limit in the message. Dispatch the workflow with `rebuild: true` to
regenerate the shards and summaries from every stored partition.

Ingestion never rewrites history and never writes `main`: it only ever appends to
the dedicated `tamperward-audit` branch. An operator can still ingest a one-off
batch by hand via the workflow's `workflow_dispatch` input (useful for recovery).

**Credential isolation.** The workflow is split into a read-only `prepare` job
that builds, validates and computes the append (it has `contents: read` and
`persist-credentials: false`, so no write credential is present while `npm ci`,
the build, or candidate package code runs) and a minimal `publish` job that holds
the write credential but runs no `npm ci` and no candidate code — only first-party
actions, a dependency-free re-validation against the committed schema, and `git`.
The prescan runs before any build, so a merge with nothing new to ingest costs
only a checkout and a shallow read of the evidence branch.
