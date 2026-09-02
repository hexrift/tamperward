# The rules

Thirteen mechanical rules on the diff, command and event surfaces, deterministic by
construction — nine `block`, four `warn` — plus the outcome layer, `tamperward verify`,
which interprets no diff at all. Two further heuristic names are reserved and unbuilt
(below). Every id here is a key under `rules:` in `.tamperward.yml`, and the baseline
severities are the ones `defaultPolicy` ships.

| rule | severity | catches |
| --- | --- | --- |
| `test-deletion` | block | deleted spec files, renames out of the tests glob, net removal of `it()`/`test()` blocks (counted via the AST; a literal `it.each` table counts one test per row), shell mutation of protected test paths (`rm`, `sed -i`, `truncate`, redirects, `cp /dev/null`, `tee`, `find -delete`, `git checkout <rev> [--] <path>`, a directory that holds protected specs, the whole cwd as `.` / `*` / a `..`-relative token), and the runner told not to open a spec — jest `testPathIgnorePatterns` / `testMatch` / `testRegex` / `roots` / `rootDir` / `modulePathIgnorePatterns` / `projects`, vitest `test.exclude` / `test.include` (a `!` entry included) / `test.dir` / `test.projects`, a `vitest.workspace.*` file, a `vite.config.*` carrying a `test:` key — evaluated as the selection predicate over the repository's own spec files (a multi-project config is the union of its projects; `typecheck.*` and `benchmark.*` are other suites; a `fixtures/` / `__mocks__/` ignore is not a narrowing), and a narrowing flag (`--testPathPattern`, `-t`, `--exclude`, `--dir`, `--project`, …) added to a `scripts.test*` entry that runs jest or vitest; a `describe.each` table multiplies the tests it encloses; a test moved into another spec in the same change (split, merge) is a relocation, not a deletion — held only by added tests that have a body, never by `it("noop", () => {})` stubs. Since 2.7.1 the predicate is read the way the runner reads it: `it.for` / `describe.for` count like `each` and a loop over a literal array counts once per element; only `scripts.test` and `test:ci` are the suite a flag can narrow, and `--exclude e2e/**` is set-up; `extends: true` projects inherit the root selection while `extends: '<path>'`, `mergeConfig` over an imported base and a `...base` spread are opaque; `test.root` rebases like `test.dir`; a `.snap` inside `__tests__/` belongs to `snapshot-rewrite`; `git checkout main -- test/` while on `main` restores nothing older |
| `test-content-removal` | block | content stripped out of a spec that survives — the failing rows of a data-driven table, the expected-message arguments of `throws(...)` calls, a gutted mock-setup region — which leaves the block count untouched and walks past `test-deletion`; a removed significant line is excused only if its text is still kept in the changeset's protected tests after the edit, and a comment does not count as kept; rows of an each-table that spreads from elsewhere (or is built by a call) are compared as elements — one-line tables included — and two rows gone that reappear nowhere in the change fire on their own; content added to a non-spec file under a test directory (a case table moved to `test/fixtures/`) counts as kept |
| `test-skip` | block | added `.skip` / `.only` / `.todo` / `xit` / `xdescribe` — `.only` narrows the suite, same class. Read per language of the protected file since 1.15.0: `@pytest.mark.skip` / `pytest.skip()` / `@unittest.skip`, Go `t.Skip()`, Rust `#[ignore]`, Ruby `skip` / `xit`, JUnit `@Disabled` / `@Ignore`, PHPUnit `markTestSkipped()`, .NET `[Ignore]` / `Skip = "…"` |
| `ts-any-cast` | block | added `as any`, `<any>` casts, `as unknown as`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` — the unambiguous escape hatches, rare in honest code |
| `ts-any-launder` | warn | `any` introduced in an annotation or generic position (`: any`, `Record<string, any>`, `Array<any>`) — the spelling agents launder with, but common enough in honest code that it surfaces for human review rather than blocking; a permanent warn |
| `lint-suppression` | block | added `eslint-disable` (inline or block), `prettier-ignore`, `biome-ignore`; per language since 1.15.0: `# noqa`, `# type: ignore`, `# pylint: disable`, `//nolint`, `# rubocop:disable`, `@SuppressWarnings`, `phpcs:ignore`, `#pragma warning disable`. Rust `#[allow]` is deliberately excluded (too common in honest code for a block rule) |
| `coverage-lowering` | block | thresholds lowered, moved, or deleted — Jest and Vitest shapes, all four metrics, `package.json` included; `--coverage` stripped from scripts, `--coverage=false` / `--coverageThreshold=` added; `passWithNoTests` as a config key, vitest `thresholds.autoUpdate`; the denominator narrowed (`collectCoverageFrom` / vitest `coverage.include` compared as a predicate over the repository's own source files, so `src/**` → `src/**/*.{ts,tsx}` in a TypeScript repo is silent while `src/**` → `src/index.ts` is not; `coveragePathIgnorePatterns` / `coverage.exclude` grown, `.coveragerc` `[run] omit` grown, codecov `ignore:` grown); vitest `coverage.enabled: false` and `thresholds.perFile` dropped; `.coveragerc` / `pyproject.toml` `fail_under`, nyc thresholds and `check-coverage` (in `.nycrc` or under package.json's `nyc` key), codecov `target` (a number, or `auto`) / `threshold` / `informational` / `project: off`, each compared within its own `project:` / `patch:` scope. It never claims a removal it cannot see: a spread, an expression, a stricter override naming one metric, an override removed for a file no longer in the repo — and a gate that moved to another config in the same change (`.coveragerc` → `pyproject.toml`, `jest.config.js` → `package.json`) with numbers no lower is a move, not a deletion. Housekeeping, not weakening (2.7.1): exemptions of generated code, migrations, `*.generated.*` / `*.gen.*` / `*.pb.*`, `*.e2e-spec.*`, `manage.py` / `wsgi.py` / `asgi.py` / `__init__.py` and `main.ts` (`**/index.ts` stays reported); vitest `thresholds: { 100: true }` read as every metric at 100; codecov `informational: true` under `patch:` beside an untouched project target; `--passWithNoTests` in a package whose directory holds no spec |
| `ci-tampering` | block | check steps removed from workflows (a **moved** check is not a removed one, and neither is one edited in place — a flag added, `npm test` → `npm run test` / `pnpm test`, an action bumped `@v3` → `@v4`), a kept check line whose block was neutralised (`set +e`, `exit 0`, `if false; then`, a heredoc comment, `shell: bash {0}`, `\|\| true`, `--passWithNoTests`), `continue-on-error: true` and `if: false` in any spelling that folds to a constant (quoted booleans, `${{ 1 == 1 }}`, `${{ 'a' == 'b' }}`, `${{ !true }}`, and the short-circuits `${{ context && false }}` / `${{ context \|\| true }}`, which decide whatever the context holds — anything that genuinely depends on a context reference stays reachable) on a step that runs a check or at the level of a job that runs one (a job-level `if: false` on a deploy job neuters no check), and `on:` narrowed so the workflow no longer runs (`push` / `pull_request` removed, `paths-ignore: ['**']`, `paths:` that no source file can match, `pull_request.types` without `opened` / `synchronize`, `branches:` no longer naming the default branch — read from `origin/HEAD`; `[main]` → `[master]` is accepted when the repository cannot say which is default). Kept, not removed: a check respelled as another invocation of the same kind (`npm test` → `npm run test:ci`, `npx jest` → `npx vitest run`) and a check moved into a reusable workflow the same change adds. Reported as neutralised: a spec path as a positional (`npm test -- test/a.test.ts`, `npx jest test/a`) and `timeout N` wrapping the check. Read the way the runner reads it since 2.7.1: a workflow expression folds to its constant or reads as one token, so a `--shard` or `--project` valued by the matrix, the strategy or a workflow input is not a narrowing while a literal `--project=unit` still is; `node --test`, `mocha`, `biome ci`, `oxlint`, `tsgo`, `deno test` are checks of their kind; a path positional narrows a test, not a lint over `src/`; `cd apps/web && npm test` places the check; `shell: bash -euo pipefail {0}` keeps fail-fast; `continue-on-error` on a reporter or upload action (`dorny/test-reporter`, `upload-artifact`, codecov) is not on the check; `[master]` → `[main]` is a rename when the branch it names exists, whatever a stale `origin/HEAD` says |
| `hook-tampering` | block | the wiring `tamperward init` writes — the two Claude settings gate entries (project, local, user or managed file — `~/.claude` or `$CLAUDE_CONFIG_DIR`, through a symlink, from a `Write` or from the shell) and the pre-commit script — compared to the **exact shape init writes**, not for whether a `tamperward` token is still present: any other key on the entry (`async`, `if`, `args`, `shell`, a short `timeout`), any text around the invocation, another launcher, a narrowed or malformed matcher (read with the runtime's own exact-list / regex semantics — `Edit, Write` and `Edit\|Write` are the same list), a top-level `env` key added or changed in the file that carries the gate (the reason names the mechanism for `PATH`, `NODE_OPTIONS`, `BASH_ENV`, `BASH_FUNC_*`, `LD_*`, `npm_config_*`, …), a version pin lowered, removed or raised past the gate judging the edit, the `disableAllHooks: false` init declares removed or flipped, a hook entry added beside the gate or a value the runtime's schema rejects on any entry; a hand-written hook judged by whether the gate still runs live under the way that hook is executed (husky's `sh -e`, git's direct exec) — shadowed by a function or alias, left in a function nobody calls, behind an exhausted `else`, after an `exec`, a passing `trap` or `set +e`, swallowed by a `\|\|` chain that ends in success, backgrounded, inverted, moved into a heredoc, run after a `cd` away; lefthook / pre-commit / package.json entries by the command they run (`skip`/`only` in any shape, `lefthook-local.yml` as an overlay, `stages` inherited from `default_stages`, `echo husky` is not `husky`); CODEOWNERS over the gate's concrete files with GitHub's glob semantics; `chmod`/`tee`/`sed`/`xargs`/`find -exec`/inline-interpreter writes and `>\|`/`&>` redirections against protected paths — the user and managed settings files included, `~`/`$HOME`/`$CLAUDE_CONFIG_DIR` expanded and symlinks resolved; `.tamperward.yml` weakened |
| `no-verify` | block | `--no-verify`, `git commit -n`, `HUSKY=0`, `HUSKY_SKIP_HOOKS`, `--no-hooks`, `core.hooksPath`, `LEFTHOOK=0`, `LEFTHOOK_EXCLUDE=`, and the pre-commit framework's `SKIP=<hook-id>` in a git or pre-commit invocation |
| `snapshot-rewrite` | warn | runner update mode (`jest -u`, `--updateSnapshot`), regeneration scripts by name, modify/delete of `*.snap`, `__snapshots__/`, `golden/` |
| `snapshot-only-rewrite` | warn | snapshots moved with **no accompanying change**, judged only at commit granularity (pre-commit and CI diffs); ~0.06% FP on audited mainlines, 7/7 TP on observed tampers — the graduation candidate |
| `transient-protected-mutation` | warn | judged at the Stop sweep from the `tamperward watch` event log: a protected file whose recorded content or mode churned during the turn while its net state at Stop is unchanged — modified and restored, so neither the per-call drift check nor the turn diff can see it, while anything that consulted the suite mid-churn consulted a weakened version. `TAMPERWARD_TRANSIENT=block` may raise it and can never lower it |

## Customised wiring needs a sign-off

`hook-tampering` holds the wiring `tamperward init` writes to the shape init writes.
The two Claude settings entries and the pre-commit script are compared byte-for-byte
— modulo a version pin, which may only go up — not for whether a `tamperward` token
is still somewhere in the file. That is deliberate: every bypass this rule has closed
left the token in place and changed what the runtime did with it (`| head -c0` after
the command, `"async": true` beside it, a pin of `0.1.0`, a `PATH=` in front). The
cost is that an honest customisation of init's wiring is reported too — a linter step
added to the init-written pre-commit script, a short `timeout` on the hook entry, a
different launcher, a hook entry of your own added beside the gate in
`.claude/settings.json`, an `env` key in that file — with the evidence *the gate
script no longer matches the shape init wrote; re-run init or sign off*, or the
reason the settings comparison gives. A comma-separated matcher (`Edit, Write`) and a
`statusMessage` on the entry are not customisations: the runtime documents both, and
they pass.

The two honest paths are exactly those. Re-run `tamperward init` to restore the
shape, or sign off once (`tamperward allow hook-tampering --reason "…"`) and keep the
customised wiring: from then on the file is hand-written wiring, and later edits to it
are judged by liveness — the gate must still run, in a position where its failure
fails the hook, under the way that hook is executed (husky runs `sh -e <file>`; git
execs a hook in `core.hooksPath` directly, so there a gate that is not the last
statement needs `set -e`). Hooks merge across the Claude settings files, so a
`settings.local.json` that only adds hooks of its own is not a finding; one that sets
`disableAllHooks`, an `env` the gate resolves through, or a neutered gate entry is. In
the file that carries the gate, though, every hook entry added beside it and every
`env` key added or changed is a sign-off: a sibling's output combines with the gate's
verdict (an `updatedInput` after an allow, a `continue: false` over the sweep's block)
and `env` reaches every hook command, whatever the key is called.

Two more things the wiring holds in place. `init` writes `disableAllHooks: false` into
the project file, because the runtime reads that key from any settings file — the user
file included, which no repository glob names and which a shell write reaches within
seconds — with the project value overriding the user's; removing or flipping the
declaration is a finding, and a file init wrote before 2.9.0 without it stays clean
until the gate is written anew. And the version pin may only go up, and only as far
as the gate judging the edit: a pin npm cannot resolve fails the hook open. The honest
raise is re-running `tamperward init` from the newer version, which raises the
pre-commit script, the workflow and the judging gate together.

## Two findings that are not rules

Two ids can appear in a verdict without being keys under `rules:`. Neither can be
disabled, lowered or excluded by policy, because each reports that the gate could
not do its job — and a gate that cannot evaluate must deny, never pass.

| finding | where | meaning |
| --- | --- | --- |
| `detector-error` | staged, worktree and range views | a detector threw on this change. Repository content that makes a rule crash used to remove that rule from the verdict; now it is a blocking finding naming the rule. |
| `hidden-drift` | the PreToolUse drift check and the Stop sweep | a protected file changed outside git's view — `git update-index --skip-worktree` / `--assume-unchanged`, or a gitignored protected file — and its last sanctioned content could not be reconstructed, so the change cannot be judged. When it can be reconstructed the ordinary rules judge it instead. Restore the file and bring it back into git's view. Also a protected path the gate cannot judge by content at all — a symbolic link (never followed: git records it as its target text, the runner reads what it points at), a FIFO, a socket, a device, a directory where a file is expected, a file above 64 MiB, or a read error — that is new or changed since the session began: blocked by name in the drift check, the Stop sweep and `check --worktree`. Put a regular file there, or remove it. |

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
Untracked and ignored files outside the protected globs are not scanned;
`node_modules` is never walked, and the drift check's walk does not enter a directory
git reports as wholly ignored (a `dist/` of 50k files costs one listing per call, not
a stat per file) — the protected files git lists under it are snapshotted from that
listing, and an ignored directory that also holds a tracked file is walked as before.
Every disk read is git's view of the path: a symbolic link is its target text and is
never followed, a regular file is read up to 64 MiB, and nothing else is content. A
path carrying a control character (a newline in a directory name) is protected in
every category, since no glob can match it and no honest path carries one; it is
shown escaped in the verdict.

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
