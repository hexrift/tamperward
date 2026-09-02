# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) as scoped in
[CONTRIBUTING](./CONTRIBUTING.md#versioning).

## [2.10.0] — 2026-09-02

**A hand-written protected hook script is held byte-for-byte to its before.
From the third adversarial pass over the shell-script liveness model, run
against the model rebuilt after the second: thirteen more shapes ran a
failing gate to exit 0 under a real `sh -e` and a real direct exec while the
model read the gate as live. A line-by-line reading of a shell script cannot
be sound, so it is no longer the verdict. A minor: every edit to a hand-written
hook script other than raising its pin — a linter step added, `npx` →
`pnpm exec`, an `if ! gate; then exit 1; fi` around it, a comment line — now
needs a sign-off where 2.7.0 passed it when the gate read as live.**

### Changed

- **A hand-written hook script (`.husky/*`, `.githooks/*`, a `core.hooksPath`
  script, anything `protected.hooks` matches that is a script) is compared
  byte-for-byte to its before.** The only clean edits are raising a plain
  `tamperward@<ver>` pin to a version no higher than the gate judging it (or
  pinning an invocation that had none) and a trailing-newline-only
  difference. Everything else is hook-tampering with the reason *the gate
  script changed; sign off* — `tamperward allow hook-tampering --file <path>`
  locally, the `tamperward:allow:hook-tampering@<head-sha>` label in CI. The
  reason the rule is byte-equal and not a better model: after the model was
  rebuilt for 2.7.0, the next pass found `( gate || true )` and its brace
  form, a multi-line `{ … } || true` and `| tee`, `|| { echo; exit 0; }`,
  `|| exec true` and `{ exit 0; }` before the gate, a trap by function name
  and `trap 'exit $OK'` with `OK=0`, `[ -d . ]` / `true && true` in an `if`
  whose `else` holds the gate, `until [ -d . ]`, `for f in "$@"` and
  `[ $# -eq 0 ] ||` in a hook that has no argv, a multi-line string and a
  `: '…'` block hiding the gate, `|| exit "$rc"` with `rc=0`, `gate & wait`,
  a second heredoc on one line and a `case` glob against a constant word —
  each read live, each exit 0 with a failing gate. Those are not fixed as a
  model; the rule covers them.
- **The liveness model stays as evidence, not as the verdict.** When the
  fail-closed rule fires the model still runs, and when it names a mechanism
  the finding carries it, so the human signing off sees `|| true`, a passing
  trap, `NODE_OPTIONS=` in front of the gate or a `--diff` swap named rather
  than a bare "changed". Its reading is right more often: the wrapper words
  in front of the command (`command`, `env`, `exec`) are tested against the
  script's own functions and aliases, so `command() { :; }` then
  `command npx …` is shadowing; an assignment or prefix of `PATH`,
  `NODE_OPTIONS`, `NODE_PATH`, `HOME`, `LD_PRELOAD`, `BASH_ENV` or
  `npm_config_*` before or on the gate is "runtime redirected"; the mode flag
  is part of the gate's identity like `--cwd`, so `check --staged` →
  `check --diff HEAD...HEAD` or `--worktree` is a replacement, and
  `--cwd "$(git rev-parse --show-toplevel)"` is the root; a single `&` is an
  operator, `& wait` without a pid is neutered and `& wait $!` (on the line
  or the next) is the gate's status; a pin that is no longer a plain version
  after a plain-pinned before — `@^1`, `@latest`, a range, a pre-release — is
  a lowering.
- **A new hand-written hook script must run the gate live.** There is no
  before to hold it to, so the model alone judges it: `tamperward check`
  neutered, unreachable, commented out, behind a `PATH=` line or absent is a
  sign-off; a deleted protected script stays the removal finding it was.
- **lefthook and pre-commit entries carry the same identity.** `run: … --diff
  HEAD...HEAD`, `entry: … --diff`, `args: [--cwd, /tmp]` and
  `args: [--diff, …]` are replacements of the gate; a command-level `env`
  setting `PATH`, `NODE_OPTIONS`, `NODE_PATH`, `HOME`, `LD_PRELOAD`,
  `BASH_ENV` or `npm_config_*` gained or changed is a runtime redirect; a pin
  no longer plain (`@^1`) after a plain-pinned before is a lowering;
  pre-commit `additional_dependencies` gained or changed on the gate entry
  chooses which gate the hook installs. These stay judged by the command
  comparator, not the byte-equal rule.
- `TAMPERWARD_OOB_SIGNOFF` accepts a token in the label's own spelling
  (`tamperward:allow:<rule>@<sha>`) as well as the stripped one the shipped
  workflow sets.
- SPEC §9.1 records round 4 of the replication study as pinned to this
  release, with the three-claim treatment boundary it is graded against.

### Fixed

- **The init-written pre-commit script with a second trailing newline** was
  reported as no longer matching the shape init wrote. Trailing newlines are
  not shape: none, one or two read as the same script.

### Sign-off

Hand-written hook wiring needs a sign-off on every edit that is not a pin
raise (docs/guide/rules.md, "Customised wiring needs a sign-off"), cleared
the same way as the first customisation: `tamperward allow hook-tampering
--file <path>` locally, the `tamperward:allow:hook-tampering@<head-sha>`
label in CI.

## [2.9.0] — 2026-09-02

**The Claude settings files are judged with the runtime's live semantics, on
the shell surface as well as the file surface. From the runtime-semantics pass
over 2.7.0's canonical-shape comparator, checked against the Claude Code
documentation: settings files are watched and reloaded in-session,
`disableAllHooks` applies from any file with the project overriding the user,
`env` reaches every session and subprocess, the hook shell is bash, a sibling
hook's output combines with the gate's. A minor: a hook entry added beside the
gate, an `env` key of any name in the file that carries it, a pin raised past
the gate judging the edit, and any shell write to a settings file outside the
repository now need a one-time sign-off where they used to pass — and `init`
now declares `disableAllHooks: false` in the project file. Two 2.7.0 false
positives are corrected: a comma-separated matcher is the honest list the
runtime documents, and `statusMessage` is cosmetic.**

### Changed

- **A Bash write to any Claude settings file is hook-tampering.** The
  shell-target model judged write targets against the repository's
  `protected.hooks` globs only, so `echo '{"disableAllHooks":true}' >
  ~/.claude/settings.json` — the user file, which the runtime reloads within
  seconds, no repository glob names, and neither the Stop sweep nor `check
  --staged` can see — was allowed through Bash while the same Write was denied;
  so were `$HOME/…`, the absolute path, `python3 -c`, `node -e`, `sed -i`,
  `tee`, `cp`/`mv`/`ln` destinations, `rm`, and `cat >
  /etc/claude-code/managed-settings.json`. A write target is now expanded as
  the shell would (`~`, `$HOME`/`${HOME}`, `%USERPROFILE%`,
  `$CLAUDE_CONFIG_DIR` — its value from the hook's own environment, else
  `~/.claude` — backslashes as separators), every symlink in it resolved
  against the repository root, and judged as a hook write whenever it is
  settings-shaped wherever it lives: `~/.claude/settings.json`,
  `managed-settings.json` at any path, a `.claude/settings*.json` at any depth,
  and a directory holding the user file (`rm -rf ~/.claude`). A symlinked
  alias (`ln -s . /tmp/xlink; rm /tmp/xlink/.claude/settings.json`, `ln -s
  ~/.claude /tmp/cfg`) resolves to the file it writes on both surfaces, the
  `Write` tool included. The finding names the expanded file, so the guarded
  pin applies and a policy that lowered the rule cannot let it through. On the
  tool-call surface `isClaudeSettings` accepts the `$CLAUDE_CONFIG_DIR`
  relocation and backslash paths.
- **`init` declares `disableAllHooks: false` in the project settings file**,
  and the canonical shape holds it there: the runtime honours the key from any
  file with the project overriding the user, so a `true` planted in the user
  file no longer reaches the gate. Removing or flipping the declaration is
  hook-tampering; a fresh gate-carrying file is held to the whole shape; a
  file init wrote before 2.9.0 has no declaration and stays clean until an
  edit writes the gate into it anew. Re-running `init` adds the declaration to
  an already-wired file, and sets a `true` back to `false`.
- **`env` inverted: any key added to or changed in the top-level `env` of a
  file that carries the gate is hook-tampering; a key removed never is.** The
  allowlist (`PATH`, `NODE_OPTIONS`, `NODE_PATH`, `HOME`, `npm_config_*`)
  missed the shell and the loader: `BASH_ENV` is sourced by every
  non-interactive bash before the hook command runs, `BASH_FUNC_npx%%`
  redefines `npx` as a function, `LD_PRELOAD` reaches node whatever the
  shell, and npm reads `npm_config_*` case-insensitively so
  `NPM_config_registry` walked past the regex. The well-known names —
  extended with `BASH_ENV`, `ENV`, `BASH_FUNC_*`, `LD_*`, `DYLD_*`,
  `TAMPERWARD_*`, and `npm_config_*` in any case — stay a finding in any
  settings file, and the reason names the mechanism when it is a known one.
- **The pin may only go up, and only as far as the gate judging the edit.**
  `npx --yes tamperward@99.0.0 hook claude` is a pin npm cannot resolve: the
  hook exits non-zero with no decision, which the runtime treats as
  non-blocking, and every tool call proceeds — "a higher pin is clean" was a
  test. A fresh entry pinned above the judging version is hook-tampering, and
  the reason says the honest raise is `tamperward init` run from the newer
  version, which raises the judging gate with it. A fresh entry with no pin is
  below any floor (`npx` then runs whatever `node_modules/.bin/tamperward` is)
  — the `c.pin &&` guard that skipped it is gone — while a file whose gate was
  unpinned before (as init wrote before 1.14.7) still sets no floor. A pin
  with leading zeros (`02.5.0`) is not a plain version. Raising the pin to any
  published version at or below the judging gate stays clean.
- **Every hook entry an edit writes into a gate-carrying file is validated,
  not only the gate's own.** A value the runtime's schema rejects on any
  entry under any event — a `type` it does not accept, a non-numeric
  `timeout`, a non-string matcher — is "broken settings" the runtime continues
  without, the gate entries in that file included; it is hook-tampering.
- **A hook entry added beside the gate under PreToolUse or Stop is a
  sign-off.** The forgery check was textual, and `args`, an `http` entry and a
  script file carried the same decision past it. A forged decision in the
  command text is still named as such (the fast path); a shape that is not a
  plain command entry (`args`, `http`, `prompt`, `agent`, `async`, `if`) is
  named; and a plain command is a finding too, because its output combines
  with the gate's verdict — an `updatedInput` rewrites the tool input after
  the gate allowed it, the last hook winning; a `continue: false` takes
  precedence over the sweep's block — and a script body carries what a regex
  cannot see. An entry that was there before, as written, is not the edit's
  doing; entries under other events are not judged this way.

### Fixed

- **A comma-separated matcher is the honest list, not a pattern that selects
  nothing.** The runtime's matcher table reads a string of letters, digits,
  `_`, `-`, spaces, `,` and `|` as an exact list separated by `|` or `,` with
  optional surrounding whitespace — `Edit, Write` and `Edit|Write` each match
  either tool. 2.7.0 read the comma as a regex and denied `Bash, Edit, Write,
  MultiEdit, NotebookEdit` at every layer as "no longer covers Bash, Edit, …";
  the 2.7.0 entry's claim that the comma fails closed described that false
  positive. The comparator and `init`'s matcher repair both split on `|` and
  `,` now.
- **`statusMessage` on the gate entry is the documented spinner text**, a
  cosmetic string, and passes; 2.7.0 reported it as a key init does not write
  and the entry as removed.

## [2.8.0] — 2026-09-02

**Every read of a repository path is git's view of it: a regular file is its
bytes up to 64 MiB, a symbolic link is its target text and is never followed,
and nothing else is content. From the adversarial pass over 2.7.0's
ignored-adds and effect layer. A minor: a protected path that stands as a
symbolic link, a FIFO, a socket, a device, a directory, or a file above the
cap is now blocked by name as `hidden-drift` where it used to be read through
or not seen at all, so a new or changed one needs a sign-off where it used to
pass; and a path carrying a control character is protected in every category
where it used to match no glob.**

### Changed

- **A protected path the gate cannot judge by content is blocked by name.**
  The untracked and ignored adds, the worktree diff's enrichment, the drift
  check's hash and the hidden-tracked probe all read a repository path
  through one reader now (`src/disk.ts`): a regular file is read through a
  descriptor opened `O_NOFOLLOW` and checked after opening, up to 64 MiB and
  not a byte past it; a symbolic link is read with `readlink` as the blob git
  records for it. What is neither — a link, a FIFO, a socket, a device, a
  directory where a file is expected, a larger file, a read error — is
  reported as `hidden-drift` by name in the PreToolUse drift check, the Stop
  sweep and `check --worktree`, the stance the effect layer already took on a
  file it could not read. The snapshot walk lstat's, so a link is a leaf
  whatever it points at and a FIFO at a protected path is recorded and its
  appearance is drift. A link that already stood there when the session began
  is sanctioned like any other pre-existing file and is not re-litigated. The
  Edit reconstruction still resolves a link by name (a settings file may
  honestly be one) and reads the end of the chain under the same guards.
- **A control character in a path is protected in every category.** picomatch
  compiles `**` to a pattern that stops at a newline, so `n\nl/conftest.py`
  matched no protected glob and was dropped by the snapshot walk, the
  untracked and ignored keep filters, the hidden-tracked probe and the
  envelope's working-tree check: a `collect_ignore` conftest passed PreToolUse
  and Stop from a directory named with one newline. A path carrying
  U+0000–U+001F or U+007F is now protected whatever category is asked, before
  any glob is consulted; the denial and the text report show it escaped and
  the finding keeps the real path.
- **The drift check's walk prunes directories git reports as wholly ignored.**
  It walked every directory that was not one of four names, so a 50k-file
  ignored `dist/` was stat'ed file by file on every PreToolUse and Stop —
  about 1.2 s per hook call. The walk now skips the directories git collapses
  in its `--directory` listing of ignored paths (the pass the ignored-adds
  view already runs) and snapshots the protected files git lists under them
  from that listing, so they stay sanctioned and excused as before. Only
  git's word prunes: an ignored directory that also holds a tracked file is
  walked, and outside a repository nothing is skipped. The protected globs
  compile to one expression per list rather than one matcher per glob, which
  is what made the listing cheaper than the walk it replaced.

### Fixed

- **A symbolic link at a protected path to a device that never reaches EOF
  hung the gate.** `ln -s /dev/zero test/conftest.py` held the Stop sweep
  indefinitely, as did the same link excluded through `.git/info/exclude`,
  and a tracked spec replaced by such a link held the very next PreToolUse;
  a link to a FIFO with no writer did the same at the open. Each now returns
  a block in well under a second.

### Sign-off

A symbolic link, a FIFO or a file above 64 MiB newly placed at a protected path
needs a sign-off (`tamperward allow hidden-drift --file <path>`), or a regular
file put in its place. One that existed before the session began is not
re-litigated.

## [2.7.1] — 2026-09-02

**The predicates read the way the runner reads them. A patch: twelve false
positives and one incidental, every one a maintainer's routine edit that 2.7.0
blocked, found by the pass-3d sweep of 77 honest edits against the built CLI.
Nothing fires that did not fire before; the tamper beside each honest edit
still does.**

### Fixed

- **ci-tampering.** A `${{ }}` expression is folded to its constant or read as
  one token, so `--shard=${{ matrix.shard }}/4`, `--shard ${{ matrix.shard
  }}/${{ strategy.job-total }}` and Playwright's `--project=${{ matrix.project
  }}` are the matrix, not a narrowed suite (a literal `--project=unit` and a
  `-t ${{ github.sha }}` still are). `node --test`, `mocha`, `ava`, `biome ci`,
  `oxlint`, `tsgo`, `deno test`, `ruff check` and `mypy` are checks of their
  kind, so `npm run lint` → `npx biome ci .` and `npm test` → `node --test` are
  respellings rather than removals. A path positional narrows a test, not a
  lint: `npx eslint "src/**/*.{ts,tsx}"` and `npx eslint src/ test/` are no
  longer "neutralised". `cd apps/web && npm test` places the check; its
  directory is not a positional. `shell: bash -euo pipefail {0}` — any `{0}`
  shell that keeps `-e` or `-o errexit` — is fail-fast and is not reported.
  `continue-on-error: true` on a reporter or upload action
  (`dorny/test-reporter`, `publish-unit-test-result-action`,
  `upload-artifact`, codecov, coveralls) is not on the check. `branches:
  [master]` → `[main]` is a rename when the repository has a `main` branch,
  locally or on a remote, even while a stale `origin/HEAD` still points at
  `master`; a branch the repository does not have is still a narrowing.
- **test-deletion.** vitest 3's `it.for` / `test.for` / `describe.for` count
  like `each`; a `describe.each` table rewritten as `for (const n of [1, 2,
  3])` or `[1, 2, 3].forEach` counts once per element (a loop over anything
  else is open, never claimed; a loop over fewer literal rows still fires).
  `test.projects` entries with `extends: true` inherit the root's selection —
  in either order; `extends: '<path>'`, `mergeConfig(shared, …)` over an
  imported base and a `...base` spread are opaque, because vite concatenates
  the arrays with a base this file cannot see; `test.root` rebases a
  project's globs like `test.dir`; and the evidence for a vitest default
  include says `test.include (default)`, not `testRegex`. Only `scripts.test`
  and `test:ci` are the suite a flag can narrow: `test:unit --project unit`,
  `test:watch --changed` and `test:staged --findRelatedTests` beside an
  untouched `test` are slices by design, and `test: vitest run --exclude
  e2e/**` excludes another runner's directory exactly as `test.exclude`
  would. A `.snap` inside `__tests__/` — jest's default layout — is
  snapshot-rewrite's file, not a deleted test, on the file surface and for
  `rm -rf src/__tests__/__snapshots__` alike. `git checkout main -- test/`
  while on `main` (any rev that resolves to HEAD) restores nothing older;
  `HEAD~1` still does.
- **coverage-lowering.** Exempting generated code, codegen output,
  migrations, `*.generated.*` / `*.gen.*` / `*.pb.*`, Nest's `*.e2e-spec.ts`,
  Django's `manage.py` / `wsgi.py` / `asgi.py`, `__init__.py` and the
  `main.ts` entrypoint is housekeeping in `coverage.exclude`,
  `coveragePathIgnorePatterns`, `collectCoverageFrom` and `.coveragerc`
  `omit` alike; `**/index.ts` stays reported. vitest's `thresholds: { 100:
  true }` is every metric at 100, not four thresholds removed. codecov
  `informational: true` is reported under `project:` (and at the top), not
  under `patch:` or `changes:` beside an untouched project target. A
  `--passWithNoTests` (or `passWithNoTests: true`) in a package whose
  directory holds no spec — a brand-new workspace package — is not a dodge;
  the root of a repository with a suite, a package that has one, and a
  change judged without a repository listing are reported as before.
- **test-content-removal.** Content this change adds to a non-spec file under
  a test directory (`test/fixtures/add-cases.ts` receiving the rows of an
  `it.each` table) is kept, not removed; `test.for` tables are read like
  `it.each`.


## [2.7.0] — 2026-09-02

**The wiring `init` writes is judged by its canonical shape, not by whether a
`tamperward` token is still present. From the adversarial pass over 2.4.1's
comparators. A minor: honestly customised wiring — a linter step added to
the init-written pre-commit script, a matcher spelled another way — now needs
a one-time sign-off where it used to pass.**

### Changed

- **Claude settings compared to the exact entry init writes.** The
  comparator used to ask whether `tamperward hook claude` appeared somewhere
  in the command; `>/dev/null` appended, the two subcommands swapped between
  PreToolUse and Stop, a pin downgraded to 1.0.0, `npx -p /tmp/evil`, a
  `PATH=` or `NODE_OPTIONS=` prefix, and every entry key the runtime honours
  (`timeout: 1`, `async`, an `if` that never matches, `args`, `shell`) passed
  every layer. The gate entry must now be exactly `npx --yes tamperward@<ver>
  hook claude` under PreToolUse and `sweep claude` under Stop, `<ver>` a plain
  version never below the one it replaces, on a matcher read with the
  runtime's own semantics (an exact `|` list, otherwise an unanchored regex; a
  comma is not a separator and fails closed, as do a non-string, invalid or
  non-ASCII matcher). Any other key on the entry, any text around the
  invocation, a top-level `env` touching `PATH`/`NODE_OPTIONS`/`NODE_PATH`/
  `HOME`/`npm_config_*`, a non-boolean truthy `disableAllHooks`, a duplicated
  JSON key, or a sibling entry emitting its own hook decision is
  hook-tampering. The user file and managed settings are judged by path shape
  at the tool-call layer, outside the repository or not. Hooks merge across
  the settings files, so the "sibling shadow" finding for an added local file
  that declares other hooks is gone — it was a false positive.
- **The pre-commit script init wrote must stay byte-equal to what init
  writes**, modulo an upward pin. A hand-written hook is judged by whether the
  gate still runs live under the way that hook is executed (husky's `sh -e`,
  git's direct exec): function or alias shadowing of a word of the invocation,
  a function nobody calls, an `else` after an always-true branch, an empty
  `for` or never-true `while`, `exec`, a passing `trap`, `set +e`, the `||`
  chain evaluated in order (`|| false || true`, `|| true; exit $?`,
  `|| kill -0 $$`, `|| exit $status` with status=0), a trailing `&`, a `!`
  prefix, heredoc bodies as data, `pipefail` only from a real `set -o
  pipefail`, a lowered pin, `--cwd` as identity, a `cd` away from the root, a
  non-shell shebang, and a gate that is not the last statement without
  `set -e` on a directly-exec'ed hook. Thirty of these were verified against a
  real shell before the model was rebuilt.
- **lefthook, pre-commit and package.json compared by the command they run**,
  not the word: `run: npx tamperward --version` and `entry: 'true'` under
  `id: tamperward` are removals; `skip`/`only` in any non-false shape at
  command and section level, `tags` against `exclude_tags`,
  `lefthook-local.yml` as the overlay it is (now in the hooks baseline),
  `stages` inherited from `default_stages ?? all`, `types`/`exclude_types`
  without `always_run`, and `prepare: echo husky` / `HUSKY=0 husky` /
  `husky uninstall` as the removals they are.
- **CODEOWNERS evaluated over the concrete gate files** with GitHub's glob
  semantics, so a later ownerless `/.husky/pre-commit`, `*.yml` or
  `**/pre-commit` un-owning the gate is reported.
- **Command surface:** absolute paths under the repository relativised;
  `>|`/`>&`/`&>` kept with their redirection; `install -t`, `cp -t`, `rsync`,
  `git checkout <rev> -- .`, `git restore --source=<rev> .`, `git apply` /
  `patch` / `git am`, inline `python -c` / `node -e` / `perl -e` / `ruby -i` /
  `ex` / `ed` scripts naming a hook, `xargs rm|chmod`, `find -exec chmod -x` /
  `-delete`, multi-group symbolic chmod (`u+rw-x`), `setfacl`. Every
  command-surface finding carries the repo-relative target, so the engine pin
  applies to it.

### Fixed

- **The docs site failed to build after 2.6.0.** The rules guide's
  ci-tampering row carried `${{ <ctx> || true }}` inside a table cell: the
  unescaped `||` split the cell and the angle-bracket placeholder was then read
  as a tag, so the page broke the Vue template compile. The pipes are escaped
  and the placeholder is spelled `context`. The site now builds in the PR
  workflow's `build` job as well, so a broken page cannot merge.

### Sign-off

Customised wiring needs a sign-off once (docs/guide/rules.md, "Customised
wiring needs a sign-off"): a linter step added before the gate in the
init-written script, `npx` → `pnpm exec` in that script, a matcher spelled as
a regex. A hand-written script that was never init's is judged by liveness
alone and stays clean when the gate is live.

## [2.6.0] — 2026-09-02

**Every dial of the selection predicate is modelled, the CI expression folder
short-circuits the way GitHub does, and the coverage denominator is compared
as a predicate. From the adversarial pass over 2.5.0. A minor: these rules
now fire on config keys they previously passed.**

### Added

- **test-deletion reads the rest of the runner's selection.** jest `roots`,
  `rootDir`, `modulePathIgnorePatterns` and `projects`; vitest `test.dir`,
  a `!` negation inside `include`, `test.projects` and `vitest.workspace.*`
  (evaluated as the union of project predicates; a project named by path
  makes the config opaque and silent); `vite.config.*` carrying a `test:`
  key is a vitest config; `typecheck.*`, `benchmark.*` and `coverage.*`
  under `test` no longer collide with `test.include`. Runner flags added to
  a `package.json` test script (`--testPathPattern`, `-t`, `--exclude`,
  `--dir`, `--project`) are narrowing. `git checkout <rev> <path>` without
  `--`, `git checkout <rev> -- .`, and `rm -rf .` / `*` / a `..`-containing
  token from the repo root are erasures. `describe.each` rows multiply the
  enclosed tests; rows dropped from a table that stays open are counted;
  only an added block with a significant body counts toward relocation, so
  a stub `it("noop", () => {})` no longer excuses a deletion.
- **coverage-lowering reads vitest's denominator and switches:**
  `coverage.include` narrowed, `coverage.enabled` off, `thresholds.perFile`
  removed; `.coveragerc [run] omit`, codecov `target: auto` / `project: off`
  / `ignore:`, and nyc thresholds inside `package.json`. The patch-threshold
  evidence reports the numbers it saw.
- **ci-tampering folds `&&` and `||` the way GitHub does**: `<ctx> && false`
  is always false and `<ctx> || true` always truthy, so
  `if: ${{ github.event_name == 'push' && false }}` and
  `continue-on-error: ${{ <ctx> || true }}` are reported; anything whose value
  depends on the unknown side stays reachable. `on.<event>.paths:` that cannot
  match source and `pull_request.types:` replacing the defaults are trigger
  narrowing; a path-shaped positional after `--` (`npm test -- test/a.test.ts`)
  is narrowing; `timeout 1 npm test` reports as neutralised.

### Fixed

- **Routine work that blocked:** a check moved into a reusable workflow added
  in the same change; a job-level `if: false` on a job with no check step;
  `npm test` → `npm run test:ci` or `npx vitest run` (a respelling, not a
  removal); `.coveragerc` → `pyproject.toml` carrying the same `fail_under`;
  `collectCoverageFrom` `src/**` → `src/**/*.{ts,tsx}` (compared over tracked
  source, not entry by entry); a jest ignore of a `fixtures/` directory;
  vitest `typecheck.exclude` read as a test exclude; `branches: [main]` →
  `[master]` when the default branch is unknown.

## [2.5.1] — 2026-09-02

**A protected file created where git will not list it is judged, never
absorbed. A patch: a bypass fix at the same severity, found by the adversarial
pass over 2.4.0's untracked sweep.**

### Fixed

- **An ignored new protected file was judged by nobody.** One line in the
  agent-writable `.git/info/exclude` (or a `.gitignore` edit) made a
  `conftest.py` created during the turn invisible: the untracked view drops
  ignored files, the hidden-tracked probe lists tracked files only, and the
  effect layer saw the file but treated an addition as something to absorb
  into the sanctioned tree. The turn ended green. The same applies to the
  gitignored `.claude/settings.local.json` Claude Code itself excludes. Now:
  the effect layer reports additions, any protected addition the turn view
  does not carry is reconstructed as the add it is and run through the
  detectors, and the git views (`turnView`, the envelope, `check --worktree`
  with untracked) list ignored files under the protected globs as adds — in
  two passes, with wholly-ignored trees collapsed and `node_modules` never
  walked, so a 100k-file package tree costs three milliseconds.
- **A forged turn tree could excuse a new file.** The turn-start snapshot is
  `.git` state; it now excuses an untracked or ignored file only when the
  per-call tree sanctions the same hash, the turn-start exemption is limited
  to a predicted edit that never landed, a turn tree that outlives its ptree
  is dropped, and tree saves are atomic. The residual — an agent that
  rewrites both trees consistently — stays documented; CI is the authority.
- **Command-surface hook-tampering findings carried no file**, so the engine
  pin that keeps findings on the gate's own wiring out of the policy's reach
  did not apply to them: with a policy that had lowered the rule to warn,
  `rm .claude/settings.json` through Bash was allowed at the hook. They now
  carry the repo-relative target and are pinned like the file-surface ones.

## [2.5.0] — 2026-09-02

**The config-narrowing class: a runner told not to open a spec, a coverage
denominator quietly shrunk, a workflow that keeps its check line and never
runs it. Closed across test-deletion, coverage-lowering and ci-tampering,
with the two most routine maintainer edits — splitting a spec and touching a
CI check line — no longer blocking. A minor: these rules now fire on config
shapes they previously passed.**

### Added

- **test-deletion reads runner selection.** jest `testPathIgnorePatterns`,
  `testMatch`, `testRegex` and vitest `test.exclude` / `test.include` are
  evaluated as the selection predicate over the repository's own spec files:
  a spec that was collected before the edit and is not collected after it is
  a deletion, with the count. A glob respelled to select the same files, or
  an ignore that matches nothing in the tree, is silent. Shell spellings that
  erase a spec join the command surface: `cp /dev/null`, `sed --in-place`,
  `tee`, `find -delete` / `-exec rm`, `truncate`, `perl -pi`, `git checkout
  <rev> --`, and a directory token that holds a protected spec (`rm -rf test`;
  `dist/__tests__` is silent).
- **coverage-lowering reads the denominator and the switches.**
  `collectCoverageFrom` entries dropped or source exempted,
  `coveragePathIgnorePatterns` / `coverage.exclude` grown, `--coverage=false`
  and `--coverageThreshold=` in a script, vitest `thresholds.autoUpdate`,
  and `passWithNoTests` as a config key. Python `.coveragerc` /
  `pyproject.toml` `fail_under`, nyc thresholds and `check-coverage`, and
  codecov `target` / `threshold` / `informational` join the protected config
  baseline and are compared.
- **ci-tampering reads the block, the expression and the trigger.** A kept
  check line preceded by `set +e`, `exit 0`, `if false; then`, a heredoc
  comment or `shell: bash {0}`, or followed by `|| true` or
  `--passWithNoTests`, is neutralised in place. `continue-on-error` and
  `if:` are constant-folded (quoted booleans, `${{ 1 == 1 }}`, `${{ 'a' ==
  'b' }}`, `${{ !true }}`); anything with a context reference stays
  reachable. `on:` narrowed so the workflow no longer runs — `push` /
  `pull_request` removed, `paths-ignore: ['**']`, `branches:` no longer
  naming main — is reported.

### Fixed

- **Splitting or merging a spec blocked as a deletion.** Added lines of every
  added AND modified protected spec in the change are the relocation set, so
  a split (modify + add), a merge (delete + modify) and two `it`s folded into
  one `it.each` are relocations; a literal `it.each` table counts one test per
  row; the Java anchor accepts `@Timeout(5) @Test` on one line.
- **Editing a check line in place blocked as a removal.** A flag added, `npm
  test` → `npm run test` / `npm t` / `pnpm test`, `npx` → `pnpm exec` /
  `yarn` / `bunx`, quoting, and an action bumped `@v3` → `@v4` (Dependabot's
  daily move) are kept; `continue-on-error` / `if:` on an unrelated step no
  longer fire.
- **Three table rows removed plus one line lengthened** slipped under
  test-content-removal's net threshold; rows inside a literal `each` table
  are counted on their own.
- **Removing `console.log` lines from a spec** no longer counts as content
  removal; a stricter one-metric coverage override, an override removed for a
  file no longer in the repo, and a `{ ...base }` spread refactor no longer
  report metrics as removed.

## [2.4.1] — 2026-09-02

**The enforcement wiring is read for what it does, not for the words in it.
Six bypasses of `hook-tampering` closed and three false positives fixed. A
patch: bypass fixes at the same severity, and the guard on the gate's own
wiring is pinned where the policy under judgment could previously switch it
off.**

### Fixed

- **Claude Code settings were scanned as a shell script.** Narrowing the
  PreToolUse matcher from `Bash|Edit|Write|MultiEdit|NotebookEdit` to `Bash`
  removed no invocation and added no `exit 0`, so nothing fired and the
  file-edit tools were ungated. Setting the hook command to `true` while
  adding a junk field that quoted the invocation excused the removal, because
  survival was judged on any added line containing the token. A new
  `settings.local.json` that declared empty hook arrays, shadowing the
  wiring, was an add with nothing removed. `.claude/settings.json` and
  `settings.local.json` are now parsed on both sides and compared as
  (matcher tool set, command) pairs: an entry removed, a tool lost from the
  matcher, an event emptied, `disableAllHooks`, a parseable-before file made
  unparseable, and an add or modify that shadows the sibling's gate are all
  hook-tampering; survival is judged only on parsed command-type hooks.
- **Shell hook scripts were scanned for words too.** `|| true` after the
  invocation, `exit 0  # comment`, `exit 0;`, bare `exit`, `[ -n "$X" ] ||
  exit 0`, `if false; then` ahead of it, `npx tamperward --version` in its
  place, and `echo "npx tamperward …"` all read as a kept check. Scripts are
  reduced to their live check identities (runner, pin, redirects stripped;
  argument position and `--version` are not invocations) with a liveness
  state — live, neutered, unreachable, comment — and only a live survivor
  with the same identity excuses a removal.
- **A fresh `.tamperward.yml` was never compared to the baseline.** Adding a
  policy with `ignore: ['**']` or a lowered severity reported nothing because
  the comparison needed a `before`; an added policy is now judged against the
  effective baseline exactly like an edit.
- **The policy under judgment could silence the judgment.** At the local
  layers, `rules: { hook-tampering: { enabled: false } }` (or `severity:
  warn`) in the head policy switched off the findings about that very edit.
  Hook-tampering findings on the policy file and on the baseline hooks class
  can no longer be disabled, excluded or lowered by policy.
- **`git update-index --skip-worktree` was not a command anyone modelled.**
  It, `--assume-unchanged` and `--chmod=-x` on a protected path are
  hook-tampering, through `git -C`, `git -c`, an absolute `git` and `cd x &&`.
  Also `chmod 0`, `chmod 00644`, `chmod --reference=`, `perl -pi`, `awk -i
  inplace`, `sponge`, `ln -sf`, `git checkout <rev> -- <hook>` and
  `git restore --source` against a hook.
- **lefthook, pre-commit and package.json wiring:** an entry removed,
  `skip: true`, a narrowing `glob`/`exclude`/`only`, `stages` without a commit
  or push stage, a top-level `exclude`, and `prepare: husky` (or its
  lefthook/simple-git-hooks/pre-commit equivalent) dropped from every
  install-phase script are hook-tampering.
- **False positives:** `chmod +x`/`u+x` on a hook no longer fires (only a lost
  execute bit does); `cat hook > /tmp/backup`, `cp hook /tmp/`, `sed -n` and
  other read-only uses no longer fire (only a write whose target is the hook
  does); removing a CODEOWNERS line is judged by last-match-wins ownership of
  gate-critical paths rather than as "a check invocation (`husky`) removed";
  `lefthook.yml → .yaml` and `npx → pnpm exec` (or `yarn`, `bunx`) of the same
  command are kept.

## [2.4.0] — 2026-09-02

**The Stop sweep scans untracked protected files, the per-call drift check
fails closed on a change git cannot see, and the pytest collection knobs are
test-skip spellings. A minor: `hidden-drift` is a new, non-configurable
finding on the hook path, and an agent-created protected file is now judged
at Stop where it was invisible before.**

### Fixed

- **The Stop sweep ignored untracked files.** It fed the detectors from
  `git diff`, so a new protected file the turn created — a shadowing
  `vitest.config.ts`, a `.claude/settings.local.json`, a `conftest.py` carrying
  `collect_ignore` — was invisible to it (the `run` envelope already scanned
  them). The sweep and the per-call drift check now share one turn view:
  tracked changes since the turn baseline, plus every untracked file under a
  protected glob that the turn created (a turn-start snapshot of the protected
  tree, advanced only on a clean Stop, tells a new file from one that was
  there before), plus the hidden tracked files below. An untracked file
  outside the protected globs is not scanned, and a new test with ordinary
  content is not a finding.
- **A protected change git could not see was absorbed as the new baseline.**
  After `git update-index --skip-worktree test/a.test.ts` (or
  `--assume-unchanged`), git omits the file from every diff; the drift check
  saw the hash move, asked git for the change, got nothing, evaluated nothing,
  and saved the tampered tree as sanctioned. The Stop sweep then had nothing
  to compare. Hidden tracked files are now diffed by hand — the trusted blob at
  the base against the disk — and judged by the ordinary rules; any remaining
  drift is reconstructed from a blob whose hash equals the sanctioned one, a
  restore to the base or turn-start content is accepted, and anything else is
  a blocking `hidden-drift` finding that no policy can lower or disable. A
  block never advances the baseline.
- **A new file reached the hunk-based rules as an empty edit.** The untracked
  view carried full content but no hunks, so test-skip and the added-line half
  of hook-tampering read a brand-new file as nothing; hunks for an add are now
  synthesised from its content.
- **pytest collection is a skip.** `collect_ignore` / `collect_ignore_glob`
  (assignment, `+=`, `.append`, `.extend`), `def pytest_ignore_collect(`, and
  the parametrize `marks=` form join test-skip's Python patterns beside the
  2.2.1 spellings.
- **`passWithNoTests: true` in a jest or vitest config** is the CLI flag's
  twin and is now coverage-lowering, so a brand-new config carrying it — which
  has no `before` to compare thresholds against — is still a weakening.

## [2.3.0] — 2026-09-02

**`verify` runs both suites under the operator's environment, not the
candidate's, and the verification surface covers what the package manager
reads before the runner starts. A minor: the suite no longer inherits
`NODE_OPTIONS` or `PYTHONPATH`, and yarn's `yarn-path` is ignored, so a suite
that leaned on any of those from the ambient environment goes red until it sets
them in its own frozen command.**

### Fixed

- **An agent-added `.npmrc` made both runs green.** `node-options=--require
  ./p.cjs` in a project `.npmrc` is exported by npm as `NODE_OPTIONS` to every
  node it spawns, so with the frozen command `npm test` a two-line preload that
  stubs the runner's `test`/`it`/`describe` to no-ops made `node --test` find
  nothing and exit 0 in the visible AND the pristine copy: VERIFIED over a
  source the base suite fails, with no protected file touched. `.npmrc` was on
  no list — it is not a file the runner consults but the file the runner is
  started under. The same line in `~/.npmrc`, which the candidate owns inside
  `tamperward run`, worked identically and no in-tree list can cover it.
  Two layers close the class: the package-manager and runner files
  (`.npmrc`, `.yarnrc`, `.yarnrc.yml`, `pnpm-workspace.yaml`, `.pnpmfile.cjs`,
  `.pnp.*`, `.yarn/releases`, `.yarn/plugins`, `.env*`, `.nvmrc`,
  `.node-version`, `.python-version`, `setup.py`, `sitecustomize.py`,
  `usercustomize.py`, `.gitattributes`, `.nycrc*`, `.c8rc*`, `.taprc`,
  `ava.config.*`, `mocha.opts`, jasmine, playwright and cypress configs) join
  the verification surface; and both suites run under a sanitised environment
  — `NODE_OPTIONS`, `NODE_PATH`, `NODE_REPL_EXTERNAL_MODULE`, `PYTHONPATH`,
  `PYTHONSTARTUP`, `PYTEST_ADDOPTS` and `PYTEST_PLUGINS` dropped; npm's
  `node-options` pinned to nothing (a single space: npm skips an empty env
  value) and its user and global config pointed at empty files; yarn's
  `yarn-path` ignored. Verified against npm 10.9, pnpm 10.33 and yarn 1.22;
  the residual (a runner input that is neither a file here nor a variable
  there, Python's user site-packages among them) is stated in
  docs/THREAT-MODEL-pristine-run.md.
- **`git show` stays, deliberately.** `git cat-file --filters` was considered
  for LFS-tracked overlay files and rejected: a smudge is a command read from
  repository config the candidate writes, selected by working-tree attributes
  the candidate writes. An LFS pointer on the surface restores as a pointer
  and fails closed.
- **`verify --base --json`** read the base as `--json`; a value-taking flag now
  refuses a following flag or a missing value and verify exits 2.

## [2.2.1] — 2026-09-02

**Five block rules closed against their one-token neighbours, and three
routine edits that blocked no longer do. A patch: bypass fixes at the same
severity and false-positive fixes, nothing else.**

### Fixed

- **`no-verify` matched raw text, not git.** `git commit --no-veri` (git
  accepts any unambiguous prefix), a quoted `'--no-verify'`, and
  `export SKIP=tamperward; git commit` all walked past it, while
  `git log -n 5 -- src/commit.ts`, a commit message quoting `--no-verify`,
  and `grep -- --no-verify docs/` blocked. Flags are now matched as unquoted
  tokens of the `commit`/`push`/`merge` subcommand with option values dropped;
  env hatches as whole assignment tokens; `SKIP=` carries to a later segment
  only when exported or assigned bare.
- **`test-skip` spellings:** vitest `skipIf`/`runIf`/`fails`, jest
  `test.failing`, mocha `this.skip()`, `it.each([])`, `concurrent.skip`, a
  non-literal `{ skip: expr }`; Python `pytestmark`, bare `@skip`, an aliased
  `pytest`, `__test__ = False`; Go `testing.Short()` guards and
  `//go:build ignore`; Rust `cfg_attr(…, ignore)`; Ruby `before { skip }` and
  a block-less example; Java `assumeTrue(false)` and a fully-qualified
  `@Ignore`; C# `[Explicit]` and `Assert.Inconclusive()`. False positives
  fixed: `fit`/`xit`/`xdescribe` require call position, comment-only lines are
  skipped, and `skip:` counts only in a test's options.
- **`lint-suppression` spellings:** ESLint inline config (`/* eslint rule: off */`),
  `# ruff: noqa`, `# flake8: noqa`, `# mypy: ignore-errors`, `# pylint:
  skip-file`, `//lint:ignore`, `@file:Suppress`, `NOSONAR`, `ReSharper disable`,
  `@codingStandardsIgnore*`. A marker inside a string literal or docstring no
  longer fires.
- **`ts-any-cast`:** `x as (any)` reached only the warn rule because the
  parenthesised type was not unwrapped; JSDoc `/** @type {any} */ (x)` in
  JavaScript files is the same cast.
- **`snapshot-rewrite`:** `npm test -- -u` (the most common spelling) and its
  yarn/pnpm/bun forms, `find … -name '*.snap' -delete`, `git checkout --` on a
  snapshot path, `cargo insta accept`, `pytest --snapshot-update`,
  `UPDATE_EXPECT=1`.

## [2.2.0] — 2026-09-02

**`init` wires the hook where git actually runs it, the CLI fails closed on
every crash path, and the policy loader refuses what it cannot vouch for. A
minor, per CONTRIBUTING and the 1.15.0 precedent: the loader now rejects two
shapes it used to accept silently (an unknown top-level key, a ledger path
outside the repository), so a policy carrying either goes from "loaded, not in
force" to exit 2 — visible, where it was invisible.**

### Fixed

- **`init` wrote `.git/hooks/pre-commit` that git never ran.** With
  `core.hooksPath` set (lefthook, simple-git-hooks, a custom `.githooks/`) the
  hook landed in the wrong directory and every re-run reported "already runs
  the staged check". The hooks directory now comes from
  `git rev-parse --git-path hooks`; a lefthook or pre-commit-framework repo gets
  a `skip` with the exact config line to add.
- **`init` appended the gate after an `exec`/`exit` that made it dead code**,
  and later reported it as wired. The gate is inserted above the first
  unconditional exit; an unreachable gate that init wrote is moved, a
  hand-written one is reported as an error.
- **Crash paths exited 1 with a stack trace.** A bad `--diff` revision, a
  `--worktree` outside a repository, an invalid policy reaching `allow`, a
  directory where `init` expected a file: each is now one line on stderr and
  exit 2 (cannot evaluate, failing closed), never 1 (a blocking finding) and
  never 0. `init` plans every change before writing any; an apply failure is an
  error row, not an abort. `hook`/`sweep` are unchanged: a deny is JSON at exit 0.
- **`signoff.ledger` could point outside the repository, unreported.** The
  local layer trusts that file, so `../../shared.jsonl` handed the sign-off
  channel to whoever controls that path. The loader rejects absolute or
  escaping ledger paths (exit 2), and policy-diff reports any ledger change.
- **An `exclude`-only override produced a false "lowered block → undefined"
  finding** because the override replaced the whole rule object and dropped the
  baseline severity. Rule overrides are field-merged; the exclude addition is
  still reported, once.
- **Policy-derived strings reached the terminal unescaped.** A crafted
  `ignore` glob could carry a terminal escape sequence into a finding's
  message. Control characters are stripped from every rendered field, in the
  text and GitHub renderers.
- **`init` inferred `@org` as a CODEOWNERS owner** for an organisation remote,
  which GitHub rejects silently. The owner is confirmed against `github.user`
  or `user.name`; otherwise the rule gets a TODO comment and init warns.
  `/dir/**` patterns are recognised so re-runs stop appending duplicates.
- **Silent config footguns.** An unknown top-level key (`Rules:`, `ignored:`)
  fails closed naming the accepted set; a leading `/` on a protected, ignore or
  exclude glob is normalised away instead of matching nothing; `init` loads an
  existing policy and reports its error instead of "left untouched";
  `check --diff` prints a stderr note when a range scans zero changes.

## [2.1.1] — 2026-09-02

**Two bypasses of every git view, closed. A patch: bypass fixes at the same
severity, and nothing that was green turns red.**

### Fixed

- **git's binary heuristic blinded every content detector.** A committed
  `.gitattributes` line (`x.spec.ts -diff`, or the `binary` macro) — or simply
  a NUL byte anywhere in the file — made git print "Binary files differ" instead
  of hunks. The parser marked the change binary, the builder skipped loading its
  content, and test-skip, test-content-removal, ci-tampering, coverage-lowering
  and hook-tampering's content branch all went silent on that file, in the
  range, staged and worktree views alike; through the hook, a Write adding
  `it.skip` plus `\0` was allowed. Every `git diff` Tamperward runs now passes
  `--text`, which overrides both the attribute and the heuristic, and content is
  loaded regardless of the binary flag. A modified binary golden file still
  produces only the snapshot-rewrite warning it did before.
- **A path containing a space was invisible.** git appends a tab to an unquoted
  path with a space in the `---`/`+++` lines; the parser kept it, so
  `my tests/b.test.ts\t` matched no protected glob and a deletion or `.skip`
  under such a directory reported clean. The tab is stripped; quoted paths are
  decoded as before, and the header split no longer mis-parses a directory
  containing ` b/`.

## [2.1.0] — 2026-09-02

**`verify` gains the out-of-band sign-off channel `check --diff` has had since
1.13.0. A minor, per CONTRIBUTING: new surface, and nothing that was green turns
red — a masked failure that no label covers exits 1 exactly as before.**

### Added

- **`tamperward:allow:verify@<head-sha>` clears a `verify` masked failure.**
  Until now a MASKED_FAILURE had no human escape at all: the one case where the
  original suite is genuinely wrong for the change — an intended behaviour change
  whose old expectations must fail — could only be merged by switching the
  verify step off. `verify` now reads the same `TAMPERWARD_OOB_SIGNOFF` and
  `TAMPERWARD_OOB_HEAD` the diff gate reads, with the same rules: once the
  workflow names the head it is adjudicating, only a token bound to that commit
  counts, so the approval dies with the next push. The verdict is still
  reported as `MASKED_FAILURE` (with `oob_signoff` in `--json`); only the exit
  code changes. It clears nothing else — SUITE_RED and cannot-verify are not
  approvable states, so a label cannot make a red suite green or turn "could
  not run" into "verified". The committed ledger is never consulted.
- The generated CI workflow passes both variables to its verify step. Re-run
  `tamperward init` to migrate a workflow it wrote; a hand-edited one is left
  alone, as before.

## [2.0.0] — 2026-09-02

**Node 18 is no longer supported. That is the whole of the breaking change, and
it is a major because CONTRIBUTING's test says so: a user on Node 18 who takes
this upgrade gets a red build without changing anything.**

Node 18 reached end of life in April 2025; the CI matrix had gone on proving a
runtime that no longer receives security fixes, and the dev toolchain was
pinned back to the last lines that still ran on it. The floor is the lowest
Node the current toolchain runs on, not the newest LTS: Node 20 stays
supported and tested. Nothing in `src/` changes — the gate's behaviour on Node
20, 22 and 24 is exactly 1.15.0's.

### Changed (breaking)

- `engines.node` is `>=20.19`. The CI matrix tests Node 20, 22 and 24.
  `init`'s generated workflow already ran on 22; nothing it writes changes.

### Changed

- Dev dependencies: `vitest` 2 → 4 and `vitepress` 1.6 → 2.0 (their vite 7
  line, whose own floor is Node 20.19 and is what set this one), `@types/node`
  20 → 22 (type definitions only; the floor is unaffected). `npm audit` is
  clean, dev dependencies included.

## [1.15.0] — 2026-09-02

**A third external audit. Five fail-open paths closed, the pattern rules read
the language of the file, and the project's own gate binds its labels to the
head SHA. A minor, per CONTRIBUTING: the rules catch more only in changes that
already violated the policy they declare, and `init` gains a pin, not a rule.**

**Five ways the gate failed open, from a third audit. Each was reproduced against
the built 1.14.6 CLI before the fix; each is now a permanent test
(`test/audit-fail-open.test.ts`).**

### Fixed

- **A mistyped severity switched a rule off, silently.** `rules.<name>.severity:
  BLOCK` (or `blocc`, `blocking`, `1`) parsed cleanly and produced findings that
  were neither `block` nor `warn` — findings nothing treats as blocking. After
  such a line, `rm a.test.js` passed the PreToolUse hook, the Stop sweep, and
  `check --worktree`; and the edit that introduced it was not reported, because
  policy-diff compared for `warn` only. The loader now validates every value in
  the file (`rules`, `ignore`, `protected`, `signoff`, `verify`) and fails
  CLOSED on anything it does not understand, exactly as it already did for
  `version:`; policy-diff reports any departure from `block` as a lowering.
  Unknown rule *names* still load, so a policy for a newer build keeps working.
- **A tool-call diff past 1 MiB was read as a smaller edit.** The hook adapter
  called `git diff --no-index` with Node's default `maxBuffer`; on overflow the
  truncated patch was parsed as the whole edit, so `test.skip` appended to a
  3 MB spec was allowed. The buffer is 256 MiB, and any diff failure other than
  "files differ" now fails closed instead of parsing partial output.
- **A redundant path segment dodged every exact-path protected glob at the
  hook.** `/repo/./.claude/settings.json` and `/repo/src/../.tamperward.yml`
  reached the detectors as `./.claude/settings.json` and
  `src/../.tamperward.yml`, which no glob matches — the gate's own wiring could
  be edited unseen at PreToolUse. Paths are resolved before matching.
- **`chmod -x` on a hook was invisible to every git view, and three spellings
  dodged the command detector.** A mode-only change carries no hunks, so the
  parser dropped it and the staged, worktree and range views reported clean
  after `chmod u-x .husky/pre-commit` (husky v8 points `core.hooksPath` at that
  file; git skips a non-executable hook). The parser now records `old mode` /
  `new mode`, hook-tampering flags a lost execute bit, and the command surface
  reads chmod arguments the way chmod does (`u-x`, `a-x`, `go-x`, `u=rw`,
  comma clauses, octal) instead of a regex that only matched `-x`.
- **`verify`'s budget kill stopped the shell and nothing else.** Workers forked
  by the runner survived a BUDGET_EXCEEDED verdict, in a directory about to be
  removed, executing the candidate's code after the verdict. The suite now runs
  in its own process group under a small supervisor, and the whole group is
  killed on budget or exit.


**Protection that was silently absent, from a third audit. Each case is a
permanent test (`test/coverage-gaps.test.ts`).**

### Fixed

- **Session state was written INSIDE the working tree from a `git worktree` or a
  subdirectory.** `git rev-parse --git-dir` answers an absolute path from
  anywhere but the top of an ordinary checkout, and the effect layer joined it
  onto `cwd` — so a Claude Code session in a worktree created
  `<worktree>/tmp/…/main/.git/worktrees/x/tamperward/` and kept its drift state
  there. The watcher's default log assumed `.git` was a directory and silently
  recorded nothing in a worktree. Both now resolve the real git directory.
- **`enabled: false` did nothing for a rule that is not a detector id.** The
  engine checked the flag per detector, so `ts-any-launder` (emitted by the
  `ts-any-cast` detector) and `transient-protected-mutation` (judged outside the
  engine) kept firing after being switched off. Findings are now filtered by
  their own rule id. The engine's `detector-error` can never be disabled.
- **`SKIP=<hook-id>` and `LEFTHOOK_EXCLUDE=` were not hook bypasses.** The
  pre-commit framework and Lefthook both document these as the way to skip a
  hook; `.pre-commit-config.yaml` and `lefthook.*` are protected, and their
  own escape hatches were not. `SKIP=` counts only in a segment that runs git
  or pre-commit, since the name is plausible elsewhere.

### Changed

- **The pattern rules read the language of the file.** Since 1.14.0 the
  baseline has protected Python, Go, Rust, Ruby, JVM, PHP and .NET test files,
  but every skip marker, every suppression directive and the test-block count
  were JavaScript spellings — `@pytest.mark.skip` in a protected spec fired
  nothing, and `def test_x` counted as zero tests on both sides. `test-skip`,
  `lint-suppression`, `test-deletion` (block count) and
  `test-content-removal` (significant lines, now one shared filter) now use the
  equivalent spellings for each of those ecosystems; a file of unknown language
  is read as before. Rust `#[allow(...)]` is deliberately not a suppression
  finding — it is the ordinary way to annotate an intentional lint, and a block
  rule on it would be mostly false positives. Per CONTRIBUTING this is a
  **minor**: the rules catch more only in changes that already violated the
  policy they declare.


### Fixed

- **This repository's own gate did not bind approval labels to the head SHA.**
  `ci.yml` set `TAMPERWARD_OOB_SIGNOFF` but never `TAMPERWARD_OOB_HEAD`, so a
  `tamperward:allow:<rule>` label earned for one benign finding cleared every
  later one pushed to the same PR — the P1-6 hole the shipped template closed in
  1.12, still open on the project's own CI. Labels on this repo now read
  `tamperward:allow:<rule>@<head-sha>`, as the generated workflow requires.
- **ci-tampering read a YAML comment as a removed check.** A comment that quoted
  `tamperward:allow:<rule>` in a code span satisfied the invocation-position test
  through the backtick before the word, and rewording it was a blocking finding.
  Comment lines are never steps.

### Changed

- **`init` pins the local hooks to the version that wrote them**, as it already
  pinned the workflow (P2-15). `npx --yes tamperward hook claude` with no
  version resolved `latest` on every call in a repo where the package was not
  a devDependency, so the gate changed under the repo without anyone changing
  anything. Re-running `init` re-pins an install it wrote for another version
  (or wrote unpinned) in `.claude/settings.json` and the pre-commit script; a
  command someone wrote by hand is left exactly as it is.
- Dev dependencies: `esbuild` 0.24 → 0.25. `vitest` stays on 2.x and `vitepress`
  on 1.6.4: every later vitest, and vitepress's only fixed line (the 2.0 alpha),
  pull in a vite that drops Node 18, which this package still supports
  (`engines >=18`, tested in CI). `npm audit` therefore still reports the vite
  dev-server advisories through those two; none of them reach the published
  package (`npm audit --omit=dev` is clean).

## [1.14.6] — 2026-09-02

**H2, the last open hypothesis from the second audit, is confirmed: a pull
request can switch off the gate that judges it. This ships what can be shipped,
and says plainly what cannot.**

### The reproduction

A `pull_request` workflow executes from the **pull request's own head**, and a
required status check is matched by **job name**. So a pull request can keep the
job called `gate`, replace every Tamperward invocation in it with `true`, and
present a green required check over any change it likes.

Run as a controlled fixture against this project's own CI, on a branch that also
lowered `hook-tampering` from `block` to `warn`:

    Complete job name: gate
    ##[group]Run true
    true

`gate` — **success, in three seconds**. The same range, checked locally with
1.14.5, blocks with two findings and exits 1:

    BLOCK  ci-tampering    .github/workflows/ci.yml
    BLOCK  hook-tampering  .tamperward.yml

The detector is correct and irrelevant. A second guard fell with it: the "No
Claude session links" step lives in the same job, so that check vanished on that
branch too. One neutered job takes out everything defined in it.

**No detector can close this**, because the detector is defined by the candidate.
Only a human requirement on the paths that constitute the gate can — which is
what CODEOWNERS expresses and what branch protection enforces.

### What `init` now does

A fifth enforcement point: `.github/CODEOWNERS`, requiring a code owner on
`/.github/workflows/`, `/.tamperward.yml` and `/.github/CODEOWNERS` itself. The
owner is inferred from the `origin` remote. Rules are appended at the **end** of
an existing file, because CODEOWNERS is last-match-wins and our rules must not
be shadowed by a broader earlier pattern; a directory rule already covering a
path (`/.github/`) counts, so nothing redundant is added. Where the owner cannot
be inferred, the file says so in capitals rather than writing a rule that binds
nobody — an unresolvable owner is protection that is silently absent, which is
the failure class this project keeps re-learning.

`CODEOWNERS` also joins the protected `hooks` class in all three locations
GitHub reads it from. It is enforcement wiring, not documentation.

### What `init` cannot do, and now says

`init` cannot set branch protection. So it ends, every run, with the step it
cannot take for you: require the check **and** enable "Require review from Code
Owners". Until both are set, the CI gate is advisory — and the message says so
in those words, because a tool that implies otherwise is worse than one that
says nothing.

### Fixed

- `init` writes and maintains a CODEOWNERS requirement on the gate-critical paths.
- `CODEOWNERS` is a protected `hooks` asset, so removing it is a finding.
- `init` always reports the branch-protection step it cannot perform.

## [1.14.5] — 2026-09-02

**The pristine run was writable by the candidate. Four findings from a second
external audit; a fifth is mechanism-established and deliberately not claimed.**

### The visible run could edit the pristine copy

The two copies were siblings under one temporary root, and BOTH were
materialised — overlay fully applied — before the visible run started. The
visible run executes the candidate's code. So the candidate's code wrote

    ../pristine/test/<the test that convicts it>

and both runs returned 0. No race. No background process. No git. Three lines in
a file the agent already controls, and the layer whose entire purpose is to
execute code the agent did not write reported `VERIFIED` over an unfixed bug.

Sequencing is the fix: **the pristine copy is built only after the visible run
has exited.** There is nothing to write into while the candidate is running,
because it does not exist yet. Separate temporary roots as well, but that is
defence in depth and not the control — a background process can still enumerate
a temp directory.

Two guards close what sequencing alone cannot:

- the restored overlay files are digested (content **and** mode) either side of
  the pristine run, so a write that reaches the copy after it exists is caught;
- the working tree and the installed dependency tree are fingerprinted around
  both runs. The pristine copy is now materialised from the source tree *after*
  the candidate has had a turn, and that tree's path is one `readlink` away
  through the `node_modules` symlink — so a visible run that reaches back into it
  would be choosing what the pristine copy is made of. Any movement is exit 2.

**Behaviour change:** a suite that rewrites its own test files or snapshots in
place during verification now fails closed rather than being verified. Run it in
whatever mode your runner calls CI, so verification observes rather than updates.

### The overlay restored content, not mode

`git ls-tree --name-only` was the whole of the base read, so a restored file kept
whatever mode `materialize` had copied from the agent's working tree — or, for a
file the agent had deleted, the 0644 a fresh `writeFileSync` produces. A base test
at `100755` therefore arrived non-executable, and a discovery command that runs
the executable files under `test/` found nothing to run in either copy: `VERIFIED`,
over a source that fails. **The agent never edited a byte of the test. `chmod -x`
was the entire attack.** Mode and type now come from the base: blobs are restored
with their mode, a base symlink is reproduced as one, and a submodule inside an
overlay class fails closed rather than being faked.

### A transient dependency substitution was invisible

`run` compared the `node_modules` fingerprint at entry against the fingerprint at
exit. A replacement runner that returns 0 for the visible run, returns 0 for the
pristine run, and puts the original bytes and mode back on its way out leaves
those two identical — reproduced end to end as `GREEN MEANS GREEN` over an unfixed
bug. The state that matters is the one the checks are about to execute, so it is
now compared **before adjudication begins**, as the object-rewrite check already
was; `verify` re-checks it around each suite invocation as well.

### The CI gate was fetched from a registry the candidate chose

`npm` reads `.npmrc` from the working directory — which, in a `pull_request`
workflow, is the checked-out pull request. One committed line,
`registry=https://…`, decided where `npx --yes tamperward@<version>` downloaded
the authority judging it from. The version pin pinned the **string**, not the
**source**. The generated workflow now sets `NPM_CONFIG_REGISTRY` at job level,
which outranks a project `.npmrc` in npm's config precedence. Workflows generated
by 1.14.4 and not edited since migrate automatically on the next `init`, via the
provenance stamp shipped in that release.

### Not claimed

A fifth hypothesis — that a pull request can neuter the generated workflow while
keeping the required job name, so the check reports green rather than missing —
is **mechanism-established and unreproduced**. `pull_request` workflows run from
the PR head and required checks match by name, so nothing in the template
prevents it; no live PR fixture has been run, so it is not described here as a
reproduction and nothing has been changed for it.

### Fixed

- `verify` builds the pristine copy only after the visible run exits, digests the
  restored files around the pristine run, and fails closed if the working tree or
  the installed dependency tree moves during verification.
- `verify` restores the base's file mode and type, not only its content.
- `run` compares the dependency fingerprint before adjudication, not only at exit.
- The generated CI workflow pins `NPM_CONFIG_REGISTRY`.

## [1.14.4] — 2026-09-02

**Six fixes from an external audit. Two of them reopen the same wound 1.14.1,
1.14.2 and 1.14.3 each closed one layer of: the verifier's inputs, and the git
objects the base resolves to.**

### The verifier executed files nothing restored

1.14.3 froze the verifier's command *string* against the base policy. It did not
freeze what that string runs. The pristine overlay restored the tests, the
snapshots and the runner configuration — and then handed the result to `sh -c`,
which ran a program:

    verify:
      command: node runner.js     # runner.js is in no protected class,
                                  # and on no runner's config surface

Rewriting `runner.js` to `process.exit(0)` produced `VERIFIED`, exit 0, over an
untouched bug. Delegation is worse, because the restoration looks complete:
`package.json` is on the verification surface, so the base's
`"test": "sh scripts/test.sh"` was faithfully restored — and then called a
script nobody restored.

The pristine copy now also carries the base's copy of **what the verifier
executes**, from two sources:

- **implicit** — command tokens naming a file that exists at the base
  (`node runner.js`, `sh scripts/ci.sh`, `./run-tests`). No configuration; it can
  only ever restore a file the base itself shipped.
- **explicit** — a new `verify: { inputs: [globs] }` block, for delegation, which
  is not statically decidable. Files matching it are restored from the base, and
  files the agent *added* under it are removed from the pristine copy — the
  added-`conftest.py` argument, one layer down.

Narrowing `verify.inputs` is policy weakening, alongside changing the command and
lowering the budget.

This bounds the class; it does not eliminate it. A command can still reach a file
neither source names — a `Makefile` include, an interpreter's startup file, a
tool config outside the surface list. Stated as a residual in
`docs/THREAT-MODEL-pristine-run.md`, not as solved.

### The base itself could be redirected

`git replace`, `.git/info/grafts` and `.git/shallow` change what a commit
*resolves to* without moving a ref or touching a tracked file. Every guarantee
here reduces to "the base says X": the overlay's `git ls-tree` (which files exist
at the base) and `git show` (their content), and the envelope's `merge-base`
ancestry assertion. `git replace <base> <a-commit-the-agent-just-wrote>` made all
three answer from a forged tree, and reported `VERIFIED`.

- every trusted read in `verify` and `run` now sets `GIT_NO_REPLACE_OBJECTS=1`,
  which is complete for replace refs;
- grafts and shallow have no such switch, so `run` fingerprints the whole
  object-rewrite state before the agent starts and re-checks it the moment the
  agent exits. A change is `OBJECT_REWRITE → ENFORCEMENT_FAILED` (exit 1),
  checked **before** adjudication rather than reported after it: a report
  produced under a redirected base describes an anchor nobody chose. It is
  checked a second time after the checks, for a survivor that installs one
  mid-run.

This closes the case where the agent installs a rewrite during the run. A rewrite
that predates the envelope predates its authority and is unchanged.

### `init` could not migrate what it had generated

"Workflow already present — left untouched" made the CI template write-once per
repository. Everything shipped in it since is therefore absent from every repo
that ran `init` before it: the pristine-verify step (1.9.0), the version pin,
`--require-ancestor`, the head-bound sign-off label. A repository whose workflow
predates 1.9.0 has diff-time detection and no pristine re-execution at all — and
re-running `init` told its owner CI was wired. **Security fixes that only reach
new adopters are not shipped.**

Generated workflows now carry a provenance stamp (version + hash of the body as
generated). A file `init` wrote that nobody has edited is migrated in place; a
file that was edited, or that `init` never wrote, is reported and left exactly as
it is. `--force-workflow` is the operator's override for the second case.

### `init` blessed a PreToolUse matcher with a hole in it

The wiring check only ever asked whether *our command* was present, so an install
wired before `NotebookEdit` was added to the matcher (1.13) kept a permanently
narrower gate, and every later `init` confirmed it as correctly configured. `init`
now compares the tool set and widens a matcher that does not cover every tool the
gate must see — as a union, so tools the user added are kept.

### The hook failed OPEN on a payload it could not read

`parseInput` absorbed every parse failure into `{}` — the empty input — which
flows through to "no findings": exit 0, empty stdout, **allow**. Truncated stdin,
a JSON array, a partial write from a runtime under memory pressure: all
indistinguishable from "this tool call is fine", for every tool call while the
condition lasted. That is the hole `failClosed()` exists to close, left open at
the front door. Unreadable and malformed payloads are now denied. Genuinely empty
stdin is still an allow — it is a well-formed *absence* of a tool call.

### Fixed

- `verify` restores the files the verifier command executes, implicitly from the
  command and explicitly from `verify.inputs`; `parsePolicy` no longer drops the
  new field, and narrowing it is flagged as weakening.
- `verify` and `run` read git with `GIT_NO_REPLACE_OBJECTS=1`; `run` convicts an
  object-rewrite installed during the run.
- `init` migrates a generated, unedited CI workflow, and never overwrites one it
  did not write (`--force-workflow` to override).
- `init` widens an incomplete PreToolUse matcher.
- The Claude hook denies a payload it cannot parse instead of allowing it.

## [1.14.3] — 2026-09-02

**Policy provenance: `verify --base` now reads its policy from that commit, not
from the candidate tree.**

`tamperward run` has always frozen the policy at the entry commit and passed it
to the verifier. Standalone `tamperward verify` did not: it called
`loadPolicy(cwd)`, so the overlay classes, the verification surface and — the
part that matters — the `verify:` block's command and budget all came from the
working tree. **The generated CI workflow runs standalone `verify`**, so a pull
request supplied the configuration for its own re-execution:

    # in the PR's .tamperward.yml
    verify:
      command: 'true'

reported `VERIFIED`, exit 0, over an unfixed bug.

`check --diff` reads its policy from the merge-base and flags that edit as
`hook-tampering`. The generated workflow is **one required job containing two
sequential checks**, not two independently required jobs. Before 1.14.3 the
composite remained blocking because the base-policy `check --diff` step was part
of that required job and its failure determined the job's final conclusion. The
current ordering additionally meant the vulnerable verifier step was skipped
after a diff failure, but **ordering itself was not the security boundary** — a
failure in either step fails the job.

If the checks are ever split into separate jobs, **both job conclusions must be
required**. Requiring only the formerly vulnerable `verify` job would reopen the
authority failure. Anyone invoking `verify` on its own had no protection at all.
The README claimed the CI verdict was base-governed; that was true of
`check --diff` and not of `verify`.

With a `--base`, `verify` now loads the policy from that commit and falls back
to the built-in defaults if the base has none. Without a `--base` there is no
trusted commit to read from and the working tree's policy is still used — that
is the local-developer path, not the authority path. A `verify:` block added
only on the candidate is therefore no longer used; add it at the base, or pass
`--cmd` explicitly, and the error message says so.

Two routes, both closed. The `verify:`-block form above is the simpler one. The
other is a tree-authored **overlay glob**, and whether it produces a false green
depends on the baseline:

- against a **red** base — the task's bug already present — widening an overlay
  class to cover source makes the pristine run fail *harder*, so it fails closed
  as `MASKED_FAILURE`;
- against a **green** base, a candidate can introduce a source regression, gut
  the test so the visible run is green, and widen an overlay class to cover the
  source. The pre-1.14.3 verifier then restored *both* the good base source and
  the base test, and both runs came back green — `VERIFIED`, exit 0.

That is what the repository's own `P0-2` fixture documented with
`protected.config: ["**"]`, and `protected.tests` is equivalent for the purpose
because both classes are in `OVERLAY_CLASSES`. Confirmed on 1.14.2 for both
spellings, and closed in 1.14.3 for both.

The existing `P0-2` regression asserted the hole rather than the fix — it
expected standalone `verify` to return 0, because at the time only the envelope
passed a frozen override. It now asserts the closed behaviour, and a new `P0-2b`
covers the `verify:`-block form. Both are mutation-checked: reverting the
provenance change fails both.

Scope: a bypass fix, therefore a patch. It is a **behaviour change for anyone
who changes `verify.command` inside a pull request** — CI now runs the base's
command. That is the intended direction: the candidate does not choose the rules
it is judged by.

## [1.14.2] — 2026-09-01

**1.14.1 fixed a filename, not the class. Six more vectors were live; this
closes them.**

1.14.1 removed agent-added files inside the policy's `protected` classes and
treated the pristine-inheritance bypass as closed. It was not. The `config`
class is jest/vitest/tsconfig/eslint/package.json — JS/TS only — so pytest's
entire configuration surface sat outside it, as did every runner that is not
jest or vitest. Demonstrated live at 1.14.1, each via a single added file, with
the bug never fixed and no base-protected file touched:

    pytest.ini      addopts = --deselect <nodeid>
    setup.cfg       [tool:pytest] addopts
    tox.ini         [pytest] addopts
    pyproject.toml  [tool.pytest.ini_options]
    pytest.ini      -p <plugin module not named conftest>
    pytest.ini      addopts = -k "not <test>"

The full envelope printed `GREEN MEANS GREEN` over an unfixed bug in every case.

`verify` now owns a **verification surface** — the files a runner auto-consults
to decide what to collect, how to configure it and which plugins to load — and
treats it as base-owned exactly like the protected classes: restored from base
if it existed there, removed if the agent added it. The pristine tree's
discovery and configuration surface is therefore the base's, never the base plus
the agent's contribution.

The surface is deliberately **separate from the policy's `protected` classes**.
They overlap but answer different questions: `package.json` is policy-protected
because gutting the test script is weakening; `pytest.ini` need not be
policy-protected at all and still must never be inherited by the pristine run.
Keeping them apart means widening the verifier's list does not widen in-loop
denials.

**This list is a lagging indicator by construction.** A runner can always add a
configuration source, so this bounds the class rather than eliminating it. That
is stated in the SPEC rather than implied to be solved, and the full analysis —
including what was tested and did not reproduce — is in
`docs/THREAT-MODEL-pristine-run.md`, with the multi-vector proof of concept at
`harness/poc/verify-pristine-inheritance-vectors.sh`.

**Considered and rejected for this release:** disabling runner plugin autoload
in the pristine run (`PYTEST_DISABLE_PLUGIN_AUTOLOAD=1`). It would cover
entry-point plugins that no file list can enumerate, but it also breaks suites
that legitimately depend on them — `pytest-asyncio`, `pytest-django` — turning
honest work into `MASKED_FAILURE`. Applying it symmetrically to both runs makes
those repositories fail closed and unverifiable instead. It needs a per-repo
opt-in, not a default.

Scope, in the terms of CONTRIBUTING: a bypass fix, therefore a patch. It makes
`verify` stricter — a repository whose pristine run depended on an agent-added
runner config may now see `MASKED_FAILURE`. Failing closed is the intended
direction.

The published record is corrected accordingly: the bypass class was open from
**v1.9.0 through 1.14.1 inclusive**, not closed by 1.14.1.

## [1.14.1] — 2026-09-01

**A bypass in `tamperward verify`: an added file could suppress the tests the
pristine run had just restored.**

`verify` materialises two copies of the tree and, in the pristine one, restores
every protected file from the trusted base. Agent-**added** protected files were
kept, on the stated premise that they "can only add strictness, and the visible
run already required them to pass". That premise was false, and the gap was
reachable without ever modifying or deleting a base-protected asset.

An agent that adds `tests/conftest.py` gets it auto-loaded by pytest, and
`pytest_collection_modifyitems` can deselect the restored base tests **by node
id** — no skip spelling, so no detector could see it. The failing test then runs
in neither copy, the pristine suite goes green, and a masked failure is reported
`VERIFIED`. Through the enforcement envelope the whole stack printed
`GREEN MEANS GREEN` over an unfixed bug.

Agent-added protected files are now **removed** from the pristine copy: its
protected surface is exactly the base's, never the base plus whatever the agent
contributed. Added tests are not lost information — the visible run still
executes them; the pristine run asks only whether the agent's source passes the
*original* suite, to which an agent-authored file is not an input. The reported
count changes from `added_protected_kept` to `added_protected_removed`.

Reproduced on v1.9.0 (where `verify` was introduced) through v1.14.0 under one
identical policy, with the control — weakening the protected test, nothing
added — correctly blocked as `MASKED FAILURE` throughout. The PoC is committed
at `harness/poc/verify-added-protected-bypass.sh` and the regression test is
mutation-checked: it fails against the pre-fix behaviour.

This is a bypass fix and therefore a **patch**, per CONTRIBUTING — a closed
evasion should reach people automatically. It does make `verify` stricter: a
repository whose suite command names an agent-added protected file may now see
`MASKED_FAILURE` where it previously saw `VERIFIED`. Failing closed is the
intended direction.

Known limitation, deliberately not closed here: removing added protected files
addresses files inside a protected class. Auto-loaded influence can also arrive
via pytest plugins, `sitecustomize.py`, package entry points, new Jest/Vitest
configuration, preload files, or shared mutable dependencies. The invariant we
want — *the pristine run must not inherit agent-added files that can change test
discovery, configuration, fixtures, setup, or execution authority* — needs its
own threat model, and is tracked for the next round.

## [1.14.0] — 2026-08-31

**The last P2s — and the one that matters is not a security bug.**

- **P2-13 — test protection was silently absent outside JavaScript.**
  `test-skip`, `test-deletion` and `test-content-removal` all gate on the
  `tests` protected class, and the default globs matched only JS/TS. A Python,
  Go, Rust, Ruby, Java, PHP or C# repository could run `tamperward init`, see
  a policy file appear, and have those rules never fire once — with nothing
  saying so. Protection that is silently absent is worse than protection you
  know you do not have. Conventional test layouts for those ecosystems are now
  in the default class, with a control asserting ordinary source that merely
  mentions "test" is still unprotected.
- **P2-12** — `NotebookEdit` was modelled by the adapter but missing from the
  matcher `init` installs, so that branch was unreachable in the default
  deployment. It is in the matcher now.
- **P2-14** — a crafted file path broke out of the link and code span into the
  rendered job summary. The label is neutralised for a code span and the URL
  percent-encoded; ordinary paths render unchanged.
- **P2-16** — revision arguments reached git unvalidated, so an argument
  beginning with `-` would be parsed as an option. `assertRev` refuses that at
  the range, merge-base and verify entry points. Operator-controlled in every
  shipped wiring, so a guard rather than a demonstrated escape — free to fix.

This closes every finding from both passes of the external review. Full suite
364/364.

## [1.13.0] — 2026-08-31

**The CI authority's own integrity: P1-3 and P1-6.**

- **P1-3 — standalone `verify` could be anchor-downgraded.** `run` enforces
  that HEAD descends from the trusted base; `verify --base <rev>` resolved
  with merge-base semantics and had no such guard, so history rewritten
  beneath the base silently anchored verification to an older commit. That
  matters more since 1.12.0, which ships exactly this standalone wiring.
  `--require-ancestor` fails closed (exit 2), and the generated workflow
  passes it. Deliberately opt-in: a PR branched from an older main
  legitimately has a non-ancestor base, so defaulting it on would break
  ordinary PRs rather than catch attacks.
- **P1-6 — a CI approval was unbound and sticky.** It matched on rule (or
  rule:file) with nothing tying it to what was approved or when, and GitHub
  labels persist across `synchronize` — so a label earned for one benign
  deletion cleared every later one pushed to the same PR. The local ledger has
  always been fingerprint-bound; this channel was not. Approvals may now carry
  `@<head-sha>` (`tamperward:allow:test-deletion@a1b2c3d4`), and once the
  workflow supplies the head it is adjudicating, an **unbound label clears
  nothing** — the next push re-blocks. Workflows generated before this release
  pass no head and keep the old behaviour, so upgrading breaks nobody;
  re-running `tamperward init` opts a repository in.

Full suite 349/349; each exploit test verified to fail with its fix reverted,
with controls (honest history, different-head label, legacy behaviour) passing
both ways.

## [1.12.0] — 2026-08-31

**The P1 batch: four AUDIT-class findings, plus the supply-chain pin.**

- **P1-7 — a detector that threw was silently dropped from the verdict.**
  Repository content that makes a rule throw removed that rule and the gate
  reported "clean". Isolation is still right at the tool-call and turn hooks,
  where a thrown error already fails open in the runtime — but the
  *adjudicating* views (staged, worktree, range) now emit a blocking
  `detector-error` finding. A rule that cannot run is not a rule that passed.
- **P1-1 — verification wrote through symlinks, out of its own sandbox.**
  `statSync` follows links while `cpSync` preserves them, so a protected path
  replaced by a symlink was copied as a link and then written and chmod'd
  through it — landing base content and permissions on a file outside the
  repository, regardless of the verdict. Both the materialiser and the
  pristine overlay now drop a symlink before writing. The test watches a file
  outside the repo and asserts it is untouched.
- **P1-4 — the enforcement wiring was protected by nothing.** `init` installs
  hooks into `.claude/settings.json` and a pre-commit config; neither was in
  any protected glob, so editing the gate out fired no rule. They are in the
  `hooks` class now. `.git/hooks/**` is outside every git view and cannot be
  covered by a glob — that residual is recorded rather than implied away.
- **P1-5 — the shipped CI template never ran `verify`.** Diff-time detection
  is spelling-dependent by nature; pristine re-execution is not, and it was
  the layer nothing got past in the taskbench sweeps. Shipping a template
  without it meant every masked-failure class was adjudicated only at the
  local layer — the layer an agent shares a filesystem with. `init` now writes
  a second step running `tamperward verify --base <base sha>`, which fails
  closed without a `verify:` block rather than passing quietly.
- **P2-15 — the gate resolved itself, unpinned, at gate time.** The workflow
  now pins `tamperward@<the version that wrote it>` instead of `npx --yes
  tamperward`: a floating dependency in the one component whose job is
  integrity.

Full suite 342/342; every exploit test verified to fail with its fix reverted.

## [1.11.1] — 2026-08-31

**The suite runner is part of the trust anchor (P0-6).** `verify` symlinks
`node_modules` into both the visible and pristine copies. It is gitignored, so
no diff view sees it, and it is where the suite's own runner lives — an agent
that writes `node_modules/.bin/<runner>` replaces the program that decides both
verdicts. Reproduced: VERIFIED, visible and pristine both exit 0, with the
source bug sitting untouched in `src.js`.

The envelope now content-hashes the installed dependency tree before the agent
starts and again at adjudication; a change is `DEPENDENCY_DRIFT` (exit 1).
Content-hashed rather than stat-compared, because P1-8 is the standing lesson
that mtime and size belong to the agent. Measured 3.4s over 145MB / 5,453
files, inside a command that already runs the suite twice.
`--allow-dep-drift` accepts the risk explicitly, the same operator-owned escape
as `--allow-dirty`. Note the honest scope: `verify` itself is still fooled by a
substituted runner — the fingerprint is what catches it.

**Also fixed, found while building that fixture: a relative `--cwd` broke
verification entirely.** The copies' `node_modules` symlink was built from the
caller's cwd verbatim, so a relative one (`--cwd .`, which the envelope passed
through) resolved against the copy's own directory — every suite in both runs
exited 127 and `verify` degraded to permanent SUITE_RED. It fails closed, so
nothing was ever wrongly cleared, but an oracle that always says red is one
people switch off. Targets are absolute now, and the envelope resolves its cwd.

Full suite 338/338; every new test verified to fail with its fix reverted.

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
