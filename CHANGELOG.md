# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) as scoped in
[CONTRIBUTING](./CONTRIBUTING.md#versioning).

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
