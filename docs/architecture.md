# Tamperward architecture

This page is the component-level map of Tamperward. It complements the lifecycle
diagram in the README: the README focuses on what happens during
`tamperward run`; this diagram shows how the local enforcement surfaces,
trusted base, verification backends, repository authority, and release path fit
together.

## Complete architecture

The diagram is drawn as three lanes. **Steering** and **Verification** run on the
agent's host, where the agent shares the filesystem with everything that judges
it; **Authority** runs in protected CI, on the other side of the trust boundary
(the shaded, dashed lane), and re-runs the same `check` and `verify` against the
trusted base. `init` writes into all three lanes; `doctor` reads all three.
Dotted edges are optional or advisory paths.

```mermaid
graph TD
    operator["Operator and repository owner"]
    onboard["tamperward onboard"]
    init["tamperward init"]
    doctor["tamperward doctor"]
    research["tamperward research"]

    subgraph steering["Steering lane: agent host, in-loop, not the final authority"]
        agent["Agent runtime"]
        hooks["Claude hooks: PreToolUse, PostToolUse, Stop"]
        hook["tamperward hook"]
        service["tamperward hook-service: opt-in warm evaluator"]
        snapshot["Protected-tree snapshot from live reads"]
        steer["Deny or allow the tool call"]
        stop["Stop sweep of the turn's net changes"]
        observer["tamperward watch: optional transient observer"]
        tree["Candidate commit and worktree"]
    end

    subgraph verification["Verification lane: agent host, post-exit envelope"]
        policy["Trusted base: entry commit, policy, verifier definition"]
        run["tamperward run envelope"]
        check["tamperward check"]
        verify["tamperward verify"]
        visible["Visible verification of the candidate"]
        pristine["Pristine verification, base-restored"]
        trace["tamperward trace-verify: advisory input audit"]
        local["Local verdict: exit code and JSON report"]
    end

    subgraph authority["Authority lane: protected CI, across the trust boundary"]
        ci["Protected CI workflow on the trusted base"]
        gate["Required tamperward gate"]
        rules["Branch protection rules and CODEOWNERS"]
        merge["Merge to main"]
    end

    release["Release workflow"]
    npm["npm package with provenance"]

    operator --> onboard
    operator --> init
    operator --> policy
    onboard --> init
    onboard --> doctor
    init --> hooks
    init --> policy
    init --> ci
    doctor -. reads .-> hooks
    doctor -. reads .-> policy
    doctor -. reads .-> ci

    agent --> hooks
    hooks --> hook
    hook --> snapshot
    hook -. opt-in .-> service
    service -.-> snapshot
    snapshot --> steer
    steer --> agent
    hooks --> stop
    observer --> stop
    stop --> steer
    agent --> tree

    tree --> run
    policy --> run
    run --> check
    run --> verify
    verify --> visible
    verify --> pristine
    policy --> pristine
    check --> local
    verify --> local
    run --> local
    policy --> trace
    trace -. proposed inputs for review .-> operator
    research --> check
    research --> verify

    tree --> ci
    policy --> ci
    ci --> doctor
    ci --> check
    ci --> verify
    ci --> gate
    gate --> rules
    rules --> merge
    merge --> release
    release --> npm

    style authority fill:#e6394614,stroke:#e63946,stroke-width:3px,stroke-dasharray:8 4
```

The `ci` edges into `check` and `verify` are the authority argument in one
picture: the generated workflow runs `doctor`, `check --diff` and
`verify --require-ancestor` against the pull request's **base** — the same
commands the local envelope ran, but with inputs the candidate could not have
written. The `policy → pristine` edge is why a pristine run is different from a
visible one: the verification surface is restored from the trusted base, not
read from the candidate tree. There is deliberately no `check → pristine` edge;
diff-time detection and re-execution are independent layers.

## Trust boundaries

The central rule is that the candidate may control the working tree, but must
not control the inputs used to judge it.

| Boundary | Trusted input | Candidate-controlled input | Result |
| --- | --- | --- | --- |
| In-loop steering | Installed Tamperward wiring and live protected-state reads | Tool-call payload and working tree | Immediate deny or correction signal |
| Local envelope | Entry commit, base policy, verifier definition, lifecycle supervisor | Agent process, exit code, candidate tree | Independent post-exit adjudication |
| Verification | Base-restored protected files and trusted command definition | Candidate implementation and runtime effects | Visible/pristine outcome |
| Repository authority | Protected workflow and branch rules | Pull request contents and proposed commit | Merge allowed or refused |
| Release | Reviewed main commit and trusted publishing identity | Version metadata within the reviewed commit | Published package or failed release |

## Data flow

1. `init` installs the supported enforcement surfaces in every lane: the Claude
   hook wiring (Steering), the committed `.tamperward.yml` policy and verifier
   definition (Verification), and the protected workflow (Authority). `onboard`
   is the guided first run around `init` and `doctor`.
2. `doctor` reads all three lanes — hook wiring, the trusted base policy and the
   workflow — and reports posture; the generated workflow runs it before
   verification, and it is a report, not a verdict.
3. Hooks provide fast feedback while the agent works: `tamperward hook` reads a
   live protected-tree snapshot and denies or allows each tool call, and the
   Stop hook sweeps the turn's net changes. The opt-in `hook-service` evaluates
   the same payloads from a warm process; `tamperward watch` is an optional
   observer whose only consumer is the Stop sweep. None of this is the final
   authority.
4. `run` freezes the entry state and trusted policy, supervises the agent, then
   adjudicates the released tree with `check` and `verify` and reports a local
   verdict as an exit code and JSON.
5. `check` evaluates committed and worktree changes. `verify` runs the candidate
   as it stands (visible) and a copy whose verification surface is restored from
   the trusted base (pristine). `trace-verify` observes what the verifier reads
   and proposes `verify.inputs` entries for human review; it edits nothing.
   `research` adjudicates both arms of a paired evaluation with the same `check`
   and `verify` primitives.
6. Protected CI runs the same `doctor`, `check --diff` and `verify` against the
   trusted base, and the required gate, branch protection rules and CODEOWNERS
   decide what reaches `main`.
7. The release workflow publishes only the reviewed version from `main`, then
   records it with a tag and GitHub release.

## Compatibility

The diagrams intentionally use conservative Mermaid syntax:

- `graph TD`, which is supported by older Mermaid renderers as well as current
  Mermaid implementations;
- plain node identifiers and quoted labels;
- one level of `subgraph` for the lanes (never nested) and a single `style`
  line for the trust-boundary shading, both of which GitHub's renderer and
  current Mermaid accept; no HTML labels, class definitions, click handlers, or
  renderer-specific configuration;
- short labels and ordinary ASCII punctuation.

This keeps the diagrams usable in GitHub, the VitePress documentation site,
Markdown previewers, and browser clients that bundle an older Mermaid version.
