# Machine output

Tamperward's machine surfaces are the integration contract for CI and other tools: the
`--json` verdict envelopes, the `--format github` annotations, the verdict and reason
enums, and the published JSON Schemas. This page is the reference; to wire it into a
pipeline see [Integrate](../integrate.md).

From **2.19.0** the public JSON verdict surfaces are **versioned independently of the npm
package version**. Every document carries a top-level `"schema_version": 1`. Schema major
**1** is deliberately additive: **consumers must ignore fields they do not understand**,
and new evidence/diagnostic fields ship without a bump. Removing or renaming a required
field, changing its type, or changing a discriminator's meaning requires
`schema_version: 2` and new `*-v2.schema.json` files; the v1 files stay published.

The JSON schemas describe **data shape**, not process status — exit codes are a separate
public protocol, documented on [Exit codes](./exit-codes.md).

[[toc]]

## Choosing a format: `--format` / `--json`

`check` renders in one of four formats; `--json` is an alias for `--format json`.

| format | where it goes |
| --- | --- |
| `text` | The terminal. Blocking findings first, then by file and line. Severity is always spelled out (`BLOCK` / `warn`), never carried by colour alone; honours `NO_COLOR` / `FORCE_COLOR`. |
| `github` | One inline annotation per finding — on the line in *Files changed* — plus a job-summary table on the run page. The full text output still goes to the log. |
| `json` | The versioned machine document (below). |
| `auto` | `github` when `GITHUB_ACTIONS=true`, otherwise `text` — so CI wiring stays one line. |

`--json` cannot be combined with `--format`. `verify`, `run`, `doctor`, `stats` and
`research` accept `--json` and emit their own documents.

## `check --json`

A findings document plus a scan summary.

```json
{
  "schema_version": 1,
  "findings": [
    {
      "rule": "test-deletion",
      "severity": "block",
      "file": "test/calc.test.js",
      "line": 12,
      "message": "Test blocks removed: 3 → 1 it()/test() in this spec.",
      "evidence": "2 test block(s) removed from test/calc.test.js",
      "remediation": "Keep the assertions and fix the code.",
      "signoff": { "required": true, "command": "tamperward allow test-deletion --file test/calc.test.js --reason \"...\"" }
    }
  ],
  "scanned": ["test/calc.test.js"],
  "ignoredFiles": [],
  "summary": { "block": 1, "warn": 0 }
}
```

| field | type | notes |
| --- | --- | --- |
| `findings[]` | array | Each finding requires `rule`, `severity`, `message`, `evidence`, `remediation`, `signoff`. `file` and `line` are present when the finding is located. |
| `severity` | enum | `block` \| `warn`. Only `block` affects the exit code. |
| `signoff` | object | `required` (boolean) and `command` (the `tamperward allow …` line that clears it). |
| `scanned` | array | Files the gate read. |
| `ignoredFiles` | array | Files excluded by `ignore` globs. |
| `summary` | object | Counts by severity. |

Full contract: [`schemas/check-v1.schema.json`](https://github.com/hexrift/tamperward/blob/main/schemas/check-v1.schema.json).

## `verify --json`

`verify --json` never falls back to prose: it emits a document with an enumerated verdict
on every path, including a `CANNOT_VERIFY` document with a machine `reason` on every
fail-closed exit before a verdict exists.

**Verdicts** (`verdict`):

| verdict | meaning | exit |
| --- | --- | --- |
| `VERIFIED` | Visible green **and** pristine green. | 0 |
| `MASKED_FAILURE` | Visible green, pristine red — the masked failure. | 1 (0 under a compact `tw1:<digest>` or legacy `verify@<full-sha>` approval) |
| `SUITE_RED` | The visible suite itself failed. | 1 |
| `BUDGET_EXCEEDED` | A stage ran out of time budget. | 2 |
| `CANNOT_VERIFY` | Could not reach a verdict; `reason` says why. | 2 |

**`CANNOT_VERIFY` reasons** (`reason`), with `stage` (`visible` \| `pristine`) naming the
suite execution in flight where one was:

`INVALID_ARGUMENTS`, `POLICY_ERROR`, `BASE_NOT_ANCESTOR`, `NO_SUITE_COMMAND`,
`VERIFIER_BACKEND_UNAVAILABLE`, `LOCAL_VERIFIER_UNSUPPORTED_PLATFORM`,
`DEPENDENCY_ENVIRONMENT_UNATTESTABLE`, `BASE_UNRESOLVABLE`, `DEPENDENCY_DRIFT`,
`MATERIALIZATION_FAILED`, `VERIFIER_BACKEND_RUNTIME_FAILURE`, `VERIFIER_RESOURCE_EXHAUSTED`,
`WORKTREE_CHANGED`, `PRISTINE_INTEGRITY_CHANGED`, `PATH_CASE_COLLISION`.

When `reason` is `MATERIALIZATION_FAILED`, the additive `materialization_reason` field
identifies the confirmed failure class: `TRACKED_NODE_MODULES_CONFLICT`,
`SYMLINK_ESCAPE`, `SPECIAL_FILE`, `RACING_DELETION`, or `UNKNOWN`. It is omitted for
other reasons and does not change the top-level fail-closed reason or exit code.

A resolved (non-`CANNOT_VERIFY`) document also carries `base`, `command`, `budget_secs`,
the `visible` and `pristine` stage records (`exit`, `secs`), `protected_restored`,
`added_protected_removed`, the `verifier_backend` (`kind` local \| container, `trust`,
`available`, digest-pinned `image` for a container), the `dependency_environment` status,
and an `oracle_assurance` block (level `suite-exit-only`). Full contract:
[`schemas/verify-v1.schema.json`](https://github.com/hexrift/tamperward/blob/main/schemas/verify-v1.schema.json).

## `run --json`

`run --json` owns stdout after the wrapped agent starts and emits **one** final envelope
document after adjudication.

**Verdicts** (`verdict`): `VERIFIED`, `AGENT_TIMEOUT`, `AGENT_FAILED`,
`ENFORCEMENT_FAILED`, `CANNOT_ADJUDICATE`, `OBJECT_REWRITE`, `HISTORY_REWRITE`,
`DEPENDENCY_DRIFT`, `NOT_QUIESCENT`, `TRANSIENT_OBSERVER_BLOCK`.

**`CANNOT_ADJUDICATE` reasons**: `AGENT_LIFECYCLE_NOT_OWNED`, `VERIFY_CANNOT_VERIFY`,
`CHECK_DIFF_UNJUDGEABLE`, `CHECK_WORKTREE_UNJUDGEABLE`.

Full contract:
[`schemas/run-v1.schema.json`](https://github.com/hexrift/tamperward/blob/main/schemas/run-v1.schema.json).

## Other JSON surfaces

| command | document | schema |
| --- | --- | --- |
| `doctor --json` | Installation + authority posture. | [`schemas/doctor-v1.schema.json`](https://github.com/hexrift/tamperward/blob/main/schemas/doctor-v1.schema.json) |
| `research run --json` / `research summarize` | Paired records and the aggregate summary (from **2.23.0**). | [`schemas/research-v1.schema.json`](https://github.com/hexrift/tamperward/blob/main/schemas/research-v1.schema.json) |
| `stats --json` | Aggregate audit document. | [`schemas/stats-v1.schema.json`](https://github.com/hexrift/tamperward/blob/main/schemas/stats-v1.schema.json) |

## The audit event

The privacy-safe structured event written under `TAMPERWARD_AUDIT_LOG` (JSONL, one event
per line, from **2.26.0**). Only allowlisted metadata is serialised — prompts, command
bodies, source, evidence, filenames, absolute paths and environment values are **never**
recorded.

| field | type | notes |
| --- | --- | --- |
| `schema_version` | `1` | |
| `id` | string | `sha256:` + 32 hex — the event id (dedup key). |
| `timestamp` | string | ISO-8601 UTC. |
| `surface` | enum | `pretooluse` \| `stop`. |
| `agent` | string | Lowercase agent id. |
| `rule` | string | The rule id. |
| `severity` | enum | `block` \| `warn`. |
| `decision` | enum | `deny` \| `warn` (a `block` severity always pairs with `deny`). |
| `session` | string | Optional `sha256:` + 24 hex hashed session id. |

Full contract:
[`schemas/audit-v1.schema.json`](https://github.com/hexrift/tamperward/blob/main/schemas/audit-v1.schema.json).
See [Audit history & stats](../guide/audit.md) for how to enable and read it.

## Consuming machine output

A program should key on **`verdict`** (or, for `check`, the presence of a `block` finding)
and treat the **exit code** as the authoritative pass/fail — the two agree, and the exit
code is the contract even when a document is truncated. Because major 1 is additive, parse
defensively and ignore unknown fields. A worked CI example is on
[Integrate](../integrate.md#consuming-machine-output).
