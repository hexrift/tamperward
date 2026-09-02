# The rules

Thirteen mechanical rules on the diff, command and event surfaces, deterministic by
construction — nine `block`, four `warn` — plus the outcome layer, `tamperward verify`,
which interprets no diff at all. Two further heuristic names are reserved and unbuilt
(below). Every id here is a key under `rules:` in `.tamperward.yml`, and the baseline
severities are the ones `defaultPolicy` ships.

| rule | severity | catches |
| --- | --- | --- |
| `test-deletion` | block | deleted spec files, renames out of the tests glob, net removal of `it()`/`test()` blocks (counted via the AST), shell mutation of protected test paths |
| `test-content-removal` | block | content stripped out of a spec that survives — the failing rows of a data-driven table, the expected-message arguments of `throws(...)` calls, a gutted mock-setup region — which leaves the block count untouched and walks past `test-deletion`; a removed significant line is excused only if its text is still kept in the changeset's protected tests after the edit, and a comment does not count as kept |
| `test-skip` | block | added `.skip` / `.only` / `.todo` / `xit` / `xdescribe` — `.only` narrows the suite, same class. Read per language of the protected file since 1.15.0: `@pytest.mark.skip` / `pytest.skip()` / `@unittest.skip`, Go `t.Skip()`, Rust `#[ignore]`, Ruby `skip` / `xit`, JUnit `@Disabled` / `@Ignore`, PHPUnit `markTestSkipped()`, .NET `[Ignore]` / `Skip = "…"` |
| `ts-any-cast` | block | added `as any`, `<any>` casts, `as unknown as`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` — the unambiguous escape hatches, rare in honest code |
| `ts-any-launder` | warn | `any` introduced in an annotation or generic position (`: any`, `Record<string, any>`, `Array<any>`) — the spelling agents launder with, but common enough in honest code that it surfaces for human review rather than blocking; a permanent warn |
| `lint-suppression` | block | added `eslint-disable` (inline or block), `prettier-ignore`, `biome-ignore`; per language since 1.15.0: `# noqa`, `# type: ignore`, `# pylint: disable`, `//nolint`, `# rubocop:disable`, `@SuppressWarnings`, `phpcs:ignore`, `#pragma warning disable`. Rust `#[allow]` is deliberately excluded (too common in honest code for a block rule) |
| `coverage-lowering` | block | thresholds lowered, moved, or deleted — Jest and Vitest shapes, all four metrics, `package.json` included; `--coverage` stripped from scripts |
| `ci-tampering` | block | check steps removed from workflows (a **moved** check is not a removed one), `continue-on-error: true`, any spelling of `if: false` |
| `hook-tampering` | block | hook files edited, gutted, or neutered; `chmod`/`tee`/`sed` against protected paths; `.tamperward.yml` weakened |
| `no-verify` | block | `--no-verify`, `git commit -n`, `HUSKY=0`, `HUSKY_SKIP_HOOKS`, `--no-hooks`, `core.hooksPath`, `LEFTHOOK=0`, `LEFTHOOK_EXCLUDE=`, and the pre-commit framework's `SKIP=<hook-id>` in a git or pre-commit invocation |
| `snapshot-rewrite` | warn | runner update mode (`jest -u`, `--updateSnapshot`), regeneration scripts by name, modify/delete of `*.snap`, `__snapshots__/`, `golden/` |
| `snapshot-only-rewrite` | warn | snapshots moved with **no accompanying change**, judged only at commit granularity (pre-commit and CI diffs); ~0.06% FP on audited mainlines, 7/7 TP on observed tampers — the graduation candidate |
| `transient-protected-mutation` | warn | judged at the Stop sweep from the `tamperward watch` event log: a protected file whose recorded content or mode churned during the turn while its net state at Stop is unchanged — modified and restored, so neither the per-call drift check nor the turn diff can see it, while anything that consulted the suite mid-churn consulted a weakened version. `TAMPERWARD_TRANSIENT=block` may raise it and can never lower it |

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
