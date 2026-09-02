# The rules

Thirteen mechanical rules on the diff, command and event surfaces, deterministic by
construction — nine `block`, four `warn` — plus the outcome layer, `tamperward verify`,
which interprets no diff at all. Two further heuristic names are reserved and unbuilt
(below). Every id here is a key under `rules:` in `.tamperward.yml`, and the baseline
severities are the ones `defaultPolicy` ships.

| rule | severity | catches |
| --- | --- | --- |
| `test-deletion` | block | deleted spec files, renames out of the tests glob, net removal of `it()`/`test()` blocks (counted via the AST; a literal `it.each` table counts one test per row), shell mutation of protected test paths (`rm`, `sed -i`, `truncate`, redirects, `cp /dev/null`, `tee`, `find -delete`, `git checkout <rev> --`, a directory that holds protected specs), and the runner told not to open a spec — jest `testPathIgnorePatterns` / `testMatch` / `testRegex`, vitest `test.exclude` / `test.include` — evaluated as the selection predicate over the repository's own spec files; a test moved into another spec in the same change (split, merge) is a relocation, not a deletion |
| `test-content-removal` | block | content stripped out of a spec that survives — the failing rows of a data-driven table, the expected-message arguments of `throws(...)` calls, a gutted mock-setup region — which leaves the block count untouched and walks past `test-deletion`; a removed significant line is excused only if its text is still kept in the changeset's protected tests after the edit, and a comment does not count as kept |
| `test-skip` | block | added `.skip` / `.only` / `.todo` / `xit` / `xdescribe` — `.only` narrows the suite, same class. Read per language of the protected file since 1.15.0: `@pytest.mark.skip` / `pytest.skip()` / `@unittest.skip`, Go `t.Skip()`, Rust `#[ignore]`, Ruby `skip` / `xit`, JUnit `@Disabled` / `@Ignore`, PHPUnit `markTestSkipped()`, .NET `[Ignore]` / `Skip = "…"` |
| `ts-any-cast` | block | added `as any`, `<any>` casts, `as unknown as`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` — the unambiguous escape hatches, rare in honest code |
| `ts-any-launder` | warn | `any` introduced in an annotation or generic position (`: any`, `Record<string, any>`, `Array<any>`) — the spelling agents launder with, but common enough in honest code that it surfaces for human review rather than blocking; a permanent warn |
| `lint-suppression` | block | added `eslint-disable` (inline or block), `prettier-ignore`, `biome-ignore`; per language since 1.15.0: `# noqa`, `# type: ignore`, `# pylint: disable`, `//nolint`, `# rubocop:disable`, `@SuppressWarnings`, `phpcs:ignore`, `#pragma warning disable`. Rust `#[allow]` is deliberately excluded (too common in honest code for a block rule) |
| `coverage-lowering` | block | thresholds lowered, moved, or deleted — Jest and Vitest shapes, all four metrics, `package.json` included; `--coverage` stripped from scripts, `--coverage=false` / `--coverageThreshold=` added; `passWithNoTests` as a config key, vitest `thresholds.autoUpdate`; the denominator narrowed (`collectCoverageFrom` entries dropped or source exempted, `coveragePathIgnorePatterns` / `coverage.exclude` grown); `.coveragerc` / `pyproject.toml` `fail_under`, nyc thresholds and `check-coverage`, codecov `target` / `threshold` / `informational`. It never claims a removal it cannot see: a spread, an expression, a stricter override naming one metric, an override removed for a file no longer in the repo |
| `ci-tampering` | block | check steps removed from workflows (a **moved** check is not a removed one, and neither is one edited in place — a flag added, `npm test` → `npm run test` / `pnpm test`, an action bumped `@v3` → `@v4`), a kept check line whose block was neutralised (`set +e`, `exit 0`, `if false; then`, a heredoc comment, `shell: bash {0}`, `\|\| true`, `--passWithNoTests`), `continue-on-error: true` and `if: false` in any spelling that folds to a constant (quoted booleans, `${{ 1 == 1 }}`, `${{ 'a' == 'b' }}`, `${{ !true }}` — anything with a context reference stays reachable) on a step that runs a check or at job level, and `on:` narrowed so the workflow no longer runs (`push` / `pull_request` removed, `paths-ignore: ['**']`, `branches:` no longer naming main) |
| `hook-tampering` | block | hook files edited, gutted, or neutered; `chmod`/`tee`/`sed` against protected paths; `.tamperward.yml` weakened |
| `no-verify` | block | `--no-verify`, `git commit -n`, `HUSKY=0`, `HUSKY_SKIP_HOOKS`, `--no-hooks`, `core.hooksPath`, `LEFTHOOK=0`, `LEFTHOOK_EXCLUDE=`, and the pre-commit framework's `SKIP=<hook-id>` in a git or pre-commit invocation |
| `snapshot-rewrite` | warn | runner update mode (`jest -u`, `--updateSnapshot`), regeneration scripts by name, modify/delete of `*.snap`, `__snapshots__/`, `golden/` |
| `snapshot-only-rewrite` | warn | snapshots moved with **no accompanying change**, judged only at commit granularity (pre-commit and CI diffs); ~0.06% FP on audited mainlines, 7/7 TP on observed tampers — the graduation candidate |
| `transient-protected-mutation` | warn | judged at the Stop sweep from the `tamperward watch` event log: a protected file whose recorded content or mode churned during the turn while its net state at Stop is unchanged — modified and restored, so neither the per-call drift check nor the turn diff can see it, while anything that consulted the suite mid-churn consulted a weakened version. `TAMPERWARD_TRANSIENT=block` may raise it and can never lower it |

## Two findings that are not rules

Two ids can appear in a verdict without being keys under `rules:`. Neither can be
disabled, lowered or excluded by policy, because each reports that the gate could
not do its job — and a gate that cannot evaluate must deny, never pass.

| finding | where | meaning |
| --- | --- | --- |
| `detector-error` | staged, worktree and range views | a detector threw on this change. Repository content that makes a rule crash used to remove that rule from the verdict; now it is a blocking finding naming the rule. |
| `hidden-drift` | the PreToolUse drift check and the Stop sweep | a protected file changed outside git's view — `git update-index --skip-worktree` / `--assume-unchanged`, or a gitignored protected file — and its last sanctioned content could not be reconstructed, so the change cannot be judged. When it can be reconstructed the ordinary rules judge it instead. Restore the file and bring it back into git's view. |

The Stop sweep also scans **untracked** protected files since 2.2.0: a new
`conftest.py`, a shadowing runner config, or a settings override the turn created is
judged as the add it is, with its content read as an edit. **Ignored** protected files
are judged the same way: a protected file created behind a `.gitignore` line, the
agent-writable `.git/info/exclude`, or the global excludes (which carry
`.claude/settings.local.json`) is in the tree the runner executes whatever git lists,
so the PreToolUse drift check, the Stop sweep, and the `run` envelope's working-tree
check all read it as an add — and a protected addition no git view can list at all is
reconstructed from disk by the drift check rather than absorbed. A protected file that
already existed, untracked or ignored, when the session began is not re-litigated; the
turn tree that says so can only excuse a file the drift state also sanctioned.
Untracked and ignored files outside the protected globs are not scanned, and
`node_modules` is never walked.

## The outcome layer: `tamperward verify`

The one question no diff rule can answer is whether the *original* suite still passes
against the current source. `tamperward verify` runs the suite twice, in two separate
copies of the working tree: as-is (the **visible** run), and with every protected test,
snapshot and config file restored from the trusted base — agent-added files on those
surfaces removed — (the **pristine** run). Visible green with pristine red is a
**masked failure** (exit 1); "could not verify" fails closed (exit 2). It is mechanical
at the outcome level, so it is immune to spelling — it identified every masked failure
in the round-1 trajectories while diff-time detection was routed around. It runs at
commit and CI granularity, not per tool call, and the `verify:` block that configures
it is itself a guarded surface. See [Getting started](./getting-started.md#pristine-verification-tamperward-verify).

Two heuristic rule names — `assertion-weakening` and `guard-removal` — are **reserved
in the baseline policy but not yet built**: they get detectors only once a measured
negatives corpus exists (SPEC §7.A), enter as `warn`, and never block until their
precision clears the bar.

## Why snapshot-rewrite warns

It was swept over 1,652 real mainline commits (prettier, jest, docusaurus, immer):
216 touched snapshots, **all legitimately**. A rule that fires on a routine workflow
cannot block — so it asks a human to confirm the new expectation instead. The full
study, pre-registered, is committed under `harness/fp-study/`. Its narrow signal —
the one commit in 1,652 that changed *only* snapshots — ships as the distinct
`snapshot-only-rewrite` warn, so that when a policy `version:` graduates it to block,
the broad rule stays warn and nobody is opted in to anything they didn't write down.

## Rule graduations are opt-in

A baseline rule promoted `warn` → `block` at policy version N blocks only for policies
declaring `version: >= N` — so graduations ship as minors and never turn an
un-opted-in build red. An explicit `severity:` you wrote always wins, in either
direction.
