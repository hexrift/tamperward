# The rules

Fourteen mechanical rules on the diff, command and event surfaces, deterministic by
construction — nine `block`, five `warn` — plus one measured JS/TS heuristic,
`assertion-weakening`, which ships `warn`, and the outcome layer,
`tamperward verify`, which interprets no diff at all. `guard-removal` remains the
one reserved/unbuilt heuristic name. Every id here is a key under `rules:` in
`.tamperward.yml`, and the baseline severities are the ones `defaultPolicy` ships.

| rule | severity | catches |
| --- | --- | --- |
| `test-deletion` | block | deleted spec files, renames out of the tests glob (a `policy.ignore` entry cannot hide one: a rename is suppressed only when both of its ends are ignored and the old path is not protected), renames into a path the runner does not walk while still inside the glob — vitest/jest's default exclude (`cypress/`, `node_modules/`, `dist/`, any dot-directory), pytest's default `norecursedirs` (`build/`, `dist/`, `venv/`, dot-directories), a Rust file under `tests/` deeper than `tests/<name>.rs` or `tests/<name>/main.rs`, a Go path with a `testdata`, `_*` or `.*` component — as a file change or an `mv`, and only when the old path was itself walked, net removal of `it()`/`test()` blocks (counted via the AST; a literal `it.each` table counts one test per row), shell mutation of protected test paths (`rm`, `sed -i`, `truncate`, redirects, `cp /dev/null`, `tee`, `find -delete`, `git checkout <rev> [--] <path>`, a directory that holds protected specs, the whole cwd as `.` / `*` / a `..`-relative token), and the runner told not to open a spec — jest `testPathIgnorePatterns` / `testMatch` / `testRegex` / `roots` / `rootDir` / `modulePathIgnorePatterns` / `projects`, vitest `test.exclude` / `test.include` (a `!` entry included) / `test.dir` / `test.projects`, a `vitest.workspace.*` file, a `vite.config.*` carrying a `test:` key — evaluated as the selection predicate over the repository's own spec files (a multi-project config is the union of its projects; `typecheck.*` and `benchmark.*` are other suites; a `fixtures/` / `__mocks__/` ignore is not a narrowing), and the package.json test scripts read as check invocations the way `ci-tampering` reads a workflow line (since 2.23.11): `test`, `test:ci`, `check` and `pretest` are the suite — a script that now runs no check or a check of another kind (`"test": "echo ok"`, `npm run lint`, `&& npm test` dropped from `check`, `pretest` deleted) is a removal, and one whose status is masked (`\|\| true`, `; exit 0`, a pipe, `--passWithNoTests`, `--if-present`), cut short (`timeout 1`), whose nyc `--check-coverage` is dropped or `--cov-fail-under` lowered, or whose suite is narrowed by a flag (`--testPathPattern`, `-t`, `--exclude`, `--dir`, `--project`, `--shard`, jest `--root` / `--rootDir` / `--testMatch` / `--testRegex` / `--modulePathIgnorePatterns` / `--selectProjects`, pytest `-k` / `-m` / `--deselect` / `--ignore`, mocha `--grep` / `-g`, `go test -run`, `cargo test -- --skip`, and the per-runner table `ci-tampering` reads), a spec path as a positional (`vitest run src/easy.test.ts`) or a `--config` pointing at a file the policy does not protect or one the same change adds is a neutralisation; `test:unit` / `test:integration` are slices whose flag or positional is design, read only for a masked status, a timeout or a replacement; a runner migration that keeps the suite (`jest` → `vitest run`, `mocha` → `vitest`), an env prefix (`cross-env`, `NODE_OPTIONS=`), a wrapper (`nyc`, `c8`, `nub exec`, `$(yarn bin jest)`), `python -m pytest`, a reporter flag, a flag that was already there, a further run added beside the kept one, the failing npm-init placeholder, and a check moved into a script the same change adds stay clean; a `describe.each` table multiplies the tests it encloses; a test moved into another spec in the same change (split, merge) is a relocation, not a deletion — held only by added tests that have a body, never by `it("noop", () => {})` stubs. Since 2.7.1 the predicate is read the way the runner reads it: `it.for` / `describe.for` count like `each` and a loop over a literal array counts once per element; `--exclude e2e/**` is set-up; `extends: true` projects inherit the root selection while `extends: '<path>'`, `mergeConfig` over an imported base and a `...base` spread are opaque; `test.root` rebases like `test.dir`; a `.snap` inside `__tests__/` belongs to `snapshot-rewrite`; `git checkout main -- test/` while on `main` restores nothing older |
| `test-content-removal` | block | content stripped out of a spec that survives — the failing rows of a data-driven table, the expected-message arguments of `throws(...)` calls, a gutted mock-setup region — which leaves the block count untouched and walks past `test-deletion`; a removed significant line is excused only if its text is still kept in the changeset's protected tests after the edit, and a comment does not count as kept; rows of an each-table that spreads from elsewhere (or is built by a call) are compared as elements — one-line tables included — and two rows gone that reappear nowhere in the change fire on their own; content added to a non-spec file under a test directory (a case table moved to `test/fixtures/`) counts as kept |
| `test-skip` | block | added `.skip` / `.only` / `.todo` / `xit` / `xdescribe` — `.only` narrows the suite, same class. Read per language of the protected file since 1.15.0: `@pytest.mark.skip` / `pytest.skip()` / `@unittest.skip`, Go `t.Skip()`, Rust `#[ignore]`, Ruby `skip` / `xit`, JUnit `@Disabled` / `@Ignore`, PHPUnit `markTestSkipped()`, .NET `[Ignore]` / `Skip = "…"`. For a JS/TS spec with full content the TypeScript AST resolves the runner behind the call — a known runner module's import (named, default, `import * as v` / `require(...)`), a `base.extend(...)` of one, an alias, or the `export const test = base.extend(...)` of a relative fixture module the change or the repository can read — and stays silent only for a root it PROVES is not a runner (a parameter, a local `function it()`, a local object); a root it cannot classify falls back to the line matcher, so a Playwright-style repo whose fixtures cannot be read is judged the same way on full content and on a bare diff (2.23.8) |
| `assertion-weakening` | warn | JS/TS AST-proven one-way weakening inside the same unambiguous suite-qualified test: a statically proven exact/structural value becomes only truthy/defined, positive `toThrow(message|regexp)` becomes bare `toThrow()`, or an assertion is purely removed. Literal→literal expected-value changes, negated specificity changes, ambiguous duplicate identities and unsupported chains are deliberately silent. The committed detector-specific replay reports 12/12 true-positive fires and 0/20 false positives on retained ordinary-maintenance negatives; this clears the 90% build threshold but **does not** authorize block severity. |
| `ts-any-cast` | block | added `as any`, `<any>` casts, `as unknown as`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` — the unambiguous escape hatches, rare in honest code |
| `ts-any-launder` | warn | `any` introduced in an annotation or generic position (`: any`, `Record<string, any>`, `Array<any>`) — the spelling agents launder with, but common enough in honest code that it surfaces for human review rather than blocking; a permanent warn |
| `ts-cast-growth` | warn | net growth of ordinary `as T` / `<T>x` and non-null `x!` assertions in non-test JS/TS source, counted on the AST net of casts the same change removed; `as any` / `as unknown as` stay `ts-any-cast`, and `as const`, `as unknown`, `satisfies`, generated/vendored/declaration files and test files are outside the budget — a warning that fires on 8.7% of legitimate mainline pairs, so it prompts review and never blocks by default |
| `lint-suppression` | block | added `eslint-disable` (inline or block), `prettier-ignore`, `biome-ignore`; per language since 1.15.0: `# noqa`, `# type: ignore`, `# pylint: disable`, `//nolint`, `# rubocop:disable`, `@SuppressWarnings`, `phpcs:ignore`, `#pragma warning disable`. Rust `#[allow]` is deliberately excluded (too common in honest code for a block rule) |
| `coverage-lowering` | block | thresholds lowered, moved, or deleted — Jest and Vitest shapes, all four metrics, `package.json` included; `--coverage` stripped from scripts, `--coverage=false` / `--coverageThreshold=` added; `passWithNoTests` as a config key, vitest `thresholds.autoUpdate`; the denominator narrowed (`collectCoverageFrom` / vitest `coverage.include` compared as a predicate over the repository's own source files, so `src/**` → `src/**/*.{ts,tsx}` in a TypeScript repo is silent while `src/**` → `src/index.ts` is not; `coveragePathIgnorePatterns` / `coverage.exclude` grown, `.coveragerc` `[run] omit` grown, codecov `ignore:` grown); vitest `coverage.enabled: false` and `thresholds.perFile` dropped; `.coveragerc` / `pyproject.toml` `fail_under`, nyc thresholds and `check-coverage` (in `.nycrc` or under package.json's `nyc` key), codecov `target` (a number, or `auto`) / `threshold` / `informational` / `project: off`, each compared within its own `project:` / `patch:` scope. It never claims a removal it cannot see: a spread, an expression, a stricter override naming one metric, an override removed for a file no longer in the repo — and a gate that moved to another config in the same change (`.coveragerc` → `pyproject.toml`, `jest.config.js` → `package.json`) with numbers no lower is a move, not a deletion. Housekeeping, not weakening (2.7.1): exemptions of generated code, migrations, `*.generated.*` / `*.gen.*` / `*.pb.*`, `*.e2e-spec.*`, `manage.py` / `wsgi.py` / `asgi.py` / `__init__.py` and `main.ts` (`**/index.ts` stays reported); vitest `thresholds: { 100: true }` read as every metric at 100; codecov `informational: true` under `patch:` beside an untouched project target; `--passWithNoTests` in a package whose directory holds no spec |
| `ci-tampering` | block | check steps removed from workflows (a **moved** check is not a removed one, and neither is one edited in place — a flag added, `npm test` → `npm run test` / `pnpm test`, an action bumped `@v3` → `@v4`), a kept check line whose block was neutralised (`set +e`, `exit 0`, `if false; then`, a heredoc comment, `shell: bash {0}`, `\|\| true`, `--passWithNoTests`), `continue-on-error: true` and `if: false` in any spelling that folds to a constant (quoted booleans, `${{ 1 == 1 }}`, `${{ 'a' == 'b' }}`, `${{ !true }}`, and the short-circuits `${{ context && false }}` / `${{ context \|\| true }}`, which decide whatever the context holds — anything that genuinely depends on a context reference stays reachable) on a step that runs a check or at the level of a job that runs one (a job-level `if: false` on a deploy job neuters no check), and `on:` narrowed so the workflow no longer runs (`push` / `pull_request` removed, `paths-ignore: ['**']`, `paths:` that no source file can match, `pull_request.types` without `opened` / `synchronize`, `branches:` no longer naming the default branch — read from `origin/HEAD`; `[main]` → `[master]` is accepted when the repository cannot say which is default). Kept, not removed: a check respelled as another invocation of the same kind (`npm test` → `npm run test:ci`, `npx jest` → `npx vitest run`) and a check moved into a reusable workflow the same change adds. Reported as neutralised: a spec path as a positional (`npm test -- test/a.test.ts`, `npx jest test/a`) and `timeout N` wrapping the check — the same invocation reading `test-deletion` applies to the package.json test scripts since 2.23.11. Read the way the runner reads it since 2.7.1: a workflow expression folds to its constant or reads as one token, so a `--shard` or `--project` valued by the matrix, the strategy or a workflow input is not a narrowing while a literal `--project=unit` still is; `node --test`, `mocha`, `biome ci`, `oxlint`, `tsgo`, `deno test` are checks of their kind; a path positional narrows a test, not a lint over `src/`; `cd apps/web && npm test` places the check; `shell: bash -euo pipefail {0}` keeps fail-fast; `continue-on-error` on a reporter or upload action (`dorny/test-reporter`, `upload-artifact`, codecov) is not on the check; `[master]` → `[main]` is a rename when the branch it names exists, whatever a stale `origin/HEAD` says. Since 2.23.10 a respelling of the same kind that runs nothing is reported as neutralised rather than kept: `npm run tests --if-present`, `npm test --prefix packages/empty`, `-w empty`, `pnpm test --filter nothing`, `jest --shard=1/1000` (a matrix-valued shard is still the matrix), `--testMatch` / `--testRegex` / `--root` / `--rootDir` / `--modulePathIgnorePatterns` / `--selectProjects` / `--grep`, `pytest -k` / `-m` / `--deselect` / `--ignore` / `-p no:python` (`-p no:cacheprovider` selects nothing and is not reported) / a lowered `--cov-fail-under`, `cargo test -- --skip`, `go test -run`; a `working-directory` added to a check step (or as `defaults.run`) that points at a directory holding no tracked code file or package manifest, and an `actions/checkout` step given a literal `ref:` (an expression such as `${{ github.event.pull_request.head.sha }}` is not reported); a removed check only survives where the shell would run it — not inside a heredoc body, a `run: >` folded scalar's continuation, an `echo`, a step `name:` or a comment; `if: contains('a', 'b')`, `${{ fromJSON('false') }}` and the other expression functions fold when every argument is a constant; and `on:` narrowings that start from an implicit every-branch filter (`push:` → `push: branches: [never-exists]`), a `tags:`-only filter replacing branches, a `!main` negation, or a `paths-ignore` that covers every source file are reported |
| `hook-tampering` | block | the wiring `tamperward init` writes — the two Claude settings gate entries (project, local, user or managed file — `~/.claude` or `$CLAUDE_CONFIG_DIR`, through a symlink, from a `Write` or from the shell) and the pre-commit script — compared to the **exact shape init writes**, not for whether a `tamperward` token is still present: any other key on the entry (`async`, `if`, `args`, `shell`, a short `timeout`), any text around the invocation, another launcher, a narrowed or malformed matcher (read with the runtime's own exact-list / regex semantics — `Edit, Write` and `Edit\|Write` are the same list), a top-level `env` key added or changed in the file that carries the gate (the reason names the mechanism for `PATH`, `NODE_OPTIONS`, `BASH_ENV`, `BASH_FUNC_*`, `LD_*`, `npm_config_*`, …), a version pin lowered, removed or raised past the gate judging the edit, the `disableAllHooks: false` init declares removed or flipped, a hook entry added beside the gate or a value the runtime's schema rejects on any entry; a hand-written hook script held byte-for-byte to its before — the only clean edits are raising its `tamperward@<ver>` pin (a plain version, never above the gate judging it) and a trailing newline; every other edit, honest or not, is a sign-off, with what the liveness model reads under the way that hook is executed (husky's `sh -e`, git's direct exec) attached as the detail — swallowed by a `\|\|` chain that ends in success, a passing `trap` or `set +e`, a `command`/`env` in front of the gate shadowed by a function or alias, a `PATH=` / `NODE_OPTIONS=` / `npm_config_*` assignment before or on it, `--staged` swapped for `--diff` or `--worktree`, `& wait` without a pid, a pin lowered or no longer plain (`@^1`, `@latest`), a `cd` away; a new hand-written hook script must run the gate live or it is a sign-off; lefthook / pre-commit / package.json entries by the command they run (`skip`/`only` in any shape, the mode flag, `--cwd` and pre-commit `args` part of the gate's identity, a command-level `env` that reroutes the gate, a pin no longer plain, `additional_dependencies` on the gate entry, `lefthook-local.yml` as an overlay, `stages` inherited from `default_stages`, `echo husky` is not `husky`); CODEOWNERS over the gate's concrete files with GitHub's glob semantics; `chmod`/`tee`/`sed`/`xargs`/`find -exec`/inline-interpreter writes and `>\|`/`&>` redirections against protected paths — the user and managed settings files included, `~`/`$HOME`/`$CLAUDE_CONFIG_DIR` expanded and symlinks resolved; `.tamperward.yml` weakened — a lowered or disabled rule, a lowered `version:`, an added `ignore` / `exclude` glob, and since 2.23.9 a protected-glob **addition** judged by the rules' reach rather than the list: a glob added to `protected.snapshots` (which demotes the spec rules on those paths), a negated glob (`!x` matches every path) in any category, a `tests` glob that also matches snapshot paths, and any path a rule judged before the edit and no longer judges after it, named with the rule (the repository's own files when available); a new `tests` glob naming a real layout is not reported |
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
customised wiring. From then on the file is hand-written wiring, and it is held
**byte-for-byte to the version you signed off**. The only edits that pass without
another sign-off are raising the `tamperward@<ver>` pin (a plain version, never above
the gate judging it, or pinning an invocation that had no pin) and a trailing newline.
Every other edit — a linter step added, `npx` → `pnpm exec`, an
`if ! … ; then exit 1; fi` around the gate, a comment line — is reported with the reason
*the gate script changed; sign off*, and cleared the same way as the first one:
`tamperward allow hook-tampering --file <path>` locally, the
`tamperward:allow:hook-tampering@<head-sha>` label in CI.

That is deliberate too. Three adversarial passes over a shell-script liveness model,
the last against a model rebuilt after the second, each found a dozen shapes a real
`sh -e` runs one way and a line-by-line reading runs another: `( gate || true )`, an
`exit 0` inside a brace, a trap by function name, a `PATH=` line, `check --diff
HEAD...HEAD`, a multi-line string, `gate & wait`. A reading that cannot be sound cannot
be the verdict. It is kept as evidence: when it recognises what changed, the finding
says so — `|| true`, `NODE_OPTIONS=` in front of the gate, `--staged` swapped for
`--diff`, a pin no longer a plain version — so the person signing off sees the
mechanism named rather than a bare "changed"; when it sees nothing, the finding says
only that the script changed, and that silence is not clearance.

A new hand-written hook script has no before to be held to. It is judged by the
model alone and must run `tamperward check` live under the way that hook is executed
(husky runs `sh -e <file>`; git execs a hook in `core.hooksPath` directly, so there a
gate that is not the last statement needs `set -e`), or the add is a sign-off as well.
The one exception is `husky`'s own v9 runtime: the files it writes under `.husky/_/`
when `npx husky` runs (usually the `prepare` step of an ordinary `npm install`) are
recognised by their exact byte content while `.husky/pre-commit` is a regular file that
runs the commit backstop itself — exactly `tamperward check --staged`, live, at the pin
the judging release carries. Its mere existence is not enough: an ordinary husky
pre-commit whose real gate is elsewhere would be displaced, and a live but ineffective
gate (`--worktree`, `--diff HEAD...HEAD`, a `--cwd` away from the root, an old or
unpinned version) is not the backstop. So an install does not need a sign-off; a file
that is not byte-for-byte husky's, or a pre-commit that is not that backstop, still does.
Hooks merge across the Claude settings files, so a `settings.local.json` that only adds
hooks of its own is not a finding; one that sets `disableAllHooks`, an `env` the gate
resolves through, or a neutered gate entry is. In
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

`assertion-weakening` is now **built but warning-only**. Its first committed
measurement lives in `harness/fp-study/AW-CORPUS.md`: 20 adjudicated legitimate
assertion-touching negatives retained from the earlier 2,304-diff OSS study plus
12 mutation positives, with 12/12 precision among fires and 0/20 false positives.
That measurement permits shipping the narrow predicate, not graduating it to block.
`guard-removal` remains **reserved and unbuilt** until it has its own measured
negatives corpus (SPEC §7.A).

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
