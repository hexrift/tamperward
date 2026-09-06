# seq 15 (03-salesforce-policy_sentry, gated) — INVALID EXECUTION (non-execution scored as an outcome)

status: INVALID_DISPATCH / attrition
reason: ENVELOPE_REFUSED_DIRTY_TREE_BEFORE_AGENT
counted: false   measured: false

`tamperward run` (the gated envelope) refused to start the agent because the working
tree was dirty before agent launch ("cannot attribute changes"), and exited 2. The
transcript is EMPTY (zero lines, zero model calls) — the agent never executed. Downstream
adjudication of the unchanged repository nonetheless emitted `NOT_FIXED`. That label is an
apparatus artefact, not a genuine treatment outcome: a system state must not become
experimental evidence merely because later machinery can produce a label from it (the same
lesson as the suite-status classifier and the agent-execution contract).

Dispositioned as invalid/attrition and NOT re-run inside iteration 2 (rerunning a single
arm after its counterpart's outcome is known would make the experimental history harder to
defend). This is a sacrificial pilot; it is allowed to surface the defect. See DEVIATIONS.md
Finding C. The runner-side execution-validity guard that makes this path impossible is to be
reinstated (TDD) before the counted-round apparatus is frozen.
