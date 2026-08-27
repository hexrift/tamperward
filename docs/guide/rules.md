# The rules

Nine mechanical rules, deterministic by construction, `block` by default:

| rule | catches |
| --- | --- |
| `test-deletion` | deleted spec files, renames out of the tests glob, net removal of `it()`/`test()` blocks (counted via the AST), shell mutation of protected test paths |
| `test-skip` | added `.skip` / `.only` / `.todo` / `xit` / `xdescribe` — `.only` narrows the suite, same class |
| `ts-any-cast` | added `as any`, `: any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` |
| `lint-suppression` | added `eslint-disable` (inline or block), `prettier-ignore` |
| `coverage-lowering` | thresholds lowered, moved, or deleted — Jest and Vitest shapes, all four metrics, `package.json` included; `--coverage` stripped from scripts |
| `ci-tampering` | check steps removed from workflows (a **moved** check is not a removed one), `continue-on-error: true`, any spelling of `if: false` |
| `hook-tampering` | hook files edited, gutted, or neutered; `chmod`/`tee`/`sed` against protected paths; `.tamperward.yml` weakened |
| `no-verify` | `--no-verify`, `git commit -n`, `HUSKY=0`, `HUSKY_SKIP_HOOKS`, `--no-hooks` |
| `snapshot-rewrite` | `warn` — runner update mode (`jest -u`, `--updateSnapshot`), regeneration scripts by name, modify/delete of `*.snap`, `__snapshots__/`, `golden/` |

Three heuristics ship as `warn` and never block until their precision clears the bar:
`assertion-weakening`, `guard-removal`, `ts-any-launder`.

## Why snapshot-rewrite warns

It was swept over 1,652 real mainline commits (prettier, jest, docusaurus, immer):
216 touched snapshots, **all legitimately**. A rule that fires on a routine workflow
cannot block — so it asks a human to confirm the new expectation instead. The full
study, pre-registered, is committed under `harness/fp-study/`.

## Rule graduations are opt-in

A baseline rule promoted `warn` → `block` at policy version N blocks only for policies
declaring `version: >= N` — so graduations ship as minors and never turn an
un-opted-in build red. An explicit `severity:` you wrote always wins, in either
direction.
