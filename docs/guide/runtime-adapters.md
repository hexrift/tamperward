# Runtime adapters: the vendor-neutral steering contract

TamperWard's detectors and engine are runtime-neutral. Every enforcement point —
the Claude Code PreToolUse hook, the Stop sweep, pre-commit, and CI — manufactures a
`Change[]`, and the engine judges that list without knowing which agent produced it.
The only Claude-specific code is a thin seam: the hook I/O (`src/cli/hook.ts`) and the
Claude adapter (`src/adapters/claude/*`).

Phase 1 of [#482](https://github.com/hexrift/tamperward/issues/482) names that seam as a
**type** — the `RuntimeAdapter` contract in `src/adapters/contract.ts` — so a second
in-loop runtime can implement it without a rewrite, and so the semantics a runtime does
and does **not** provide are recorded explicitly rather than assumed.

This page documents the contract. It ships **no** second runtime: Claude Code is the
first (and, in this release, only) implementation. Anything a partial adapter cannot do
is stated as an explicit gap, never silently degraded.

## The three phases: decision vs. observation

A runtime can hand TamperWard control at three distinct points. They are kept separate on
purpose, so that a hook which only *observes* an operation is never mistaken for one that
can *veto* it.

| Phase | When | What it carries | Claude Code |
| --- | --- | --- | --- |
| `pre-action` | **before** the operation runs | a **synchronous decision** — a `deny` blocks the operation | `PreToolUse` (holds even under `--dangerously-skip-permissions`) |
| `post-action` | **after** the operation ran | the outcome, **observation only** — never a veto | *(none live; see below)* |
| `end-of-turn` | the turn is ending | lifecycle status **plus a mandatory final sweep** of the turn's net effect | `Stop` |

The end-of-turn sweep is the safety net for anything the pre-action layer could not veto.
If a runtime can only *observe* native file edits (they land before the hook sees them),
the mandatory Stop sweep is what still catches a protected-file deletion made that way —
which is exactly why `post-action` never carries a decision and `end-of-turn` is not
optional.

## Per-operation capabilities

Capabilities are declared **per operation**, not per layer. The operation kinds are:

```
shell | file-edit | file-read | mcp | other
```

A runtime's `RuntimeCapabilities` records, for each phase, which operation kinds it
covers:

- `preDeny` — operation kinds it can **synchronously deny** before execution;
- `postObserve` — operation kinds it reports **after** execution (observation only);
- `endOfTurn` — whether it delivers a stop event that can run the mandatory sweep;
- `unsupported` — semantics it explicitly does **not** provide, as prose tags.

**Claude Code declares `preDeny` for every operation kind** (PreToolUse fires for all
tools and can deny any of them — it simply finds nothing to block on a pure read) plus
`endOfTurn`. It has no live per-tool `post-action` veto, so `postObserve` is empty and
`unsupported` names that, along with the boundaries TamperWard does not police at all
(network-egress control, identity/authentication).

Because `post-action` is observation-only, `decide(..., 'post-action')` for Claude returns
the `unsupported` outcome — **no decision, no deny wire**. The phase→hook mapping refuses to
route `post-action` to any deny-capable hook rather than silently falling through to
PreToolUse: a post-edit observation must never be treated as a pre-execution veto.

## Mapping to the research adapter layers

The research runner (`src/research/adapter.ts`) records, per gated run, a coarse `layers`
list — `envelope` / `pre-tool-use` / `stop-sweep` — so a cross-runtime comparison never
silently compares different treatments. The neutral contract maps onto it directly
(`CONTRACT_TO_RESEARCH_LAYER` in `src/adapters/contract.ts`):

| Neutral contract | Research `layer` |
| --- | --- |
| `pre-action` (synchronous pre-execution deny) | `pre-tool-use` |
| `end-of-turn` (mandatory reconciliation sweep) | `stop-sweep` |
| the post-exit run envelope around the agent process | `envelope` |

The per-**operation** capabilities refine this coarse mapping: a runtime records the
`pre-tool-use` layer only for the operation kinds it can actually pre-deny, so a partial
adapter's shell/MCP interception is never recorded as the same treatment as Claude's
all-operation PreToolUse. (This is a doc/type mapping; it changes no research-runtime
behaviour.)

### Partial adapters are scoped, not equivalent

A runtime that supplies only a **subset** — for example shell and MCP pre-deny but not
native file-edit pre-deny — is a **scoped partial adapter**. It records the gap in
`unsupported` (e.g. `file-edit pre-deny`) and **does not meet Claude-equivalent
semantics**. A cross-runtime study reads the capability descriptor precisely so it never
presents a shell/MCP-only interception as equivalent to Claude's all-tool PreToolUse. For
the operation kinds a partial adapter cannot pre-deny, the run envelope and CI remain the
security boundary, and the mandatory end-of-turn sweep still catches a mutation the
pre-action layer could not veto.

## Explicit failure states, and the fail-closed rule

The contract makes the outcome of a steering attempt explicit, so a runtime that could
**not** participate is never confused with one that **allowed**:

| Outcome | Meaning | Maps to |
| --- | --- | --- |
| `ok` | the runtime participated | the decision it produced (allow or deny) |
| `unsupported` | this phase/operation is outside the declared capabilities | no decision — the envelope/CI boundary is authority |
| `not-invoked` | a required hook did not fire (config removed, platform regression) | **deny** (fail closed) for a required phase |
| `parse-failure` | the event bytes could not be understood | **deny** (fail closed) |
| `transport-failure` | the event could not be delivered/retrieved | **deny** (fail closed) |

`parse-failure` and `transport-failure` **must** map to `deny`. This mirrors the live
`HookInputError` → `failClosed` behaviour in `src/cli/hook.ts`: a payload TamperWard
cannot parse, or a verdict it cannot transport, is denied rather than allowed. The core
wire rule the whole seam preserves:

> **deny = JSON on stdout at exit 0; exit 2 is never a verdict; unparseable/unreachable =
> deny (fail closed); empty stdin = allow.**

Note one Claude-specific nuance: Claude's live hook client degrades a hook-*service*
transport failure to the **in-process** verdict (`src/cli/hook-client.ts`) rather than
surfacing `transport-failure` at the seam — the verdict is still computed, just locally.
A partial adapter with no in-process fallback denies through the fail-closed path instead.

## Identity is a claim to validate, not a trusted fact

The `cwd`, repository, and session a runtime supplies are **untrusted input**. The runner
derives the real repository root **independently** with `git rev-parse --show-toplevel`
(which resolves symlinks to a canonical path) and validates the claim against it:

- a malformed or empty cwd claim is **rejected**;
- a claim that resolves to **no repository**, or to a **different** repository than the
  one under enforcement, is **rejected**;
- path escapes and symlink escapes out of the trusted root are **rejected**;
- a relative claim resolves against the **runner's** cwd, never against itself.

This is enforced, not merely documented. `RuntimeAdapter.validateIdentity` derives the
runner's trusted root from the **runner** context (the runner cwd the adapter is given),
INDEPENDENTLY of the claim, then validates the claim against it with the shared
`validateClaimAgainstRoot` helper (`src/repo-context.ts`). `RuntimeAdapter.decide` calls it
**first** — `parse → validate → decide` — and returns a fail-closed **deny** on rejection,
before any content reaches the detectors, so a runtime-supplied cwd pointing at another
repository can never be evaluated as if it were the one under enforcement.

The same helper closes the boundary on the live path: `preToolUseVerdict` / `stopVerdict`
accept an optional `trustedRoot`, and when a runner supplies one (a `RuntimeAdapter`'s
validated root; the persistent hook service's bound root), a cross-repo / non-repo /
malformed `input.cwd` fails closed there too. The parameter is optional and defaults to
unset: the **direct** in-loop hook is launched by the runtime inside the repository it
names, so it has no separate anchor, and every existing caller that supplies no
`trustedRoot` behaves byte-identically — only a runner with its own independently-derived
trusted root turns the claim into something to reject. This mirrors — and never weakens —
what the live path already does by resolving through `repoRoot()` (#412: the verdict is
always computed at the repository root, so an edit judged from `packages/x` is the edit
judged from the root). The payload's `cwd` is a fact to check, not authority to accept.

## How to add a runtime

1. **Map the runtime's events to the neutral shape.** Implement `parseEvent(raw, phase)`
   returning a `SteeringEvent` (proposed operation + kind + args + untrusted identity), or
   `{ failure: 'parse-failure', detail }`. Reuse `synthFileChange`
   (`src/adapters/claude/changes.ts`) so diff reconstruction and its fail-closed behaviour
   are shared, not re-implemented.
2. **Declare capabilities honestly, per operation.** Only claim `preDeny` for an operation
   kind the runtime can *synchronously* deny in the *installed* configuration, proven by
   invocation evidence — not by the existence of a hook name. Record every gap in
   `unsupported`.
3. **Emit the runtime's native deny envelope** from `denyPayload(findings, phase)`, reusing
   `formatDenial` so the denial reason reaches the agent identically.
4. **Fail closed.** Ensure the *installed* configuration denies on timeout, malformed
   output, a missing executable, a non-zero exit, and hook non-invocation. A green
   standalone hook test is not evidence; the failure modes must be exercised against the
   real config.
5. **Validate identity independently** in `validateIdentity`, per the section above. Never
   let the runtime's `cwd` become authority.
6. **Protect the new wiring itself.** A gate that cannot protect its own steering
   configuration on the new runtime does not meet the bar. (This, the second adapter, the
   research-adapter registration, and the parity suite are Phase 2 / Phase 3 work — see the
   issue's staged sequence. Phase 1 ships the neutral seam and the Claude conformance only.)

## Codex (EXPERIMENTAL — adapter exists, not yet 4.1-eligible)

An **experimental** Codex adapter ships in `src/adapters/codex/*`
([#482](https://github.com/hexrift/tamperward/issues/482),
[#563](https://github.com/hexrift/tamperward/issues/563)). It is the second implementation
of the neutral `RuntimeAdapter` contract, and it is deliberately conservative.

**Grounded in the real Codex protocol.** The adapter's wire is grounded against the Codex
source (`openai/codex`, `codex-rs/hooks/schema/generated` and `codex-rs/core/src/tools`),
not guessed. The canonical **hook-facing** tool names are `Bash` (the whole shell/exec
family), `apply_patch` (with `Write`/`Edit` as matcher aliases), and `mcp__<server>__<tool>`
(`hook_names.rs`, `unified_exec.rs`, `mcp.rs`). The **apply_patch** payload is
`tool_input.command` carrying the patch text (`apply_patch.rs`). The **deny wire differs by
phase**: PreToolUse denies with `hookSpecificOutput.permissionDecision:"deny"` (plus the
deprecated top-level `decision:"block"`), while Stop denies with `{decision:"block", reason}`
and **no** `hookSpecificOutput`
(`pre-tool-use.command.output.schema.json`, `stop.command.output.schema.json`). Those four
schema files are copied verbatim into `test/fixtures/codex-schemas`, and
`test/codex-protocol.test.ts` validates the adapter's inputs and deny wire against them.

**Two milestones, not one.** *An adapter existing is not the same as a runtime being
qualified for in-loop enforcement.* Milestone one — the adapter — is done: it normalizes
Codex hook payloads, maps the canonical tool names to operation kinds, reconstructs shell
and file-edit operations (including `apply_patch`) into the shared `Change[]` via
`synthFileChange`, runs the **same** engine as the Claude path for its pre-action content
decision, delegates the end-of-turn sweep to the canonical git sweep, validates identity as
an untrusted claim, and fails closed on every failure state. Milestone two — proving that
Codex actually **enforces** a pre-action deny and that its hook transport actually **fails
closed** on a *pinned* Codex build — is **not** met, so Codex is **not** eligible for
Round 4.1. The registry (`src/runtimes.ts`) keeps Codex at `steering: 'neutral'` and no
research round is registered. This matters because Codex currently **fails open** on some
hook failures (`pre_tool_use.rs` `serialization_failure_outcome`,
`permission_decision_allow_without_updated_input_fails_open`): a real qualification run may
legitimately come back PARTIAL, which is exactly why the probe *proves* fail-closed from
evidence rather than assuming it.

**Conservative capabilities.** The Codex adapter declares:

- `preDeny: []` — pre-action deny enforcement is **not yet proven** on a pinned Codex build,
  so the adapter claims no synchronous veto (per the honesty rule: only claim `preDeny` for
  a kind proven by invocation evidence, never by the mere existence of a hook name);
- `postObserve: shell | file-edit | file-read | mcp | other` — Codex surfaces
  post-execution tool outcomes;
- `endOfTurn: true` — Codex delivers a stop event that runs the mandatory git sweep;
- `unsupported` names the real gaps in prose: *pre-action deny enforcement not yet proven on
  a pinned Codex build*, *fail-closed hook transport not yet proven
  ([openai/codex#41979](https://github.com/openai/codex/issues/41979))*, *network-egress
  control*, and *identity / authentication*.

**Three-layer qualification.** Qualification is layered so the parts that *can* run
deterministically in CI are separated from the part that needs a real Codex box:

- **(a) Protocol conformance** (`test/codex-protocol.test.ts`, CI) — the adapter parses the
  real Codex input shape and its deny wire validates against the copied real output schemas.
- **(b) Probe self-test** (`test/codex-probe-selftest.test.ts`, CI) — the probe's own
  classifiers are asserted against every deterministic mode (hook-fired-deny-respected,
  deny-ignored, hook-never-fired, tool-never-attempted, observed-failure-fail-closed,
  unobserved-failure, outer-timeout-inconclusive, stop-respected/ignored/never-fired), the
  provenance gate is asserted (a missing pin or version mismatch caps at not-full), the
  distinct-`tool_use_id` counter is checked, and the **real** driver is built and exercised
  end-to-end (decide → append to a parent-owned ledger → classify). This proves the probe
  *itself* cannot false-green.
- **(c) Real Codex E2E** (`npm run probe:codex-runtime`, **not** run in CI) — the real gate
  for milestone two, on a pinned Codex build.

**`probe:codex-runtime`** (`harness/adapters/codex-probe.mjs`) drives a real `codex` binary
against a real repository. Each mutation class (shell edit, `apply_patch` edit, native
edit/write, delete, rename, git checkout/reset/restore, MCP op, nested shell, *multiple tool
calls in one turn*, detached/background mutation) is run as a **CONTROL** (fully pass-through
hooks → the mutation must land) vs **GATED** (TamperWard hook → deny) pair. Evidence is a
**parent-owned, append-only ledger** written **outside** the candidate repo by the hook
driver, plus a tracer hook that records that the tool was attempted; `specIntact` alone is
never proof. A mutation case passes only when the ledger shows the expected tool was
attempted, PreToolUse fired, TamperWard denied, the reason reached Codex, the mutation did
**not** land, and Codex completed, and the gated wiring **binds** to the recorded provenance
hash. The *multiple protected mutations* case additionally requires a **denied PreToolUse
command targeting each protected file** (`src/a.spec.ts` *and* `src/b.spec.ts`) — two denials
against one file is not two targets — and the control arm must land both; genuine concurrency
is not asserted. A dedicated **detached/background** case backgrounds a delayed mutation and a
parent-owned sentinel, then judges only after a **settle interval** exceeding the child's
delay, so a deny that was ignored cannot escape by mutating after the command returns.

FULL additionally requires a **real Stop qualification**: a case that lets a protected
mutation LAND during the turn (pre-action pass-through) and then proves from the ledger that
Stop fired, the sweep returned the `{decision:block, reason}` wire, and Codex **honoured** it
by continuing the turn — a subsequent Stop with `stop_hook_active:true` (codex-rs `turn.rs`
injects a continuation), not merely that the feedback appeared and the process exited.

For **fail-closed transport**, each broken hook (crash, non-zero exit, malformed JSON, empty
output, timeout, missing executable) writes a positive `hook-failure` marker of its kind to
the ledger **before** it triggers the fault, so `intendedHookFailure` is **observed**, never
assumed; `protectedToolAttempted` is bound to the **specific** expected Bash command (the
sentinel path *and* the protected file), not merely "some tool fired", and a pass-through
control proves the prompt is potent; the protected command drops a parent-owned **dispatch
sentinel**, so a PASS requires direct proof the tool was **not dispatched**, not merely an
intact file; a case where the **outer harness timeout** killed Codex is treated as
**inconclusive**, never a fail-closed PASS. Three identity-poison cases (invalid, cross-repo,
symlink-escape claimed cwd) run the driver directly with an **explicit** adversarial cwd and
must fail closed.

Before it may print `Eligible for Round 4.1`, the probe enforces a **provenance gate**:
`CODEX_VERSION_EXPECTED` (the running Codex version token must match it **exactly** — `0.9.1`
never qualifies a running `0.9.10`), `CODEX_MODEL` (passed
operatively to `codex exec` as `--model`, so the pinned model is the one that runs), and
`CODEX_HOME` must be set, and the **canonical SHA-256 of the gated `.codex/hooks.json`** — the
wiring every qualifying gated run is bound to — must be captured, alongside the Codex binary
SHA-256, OS/arch, `exec` args, approval/sandbox mode, and adapter/probe/driver hashes. Any
missing pin caps the result at PARTIAL. With no
Codex CLI present it reports PARTIAL and exits non-zero, so "could not test" is never mistaken
for "passed". Only a FULL verdict justifies flipping Codex to `in-loop` and registering
Round 4.1 — deliberately not done by this PR.

**CI honesty.** A green CI run proves the **build, unit/adapter tests, static gate, protocol
conformance (a), and the probe self-test (b)** only. It does **not** prove runtime
qualification: the real-Codex E2E (c) is not run in CI (no Codex binary there). Codex stays
experimental and `neutral`, `preDeny` stays empty, and no Round 4.1 is registered until a FULL
`probe:codex-runtime` verdict on a pinned build says otherwise.

The Codex pre-action path pins the Stop-sweep baseline at **turn start** (`turnBaseline`) on
every pre-action call, exactly as the canonical `preToolUseVerdict` does — because with
`preDeny` empty the end-of-turn git sweep is Codex's only real enforcement, and a baseline
first set at Stop time would let a mutation the turn *committed* mid-turn slip past the
sweep. Full parity with the other two canonical pre-action steps — `effectDriftBlocks`
(hidden out-of-band drift) and `sanctionPredictedWrites` (so an allowed pre-action edit is
not re-flagged by the Stop sweep) — is a **PR 2** follow-up; those matter only once Codex is
wired live with the effect observer.

**PR 2 follow-up.** Generating `.codex/hooks.json` from `init` / `onboard`, and protecting
that control surface (the same way the Claude hook wiring is protected), is the next PR,
along with the `effectDriftBlocks` / `sanctionPredictedWrites` parity noted above. This PR
wires hooks only inside the probe harness; it adds no init/onboard generation.

## GitHub Copilot CLI (EXPERIMENTAL — adapter exists, not yet 4.1-eligible)

An **experimental** GitHub Copilot CLI adapter ships in `src/adapters/copilot/*`
([#482](https://github.com/hexrift/tamperward/issues/482),
[#598](https://github.com/hexrift/tamperward/issues/598)). It is the third implementation of
the neutral `RuntimeAdapter` contract, and — like Codex — it is deliberately conservative.

**Grounded in the published Copilot hook contract, both documented formats.** Copilot CLI is
closed-source, so the adapter's wire is grounded against the **GitHub Copilot hooks reference**
(the canonical contract for the CLI) rather than a source tree. GitHub documents **two** hook
wire formats, and the adapter accepts **both**:

- **Native camelCase** — `preToolUse` carries `sessionId`, `timestamp`, `cwd`, `toolName`, and
  `toolArgs` (a JSON **string** that must be parsed); `agentStop` carries `sessionId`,
  `transcriptPath`, `stopReason`. The native tool names are lowercase: `bash` / `powershell`
  (shell), the shell-**session** tools `write_bash` / `write_powershell` (send input to a
  running shell — mutation-capable, so classified as `shell`), `create` / `edit` /
  `apply_patch` / `str_replace_editor` (file write), `view` (read).
- **PascalCase / Claude-compatible** — `PreToolUse` carries `hook_event_name`, `session_id`,
  `timestamp`, `cwd`, `tool_name`, and a `tool_input` object, where `tool_name` is the **Claude
  tool name** (`Bash`, `Write`, `Edit`, `Read`); `Stop` carries `session_id`, `transcript_path`,
  `stop_reason`. In this mode a native `apply_patch` / `edit` / `str_replace_editor` is reported
  as `Edit` — but whether GitHub rewrites the `tool_input` into ordinary Edit fields
  (`file_path` + `old_string`/`new_string`) is **not confirmed**, so an `Edit` carrying a
  patch-style payload without those fields **fails closed** pending a real fixture. `MultiEdit`
  is accepted **defensively** (a Claude-compatible name), not because a Copilot source documents
  it as a Copilot tool.

Normalization is field-by-field with the snake_case spelling winning and the camelCase spelling
as a fallback, so either mode normalizes sensibly; `tool_use_id` is **not** a documented Copilot
field and is not read. `apply_patch` (the OpenAI patch envelope, shared with Codex) is
reconstructed via the shared `applyPatchChanges`; `str_replace_editor` is modelled for its
`str_replace` and `create` sub-ops and **fails closed** on any other sub-op (e.g. `insert`)
pending a real pinned-run payload. A shell-session write (`write_bash` / `write_powershell`)
reconstructs the `input` it sends as a command, and **fails closed** if it carries no
reconstructable command/input — so a model cannot bypass the pre-action decision by piping a
mutation into an existing session instead of opening a new `bash` call. Deletes and renames are
issued through the shell (`rm` / `mv`). The **deny wire differs by phase**, and differs in shape
from Claude/Codex: `preToolUse`
denies with a **flat** `{ permissionDecision: "deny", permissionDecisionReason }` (no
`hookSpecificOutput` wrapper), while the `agentStop` end-of-turn event carries a flat
`{ decision: "block", reason }` — the same shape the canonical Stop sweep already emits. The
raw `agentStop` / `Stop` payload is normalized to the Claude Stop shape first (native
`sessionId` → `session_id`) so the sweep anchors the same per-session baseline the pre-action
path pinned.

**Control points and the agentStop continuation limit.** On Copilot, `preToolUse` is the only
**pre-execution tool veto**. `agentStop` is a **lifecycle control**: its `{decision:"block"}`
**forces another agent turn** (it cannot undo a filesystem mutation that already landed), and
Copilot **overrides the hook after 8 consecutive `block` continuations** (the `stop_hook_active`
lifecycle) — so `endOfTurn: true` must **not** be read as Claude-equivalent enforcement until
the real Stop qualification exercises that interaction (TamperWard's canonical `stopVerdict`
immediately allows when `stop_hook_active:true`). `postToolUse` is a real observation surface
(it carries `toolName`, `toolArgs`, and the tool result), but **milestone one does not consume
it**: `decide(..., 'post-action')` returns `unsupported` and rejects a post-action deny wire at
the boundary, exactly as the Codex adapter does — so the adapter declares `postObserve: []`
rather than advertising kinds it does not report.

**A fail-open risk scoped to the transport, recorded not masked.** For a **command**
`preToolUse` hook, Copilot's failure semantics are **asymmetric**: a hook that **crashes**,
exits non-zero, or exits 2 **fails closed** (exit 2 denies even if stdout says allow), but a
hook that **times out** **fails OPEN** (the tool call proceeds). Separately, an **HTTP**
`preToolUse` hook **fails OPEN** on network error, timeout, or a non-2xx response. TamperWard
therefore qualifies only the **local command/exec** transport, and both facts are carried in the
adapter's `unsupported` list so a cross-runtime study cannot mistake Copilot for a fail-closed
transport. The real `probe:copilot-runtime` qualification (follow-up PR) measures whether the
pinned command-hook build behaves as documented, and makes the transport part of the pinned
provenance.

**Conservative capabilities.** The Copilot adapter declares:

- `preDeny: []` — pre-action deny enforcement is **not yet proven** on a pinned Copilot CLI
  build, so the adapter claims no synchronous veto (the honesty rule: only claim `preDeny` for
  a kind proven by invocation evidence, never by the mere existence of a hook name);
- `postObserve: []` — Copilot exposes a `postToolUse` observation surface, but milestone one
  does not consume it, so the adapter advertises no post-observe capability (rather than
  contradicting its own `unsupported` post-action outcome);
- `endOfTurn: true` — Copilot delivers an `agentStop` event that runs the mandatory git sweep
  (subject to the 8-block continuation limit above);
- `unsupported` names the real gaps in prose: *pre-action deny enforcement not yet proven on a
  pinned Copilot CLI build*, the *command-hook timeout fails OPEN / HTTP-hook fails OPEN*
  transport scoping, *`preToolUse` is the only pre-execution veto while `agentStop` only forces
  continuation (8-block override)*, *`apply_patch` / `str_replace_editor` payloads modelled from
  the published contract but not yet confirmed against a real fixture*, *network-egress control*,
  and *identity / authentication*.

Identity is validated as an untrusted claim exactly as the Claude and Codex adapters do, and
every failure state (`parse-failure`, `transport-failure`, `not-invoked`, an unreconstructable
edit, a rejected identity) fails closed to a deny. The pre-action path pins the Stop-sweep
baseline at **turn start** on every call, for the same reason Codex does: with `preDeny` empty
the end-of-turn git sweep is the only real enforcement, and a baseline first set at Stop time
would let a mutation the turn *committed* mid-turn slip past.

**Two milestones, not one.** Milestone one is the adapter, with unit/adapter conformance in
`test/copilot-adapter.test.ts` (CI). Milestone two is the real qualification, layered exactly
like Codex so the CI-deterministic parts are separated from the part that needs a real Copilot
box:

- **(a) Adapter conformance** (`test/copilot-adapter.test.ts`, CI) — the adapter parses both
  documented hook formats and its deny wires match the published shapes.
- **(b) Probe self-test** (`test/copilot-probe-selftest.test.ts`, CI) — the probe's own pure
  classifiers are asserted against every deterministic mode (hook-fired-deny-respected,
  deny-ignored, hook-never-fired, tool-never-attempted, observed-failure-fail-closed,
  the documented timeout **fail-open**, outer-timeout-inconclusive, Stop
  respected/ignored/never-fired), the provenance gate, the distinct/denied `tool_use_id`
  counters, and the **real** driver end-to-end (build → decide over a native Copilot payload →
  append to a parent-owned ledger → classify). This proves the probe *itself* cannot
  false-green.
- **(c) Real Copilot E2E** (`npm run probe:copilot-runtime`,
  `harness/adapters/copilot-probe.mjs`, **not** run in CI) — the real gate on a pinned,
  authenticated Copilot CLI. It wires TamperWard as a Copilot `preToolUse` hook (deny) plus an
  `agentStop` hook (sweep) in `.github/hooks/tamperward.json`, and — because Copilot gates
  repository hooks in `-p` prompt mode — sets `GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=true` in
  the child environment (recorded in provenance) so the wiring actually loads. It runs
  CONTROL-vs-GATED mutation pairs (shell edit, `apply_patch`, native `edit`/`create`, delete,
  rename, git restore, MCP, nested shell, **`write_bash` shell-session**, and multiple protected
  mutations in one turn) against `copilot -p … --allow-all-tools --no-ask-user`, and judges each
  from the ledger, which is written **outside the candidate's file sandbox** and treated as
  **corroborating** evidence only — the unforgeable gate is parent-observed (spec state, the
  CONTROL arm landing, Copilot's own stdout, the exit code), and a **landed protected mutation
  (parent-observed) always FAILs** regardless of any ledger record. It also runs the
  **detached/background** case (a delayed background mutation, evidence **bound to the intended
  command** via a unique sentinel + the protected spec, with a CONTROL arm proving the prompt is
  potent, judged only after a settle interval — a dispatched sentinel is fail-open even if the
  file stays intact) and the real
  **`agentStop` continuation** case (a mutation lands under a pass-through pre-action, then the
  Stop sweep must return `decision:block` AND Copilot must honour it by continuing for another
  turn — a later Stop carrying `stop_hook_active`). The **broken-hook transport** matrix drives
  six hooks and classifies each by its DOCUMENTED semantic, not an assumed result: crash /
  non-zero exit must fail **CLOSED**; a **timeout, or exit 0 with empty or malformed stdout**, is
  the documented **FAIL-OPEN** (no hook output → default permission → the tool proceeds under
  `--allow-all-tools`); a **missing configured executable** — wired via Copilot's `exec` hook
  form so the binary genuinely cannot be spawned (distinct from a shell reporting "command not
  found") — is **measured**. It emits the
  **operation-specific capability matrix** #598 asks for (`pre-deny:shell PROVEN`, `hook-crash
  FAIL-CLOSED`, `hook-timeout FAIL-OPEN`, `overall PARTIAL`, …), never a single
  supported/unsupported boolean, and **every** measured transport contributes to the overall
  gate (a fail-open on any keeps `overall` below FULL). A **provenance gate**
  (`COPILOT_VERSION_EXPECTED` matched **exactly**, `COPILOT_MODEL`, `COPILOT_HOME`, and the
  canonical hooks-config SHA-256) caps the result at PARTIAL when unpinned; with no Copilot CLI
  it reports PARTIAL and exits non-zero, so "could not test" is never mistaken for "passed".

Because Copilot's command-hook timeout fails open by documentation, a real run's `overall` is
expected to be **PARTIAL**, not FULL — which is precisely why the probe measures it rather than
assuming fail-closed. Until a FULL verdict on a pinned build says otherwise, Copilot stays
`steering: 'neutral'` in `src/runtimes.ts`, `preDeny` stays empty, and no Round 4.1 research
round is registered. A green CI run proves the build, unit/adapter tests, static gate, and the
probe self-test only — **not** runtime qualification (layer c is not run in CI; there is no
Copilot binary there).

## Runtime detection in onboarding

`tamperward onboard` reports which agent runtime a repository actually hosts and what
protection it gets, instead of silently assuming Claude. The registry lives in
`src/runtimes.ts`: each known runtime carries repository-relative marker files
(`.claude/` for Claude Code, `.cursor/` / `.cursorrules` for Cursor,
`.github/copilot-instructions.md` for Copilot, `AGENTS.md` / `.codex/` for an
AGENTS.md-aware agent) and a `steering` value — `in-loop` for a runtime with a shipped
adapter, `neutral` otherwise.

Detection is **honest reporting, never a trust input**. The marker files are
candidate-controlled, so detection only shapes the setup narrative; it adjudicates
nothing and opens no verdict path. When a repository uses a runtime that has no shipped
in-loop adapter, onboarding states plainly that deny-before-execute is Claude-only today,
that the runtime's live protection is the agent-neutral layers (pre-commit + CI), and that
a native adapter is tracked in #482 — the same honesty rule the capabilities declaration
enforces (`unsupported` over silent degradation). Adding a runtime to `src/runtimes.ts`
does **not** grant it in-loop steering; that still requires a conforming `RuntimeAdapter`
and the parity suite above. The registry's `steering` flag flips to `in-loop` only once
that adapter ships.

## What Phase 1 is, and is not

Phase 1 is the neutral contract plus Claude Code's conformance to it, with **zero** change
to live steering behaviour: the CLI (`tamperward hook claude` / `tamperward sweep claude`)
is still wired directly to the canonical functions in `src/cli/hook.ts`, and the Claude
adapter delegates to those same functions so its output is byte-identical. It does **not**
add a second runtime, and it does **not** satisfy the repository's `SPEC.md` milestone
**M5**, which requires an in-loop adapter for a second runtime with the same
PreToolUse/Stop semantics.
