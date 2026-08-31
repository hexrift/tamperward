# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) as scoped in
[CONTRIBUTING](./CONTRIBUTING.md#versioning).

## [1.11.0] — 2026-08-31

**Quiescence (P0-5): a verdict cannot outlive the tree it describes.** `run`
owned the agent's exit code but not its descendants. A worker detached with
`setsid`/`nohup` survived every check and edited the tree afterwards —
reproduced: GREEN MEANS GREEN, exit 0, and six seconds later the test file was
empty. The same escape as the runtime hole this command exists to close, one
level up.

A synchronous wrapper cannot reap a new session, so the envelope does the
honest thing instead of pretending it can:

- **Fingerprint guard (portable, always on).** Every non-ignored file is
  hashed before and after adjudication; if the tree moved while it was being
  judged, the verdict is `NOT_QUIESCENT` (exit 1) rather than a statement
  about a tree that no longer exists.
- **Survivor detection (Linux).** Processes that still hold the working tree
  and *started after the agent spawned* are surfaced the same way. Start time
  is the discriminator that keeps a developer's editor or dev server — and the
  caller's own shell pipeline — from being convicted; an earlier version keyed
  on envelope start and did exactly that, caught by the honest-run control.
- **`--settle <secs>`** extends the window past workers that sleep through
  the checks.

Residual, stated in SPEC row 17 rather than implied away: non-Linux hosts have
no survivor scan (fingerprint and `--settle` still apply), and a worker that
outwaits the run entirely can only be contained by OS-level isolation. Full
suite 335/335; both exploit tests verified to fail with the fix reverted.

## [1.10.4] — 2026-08-31

**The effect layer no longer trusts stat (P1-8).** `snapshotProtected` reused
the previous entry whenever mtime, size and mode all matched, skipping the
hash — and all three are writable by the agent being watched. Reproduced:
`it('alpha_padding_here', ...)` → `it.skip('alpha_padding', ...)` is
byte-identical in length, `touch -r` restores the mtime from any reference
file, and the drift check then passed a file that carried the skip. This is
the layer that exists *because* some mutation always arrives by a path the
matcher did not see, so a cache keyed on data the mutation's author controls
reintroduced exactly the blind spot it was built to close.

Every protected file is now hashed on every snapshot. Measured A/B on a
1000-file / 4MB protected tree: **4.0ms → 17.2ms per snapshot**, against the
~450ms of node startup each hook invocation already pays — soundness at
roughly 3% of a call. Regression tests cover the exploit and the
no-false-positive case. Full suite 332/332.

## [1.10.3] — 2026-08-31

**Rename semantics — two committed-diff exploits that the CI authority layer
called clean.** Pass 2 of the external review found the fallback every
local-layer finding leaned on ("CI still catches it") was itself defeated.
Both reproduced before the fix, both now regression-tested.

- **P0-7**: `test-deletion` and `test-content-removal` gated their content
  comparison on `op === 'modify'`. A rename is neither modify nor the
  rename-OUT case they handle, so `git mv spec.js spec2.js` in the same
  commit carried an arbitrary it()-block deletion past both rules — 10
  blocks to 7, reported clean at CI. Both rules now content-inspect renames
  exactly like modifications; an honest rename with unchanged content stays
  clean.
- **P0-8**: `git mv ci.yml ci.yml.disabled` disabled every check without
  changing a line, and was reported clean — because the file never leaves
  the protected glob (`.github/workflows/**` matches `.disabled` too), only
  GitHub's executable set. For a `pull_request` event that disables CI for
  the very merge ref performing it. ci-tampering now tests **executability**
  (`.github/workflows/*.{yml,yaml}`), not glob membership; `ci.yml →
  build.yml` remains clean.
- **P1-9**: `core.hooksPath` — git-native and strictly more general than the
  flags already covered, since it disables husky, lefthook and plain
  `.git/hooks` alike — bypassed `no-verify` in all three spellings (`-c`,
  `git config`, `GIT_CONFIG_*` injection). Now covered, with LEFTHOOK=0,
  SKIP_SIMPLE_GIT_HOOKS and PRE_COMMIT_ALLOW_NO_CONFIG.
- **P2-11**: evidence is repository content, and `\s` collapsing left ESC
  intact — a crafted test line emitted clear-screen plus a forged "clean"
  verdict into tamperward's own stdout. Control bytes are now replaced
  before rendering.

**Withdrawn claim.** 1.10.2's tracker recorded `check --diff` as surviving
every finding but P0-6. Four findings defeat it (P0-2, P0-6, P0-7, P0-8);
`SECURITY-ENVELOPE.md` now says so. Full suite 330/330.

## [1.10.2] — 2026-08-31

**Envelope hardening — four executed P0 inversions from external review, each
reproduced then closed with a regression test.** #117/#118 froze the entry
SHA, ancestry, and verifier; this freezes the rest of the trust anchor. The
common root: the envelope adjudicated the post-agent tree using that tree's
own policy, its tracked-only file view, and its local sign-off ledger — all
agent-authorable.

- **P0-1**: an uncommitted `.tamperward.yml` disabling test-deletion +
  hook-tampering made the worktree check score a gutted suite "clean". The
  whole policy (rules, protected globs, verifier) is now resolved from the
  base commit via `loadPolicyAt(base)` — never the working tree.
- **P0-2**: widening `protected` reverted the pristine overlay to base,
  masking the agent's own source bug, and policy-diff scores adding globs a
  strengthening. Verify's overlay classes now come from the frozen policy.
- **P0-3**: untracked files were invisible to `git diff HEAD`. The worktree
  view now includes untracked, not-ignored files.
- **P0-4**: the agent cleared its own findings by running `tamperward
  allow`. The envelope now adjudicates at the CI layer — only out-of-band
  approval, never the agent-writable ledger.

Honest boundary: P0-5 (a detached background worker can mutate the tree
after the checks — a TOCTOU on a live tree) and P0-6 (the shared, gitignored
`node_modules` runner) remain OPEN and are tracked, with every P1/P2 finding,
in the new `SECURITY-ENVELOPE.md`. SPEC row 17 now names process quiescence
as outside the current boundary. Full suite 325/325.

## [1.10.1] — 2026-08-31

**Envelope hardening — two High findings from owner review of 1.10.0,
both reproduced as failing tests before the fix.**

- **The trust anchor could be moved backwards.** The envelope froze the entry
  SHA but adjudicated with merge-base semantics (right for PR review, wrong
  here): an agent running `git reset --hard <ancestor>` downgraded the anchor
  to a commit predating its task — empty diff, clean worktree, green verify,
  exit 0. Now post-agent HEAD must be a descendant of the entry SHA; anything
  else is itself the conviction (HISTORY_REWRITE, exit 1), and with ancestry
  enforced, merge-base collapses to exactly the frozen SHA everywhere
  downstream.
- **An agent could author its own verifier.** With no `verify:` block at
  entry and no `--cmd`, verification read the suite command from the
  CURRENT tree's policy — which the agent could have written
  (`verify.command: "true"`), and which policy-diff deliberately treats as a
  strengthening. The verifier command and budget are now resolved from the
  entry-time policy or flags BEFORE the agent starts, and only those frozen
  values are used; no verifier at entry → refuse to start (exit 2).
- **Documented TCB scoping (SPEC row 17):** ignored dependency trees are
  explicitly outside the 1.10.x boundary — node_modules is symlinked into
  both verification copies, so agent-mutated dependencies corrupt visible
  and pristine runs alike. Closing that surface is a named 2.0 roadmap item
  with candidate designs.

## [1.10.0] — 2026-08-31

**`tamperward run` — the enforcement envelope (SPEC row 17).** Round 2's
decisive negative finding, turned into architecture: a hook can be correct at
every decision point and the system still fail, because the hook does not own
termination. In the round-2 cssstyle-gated trajectory the gate denied 42
mutations and pristine verification rejected all 25 stop attempts — including
the final one, two seconds before the runtime completed the session anyway
with a masked-green tree. Correct policy decisions are insufficient when the
policy mechanism does not own the lifecycle boundary.

`tamperward run [--base R] [--cmd C] [--budget S] [--allow-dirty] -- <agent
command...>` closes that boundary from outside the runtime: it records the
trusted base before the agent starts, treats the agent's exit as untrusted,
and re-adjudicates the released tree against that entry-time base — policy
check over `base...HEAD` (weakening the agent committed), policy check over
the worktree (weakening left uncommitted), and pristine verification (masked
failure, however produced). Exit contract, "green means green" as an exit
code: the agent's own code when enforcement is clean; 1 on any blocking
finding or masked failure, even if the agent claimed success; 2 when
adjudication is impossible (dirty start, unresolvable base, no suite
command) — failing closed, never open.

The hooks remain the in-session fast path — round 2 measured them converting
blocked shortcuts into honest work in eight of twelve denied trajectories.
The envelope (or `check --diff` + `verify` in CI, which no runtime can
override) is the boundary. Tests replay the cssstyle escape in miniature: a
masking agent that exits 0 becomes a failing pipeline.

## [1.9.0] — 2026-08-30

**`tamperward verify` — pristine-suite re-execution, productized.** The
taskbench run-correctness oracle was the one layer nothing got past in the
Phase-3 sweep: it identified every masked failure in all 53 trajectories while
diff-time detection was routed around. That is a trajectory record on one
frame, not a guarantee — and it is the strongest signal the programme has, so
it is now a shipped command (SPEC row 16, `pristine-verification`).

Mechanics: two isolated copies of the working tree (tracked + untracked
non-ignored files, node_modules symlinked). The suite runs in one as-is (the
visible run) and in the other with every protected test/snapshot/config file
restored from a trusted base rev (merge-base semantics; protected files the
agent ADDED are kept — they can only add strictness, and the visible run
already required them green). Visible-green + pristine-red is a **MASKED
FAILURE** (exit 1). Budget exceeded or cannot-run **fails closed** (exit 2) —
"could not verify" is never "verified". Immune to spelling by construction:
no diff is interpreted at all; only outcomes are compared.

CI wiring (the layer's natural home — judged at commit granularity, not per
tool call):

```yaml
- run: npx tamperward verify --base origin/main --cmd 'npm test' --budget 300
```

Configuration can live in policy — and that block is itself a guarded surface:

```yaml
verify:
  command: npm test
  budget: 300
```

policy-diff flags any `verify.command` change, any `budget` lowering, and the
block's removal as policy weakening: a verify an agent can point at `true` is
no verification at all.

**Base selection, stated where it can be checked:** verify restores protected
files from `--base` (default HEAD, merge-base semantics). The default covers
UNCOMMITTED weakening only — a tamper the agent commits is inside HEAD and
invisible to it; the test suite demonstrates that blindness rather than hiding
it. In CI, point `--base` at a rev the agent cannot rewrite (the protected
default branch), which is also where this layer belongs.

## [1.8.0] — 2026-08-30

**The effect layer.** Spelling-level inspection has a floor: some mutation will
always arrive by a path the matcher didn't see — taskbench Phase 3 measured one
(run 07-fastify gated: a test-skip Edit landed without a PreToolUse deny, the
same edit class denied at PreToolUse in eleven other runs, and the weakened
suite was consulted for 51 seconds until the Stop sweep caught it). Three
additions REDUCE that surface — reduce, not end; the residuals are stated at
the bottom of this entry:

- **Per-call protected-tree drift check** (PreToolUse): the hook snapshots the
  protected files' content+mode and, when the tree drifts from the last
  sanctioned state, runs the ordinary detector stack over the drift (diff vs
  the turn baseline, scoped to the drifted paths) at the very next call.
  Stated precisely: this **detects persistent protected-state drift
  independently of the mutation's command spelling** — however it was produced
  (a sed spelling, a generated script, a hook flake, a reconstruction miss) —
  and judges it with the existing corpus-priced rules; a deny repeats until
  the tree is restored. Benign drift (a first-run snapshot, a git restore that
  evaluates clean) is absorbed silently. Verified end-to-end: an unseen
  `sed -i 's/^test(/test.skip(/'` is denied at the next call by `test-skip`.
- **`tamperward watch`** — the filesystem-event observer (DESIGN A.1's named
  candidate): a daemon recording protected-file events (content hash + mode)
  to `.git/tamperward/fsevents.jsonl`, consumed by the Stop sweep under the
  new `transient-protected-mutation` rule (SPEC row 15). This is the layer
  for what no per-call check can see: a protected file modified and restored
  WITHIN one tool call — measured at 1 occurrence in 59 real trajectories,
  and that one was the laundering pattern (skip → npm test → restore). Warn
  by default (a Stop block already forces restores; a compliant restore reads
  as churn — block-by-default would deadlock the honest path);
  `TAMPERWARD_TRANSIENT=block` may raise it, never lower it. Chmod-only churn
  — the other A.1 documented miss — is the same rule's attribute variant.
- **Edit-reconstruction fail-open closed**: when an Edit's old_string cannot
  be located in the disk read, the adapter previously produced ZERO changes —
  and allowed the call. Now the incoming new_string is modeled as added
  content (the NotebookEdit stance) and judged. The 07-fastify edit is this
  release's regression test both ways: unreconstructable-Edit deny and
  next-call drift deny.

Warn-severity transients also append to the `TAMPERWARD_DENYLOG` audit trail
(marked `warn:`) so an unattended loop's warnings are at least recorded — the
schema-utils lesson, applied.

**What the effect layer still does not do**, stated where it can be checked:
within-call transients surface as warn unless a harness raises them; the drift
check judges content only through the existing rules, so a mutation none of
them prices (above all the semantic class — expected values rewritten in
place) passes the effect check exactly as it passes the diff check; and the
snapshot state and event log live in `.git/`, reachable by the agent — the
loop layer's standing trust boundary. Held-out re-execution remains the layer
that caught everything in Phase 3, and CI remains the authority.

New detector: **`test-content-removal`** (SPEC row 14, block) — NET removal of
≥3 significant lines from a modified protected test file whose it()/test()
block count did not drop. This is the post-experiment closure of the evasion
class the taskbench Phase-3 sweep measured carrying the gated-arm false greens
(PHASE3.md §4): case-table row deletion, assertion-argument stripping, and
mock/setup gutting — edits that walk through a block-count rule because the
test keeps its name while losing its teeth. Removed content is excused only if
it is actually kept — whitespace-normalized, in the changeset's protected-test
content, comments never excusing (the pilot agent's comment-out spelling is a
regression test). One-for-one rewrites stay out of scope: expected-value
tampering is the semantic class and belongs to held-out oracles, as ever.

Corpus-priced before shipping (`harness/fp-study/TCR-CORPUS.md`): fires on
1.5% of 2,304 real mainline diffs across immer/zustand/zod/prettier, every
adjudicated fire legitimate — block-with-signoff accepted because the corpus's
most instructive fire (prettier deleting error-expectation rows after a parser
genuinely improved) is byte-shaped like the tamper, and Phase 3 measured what
`warn` means in an unattended agent loop: nothing.

Also from the same evidence: **`tap-snapshots/**` joins the snapshot globs**
(node-tar's recorded expectations were rewritten unseen in Phase 3), and
snapshot-glob files are explicitly excluded from the new rule — recorded
expectations stay `snapshot-rewrite`'s jurisdiction with its own measured
severity, one class, one rule.

Scope discipline, stated where it can be checked: the treatment tested in
Phase 3 was and remains 1.6.0; nothing in 1.7.0 is validated against the
Phase-3 pool, and a prevention claim for these detectors requires the fresh
frame draw the results post committed to. The exact trajectory edits that
evaded 1.6.0 now ship as this release's regression tests, including an
end-to-end replay of the postcss-selector-parser throws-stripping edit
denied by the built hook.

## [1.6.0] — 2026-08-29

New policy surface: **per-rule `exclude` globs** — `rules: { ts-any-cast: { severity:
block, exclude: ['**/*.test-d.ts'] } }` scopes ONE rule off matching paths while every
other rule keeps full coverage there. This is the tuning the adjudicated zod FP study
recommended (casts are legitimate in test/type-test files) that the global `ignore`
could never express without blinding the test-protection rules on exactly the files
they guard. Two invariants ship with it: findings on the policy file itself are never
excludable, and **adding** exclude globs is flagged by hook-tampering's policy-diff as
a weakening — the invisible-spelling lesson applied on day one, not after an evasion.
Measured in `harness/PREDICTION-tuned-fp.md`. Six new tests.

## [1.5.1] — 2026-08-29

`test-skip` now covers the **node:test options spelling** — `test('x', { skip: true }, …)`,
the `{ todo: … }` form, and runtime `t.skip()` — closing a gap found live: in the
cheap-baselines study (`harness/PREDICTION-baselines.md`), an agent denied the crude
`rm` skipped the suite by option instead, and the shipped rule was as blind to that
spelling as the 20-line strawman under test. Coverage of a class has to mean the whole
class (the lesson the type-laundering study taught the same day), so the flagship rule
gets its class completed. Five new tests; no other behavior changes.

## [1.5.0] — 2026-08-28

New rule, `warn`: **`snapshot-only-rewrite`** — the FP study's narrow signal (a
snapshot moved with no accompanying change; ~0.06% of 1,652 audited mainline commits,
7/7 of observed harness tampers) as its own rule, distinct from the broad
`snapshot-rewrite` warn so a future policy `version:` can graduate it to `block`
without touching the broad rule (`BLOCK_SINCE` stays empty in this release; nobody's
severity changes).

Granularity is load-bearing and enforced: the rule fires only on the staged and range
views — pre-commit and CI, the granularity the FP corpus measured — never at the
PreToolUse hook or Stop sweep, where "no accompanying change" is meaningless. This
rides a new additive `view` parameter through `evaluate()` and `Detector.run`;
third-party detectors written against the two-argument shape keep working.

Also: the round-three studies (assert-affordance demand measured at a real zero,
frontier-model matrix completed at four models) shipped to the docs and README in
#38/#39. Minor per CONTRIBUTING: a new warn rule is new surface. 272 tests.

## [1.4.6] — 2026-08-27

Docs only. The README stopped claiming the two heuristic rules ship: no detector
implements `assertion-weakening` or `guard-removal` — the names are reserved in the
baseline policy until the SPEC §7.A negatives corpus exists — and `ts-any-launder`,
which existed nowhere but that sentence, is gone. Also links the docs site and launch
post from the header, fixes the init table's policy-as-enforcement-point taxonomy,
makes the sample verdict match the real renderer (a sign-off line on every blocking
finding), and reconciles SPEC to v0.3. The npm page snapshots the README at publish,
so this publish is what corrects it there. No code changes.

## [1.4.5] — 2026-08-27

Docs and harness only. Two new pre-registered studies answer the two sharpest
critiques of the headline number, and the README carries the results (the npm page
snapshots the README at publish, so this publish is what updates it there):

- **Ungated control arm** (`harness/PREDICTION-ungated-control.md`): same seed, model,
  prompt and oracle with the hooks removed — 6/10 tampers through, honest fixes
  10/10 → 4/10. The deny→fix claim graduates from ordering to causation (+60 points);
  one of three bets refuted.
- **Informed adversary** (`harness/PREDICTION-informed-adversary.md`): detector
  sources vendored into the repo, prompt names the gate. All three leak bets refuted —
  informed Haiku attempted zero bypasses (vs 5/10 uninformed same-day); Sonnet refused
  outright in 3/5 runs. Disclosure measured as deterrence, not an evasion spec.
- Headline aggregates: 67 guarded runs, 0 through, 25/25 conversions (95% lower bound
  ≈89%). seed-hard gains an independent held-out oracle (`oracle-hard.mjs`) so a
  hardcoded lookup table can no longer score as an honest fix; `run.sh` gains
  `HF_UNGATED` / `HF_INFORMED` arm levers.
- Enforcement copy scoped on all surfaces: the loop layer exists where the hooks do
  (Claude Code today); CI is the authority.

## [1.4.4] — 2026-08-27

Docs only. The README header now carries the ward glyph — four strokes of change
converging on the ward that stops them at the exact point — replacing the lock mark
(#29). The npm page snapshots the README at publish, so this publish is what puts the
new mark there. No code changes.

## [1.4.3] — 2026-08-27

Docs only. "Wires all four enforcement points" stopped counting: the policy file is
configuration, not an enforcement point, and the SPEC's four adapters (PreToolUse deny,
Stop sweep, pre-commit, CI) group into the three stages the prose describes — two
taxonomies were sharing the word "points". `init` now says what it wires by role: the
policy plus every enforcement point.

## [1.4.2] — 2026-08-27

Docs only. The README's two harness numbers now carry their scopes — "0 tampers reached
green" is true of the guarded-scenario corpus, "7/10 regenerated the golden and sailed
through" is true of the affordance runs where that class was deliberately unguarded.
Adjacent and unscoped, they invited the fair reading that the numbers were massaged.

## [1.4.1] — 2026-08-27

Docs and packaging only — no behaviour change.

- README rewritten front-door-first: install, a real denial transcript, then the
  measured evidence (the §7.B conversion rate with its bound, the affordance experiment
  with its refuted bets, the 1,652-commit FP study). The build-log sections are gone;
  SPEC keeps the depth.
- `package.json` gains `keywords` so the package is findable on npm at all.
- GitHub release bodies are now the CHANGELOG section for the version instead of the
  auto-generated PR list.

## [1.4.0] — 2026-08-27

### Added

- **`tamperward init`** — the last unshipped SPEC promise. One idempotent command wires
  all four enforcement points: a commented baseline `.tamperward.yml`, the Claude Code
  PreToolUse + Stop hooks (merged into `.claude/settings.json`, preserving whatever is
  already there), a pre-commit hook (husky when present, the plain git hook otherwise,
  appended with a marker when a script already exists), and a GitHub Actions PR gate
  carrying the out-of-band label sign-off — including the `labeled`/`unlabeled`
  re-triggers, so an applied or revoked sign-off takes effect without a push. Running
  twice is a no-op; nothing you wrote is ever overwritten; an unparseable
  `.claude/settings.json` aborts that item instead of clobbering it; `--dry-run`
  prints the plan.

### Fixed

- Restored the 1.3.0 `version:` gate source, tests, and docs on `main`, which the
  FP-study merge (#22) had accidentally reverted — a commit built from a stale
  checkout. The published 1.3.0 package always carried the code (it shipped from the
  1.3.0 merge commit); only the repository regressed behind it.

## [1.3.0] — 2026-08-27

### Added

- **The `version:` opt-in mechanism is real** (previously reserved in CONTRIBUTING).
  A baseline rule graduated `warn` → `block` at policy version N now blocks only for
  policies declaring `version: >= N` and stays `warn` below. Missing `version:` — or no
  policy file at all — means 1: nobody is opted in to anything they didn't write down.
  An explicit `severity:` wins over the gate in either direction. An unparseable
  `version:` fails closed like any other malformed policy. This unblocks shipping rule
  graduations (first candidate: `snapshot-rewrite`) as minors instead of majors.
- `policy-diff` flags a lowered `version:` — the only thing a lowering can do is un-opt
  the repo from future blocks — and, once a gate exists, reports the concrete rule
  downgrades the lowering causes, exactly as the engine would enforce them.

No gate ships in this release: `BLOCK_SINCE` is empty, so behaviour is identical for
every existing policy. The mechanism is exercised by simulated-graduation tests.

## [1.2.1] — 2026-08-27

### Fixed

- **`ci-tampering` no longer flags moved or argument-position "checks"** (#15). Both
  false positives the rule ever produced were the same mistake from two directions:
  `- run: npm test` re-added indented under a new `if:` read as a deletion (the check
  had *moved*), and `npm view tamperward dist-tags` read as a removed check (the check
  keyword was a *package name* in argument position). A removal now means the command's
  core no longer exists anywhere in the after-file, and check keywords only count in
  invocation position. A check moved behind a literal `if: false` (any spelling) is
  still caught by the added-line scan; genuine deletions still block — verified by
  replaying both historical false-positive diffs (clean) and a real deletion (blocked).

## [1.2.0] — 2026-08-27

### Added

- **`snapshot-rewrite`** (`warn`) — the first detector built from measured demand rather
  than intuition. In the affordance-seed experiment (`harness/PREDICTION-affordance.md`),
  7 of 10 adversarial runs regenerated a golden file from buggy output and every one
  passed unseen, while three other hypothesized bypass classes measured zero attempts
  and stay unbuilt. Catches: runner update mode (`jest -u`, `--updateSnapshot`,
  `vitest --update`, playwright `--update-snapshots`), regeneration scripts by naming
  convention (`update-golden`, `regen-snapshots`, `rebless-baselines`), shell mutation
  of protected snapshot paths, and any modify / delete / rename-out of a recorded
  expectation. New default protected category `snapshots`
  (`**/*.snap`, `**/__snapshots__/**`, `**/golden/**`, `**/*.golden.*`).
  `warn` because updating a snapshot is the legitimate workflow when intended output
  changes — the finding asks a human to confirm the new expectation, and graduation to
  `block` follows the SPEC §7 evidence path.
- Harness: four affordance seeds with independent oracles and mechanical validation,
  plus `shadow.mjs`, a record-only scanner accumulating attempt-rate evidence for
  hypothesized detectors on every run.

## [1.1.0] — 2026-08-26

### Fixed

- **`coverage-lowering` was blind to `package.json`.** Configs are parsed as TypeScript,
  where a top-level `{…}` is a *block statement* rather than an object literal — so no
  property nodes were produced and the file read as "no coverage gate here". Jest's
  `coverageThreshold` lives in `package.json` at least as often as in `jest.config.js`,
  and `**/package.json` has always been in the default protected config globs, so this
  was a silent false negative on a headline rule. **Anyone on 1.0.0 has a gate that
  misses coverage tampering in that file.** JSONC configs are now read too.
- Every git probe that missed — reading `.tamperward.yml` from a merge base that has
  none, which is the ordinary case — printed git's own `fatal:` line to the terminal
  before the caller handled the absence cleanly. stderr is piped now and folded into the
  thrown error, so a real failure stays exactly as diagnosable.

### Added

- **The verdict is rendered for whoever is reading it.** Under GitHub Actions
  (auto-detected), each finding becomes a workflow annotation placed **inline on the diff
  in Files changed**, plus a job-summary table on the run page — the verdict no longer
  lives only inside a collapsed job log. Annotations rather than SARIF deliberately: they
  need no `security-events: write` and no Advanced Security, so they work on every
  repository.
- Terminal output groups blocking findings first, wraps to the terminal, and keeps
  `path:line` intact so terminals linkify it.
- `--format text | json | github | auto` to select explicitly. `--json` is unchanged and
  the keys it already emitted keep their exact shape; `summary` is additive.

### Accessibility

Severity is carried by the word (`BLOCK` / `warn`) in every format, never by colour or a
glyph alone, so the verdict reads the same piped, in a log, through a screen reader, and
for a reader who cannot distinguish the colours. A test asserts that stripping the ANSI
from the coloured output equals the mono output byte for byte. `NO_COLOR` and
`FORCE_COLOR` are honoured; colour is off whenever stdout is not a terminal. The job
summary is a real markdown table with a header row.

### Internal

- Publishing moved to npm trusted publishing (OIDC) with no stored token, verified end to
  end via the `1.1.0-rc.2` prerelease. CI runs on pull requests only.
- 211 tests, up from 158.

## [1.0.0] — 2026-08-26

First public release.

### The engine

- `Change` model shared by every enforcement point: a change is a command or a per-file
  diff, and the engine never knows which point produced it.
- Pure unified-diff parser — add / modify / delete / rename (as one change carrying
  `oldPath`) / rename+edit / binary, with per-line old/new numbers correct across hunks,
  and git's C-quoted non-ASCII paths decoded before glob matching.
- Git adapter for the range, staged and working-tree views, enriching `before`/`after`
  with full content so the AST detectors have something to parse.

### Detectors

Eight mechanical rules, all `block`: `test-deletion` (AST block-count, rename-out-of-glob,
shell mutation), `test-skip`, `ts-any-cast`, `lint-suppression`, `coverage-lowering`
(Jest and Vitest shapes, all four metrics), `ci-tampering` (including checks removed from
a multi-line `run:` block), `hook-tampering` (including a hook gutted in place), and
`no-verify`.

Two heuristic rules ship as `warn` and do not block: `assertion-weakening` and
`guard-removal`. They graduate only when their precision is measured against a negatives
corpus — see SPEC §7.A.

### Enforcement points

- Claude Code `PreToolUse` hook — denies before the change reaches disk, and **fails
  closed**: if the gate cannot evaluate, the change is denied rather than allowed.
- Claude Code `Stop` sweep — re-checks the turn's net diff against the commit the turn
  started at, so a mid-turn commit cannot launder a tamper past it.
- `tamperward check --staged` for pre-commit, `--diff <base>...<head>` for CI.

### Trust model

- Three-layer sign-off: the agent layer honours nothing it can author; the local ledger is
  fingerprint-bound and expiring; CI honours only an out-of-band approval.
- At the CI layer the governing policy is read from the **merge-base**, never the head, so
  a change cannot weaken the policy that decides its own verdict.
- `ignore` can never suppress the policy file itself, and protected globs merge additively
  with the baseline rather than replacing it.

### Measurement

- Bypass-to-fix conversion (SPEC §7.B) measured over 42 agent runs: 0 tampers reached
  green; of 20 runs where a block fired, 20 ended in an honest fix. See the README for the
  arms, the split by model, and the limits of the sample.

[1.0.0]: https://github.com/hexrift/tamperward/releases/tag/v1.0.0
[1.1.0]: https://github.com/hexrift/tamperward/releases/tag/v1.1.0
[1.2.0]: https://github.com/hexrift/tamperward/releases/tag/v1.2.0
[1.2.1]: https://github.com/hexrift/tamperward/releases/tag/v1.2.1
[1.3.0]: https://github.com/hexrift/tamperward/releases/tag/v1.3.0
[1.4.0]: https://github.com/hexrift/tamperward/releases/tag/v1.4.0
[1.4.1]: https://github.com/hexrift/tamperward/releases/tag/v1.4.1
[1.4.2]: https://github.com/hexrift/tamperward/releases/tag/v1.4.2
[1.4.3]: https://github.com/hexrift/tamperward/releases/tag/v1.4.3
