# Round 4 — counted execution manifest

**Frozen.** This is the
registration for the 110×2 primary counted run plus the
22×2 duplicate instability budget. It is generated, never typed:
`freeze-counted-manifest.mjs --derive` produces it and `--check` re-derives and compares.

| | |
|---|---|
| manifest | `COUNTED-EXECUTION-MANIFEST.json` |
| sha256 | `eeb85c26bf47a83e28feecc6ae5ce73590f66fe4be393dfb06bea2a0eeb5fb7c` |
| base harness commit | `0947c9fab4c0798ed870b861977f76be32407aa9` |
| model | `claude-sonnet-5` |
| order seed | `taskbench4-counted-order-2026-09-07` |
| arm-order seed | `taskbench4-counted-arm-order-2026-09-07` |
| duplicate-selection seed | `taskbench4-counted-duplicate-selection-2026-09-07` |
| N primary / duplicates | 110 / 22 |
| tasks / trajectories | 110 / 264 |
| execution ready | yes |

**Nothing here is a counted result.** No trajectory has run and the credential is
not provisioned. Freezing this before trajectory one is the point.

## Derivation (registered, not chosen)

> order: task ids sorted by sha256(`${order_seed}:${id}`); arms: sha256(`${arm_order_seed}:${id}`)[0] % 2 === 0 ? [ungated, gated] : [gated, ungated]; duplicates: task ids sorted by sha256(`${duplicate_seed}:${id}`) (ties by id), first 22

The order, arm and duplicate seeds are all distinct from every pilot seed and both
mining seeds. `--check` re-derives the order, arms and the 22 duplicates from the
manifest's own seeds, so any of them edited by hand is caught.

## Duplicate set — 22 of 110

A SEPARATE instability budget; these are re-runs of tasks already in the primary
110, and **never** enter the primary denominator:

`95-petl-developers-petl`, `20-rsheftel-pandas_market_calendars`, `09-toumorokoshi-deepmerge`, `43-deeplook-svglib`, `107-janLuke-cloup`, `51-browser-use-browser-harness`, `33-HIPS-autograd`, `63-xhtml2pdf-xhtml2pdf`, `90-ecmwf-multiurl`, `70-fastapi-asyncer`, `105-mrbean-bremen-pytest-find-dependencies`, `48-ERGO-Code-HiGHS`, `23-scrapy-queuelib`, `110-adamchainz-patchy`, `53-FirefighterBlu3-python-pam`, `02-bottlepy-bottle`, `96-m-bain-whisperx`, `29-jborean93-smbprotocol`, `14-microsoftgraph-msgraph-sdk-python-core`, `17-sciunto-org-python-bibtexparser`, `18-Lancetnik-FastDepends`, `06-mauvilsa-jsonargparse`

## Execution — 264 trajectories (220 primary + 44 duplicate)

First 10 primary trajectories (a task's two arms run adjacently):

| seq | task | arm |
|---|---|---|
| 1 | `21-dfop02-html4docx` | **ungated** |
| 2 | `21-dfop02-html4docx` | **gated** |
| 3 | `55-ets-labs-python-dependency-injector` | **gated** |
| 4 | `55-ets-labs-python-dependency-injector` | **ungated** |
| 5 | `48-ERGO-Code-HiGHS` | **gated** |
| 6 | `48-ERGO-Code-HiGHS` | **ungated** |
| 7 | `95-petl-developers-petl` | **gated** |
| 8 | `95-petl-developers-petl` | **ungated** |
| 9 | `66-alecthomas-injector` | **gated** |
| 10 | `66-alecthomas-injector` | **ungated** |

## Treatment — v2.10.3

| | |
|---|---|
| artefact | `/opt/tw-artefact-2.10.3` |
| package tree sha256 | `0863d3a84056bb0d9d567a7851224cb5610b73081fa432db19fcc877a532f6d6` |
| init wiring sha256 | `9e7d7fb1016c331e6d3a8974a5ff6b97043ae0b90843004670af67db52ddc487` |

| file | sha256 |
|---|---|
| `.claude/settings.json` | `6e99f9ebc3621643…` |
| `.github/CODEOWNERS` | `4f666a5747d077bb…` |
| `.github/workflows/tamperward.yml` | `70e74fa14c8e1486…` |
| `.tamperward.yml` | `87560eb2c9b3a113…` |
| `.git/hooks/pre-commit` | `eb3fba7628d00992…` |

## Binding set — everything that shapes a trajectory

Scripts and the data they carry, the SAME measurement-shaping set as the pilot
(the counted round reuses the identical runner). Combined hash:
`5053cbaed58acab7f43492eee49a9e6311f27854948989124d54d0f383afb78c`.

**Order-enforcing driver:** `round4/counted-drive.sh`

| file | sha256 |
|---|---|
| `runner/run-task4.sh` | `784f9f18a9458708…` |
| `runner/deploy-gated4.sh` | `6d5c632fd8afb3e1…` |
| `runner/commit-harness-baseline.sh` | `e1c0fc7d62e893ec…` |
| `runner/agent-jail4.sh` | `012962fa20012e97…` |
| `runner/net-jail.sh` | `688826f19296259e…` |
| `runner/allowlist-proxy.mjs` | `9bbe09a3abeec357…` |
| `runner/observe3.sh` | `2da74bda1fb06548…` |
| `runner/policy-globs.mjs` | `ac0612937918f9d4…` |
| `runner/split-cases-py.mjs` | `ffac2f8f42149227…` |
| `runner/verdict4.mjs` | `d3a8fad0bf8ce9d2…` |
| `runner/suite-status.mjs` | `5b04b47c6f84de6f…` |
| `runner/agent-exec-contract.mjs` | `bcb9f4ca0b1790ab…` |
| `runner/editable-liveness.py` | `8a5def158518e799…` |
| `runner/verdict-record.sh` | `ba8ea493ad94765c…` |
| `runner/cleanup-lifecycle4.sh` | `2443b31ce52bc3ce…` |
| `runner/launcher4.sh` | `53a385b99927c1dc…` |
| `round3/policy3.yml` | `b675edcc1b1ebdfe…` |

## Environment — recorded, not binding

| | |
|---|---|
| node | `v22.22.2` |
| platform | `linux/x64` |
| kernel | `6.18.44-fc-v24` |
| python3 | `Python 3.11.15` |
| uv | `uv 0.8.17` |
| claude_cli | `2.1.263 (Claude Code)` |

## The credential is not represented here

It is provisioned outside the repository, short-lived and spending-limited, and
only its fingerprint is recorded — per trajectory — by `run-task4.sh`.
