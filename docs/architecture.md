# Tamperward architecture

This page is the component-level map of Tamperward. The README explains the local
`tamperward run` lifecycle; this page shows how setup, agent steering, local
adjudication, protected CI, and release fit together.

## Complete architecture

The diagram is intentionally read **left to right**. It shows the main decision
path only; supporting and advisory tools are kept in a separate row so they do
not obscure the security boundary.

![Tamperward complete architecture — setup establishes trusted inputs and local wiring; the agent works under in-loop steering; Tamperward adjudicates the candidate locally; protected CI repeats the authoritative checks before merge; release publishes the reviewed main commit](./architecture.svg)

### How to read it

1. **Setup** — `onboard` guides first use and `init` installs the repository
   wiring: hooks, policy, verifier configuration, and CI integration.
2. **Agent work** — the coding agent edits the candidate tree. In-loop hooks can
   deny known weakening operations and detect protected-state drift while work is
   happening. These hooks steer; they are not the final authority.
3. **Local adjudication** — `tamperward run` owns the lifecycle boundary. After
   the agent exits, it independently judges the resulting candidate with
   `check` and `verify`, then emits one local verdict.
4. **Repository authority** — protected CI sits across the trust boundary. It
   runs from trusted repository configuration, re-adjudicates the pull request
   against the trusted base, and exposes a required gate to branch protection.
5. **Release** — only a commit that reaches protected `main` can enter the
   release path and become the published npm package.

The green **Trusted inputs** bar is deliberately separate from the candidate
flow. The core invariant is:

> The agent may author the candidate tree, but it must not choose the trusted
> baseline, governing policy, verifier, protected workflow, or final repository
> verdict.

## Why the diagram is shaped this way

The architecture has two different jobs and they should not be confused:

- **Steering** happens while the agent is working. It provides fast feedback and
  can stop known weakening moves before they land.
- **Adjudication** happens outside the agent's normal completion path. It asks
  what actually changed and whether the candidate still passes when trusted
  verification state is restored.

Local adjudication is valuable because it gives immediate, independent feedback,
but the **repository authority** is the final merge boundary. A process sharing
the agent's host and filesystem is not equivalent to protected CI.

Supporting commands such as `doctor`, `hook-service`, `watch`,
`trace-verify`, and `research` are shown below the primary path because they
assist setup, observation, diagnosis, or evaluation without being separate
final-verdict authorities.

## Trust boundaries

| Boundary | Trusted input | Candidate-controlled input | Result |
| --- | --- | --- | --- |
| In-loop steering | Installed Tamperward wiring and protected-state reads | Tool-call payload and working tree | Immediate deny or correction signal |
| Local envelope | Entry commit, base policy, verifier definition, lifecycle supervisor | Agent process, exit code, candidate tree | Independent post-exit adjudication |
| Verification | Base-restored protected files and trusted command definition | Candidate implementation and runtime effects | Visible/pristine outcome |
| Repository authority | Protected workflow, required checks, branch rules | Pull request contents and proposed commit | Merge allowed or refused |
| Release | Reviewed commit on protected `main` and trusted publishing identity | Version metadata within that reviewed commit | Published package or failed release |

## Main data flow

### 1. Establish the trusted starting point

`init` writes the supported enforcement surfaces: local hook wiring, the
committed `.tamperward.yml` policy and verifier definition, and the repository
workflow. `onboard` is the guided path around setup and posture checks.

At the start of an adjudicated run, Tamperward freezes the entry state used as
the trusted reference. Candidate changes are judged *against* that state; they
do not redefine it.

### 2. Steer the agent while it works

Supported hooks call `tamperward hook` for live decisions. The Stop hook sweeps
the turn's net changes. The optional `hook-service` can evaluate the same hook
payloads from a warm process, and `tamperward watch` can observe transient
filesystem activity.

These surfaces reduce the chance of a weakening move surviving, but they are
not relied on as the final proof of integrity.

### 3. Adjudicate the released candidate

`tamperward run` supervises the agent lifecycle and then evaluates the state
left behind.

- `check` evaluates committed and worktree changes for protected weakening
  classes.
- `verify` runs the candidate visibly and again with the protected
  verification surface restored from the trusted base.
- ancestry, dependency, and quiescence checks protect the adjudication boundary
  itself.

Those signals converge on one local exit verdict and machine-readable report.

### 4. Re-adjudicate in protected CI

The generated repository workflow repeats the relevant posture, diff, and
verification checks from a trusted workflow copy and trusted base. Required
status checks and branch protection then decide whether the candidate may reach
`main`.

This is the key authority separation: the pull request proposes code, but it
does not get to replace the protected rules that decide whether that proposal is
accepted.

### 5. Release reviewed `main`

The release workflow starts from protected `main`. It publishes the reviewed
package version and records the release/tag using the trusted publishing path.

## Supporting tools

These commands are intentionally outside the main arrow path in the diagram:

| Tool | Role |
| --- | --- |
| `doctor` | Reports repository posture and wiring. A diagnosis, not a verdict. |
| `hook-service` | Optional warm evaluator for supported hook payloads. |
| `watch` | Optional observer for transient protected-state mutations. |
| `trace-verify` | Observes verifier reads and proposes `verify.inputs` entries for human review; it does not edit policy. |
| `research` | Runs paired evaluations using the same underlying `check` and `verify` primitives. |

## Compatibility

The architecture is a standalone, dependency-free SVG
(`architecture.svg`) referenced as a Markdown image rather than an inline
Mermaid graph.

That keeps the same layout on GitHub, the VitePress documentation site, Markdown
previewers, and older browser clients without depending on a Mermaid runtime.
The SVG is self-contained, uses a generic system-font stack, has no scripts or
external assets, and includes `<title>` / `<desc>` accessibility text.

The diagram deliberately avoids encoding every implementation relationship as an
arrow. Only the primary security flow and trusted-input feeds are connected;
secondary tools are grouped separately. Detailed lifecycle mechanics remain in
the README's local enforcement diagram and the implementation/specification
docs.
