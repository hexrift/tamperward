# Policy reference

`.tamperward.yml` at the repository root configures the gate. It is an **overlay on the
built-in baseline**, never a replacement: setting one rule's severity does not drop the
other rules, and naming one protected glob does not wipe out the rest of its category. The
defaults apply even with no file present — `tamperward init` writes a commented baseline.

The policy file is itself a **guarded surface**. At the CI layer the governing policy is
read from the merge-base, not the branch head, so a pull request cannot weaken the gate
that judges it; a weakening edit still shows up as a `hook-tampering` finding but does not
take effect until a human merges it.

**Fail closed on anything not understood.** A file that exists but cannot be parsed —
invalid YAML, an unknown top-level key, a mistyped value like `severity: BLOCK` — is a
`PolicyError`: `check` exits 2 and the hook denies until it is fixed. It is never
swallowed into the baseline, because a silently weaker gate is the exact failure the check
exists to prevent. Unknown **rule names** stay accepted (a policy written for a newer build
must still load on an older one); it is the **values** that must be exact.

[[toc]]

## Top-level keys

Exactly these six keys are recognised; any other top-level key fails closed.

| key | shape | purpose |
| --- | --- | --- |
| [`version`](#version) | positive integer | Opt in to rule graduations. |
| [`protected`](#protected) | mapping of category → list of globs | Files the gate guards, by category. |
| [`rules`](#rules) | mapping of rule name → override | Per-rule severity / enable / exclude. |
| [`ignore`](#ignore) | list of globs | Paths the gate does not scan. |
| [`signoff`](#signoff) | mapping | Which severities need sign-off, and the ledger path. |
| [`verify`](#verify) | mapping | The pristine-suite verifier contract. |

A complete example:

```yaml
version: 1

protected:
  tests: ['test/**', '**/*.test.ts']
  snapshots: ['**/__snapshots__/**']
  config: ['jest.config.*', 'vitest.config.*']

rules:
  assertion-weakening:
    severity: warn
  test-deletion:
    exclude: ['test/legacy/**']

ignore: ['docs/**']

signoff:
  required_for: [block]
  ledger: .tamperward-signoffs.jsonl

verify:
  command: npm test
  budget: 300
  inputs: ['scripts/**']
```

## `version`

```yaml
version: 1
```

A positive integer (default `1`). It opts the policy in to **rule graduations** — a
baseline rule promoted `warn` → `block` at policy version *N* blocks only for policies
declaring `version: >= N`. Graduations therefore ship as minors and never turn an
un-opted-in build red; an explicit `severity:` you write always wins in either direction.
A value that is not a positive integer fails closed. See
[rule graduations](../guide/rules.md#rule-graduations-are-opt-in).

## `protected`

```yaml
protected:
  tests: ['test/**', '**/*.spec.js']
  snapshots: ['**/*.snap']
  config: ['jest.config.*']
```

A mapping of **category** to a list of globs, merged **per category** onto the baseline —
naming one glob adds to that category rather than replacing it. The three categories the
pristine verifier restores from the trusted base — the **overlay classes** — are `tests`,
`snapshots`, and `config`. A negated (`!`) glob is refused, because in an inclusion list it
would match every path; list the paths instead.

## `rules`

```yaml
rules:
  assertion-weakening:
    severity: warn        # "block" | "warn"
    enabled: true         # true | false
    exclude: ['test/fixtures/**']
```

A mapping of rule name to an override object. Each field is optional and validated exactly:

| field | type | notes |
| --- | --- | --- |
| `severity` | `block` \| `warn` | Any other spelling (`BLOCK`, `blocc`) is rejected. |
| `enabled` | boolean | `false` disables the rule where policy is permitted to. |
| `exclude` | list of globs | Paths the rule does not judge. Negated globs refused. |

An `exclude`-only override keeps the rule's baseline severity (it is merged, not replaced).
Two ids — `detector-error` and `hidden-drift` — are **not** rules and cannot be disabled,
lowered, or excluded, because each reports that the gate could not do its job; see
[two findings that are not rules](../guide/rules.md#two-findings-that-are-not-rules). The
full rule catalogue is on [The rules](../guide/rules.md).

## `ignore`

```yaml
ignore: ['vendor/**', 'docs/**']
```

A list of globs the gate does not scan at all. A negated glob is refused (it would ignore
every file).

## `signoff`

```yaml
signoff:
  required_for: [block]
  ledger: .tamperward-signoffs.jsonl
```

| field | type | notes |
| --- | --- | --- |
| `required_for` | list of `block` / `warn` | Which severities require a recorded sign-off to clear. (`requiredFor` is also accepted.) |
| `ledger` | relative path inside the repo | The local sign-off ledger. An absolute path or one escaping the repo (`../shared.jsonl`) is refused — the ledger is the one file the local layer trusts, so it must not be handed to a location outside the diff and CODEOWNERS. |

In CI the sign-off is out-of-band (a PR label bound to the head SHA), never the committed
ledger. See [the sign-off model](../guide/enforcement.md#the-sign-off-model).

## `verify`

```yaml
verify:
  command: npm test
  budget: 300              # seconds; default 300
  inputs: ['scripts/**']   # what the command DELEGATES to — optional
  # backend: container
  # image: ghcr.io/acme/verifier@sha256:<64-hex-digest>
```

The contract for `tamperward verify` (and the CI verify step). The CI verify step **needs**
a `command`; without one it fails closed rather than passing quietly.

| field | type | notes |
| --- | --- | --- |
| `command` | string | The trusted suite command. |
| `budget` | positive number | Per-stage seconds (default `300`). |
| `inputs` | list of globs | Extra files the command delegates to, restored alongside the overlay classes. |
| `backend` | `local` \| `container` | `local` (default) is checkpointed same-host verification; `container` is a stronger frozen-artifact boundary. |
| `image` | `name@sha256:<64 hex>` | **Required** when `backend: container`, and only valid then; must be pinned by sha256 digest. |

The `container` backend runs the digest-pinned image with no pull during adjudication,
read-only candidate input, network disabled, and private HOME/tmp; write suite artifacts to
`$TAMPERWARD_OUTPUT_DIR`. Images with a Dockerfile `VOLUME` are rejected, and the image
`ENTRYPOINT` is overridden so the trusted `command` controls execution. The container
verifier is intentionally not available through `tamperward run`.

**Changing `command`, lowering `budget`, narrowing `inputs`, removing an isolated backend,
or changing its image is itself reported as policy weakening.** Use
[`trace-verify`](../guide/getting-started.md#discovering-delegated-verifier-inputs-tamperward-trace-verify)
to discover candidate `inputs` from a trusted base.

## See also

- [The rules](../guide/rules.md) — the rule catalogue and severities.
- [Enforcement & sign-off](../guide/enforcement.md) — the trust model policy lives in.
- [Environment variables](../guide/environment.md) — variables the gate reads at runtime.
- [CLI reference](./cli.md) · [Machine output](./machine-output.md) · [Exit codes](./exit-codes.md).
