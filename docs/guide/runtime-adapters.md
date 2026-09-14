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
