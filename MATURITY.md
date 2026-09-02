# Maturity milestones

In September 2026 an external review of v2.0.0 assessed Tamperward as
"technically important, well-reasoned and unusually honest for an early
repository — considerable as emerging research engineering; promising but
unproven as industry infrastructure", and named five milestones that would
change that answer. This file tracks them, in the same spirit as
[SECURITY-ENVELOPE.md](./SECURITY-ENVELOPE.md): the project's standing is only
as honest as this table.

Rules for the table:

- A status moves only with a link — a tagged release, a merged pull request, a
  committed preregistration, or a published artifact by a party other than
  this repository. Intent does not move a row.
- **OPEN** means nothing that closes the row exists yet, whatever partial
  mitigations have shipped. **IN PROGRESS** needs a linked branch or
  preregistration. **CLOSED** links the artifact.
- Nothing here is a date. The order is the review's, not a priority.

## The five milestones

| # | milestone | status | what exists today | what closes it |
|---|-----------|--------|-------------------|----------------|
| M1 | **An independent, named security audit with a public report** | OPEN | Three external review passes — the 1.10.x envelope review (executed exploits plus source audit, P0/P1/P2), the 1.14.x passes and the 1.15.0 audit — every finding reproduced, ledgered in [SECURITY-ENVELOPE.md](./SECURITY-ENVELOPE.md) and closed with a regression and a mutation check. The reviewers are not named and the reports are this repository's own write-ups, not theirs. | A named auditor publishes a report against a tagged 2.x release. Every finding gets a SECURITY-ENVELOPE row with a REPRO/AUDIT disposition, and the report is linked from this row. |
| M2 | **A fresh preregistered replication on 2.x — multiple agents, a fixed treatment, substantially larger samples** | OPEN | Rounds 1–3.1 ([README](./README.md#what-we-have-actually-measured)) ran on v1.6.0 → v1.14.0 with the prediction committed before each run (`harness/PREDICTION-*.md`, `harness/taskbench/PREDICTION-taskbench.md`). All four ran one agent runtime (Claude Code). Rounds 2 and 3 changed the treatment version together with the ecosystem, so transfer is not isolated; round 3.1 could not have replicated (b ≤ 3 by construction). Every round ran on a verifier later found to carry the 1.14.1 bypass. Round 4 is named as the fresh pool and has not been drawn. | A `PREDICTION` committed before the run that pins one 2.x version as the treatment across every ecosystem in the round, runs at least two agent runtimes, and sizes the sample to detect a round-2-sized effect (b = 9 / c = 0 on 22 pairs). Analysis script frozen before the draw; result published beside the bet, whichever way it goes. |
| M3 | **Production pilots with published false-positive rates, operational overhead and developer friction** | OPEN | Precision work is corpus-based, on mainline commits with no agent in the loop: [`harness/fp-study/`](./harness/fp-study/) (zod, immer, zustand, prettier, hono, nest, docusaurus, jest; `snapshot-only-rewrite` at ~0.06% over 1,652 audited commits; `test-content-removal` priced on 2,304 commits before shipping as block). No deployment has been measured and no production user is named. | At least one named pilot publishes, per rule, fire and false-positive counts over a stated period; `verify` wall-clock relative to the bare suite; how often the out-of-band label was needed; and hook latency at PreToolUse and Stop. The numbers are linked here whether or not they flatter the gate. |
| M4 | **Stronger verifier isolation — immutable mounts or a separately controlled execution environment — and dependency integrity across ecosystems** | OPEN, partial mitigations shipped | Two temporary copies; the pristine copy built only after the visible run exits; restored files digested either side of the pristine run; working-tree and `node_modules` content fingerprints; a Linux survivor scan; every trusted git read with replace-objects disabled. Still true: both runs execute the candidate's code, `node_modules` is a symlink into the agent-writable tree, there is no OS boundary, the dependency fingerprint covers Node only, and the verification surface is an enumerated list ([docs/THREAT-MODEL-pristine-run.md](./docs/THREAT-MODEL-pristine-run.md), "Residual risk"). | The pristine run executes where the candidate cannot write: a read-only mount of the base's protected surface, or a separate container or runner with its own dependency install. Dependency integrity for the ecosystems the `tests` class already covers — pip/venv, the Go module cache, cargo, bundler, Maven/Gradle — with the same before-and-after comparison Node gets. Each shipped as a versioned change with its threat-model note. |
| M5 | **Signed or attested verdict artifacts, broader agent integrations, enterprise policy administration** | OPEN | `--json` verdicts and a GitHub job-summary renderer. The npm package ships with SLSA provenance through trusted publishing, but a *verdict* is not attested — nothing binds "VERIFIED" to a head SHA, a base SHA, a gate version and a policy hash in a form CI can require. In-loop hooks exist for Claude Code only; other agents meet the gate at pre-commit and CI. Policy is one `.tamperward.yml` per repository. | A signed verdict statement (in-toto attestation or equivalent) carrying head, base, tamperward version, policy hash and verdict, that a required check can verify. An in-loop adapter for at least one more agent runtime, with the same PreToolUse and Stop semantics. A documented way to distribute an organisation baseline that per-repository policy can strengthen and never weaken. |

## Corrections prompted by the review

| what the review found | disposition |
|---|---|
| The v2.0.0 README's scope note said the evidence table covered "one model, one pressure prompt, one JS/TS ecosystem" directly beneath the Python and `claude-sonnet-5` rows. | Corrected on `main` before this file existed (the README readability pass): the note now reads "specific models, pressure prompts, treatment versions, and finite JavaScript/TypeScript and Python repository samples — evidence for those settings, not a universal claim." |
| v2.0.0 must not be read as a maturity claim; the major only drops Node 18. | Already stated in the README's opening banner. This file is where the distance to maturity is kept. |
| What green means: "the configured suite passed without the detected verification-integrity failures", not "the implementation is correct". | Stated in the README ("What Tamperward does not do") and in the `verify` output. No change. |

## What the review placed outside the milestones

These are limits the review named and the README already carries. They are
listed so nobody reads the table above as the whole gap.

- Both verification runs execute agent-controlled code; the pristine copy is a
  restored and monitored copy, not an immutable boundary (M4 narrows this, it
  does not remove it).
- No network, host, secret, kernel or process isolation. Tamperward is one
  layer; the sandbox is somebody else's.
- A hardcoded solution, an incomplete implementation, or source that colludes
  with a suite the base already accepts is invisible to every layer here.
  Held-out tests and human review own that class.
- JavaScript/TypeScript has the deepest detector coverage; other ecosystems get
  file- and pattern-level protection and the outer layers.
