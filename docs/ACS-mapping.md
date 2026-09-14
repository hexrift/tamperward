# TamperWard and the OWASP Agent Control Standard (ACS)

This page maps TamperWard's **implemented** in-loop event/control semantics to concepts in
the OWASP **Agent Control Standard (ACS)**, and states plainly what TamperWard does **not**
do. It is a mapping of concrete, tested mechanisms — not a compliance claim.

> **TamperWard does not claim ACS compliance.** ACS spans identity, authentication,
> authorization, network-egress control, and full lifecycle governance. TamperWard
> implements a narrow slice — synchronous pre-execution interception and post-turn
> reconciliation for test/CI/policy-integrity, fail-closed — and the rest is out of scope.
> Only the semantics actually implemented and tested are mapped below.

Reference: [OWASP Agent Control Standard](https://genai.owasp.org/resource/agent-control-standard-acs/).

## What TamperWard actually implements

TamperWard's neutral steering contract ([runtime-adapters](./guide/runtime-adapters.md))
has three phases and a fail-closed rule. The Claude Code adapter is the reference
implementation:

- **`pre-action`** — a synchronous decision before an operation runs (Claude `PreToolUse`).
  A `deny` blocks the operation, and holds even under `--dangerously-skip-permissions`.
- **`post-action`** — observation only, never a veto.
- **`end-of-turn`** — a mandatory sweep of the turn's net effect on the repository (Claude
  `Stop`), which catches mutations the pre-action layer could not veto.
- **fail-closed** — an unparseable event or an unreachable verdict is a **deny**, not an
  allow.

## Mapping: implemented semantics → ACS concepts

| TamperWard mechanism | ACS-adjacent concept | Status |
| --- | --- | --- |
| `pre-action` deny (PreToolUse) | a **synchronous policy-enforcement / interception point** on a proposed action, returning allow/deny before execution | **Implemented** for every Claude operation kind (shell, file-edit, file-read, MCP, other) |
| `end-of-turn` mandatory sweep (Stop) | **post-turn reconciliation** of the actual resulting state against policy | **Implemented** (Claude `Stop`) |
| fail-closed on parse/transport failure | a **control that denies when it cannot evaluate** (no fail-open on control-plane failure) | **Implemented** (`HookInputError` → `failClosed`; `parse-failure` / `transport-failure` → deny) |
| per-operation capability descriptor | **explicit declaration of which controls are enforced**, per operation, so uncovered operations are visible | **Implemented** (`RuntimeCapabilities`: `preDeny` / `postObserve` / `endOfTurn` / `unsupported`) |
| identity-claim validation | **binding an action to a validated resource identity** (here: the repository root) | **Partial** — the repository root is derived independently and the runtime `cwd` claim is validated against it; there is **no** agent identity or authentication |
| deny reason returned to the agent | **actionable policy feedback** to the controlled agent | **Implemented** (`formatDenial` on the deny wire) |
| repository/CI as final authority | **defence in depth** — a control layer that is not the sole authority | **Implemented** — the run envelope and CI re-adjudicate independently of any adapter |

## Explicitly unsupported (out of scope)

TamperWard does **not** implement, and does not claim, the following ACS-adjacent
capabilities:

- **Identity and authentication.** There is no agent identity, no credential, no authN/authZ
  of the acting principal. The only "identity" is the repository root, and it is validated,
  not authenticated.
- **Network-egress control.** TamperWard does not observe or gate network activity.
- **Per-operation post-action veto.** A mutation observed after it lands is reconciled at
  `end-of-turn`, not vetoed in place — a post-edit hook is never treated as a
  pre-execution control.
- **Full lifecycle / runtime governance, quotas, rate limits, and audit attestation.** The
  `--json` verdict and job-summary renderer exist, but a *signed, attested verdict
  statement* does not (tracked as SPEC M5).
- **Cross-runtime equivalence.** Only Claude Code is implemented in-loop. A future partial
  adapter (e.g. shell/MCP pre-deny only) would map a **strict subset** of the pre-action
  row above and record the rest in `unsupported`; it would not inherit this table's
  "Implemented" marks for the operations it cannot pre-deny.

## Why the mapping is by mechanism, not by hook name

The mapping above is deliberately from **implemented event/control semantics** to ACS
concepts, with the gaps named — not from the *names* of Claude's hooks to ACS concepts. A
runtime earns an "Implemented" mark only when the mechanism is present, installed
fail-closed, and tested; the capability descriptor is what a cross-runtime study reads, so
a scoped partial adapter is never presented as more than it is. This is the honest basis on
which TamperWard maps to ACS while declining to claim compliance it has not implemented and
tested.
