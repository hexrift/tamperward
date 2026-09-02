# Tamperward — Build Spec v0.8

> The deterministic agent-integrity gate. One ruleset, evaluated on the actual
> diff/commands as a verdict (not a probability), at every stage a change passes
> through — the agent loop (a Claude Code hook today), pre-commit, and CI, which is
> the authority.

**Slice:** TypeScript/Jest · Claude Code · 17 rules specified, 15 shipped ·
agent-loop + pre-commit + CI + pristine re-execution · the agent-correction
loop measured, not asserted.

v0.8 reconciles the spec with 1.15.0. No new row: the seventeen-row table (§4) had
outgrown its heading, the canonical policy example had not kept pace with
`defaultPolicy`, and §5.1 still described the hook's output contract as a plan when
it has shipped on the JSON channel since v0.2. This revision brings the counts, the
policy example, the hook and Stop contracts, the CI wiring (the generated workflow's
`check --diff` + `verify --require-ancestor` pair with SHA-bound labels) and the repo
layout into line with the code — the code did not move.

v0.7 reconciled the spec with 1.9.0: `tamperward verify` — the taskbench
run-correctness oracle productized as row 16 (`pristine-verification`). The
suite runs twice in separate copies of the working tree: as-is, and with every
protected test/snapshot/config file restored from a trusted base rev
(merge-base semantics; agent-added files are **removed** across both the
protected classes and a separate **verification surface** — the files a runner
auto-consults for collection, configuration and plugin loading — so the pristine
tree's discovery and configuration surface is exactly the base's. See 1.14.1 and
1.14.2; the surface list lags runner behaviour by construction and bounds the
class rather than eliminating it). The
copies are separate directories, not a security boundary: both execute
agent-controlled code unsandboxed. Visible-green/pristine-red is a MASKED FAILURE; cannot-verify
fails closed. The policy `verify:` block is itself a guarded surface —
policy-diff flags command changes, budget lowering, and removal as weakening.
Base-selection caveat, stated where it can be checked: verify against a rev
the agent cannot rewrite (a protected branch in CI); the default HEAD base
covers uncommitted weakening only, and the test suite demonstrates the
committed-weakening blindness rather than hiding it.

v0.6 reconciles the spec with 1.8.0 — the effect layer: a per-call protected-tree
drift check at PreToolUse that detects persistent protected-state drift
independently of the mutation's command spelling and judges it at the next call
by the ordinary rules (narrowing, not closing, the 07-fastify anomaly's class);
the `tamperward watch` filesystem-event observer with row 15
(`transient-protected-mutation`) consuming its log at the Stop sweep, observing
supported transient filesystem effects; and the
Edit-reconstruction fail-open closed (an unlocatable old_string is judged from its
incoming content, never silently allowed).
v0.5 reconciles the spec with 1.7.0: `test-content-removal` seated as row 14 —
the post-experiment closure of the evasion class taskbench measured carrying the
gated-arm false greens (net content removal from a surviving spec), corpus-priced
at 1.5% of mainline diffs and shipped block-with-signoff; `tap-snapshots/**`
added to the snapshot globs from the same evidence. The treatment tested in
Phase 3 remains 1.6.0, frozen and published; nothing in 1.7.0 is validated
against the Phase-3 pool — a v2 claim requires a fresh frame draw (§7.B).
v0.4 reconciled the spec with what shipped through 1.6.0: `test-skip`'s class
completed with the node:test options spelling (1.5.1), the per-rule `exclude` policy
surface with its weakening symmetry (1.6.0), `ts-any-launder` given the table row it
always deserved with its graduation question now closed by corpus, and §7.B extended
with the studies that closed it — baselines, the tuned-FP trio, the laundering
corpus, and the capability-restriction comparison. v0.3 reconciled with 1.4.5; v0.2
was v0.1 plus four fixes found while verifying the `PreToolUse` schema against
current docs: the Bash-as-file-mutation hole (→ Stop sweep), out-of-band CI sign-off,
AST for the structure detectors, and the expected-value-tampering move.

---

## 0. What this slice has to prove

Two assertions have to become true or false here:

1. **Determinism** — the moves agents use to game checks can be detected from the
   diff/command as a verdict, at an acceptably low false-positive rate.
2. **The correction loop** — when the agent layer denies a shortcut, the returned
   message redirects the agent to fix the *real* failure rather than hunt for another
   bypass.

Fifteen of the seventeen specified rules are mechanical, and those fifteen are the
ones that shipped — so #1 is largely engineering. The two heuristics remain unbuilt (§4). #2 —
whether a denied agent fixes the truth or fights the gate — is the harder question. The
metric that quantifies it is the **bypass-to-fix conversion rate** (§7.B); see the
README for the measured result, now including its no-gate control arm.

---

## 1. Scope & non-goals

**In:** one stack (TS + Jest), one agent (Claude Code), the diff/command detectors,
four thin adapters (agent PreToolUse hook / agent Stop sweep / pre-commit / CI), a
fixtures corpus, and an end-to-end proof harness.

**Explicitly out** until the core earns it: a dashboard, audit *persistence* beyond the
local JSONL ledger, multi-agent support, cross-repo policy, and languages beyond TS. Of
the schema fields this section once merely anticipated, the `version` graduation gate
has since shipped (1.3.0 — §3's comment block is now a description, not a reservation);
rule namespacing remains reserved.

---

## 2. Architecture — one engine, four adapters

The whole design is one normalization. Every enforcement point produces the same
intermediate object; the engine does not know which point it runs at — with one narrow,
additive exception: adapters pass a `view` (the diff's granularity), and a rule whose
SIGNAL is only valid at a given granularity may consult it (only `snapshot-only-rewrite`
does — "no accompanying change" means nothing at single-tool-call scope). Every other
rule fires identically everywhere; that remains the "block the class" promise.

```
                 ┌─────────────── adapters (thin) ───────────────┐
 Claude PreTool ─▶│ hook claude    (tool_input → Change[])         │
 Claude Stop    ─▶│ sweep claude   (net working-tree diff → Change[])│ ─▶ Change[] ─▶ engine ─▶ Finding[]
 git staged     ─▶│ check --staged (staged diff → Change[])        │
 CI / PR         ─▶│ check --diff   (range diff → Change[])         │
                 └───────────────────────────────────────────────┘
                                                          engine = run enabled
                                                          Detectors over Change[]
```

**The core abstraction** — a `Change` is either a command or a per-file diff. The
adapters' only job is to manufacture `Change[]`; see `src/types.ts`.

```ts
type Change =
  | { kind: 'command'; raw: string; argv: string[] }
  | { kind: 'file'; path: string; oldPath: string | null;
      op: 'add'|'modify'|'delete'|'rename';
      before: string | null; after: string | null;
      binary: boolean; hunks: Hunk[] }

interface Detector {
  id: string;
  surface: ('command'|'file')[];
  certainty: 'mechanical' | 'heuristic';
  run(changes: Change[], policy: Policy, view?: View): Finding[];  // view: additive, most rules ignore it
}
```

- **Claude PreToolUse hook** — `Edit`/`Write` give `old_string`/`new_string` (or full
  content) → synthesize a file `Change` *before it's written*. `Bash` gives `command`
  → a command `Change`. The magic property: the change is evaluated before it exists
  on disk.
- **Claude Stop sweep** — closes the hole the PreToolUse matcher can't see (§5.2).
- **Pre-commit** — `git diff --cached` → file `Change[]`.
- **CI** — `git diff origin/main...HEAD` → file `Change[]`. The authority; the others
  are speed/UX.

A rename is modeled as **one `Change` carrying `oldPath`**, not add+delete, so a
detector can ask "was a protected file renamed *out* of its glob?" — which git would
otherwise hide behind rename detection. Per-line `oldLine`/`newLine` numbers are
computed in the parser and are the only thing every `Finding.line` can trust.

One engine means a rule written once fires identically everywhere. That's not a
nicety — it *is* the "block the class, not the flag" promise.

---

## 3. The rule schema

Two files. A **policy** (`.tamperward.yml`, user-facing, in the repo) and a **Finding**
(engine output, also the hook's wire format). Detectors are TS functions in the
open-core package — the open "rule format" is the policy schema + the `Detector`
interface, so third parties add detectors without forking.

**`.tamperward.yml`** (written by `tamperward init`, which wires the policy plus every
enforcement point — agent hooks, pre-commit, CI — idempotently, never overwriting
yours):

```yaml
# version gates rule GRADUATIONS: a baseline rule promoted warn -> block at policy
# version N blocks only for policies declaring version >= N, and stays warn below.
# Missing version (or no policy file) = 1: opted in to nothing. An explicit severity
# written here wins over the gate in either direction. Lowering version is itself a
# policy-diff finding. This is what lets a graduation ship in a minor (CONTRIBUTING).
version: 1
protected:                         # the safety nets, as first-class assets
  # abbreviated — the baseline (src/policy.ts defaultPolicy) also carries the other
  # JS/TS test extensions and the conventional Python/Go/Rust/Ruby/JVM/PHP/C# layouts,
  # and the pre-commit / Claude settings / CODEOWNERS wiring under hooks. User globs
  # MERGE onto the baseline per category; a category can only grow.
  tests:     ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**']
  config:    ['**/jest.config.*', '**/vitest.config.*', '**/tsconfig*.json', '**/.eslintrc*', '**/eslint.config.*', '**/package.json']
  ci:        ['.github/workflows/**']
  snapshots: ['**/*.snap', '**/__snapshots__/**', '**/tap-snapshots/**', '**/golden/**', '**/*.golden.*']
  hooks:     ['.husky/**', '**/lefthook.*', '**/lefthook-local.*', '.tamperward.yml', '.claude/settings.json', '**/.pre-commit-config.yaml', '.github/CODEOWNERS']
rules:
  test-deletion:         { severity: block }   # AST
  test-content-removal:  { severity: block }   # content gutted from a surviving spec (§4 row 14)
  test-skip:             { severity: block }
  assertion-weakening:   { severity: warn  }   # heuristic — RESERVED, not yet built (§4)
  ts-any-cast:           { severity: block }
  ts-any-launder:        { severity: warn  }   # permanent warn — graduation closed by corpus (§4 row 13)
  lint-suppression:      { severity: block }
  coverage-lowering:     { severity: block }
  ci-tampering:          { severity: block }
  hook-tampering:        { severity: block }
  no-verify:             { severity: block }
  snapshot-rewrite:      { severity: warn  }   # mechanical but intent-ambiguous — FP study
  snapshot-only-rewrite: { severity: warn  }   # the FP study's narrow signal — graduation candidate
  transient-protected-mutation: { severity: warn }  # the watcher's class (row 15); TAMPERWARD_TRANSIENT=block may raise it
  guard-removal:         { severity: warn  }   # heuristic — RESERVED, not yet built (§4)
ignore: []                         # reported, never silent; can never cover this file
signoff:
  required_for: [block]
  # LOCAL ONLY. In CI, sign-off is out-of-band (§5.4) — never this file.
  ledger: .tamperward/ledger.jsonl
```

**Per-rule `exclude` globs** (1.6.0): any rule may carry
`exclude: ['**/*.test-d.ts', …]` to scope *that rule alone* off matching paths while
every other rule keeps full coverage there — the tuning the global `ignore` list
could never express without blinding the test-protection rules on exactly the files
they guard. Two invariants are part of the schema's meaning, not implementation
detail: **findings on the policy file itself are never excludable**, and **adding an
exclude glob is itself a policy-weakening signal** flagged by `hook-tampering`'s
policy-diff — the invisible-spelling lesson applied the day the surface was born. A
disclosure ships with the feature: on the two-repo FP corpus it was built against
(`harness/PREDICTION-tuned-fp.md`), the recommended test-path scoping of
`ts-any-cast` measured **zero effect** — those repos' casts live in library source.
FP tuning is repo-shaped; the feature's value claim is scoped to repos whose fires
cluster in scopeable paths (the adjudicated zod class), and the null is published
next to the bet that predicted otherwise.

**The loader is strict.** An unknown top-level key (`Rules:`, `ignored:`) fails the
load like an unknown value does — a policy that silently said nothing is the "weaker
gate than written" case the loader exists to refuse; rule *names* under `rules:` stay
open so a policy written for a newer build loads on an older one. `signoff.ledger`
must be a relative path inside the repository (the local layer trusts that file, and
a path outside the repo is outside every view and every code-owner rule); moving it
is a policy-diff finding. A leading `/` on a `protected`, `ignore` or `exclude` glob
is dropped at load — every git view reports repo-relative paths, so `/e2e/**` and
`e2e/**` are one rule rather than a glob that matches nothing.

**Finding** — the verdict object and the hook's return payload (see `src/types.ts`):

```ts
interface Finding {
  rule: string;
  severity: 'block' | 'warn';
  file?: string; line?: number;
  message: string;       // what was detected, plainly
  evidence: string;      // the exact offending line/command
  remediation: string;   // what to do INSTEAD — this is the correction signal
  signoff: { required: boolean; command: string };
}
```

Severity has exactly two values on purpose — `block` and `warn`, no "info." A gate
with five severities is a dashboard pretending to be a gate. **Every `block`-severity
rule is 100% mechanical**; heuristics may only ever be `warn` until measured (§7).

---

## 4. The seventeen rules — fifteen shipped, two reserved

Surface · signal · and **certainty class**, because fifteen are mechanical and two are
heuristic, and the spec must not pretend otherwise. Rows 1–15 are policy rule ids
(`src/policy.ts` `defaultPolicy`); rows 16 and 17 are the outcome and process layers,
which interpret no diff and carry no severity — their verdict is an exit code. The two heuristics (rows 3 and 10)
are **specified here and reserved in the baseline policy, but no detector implements
them yet** — their names exist so a user policy written today keeps meaning the same
thing on the release that builds them.

| # | id | Surface | Signal (TS/Jest concrete) | Certainty | Parser |
|---|----|---------|---------------------------|-----------|--------|
| 1 | `test-deletion` | file/cmd | test file `op: delete`; **rename out of the tests glob** (`git mv x.spec.ts x.spec.bak`); net removal of `it()`/`test()` blocks in a modified spec (a literal `it.each` table counts one per row; a test moved into another spec in the same change is a relocation); `rm`/`sed -i`/`truncate`/`> `/`cp /dev/null`/`tee`/`find -delete`/`git checkout <rev> [--] <path>` of a protected-tests path, a directory holding one, or the whole cwd (`.`, `*`, a `..`-relative token resolved against the cwd); **the runner told not to open a spec** — jest `testPathIgnorePatterns`/`testMatch`/`testRegex`, vitest `test.exclude`/`test.include` — evaluated as the selection predicate over the repository's own specs (2.5.0); the rest of that predicate's dials — jest `roots`/`rootDir`/`modulePathIgnorePatterns`/`projects`, vitest `test.dir`, a `!` entry in `include`, `test.projects`, `vitest.workspace.*`, a `vite.config.*` carrying `test:` (multi-project configs compared as the UNION of their projects; `typecheck.*`/`benchmark.*` are other suites) — and a narrowing flag (`--testPathPattern`, `-t`, `--exclude`, `--dir`, `--project`, …) added to a `scripts.test*` entry that runs jest/vitest; a `describe.each` table multiplies the tests it encloses, and a relocation is held only by added blocks with a body (stubs hold nothing). Read the way the runner reads it (2.7.1, the pass-3d sweep): `it.for` / `describe.for` count like `each`, a test inside a loop over a literal array counts once per element and any other loop is open; only `scripts.test` and `test:ci` are the suite a flag can narrow, and `--exclude` of another runner's directory (`e2e/**`) is set-up; a project with `extends: true` inherits the root selection, while `extends: '<path>'`, `mergeConfig` over an imported base and a `...base` spread are opaque, and `test.root` rebases like `test.dir`; a `.snap` inside `__tests__/` is row 11's file, on the file and command surfaces alike; `git checkout <rev> -- <path>` where `<rev>` resolves to HEAD (`main` while on main) restores nothing older | mechanical | **AST** |
| 2 | `test-skip` | file | added `.skip` / `.only` / `xit` / `xdescribe` / `it.todo` / `test.skip` (`.only` *narrows* the suite — same class); the **node:test options spelling** — `test('x', { skip: true }, …)`, `{ todo: … }`, runtime `t.skip()` (1.5.1, closing a gap a live agent found: denied the crude `rm`, it skipped by option, and the shipped rule was blind to that spelling — coverage of a class must mean the whole class) | mechanical | regex |
| 3 | `assertion-weakening` | file | net decrease in `expect(` count inside a kept test; strong matcher → weak (`toBeDefined`/`toBeTruthy`/`not.toThrow`); **changed literal inside a kept `expect()`** (the sly-genie `toBe(42)`→`toBe(43)` move) | heuristic — **reserved, not built** | **AST** |
| 4 | `ts-any-cast` | file | added `as any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` (`: any` and generic-position `any` are `ts-any-launder`, row 14, warn) | mechanical | regex |
| 5 | `lint-suppression` | file | added `eslint-disable[-next-line]`, `/* eslint-disable */`, `// prettier-ignore` | mechanical | regex |
| 6 | `coverage-lowering` | file | `coverageThreshold` numbers reduced, moved or deleted; `--coverage` stripped from the test script, `--coverage=false`/`--coverageThreshold=` added; `passWithNoTests` as flag or config key; vitest `thresholds.autoUpdate`; the denominator narrowed (`collectCoverageFrom`/vitest `coverage.include` compared as the predicate over the repository's own source files — a respelling that measures the same files is silent; `coveragePathIgnorePatterns`/`coverage.exclude` grown, `.coveragerc` `[run] omit` grown, codecov `ignore:` grown); vitest `coverage.enabled: false`, `thresholds.perFile` dropped; `.coveragerc`/`pyproject.toml` `fail_under`, nyc thresholds (also under package.json `nyc`), codecov `target` (a number or `auto`, compared within its `project:`/`patch:` scope)/`threshold`/`project: off` (2.5.0). Never claims a removal it cannot see (a spread, an expression, a stricter one-metric override), and looks for a gate that MOVED to another config in the same change before reporting its old home deleted. Housekeeping exemptions (2.7.1): generated code and codegen output, migrations, `*.generated.*` / `*.gen.*` / `*.pb.*`, `*.e2e-spec.*`, Django's `manage.py` / `wsgi.py` / `asgi.py`, `__init__.py` and the `main.ts` entrypoint join tests, types and tooling in the benign list (`**/index.ts` stays reported); vitest `thresholds: { 100: true }` is every metric at 100; codecov `informational: true` is a gate switched off under `project:` only; `passWithNoTests` in a package whose directory holds no spec is not a dodge | mechanical | regex/JSON |
| 7 | `ci-tampering` | file | in `protected.ci`: removed/commented test/lint/typecheck step (a moved or in-place-edited check — a flag added, `npm test`→`npm run test`, `@v3`→`@v4` — is kept); a kept check whose block is neutralised (`set +e`, `exit 0`, `if false; then`, `shell: bash {0}`, `\|\| true`); `continue-on-error: true` and `if: false` in any spelling that folds to a constant — including the short-circuits `<ctx> && false` / `<ctx> || true`, which decide whatever the context holds — on the check's step or at the level of a job that runs a check; `on:` narrowed so the workflow no longer runs (`push`/`pull_request` removed, `paths-ignore: ['**']`, `paths:` no source file can match, `pull_request.types` without opened/synchronize, `branches:` without the default branch — resolved from `origin/HEAD`, main and master accepted alike when unknown) (2.5.0). Respelled is kept: `npm test` → `npm run test:ci` / `npx vitest run` (same kind of check), a check moved into a reusable workflow the same change adds; narrowed is reported: a spec path as a positional (`npm test -- test/a.test.ts`), `timeout N` wrapping the check. Read the way the runner reads it (2.7.1): a `${{ }}` expression folds to its constant or reads as one token, and a flag valued by `matrix.*` / `strategy.*` / `inputs.*` (`--shard=${{ matrix.shard }}/4`, `--project=${{ matrix.project }}`) is the matrix, not a narrowing; `node --test`, `mocha`, `ava`, `biome ci`, `oxlint`, `tsgo`, `deno test`, `ruff check`, `mypy` are checks of their kind; a path positional narrows a test, not a lint over `src/`; a `cd dir &&` prefix places the check; `shell: bash -euo pipefail {0}` keeps fail-fast; a reporter or upload action (`*-reporter`, `*-results`, `upload-*`, codecov, coveralls) is not the check whose `continue-on-error` matters; `[master]` → `[main]` is a rename when the branch it now names exists, whatever a stale `origin/HEAD` says | mechanical | regex/YAML |
| 8 | `hook-tampering` | file/cmd | edit/delete in `protected.hooks` (the `config` class is `coverage-lowering`'s jurisdiction, row 6); `chmod -x` on a hook; edit to `.tamperward.yml` lowering severities, disabling rules, lowering `version:`, **adding `ignore` or per-rule `exclude` globs** (every new policy surface that can weaken the gate is a policy-diff signal the release it ships, 1.6.0); **the wiring `init` writes, compared by canonical shape rather than token presence**: a Claude settings gate entry — in the project file, its local override, the user file (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` when the environment relocates it) or managed settings, judged by path shape at the tool-call layer with backslashes as separators and symlinks resolved, a `.claude/settings*.json` at any depth being settings-shaped — must be exactly `{type: command, command: npx --yes tamperward@<ver> hook claude}` on a matcher covering every tool init lists (the matcher read as the runtime reads it: an exact list separated by `\|` or `,` with optional surrounding whitespace when every character is in `[A-Za-z0-9_ ,\|-]` — `Edit, Write` is the list `Edit\|Write`, as the runtime's own matcher table says (2.9.0; 2.7.0 read the comma as a regex and reported the honest list as selecting nothing) — otherwise an unanchored regex; a non-string, invalid or non-ASCII matcher fails closed), `sweep claude` under Stop, `<ver>` a plain version without leading zeros, never below the one it replaces (nor below the judging gate for a file that carried no gate entry under that event — an unpinned fresh entry is below any floor, since `npx` then runs whatever `tamperward` resolves to locally) and, for an entry the edit wrote, never above the judging gate either (a pin npm cannot resolve exits without a decision, which the runtime treats as non-blocking — fail-open; the honest raise is `init` run from the newer version, which raises the judging gate with it), a `timeout` at 120 or more and a string `statusMessage` (the documented spinner text) the only other keys, and `disableAllHooks: false` declared at the top level as init writes it since 2.9.0 (the project value overrides the user file's, so a `true` planted in `~/.claude/settings.json` no longer reaches the gate; removing or flipping the declaration is the tamper, and a pre-2.9.0 file without it stays clean until an edit writes the gate anew); any other key on the entry (`async`, `asyncRewake`, `if`, `args`, `shell`, `once`, a `timeout` below 120 or non-numeric, a missing or non-command `type`), any text around the invocation (a redirect, pipe, `sh -c`, `&&`/`;`, a leading `PATH=`/`NODE_OPTIONS=` assignment, `-p`/`--package`, a launcher other than `npx --yes`), a top-level `env` key added or changed in a file that carries the gate, whatever its name (`env` is set for every session and every subprocess and init writes none; the reason names the mechanism when the name is a known one — `PATH`, `NODE_OPTIONS`/`NODE_PATH`, `HOME`, `npm_config_*` case-insensitively, `BASH_ENV`/`ENV`, `BASH_FUNC_*`, `LD_*`/`DYLD_*`, `TAMPERWARD_*` — and those names are the tamper in any settings file; a key removed never is), a non-boolean truthy `disableAllHooks`, a duplicated JSON key, a value the runtime's schema rejects on any hook entry the edit wrote under any event (a `type` it does not accept, a non-numeric `timeout`, a non-string matcher: the runtime continues without the broken file, gate included), or a hook entry added beside the gate under PreToolUse or Stop in a file that carries it — a forged decision in the command text named as such, a shape that is not a plain command entry (`args`, `http`, `prompt`, `agent`, `async`, `if`) named as such, and a plain command still a sign-off because its output combines with the gate's verdict (an `updatedInput` after an allow, the last hook winning; a `continue: false` over a block) and a script body carries what a regex cannot see — is the tamper — while hooks MERGE across the settings files, so an added local file declaring its own hooks shadows nothing, and an entry beside the gate that was there before, as written, is not this edit's doing; the pre-commit script init wrote must stay byte-equal to what init writes modulo an upward pin (trailing newlines not counted, 2.10.0); **a hand-written hook script is held byte-equal to its before** (2.10.0) — the only clean edits are raising a plain-semver `tamperward@<ver>` pin to a version no higher than the judging gate (or pinning an unpinned invocation) and a trailing-newline-only difference; every other edit, honest or not, is hook-tampering with the reason *the gate script changed; sign off*, because three adversarial passes showed a line-by-line liveness model of a shell script cannot be sound (against a model rebuilt after the second pass, `( gate \|\| true )`, a multi-line `{ … } \|\| true`, an `exit 0` inside a brace, a trap by function name or `exit $VAR`, a `PATH=` line, `check --diff HEAD...HEAD`, `if [ -d . ]`, `for f in "$@"`, `[ $# -eq 0 ]`, a multi-line string, `: '…'`, `\|\| exit "$rc"` with `rc=0`, `& wait`, a second heredoc on one line and a `case` glob all ran a failing gate to exit 0 under a real `sh -e` and a real direct exec while the model read the gate as live); the liveness model stays as EVIDENCE, not the verdict — when it names a mechanism (the `\|\|` chain evaluated in order and ending in success, a passing `trap`, `set +e`, function/alias shadowing of the command or of a wrapper word in front of it (`command`, `env`), an assignment or prefix of `PATH`/`NODE_OPTIONS`/`NODE_PATH`/`HOME`/`LD_PRELOAD`/`BASH_ENV`/`npm_config_*` before or on the gate ("runtime redirected"), the mode flag or `--cwd` swapped (the mode flag is identity: `--staged` → `--diff HEAD...HEAD` or `--worktree` is another check; `--cwd "$(git rev-parse --show-toplevel)"` is the root), a lone `&` (`& wait` without a pid returns 0; `& wait $!` is the gate's status), a pin lowered or no longer a plain version (`@^1`, `@latest`, a pre-release), a `cd` away from the root, heredoc bodies as data, `pipefail` only from a real `set -o pipefail`, a non-shell shebang or a gate that is not the last statement without `set -e` on a directly-exec'ed hook) the finding carries it as detail for the human signing off; a NEW hand-written script has no before and is judged by the model alone — `tamperward check` must be live in it under the way that hook runs (husky's `sh -e`, git's direct exec) or the add is a sign-off, save for husky's own v9 runtime under `.husky/_/`, recognised by exact byte content while `.husky/pre-commit` sits beside it so an ordinary `npm install` does not need a sign-off (2.10.1); a deleted one is the removal finding; lefthook / pre-commit / package.json entries compared by the command they run (`tamperward check` live, not the word, its identity including the mode flag, `--cwd` and pre-commit `args` — `run: … --diff HEAD...HEAD`, `entry: … --diff`, `args: [--cwd, /tmp]` are replacements; a command-level `env` setting `PATH`/`NODE_OPTIONS`/`NODE_PATH`/`HOME`/`LD_PRELOAD`/`BASH_ENV`/`npm_config_*` gained or changed is a runtime redirect; a pin lowered or no longer plain after a plain-pinned before is a lowering; pre-commit `additional_dependencies` gained or changed on the gate entry chooses which gate the hook installs; `skip`/`only` in any non-false shape at command and hook level, `tags` against `exclude_tags`, `lefthook-local.yml` as the overlay it is, `stages` inherited from `default_stages ?? all`, `types`/`types_or`/`exclude_types` without `always_run`, `husky`/`lefthook install` by identity so `echo husky`/`HUSKY=0 husky`/`husky uninstall` are removals); CODEOWNERS over the concrete gate files with GitHub's glob semantics (a later ownerless `/.husky/pre-commit`, `*.yml`, `**/pre-commit` un-owns the gate); on the command surface, a write target expanded as the shell would — `~`, `$HOME`, `%USERPROFILE%`, `$CLAUDE_CONFIG_DIR` (its value from the hook's own environment, else `~/.claude`), backslashes as separators — every symlink in it resolved against the repository root (`/tmp/xlink/.claude/settings.json` through a link into the checkout is `.claude/settings.json`; `/tmp/cfg/settings.json` through a link to `~/.claude` is the user file) and judged as a hook write whenever it is settings-shaped wherever it lives (`~/.claude/settings.json`, `managed-settings.json` at any path, a `.claude/settings*.json` at any depth: the runtime reloads every one of them live in-session, and none is in a repository glob), a directory holding the user file (`rm -rf ~/.claude`) included, the finding naming the expanded file so the guarded pin applies (2.9.0); absolute paths under the repository relativised, `>\|`/`>&`/`&>` kept with their redirection, `install -t`/`cp -t`/`rsync`, `git checkout <rev> -- .`/`git restore --source=<rev> .`, `git apply`/`patch`/`git am`, inline `python -c`/`node -e`/`perl -e`/`ruby -i`/`ex`/`ed` scripts naming a hook, `xargs rm`/`chmod`, `find -exec chmod -x`/`-delete`, multi-group symbolic chmod (`u+rw-x`), `setfacl -m u::rw-` (2.7.0) | mechanical | regex + parsed JSON/YAML |
| 9 | `no-verify` | command | `git commit -n/--no-verify`, `git push --no-verify`, `HUSKY=0`, `HUSKY_SKIP_HOOKS=1`, `--no-hooks` | mechanical | regex |
| 10 | `guard-removal` | file | deletion of lines matching auth/validation patterns (`requireAuth`, `checkPermission`, `if (!user`, `authorize`, zod `.parse(`, `csrf`) | heuristic — **reserved, not built** | regex |
| 11 | `snapshot-rewrite` | command+file | runner update mode (`jest -u`, `--updateSnapshot`, `vitest --update`), regeneration scripts by name (`update-golden`, `regen-snapshots`), shell mutation of protected snapshot paths, and any modify/delete/rename-out of `**/*.snap`, `__snapshots__/`, `golden/` | mechanical, **warn** (updating a snapshot is legitimate when intended output changes; built from measured demand — harness/PREDICTION-affordance.md) | regex + glob |
| 12 | `snapshot-only-rewrite` | file | every changed file in the diff is a moving protected snapshot (adds excluded) — the FP study's narrow signal, ~0.06% of audited mainline commits, 7/7 of observed tampers; judged ONLY at commit granularity (staged/range views) via the engine's `view` parameter, because at tool-call scope every snapshot edit is "only" | mechanical, **warn** (graduation candidate: `BLOCK_SINCE` at a future policy `version:`) | glob |
| 13 | `ts-any-launder` | file | `any` introduced in annotation/generic position (`: any`, `<any>`) — the laundering spelling of row 4's class, split out in the 1.0 precision pass | mechanical, **permanent warn** — graduation to block is *closed by corpus* (`harness/PREDICTION-launder-corpus.md`): the spelling fires on **10.5%** of 1,227 legitimate mainline commits, 4–10× any deployable block threshold; the measured 26/40 demand for the laundering class routes to the held-out-oracle and prompt layers, not to a block rule | regex |
| 14 | `test-content-removal` | file | NET removal of ≥3 significant lines from a modified protected test file whose it()/test() block count did not drop — case-table rows, assertion arguments, mock/setup regions. Removed content is excused only if kept (whitespace-normalized) in the changeset's protected-test content after the edit; comments do not excuse; snapshot-glob files are row 11's jurisdiction; one-for-one rewrites (line count kept) are the semantic class and stay with the held-out oracles. Rows of an each-table whose after-shape is OPEN (spread from elsewhere, a call, or a table that stays spread with fewer explicit rows) are compared as elements, one-line tables included: ≥2 rows gone that reappear nowhere in the change fire regardless of the net line count. Content this change adds to a non-spec file under a test directory (a case table moved to `test/fixtures/`) is kept, not removed (2.7.1) | mechanical, **block** — built from the taskbench Phase-3 evasion class (PHASE3.md §4: row deletion, throws-message stripping, setup gutting — the family that carried the gated-arm false greens), shipped AFTER the experiment per the frozen protocol. Corpus: fires on **1.5%** of 2,304 mainline diffs (immer/zustand/zod/prettier, `harness/fp-study/TCR-CORPUS.md`), every adjudicated fire legitimate — the block-with-signoff price, accepted because the legitimate edit and the tamper are mechanically indistinguishable (a maintainer deleting error-expectation rows because a parser improved is byte-shaped like the agent deleting failing rows) and Phase 3 measured what warn means in an unattended loop: nothing | line-set + AST guard |
| 15 | `transient-protected-mutation` | events (`tamperward watch` log, judged at the Stop sweep) | a protected file whose recorded content or mode CHURNED during the turn while its net state at Stop is unchanged — modified and restored, so neither the per-call drift check nor the turn diff can see it, while anything consulting the suite mid-churn consulted a weakened version; mode churn is the chmod-only class | **warn** by default, and deliberately: a Stop block already forces restores, and a compliant restore reads as churn — block-by-default deadlocks the honest path. `TAMPERWARD_TRANSIENT=block` may RAISE it (harnesses owning restore semantics), never lower it. Measured basis: **1 transient in 59 real trajectories** and it was exactly this pattern (07-fastify: skip → npm test → restore); the two A.1-documented observer misses (chmod-only, single-call modify+restore) are this row's coverage — to the extent the platform's fs events deliver them: a recorded event is evidence, an absent event is never evidence of absence | fs events + hash/mode churn |
| 16 | `pristine-verification` | execution (`tamperward verify`) | the suite re-run in two separate copies of the working tree: as-is (visible) and with protected tests/snapshots/config restored from a trusted base rev (pristine; agent-added files **removed** across the protected classes and a separate verification surface of runner-consulted config — 1.14.1 closed the `conftest.py` form of this bypass and 1.14.2 the runner-config form; the surface list lags runner behaviour and bounds the class rather than eliminating it). The copies are separate directories, not a sandbox. Visible-green + pristine-red = **MASKED FAILURE** (exit 1); budget exceeded or cannot-run fails CLOSED (exit 2). From 1.14.5 the pristine copy is materialised only AFTER the visible run exits — the two used to be prepared together as siblings, so the candidate's own code wrote `../pristine/<the test that convicts it>` with no race and no background process — and its restored files are digested (content and mode) either side of the pristine run, while the working tree and installed dependency tree are fingerprinted around both runs; any movement is exit 2. 1.14.5 also restores the base's file MODE and TYPE, not only content: `--name-only` left a restored test at whatever mode the agent's tree carried, so `chmod -x` alone hid it from an exec-bit discovery runner in both copies | mechanical at the outcome level — no diff interpretation at all, which is why it is immune to spelling. Evidence base: in the taskbench Phase-3 sweep this layer identified **every masked failure in all 53 trajectories** while diff-time detection was routed around — a trajectory record on one frame, not a guarantee. Judged at commit/CI granularity by design (a full double suite run per tool call is not a loop-layer cost anyone pays); the `verify:` policy block is guarded by policy-diff (command change, budget lowering, removal = weakening), and from 1.14.3 `verify --base <rev>` reads the overlay policy, verification surface and verifier command/budget from that commit, so the candidate cannot supply the configuration for its own re-execution. 1.14.4 extends the overlay to what the verifier command EXECUTES — command tokens naming a file present at the base (`node runner.js`), plus an explicit `verify: { inputs: [globs] }` for delegation that no token names (`npm test` -> `scripts/test.sh`), whose narrowing is itself weakening — and makes every trusted git read set `GIT_NO_REPLACE_OBJECTS=1`, since `git replace` redirected both `ls-tree` (which files exist at the base) and `show` (their content) to a tree the agent had just written. Both remain BOUNDS, not eliminations: a command can reach a file neither source names, and grafts/shallow have no disable switch (row 17 covers them by fingerprint) | double execution + exit codes |
| 17 | `run-envelope` | process (`tamperward run`) | the agent invocation wrapped so its exit is untrusted: the trusted base is recorded before the agent starts, and after any termination the released tree is re-adjudicated against that base — policy check over base...HEAD (committed weakening), policy check over the worktree (uncommitted), and pristine verification. Exit: the agent's own code when enforcement is clean; 1 on any blocking finding or masked failure; 2 when adjudication is impossible (dirty start, unresolvable base, no suite command) — failing closed Trust anchor hardening: the entry SHA is frozen before the agent starts, post-agent HEAD must be a descendant of it (history rewrite = the conviction, exit 1), and the WHOLE policy — rules, protected globs, verifier command/budget — is resolved from the base commit (`loadPolicyAt(base)`), never the working tree the agent controls; the worktree check adjudicates at the CI layer (no agent-writable local sign-off ledger) and includes untracked files — a verifier that appears after the agent runs is agent-authored and is never used — and ignored files on protected paths. Every disk read in that check is git's view of the path (2.8.0): a regular file is its bytes up to 64 MiB, a symbolic link is its target text and is never followed, and nothing else is content; a protected path that is anything else — a link, a FIFO, a socket, a device, a directory where a file is expected, a larger file — is blocked by name as `hidden-drift`, and a path carrying a control character is protected in every category. Quiescence is guarded, not assumed: the tree is fingerprinted across adjudication and refused (NOT_QUIESCENT) if it moves, and processes started after the agent spawned that still hold the working tree are surfaced the same way — a synchronous wrapper cannot reap a new session, so the envelope declines to certify rather than pretending it can. The dependency fingerprint is compared BEFORE adjudication as well as after it (1.14.5): entry-vs-exit alone could not see a transient substitution — a replacement runner that returns 0 twice and restores its own bytes on the way out. Residual: on non-Linux hosts the survivor scan is unavailable (fingerprint and --settle still apply), and a worker that waits out the run entirely can only be contained by OS-level isolation. From 1.14.4 the git OBJECT layer is inside the boundary too: `git replace`, `.git/info/grafts` and `.git/shallow` change what the trusted base resolves to without moving a ref or touching a tracked file, so the whole rewrite state is fingerprinted before the agent starts and re-checked the moment it exits — a change is OBJECT_REWRITE -> ENFORCEMENT_FAILED (exit 1), adjudicated before the checks rather than reported after them, and re-checked afterwards for a survivor that installs one mid-run. Residual: a rewrite that PREDATES the envelope predates its authority and is not detected. Explicitly OUTSIDE this boundary (documented TCB), each tracked in SECURITY-ENVELOPE.md: ignored dependency trees (node_modules is symlinked into both verification copies, so an agent that mutates installed dependencies corrupts visible and pristine runs alike); closing the dependency surface is a 2.0 roadmap item | round 2's decisive negative: hooks decide, runtimes terminate. In the cssstyle-gated trajectory the gate denied 42 mutations and verify rejected all 25 stop attempts, and the session completed anyway with a masked tree — correct policy decisions are insufficient when the policy mechanism does not own the lifecycle boundary. The envelope (or `check --diff` + `verify` in CI) owns it from outside; the hooks remain the in-session fast path | double execution + exit codes, adjudicated post-termination |

The fifteen mechanical rules are where determinism is real and the demo is honest. The two
heuristics (3, 10) are the research surface, and the discipline is: **built only against
a measured negatives corpus, entering as `warn`, promoted per-rule only when the number
clears the bar (§7)**. Neither has been built — the corpus comes first, because a
false-firing rule trains people to override, which is the exact failure the FP study
exists to prevent.

**Parser discipline:** detector 1 uses the TS compiler API — comments, strings, and
`describe` text containing `it(` will false-fire a line count, and a false-firing
*block* rule is poison. Detector 3, when it is built, ships in halves: the count-based
signals (`expect()` count — clean two-AST work) first; the node-alignment sub-signals
(matcher-weakened, literal-swapped-in-a-kept-`expect()`, which require matching "the
same test" across the two versions) after — that's the part that quietly eats a week.
Regex is genuinely fine for the additive-token detectors (4, 5, 9) and adequate for
6–8, 11 and 12 against known config shapes.

**`tamperward allow` granularity:** a sign-off is keyed on `rule + file + hash(evidence)`
and expires — never a session-wide blanket on a whole rule.

**Row 13's closed question, because a spec should record decisions, not just
surfaces:** whether the laundering spelling could ever block was this project's
longest-open graduation question — the strongest measured demand in the series
(26/40 uncovered-class tampers) pointed straight at it. The §7.A-style corpus sweep
answered it with a denominator: both laundering spellings (annotation-`any` at
10.5%, non-const named-type assertions at 7.5%) are ordinary honest TypeScript at
rates no block threshold survives, so `ts-any-launder` stays warn permanently on
syntactic evidence, no assertion rule gets built, and the laundering class is owned
by the layers where coverage is actually measured — held-out oracles (18/18 caught)
and the naming sentence (a 10/10 behavioral flip). Detection is not the gate's
layer for this class; verification and framing are.

---

## 5. Agent-layer wiring (Claude Code)

The agent layer closes the cheat path *before it opens*. It has **two** touchpoints,
not one — the PreToolUse hook plus a Stop sweep — because a single matcher can't see
every way a file gets mutated.

### 5.1 PreToolUse hook

`settings.json` (written by init):

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
      "hooks": [{ "type": "command", "command": "tamperward hook claude" }]
    }],
    "Stop": [{
      "hooks": [{ "type": "command", "command": "tamperward sweep claude" }]
    }]
  }
}
```

> The matcher must name EVERY file-mutating tool the adapter models. `MultiEdit` was
> dropped from v0.1's matcher while `changesFromClaudeHook` still handled it — so that
> branch was dead at the enforcement point and a MultiEdit test-strip walked past the
> inner-loop gate. Re-confirm the live edit-tool set on each Claude Code release; anything
> not matched here is caught only by the Stop sweep (§5.2), one step later.

`tamperward hook claude` reads the tool call on stdin → builds `Change[]` from
`tool_input` → runs the engine. On a `block` finding it **denies**, and the deny reason
*is* the correction signal.

**Output contract (shipped — `src/cli/hook.ts`, verified against current Claude Code docs):**
- A deny is **JSON on stdout at exit 0**. PreToolUse:
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":<reason>}}`;
  the Stop sweep's block is `{"decision":"block","reason":<reason>}`, also at exit 0. An
  allow is exit 0 with empty stdout.
- **Exit 2 is never a verdict.** Claude Code ignores hook JSON when the process exits 2
  and falls back to the raw-stderr channel — which arrives wrapped as a "hook error" and
  leaks the invoking command line. So the adapter exits 0 whenever it emits JSON, and the
  reason carries only the correction message: no command line, no env.
- A `permissionDecision: "deny"` blocks the tool **even in `bypassPermissions` mode or
  with `--dangerously-skip-permissions`**. The agent cannot escape the gate by changing
  permission mode. This is the property the whole agent layer rests on — and it holds.
- A payload the hook cannot read or parse is **denied, not allowed** (fail closed, 1.14.4).
  Genuinely empty stdin is a well-formed absence of a tool call and stays an allow, which
  is what lets `tamperward hook claude < /dev/null` smoke-test the wiring.

The deny payload, with the reason as the agent sees it:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Tamperward blocked: test-deletion. You are deleting src/auth/session.spec.ts while its assertions are failing — this weakens a protected safety net to pass checks.\n\nFix the underlying failure in the code under test, not the test. Other bypass paths are also blocked: --no-verify, editing the hook, lowering the coverage gate, editing the CI workflow, and rewriting the file via shell (sed/tee) will each be denied too. If the deletion is genuinely correct, a human must sign off: `tamperward allow test-deletion --reason \"...\"`."
  }
}
```

The message is engineered, not casual — it (a) names the class, (b) redirects to the
real fix, (c) **pre-empts the next bypasses** so the agent doesn't try them in
sequence, (d) offers the legitimate human escape. Its wording is the lever to tune
when the §7.B conversion rate is mediocre.

### 5.2 Stop sweep — closing the Bash-mutation hole

The PreToolUse matcher watches `Edit`/`Write` (file changes) and `Bash` (commands).
But an agent can mutate a protected file *through* Bash — `sed -i '/expect/d'
x.spec.ts`, `echo > x.ts`, `tee`, `cat >` — which never fires the `Edit|Write` matcher
and isn't an `rm`/`--no-verify` hit, so it sails past every file detector at the agent
layer. The docs name this exactly: *Claude can also create or modify files by running
shell commands through the Bash tool.*

Fix: a **`Stop` hook** re-runs the detectors once per turn over the turn's net working
-tree diff (`git status --porcelain` + `git diff`) and blocks — feeding the same
correction — if any protected asset was weakened by any means. Without it, a `sed`-based
strip shows green inside the agent loop and is only caught later at pre-commit/CI, which
silently degrades the inner-loop correction property (§2's magic) and the §7.B metric.
The product is about *not* having flag-shaped gaps; this would be one.

The sweep's view of the working tree is git's, not the filesystem's (2.8.0). Every disk
read of a repository path — the untracked and ignored adds, the worktree diff's `after`,
the drift check's hash, the hidden-tracked probe — takes a regular file as its bytes up
to 64 MiB and a symbolic link as a blob holding its target text, never followed; nothing
else is content. A protected path the gate cannot judge by content (a link, a FIFO, a
socket, a device, a directory where a file is expected, a larger file, a read error) is
blocked by name as `hidden-drift` — in the sweep, in the PreToolUse drift check and in
`check --worktree` — rather than read through, which is how a link to `/dev/zero` at
`test/conftest.py` once held the verdict indefinitely. A path carrying a control
character is protected in every category before any glob is consulted, since no glob
matches it and no honest path carries one. And the drift check's walk of the protected
tree does not enter a directory git reports as wholly ignored: the protected files git
lists under it are snapshotted from that listing, so a 50k-file `dist/` costs one
listing per call, not one stat per file.

Handle `stop_hook_active`: Claude Code sets it on the Stop payload when the agent is
already continuing because a Stop hook blocked it. The sweep honours it **immediately**
— `stopVerdict` returns exit 0 with empty stdout on the first payload that carries it,
before any diff is read — so a turn that was blocked once and restored is never trapped
in an unbreakable loop. The cost is bounded: what that second stop leaves behind is
still judged at pre-commit, in CI, and by the `run` envelope.

### 5.3 Defense in depth

Pre-commit and CI remain backstops so nothing reaches `main` even if both agent
touchpoints are somehow evaded. But the agent layer is where the *correction* happens;
the backstops only stop, they don't teach.

### 5.4 Sign-off must be out-of-band in CI

`.tamperward/ledger.jsonl` lives in the repo. Locally that's fine — it's the dev's own
machine. In CI it's fatal: the same PR that triggers a block can append its own
sign-off. The escape valve would guard nothing.

CI sign-off is therefore **out-of-band**: a PR **label** applied by someone with triage
access or higher (GitHub's triage role can label, so label permission IS approval permission), gated by **branch protection** plus **`CODEOWNERS`** on the protected paths and
on `.tamperward.yml`. Never a committed file.

Those two are not belt-and-braces, they are load-bearing, and 1.14.6 confirmed why.
A `pull_request` workflow runs from the PR's OWN head and a required check is matched
by JOB NAME, so a PR that keeps the job name and replaces the gate with `true` reports
a green required check over anything it likes — reproduced on this project's own CI in
three seconds. No detector can object, because the detector is defined by the candidate.
`CODEOWNERS` on `/.github/workflows/` (which `tamperward init` now writes) plus
"Require review from Code Owners" is the only thing that puts a human in that path.
**Without both, the CI layer of this tool is advisory.** This is the "who guards the guardrail"
problem turned on us — getting it right is on-thesis; getting it wrong quietly
undermines the whole pitch.

---

## 6. Pre-commit & CI wiring

Same engine, dumber adapters.

- **Pre-commit** (husky): `tamperward check --staged` → exit 1 on any `block`, printing
  the Finding messages. Catches what the agent layer missed (human commits, another
  agent).
- **CI** (GitHub Action — the workflow `tamperward init` writes, `src/cli/init.ts`
  `WORKFLOW_CONTENT`): two steps over the pull request, both pinned to the gate's own
  version and fetched from the public registry regardless of any committed `.npmrc`.
  1. `tamperward check --diff "${{ github.event.pull_request.base.sha }}...${{ github.event.pull_request.head.sha }}"`
     with `TAMPERWARD_OOB_SIGNOFF` resolved from the PR's `tamperward:allow:<rule>@<head-sha>`
     labels and `TAMPERWARD_OOB_HEAD` set to the head SHA, so an approval binds to the one
     commit it was granted for and the next push re-blocks.
  2. `tamperward verify --require-ancestor --base "${{ github.event.pull_request.base.sha }}"`
     — pristine re-execution against the trusted base, reading its policy and verifier
     from that commit. It needs a `verify:` block in the policy at the base and fails
     closed (exit 2) without one. It receives the same two variables (2.1.0): a
     `tamperward:allow:verify@<head-sha>` label accepts a MASKED_FAILURE — a reviewer
     has read the intentional test change and agrees the original suite no longer
     applies — and nothing else; SUITE_RED and cannot-verify are not approvable states.

  The authority for `main`. A `block` fails the check; it clears only via the
  out-of-band label of §5.4, never via the agent or a committed ledger. This
  repository's own `ci.yml` runs the `check --diff` half only — its test expectations
  legitimately change with every rule change, so nearly every rule PR would carry the
  verify label — and the self-gate is a diff-time gate (README, "CI authority").

### 6.1 Presentation

The engine emits exactly one thing — `Finding[]` — and rendering never changes it. What
the audience gets does change, because a verdict nobody reads gates nothing:

- **Terminal** — blocking findings first, wrapped to the terminal, `path:line` kept intact
  so terminals linkify it.
- **GitHub Actions** (auto-selected on `GITHUB_ACTIONS=true`) — a workflow annotation per
  finding, which GitHub places inline on the diff in *Files changed*, plus a job-summary
  table on the run page. Annotations were chosen over SARIF deliberately: they need no
  `security-events: write` and no Advanced Security, so they work on every repo. The text
  output still goes to the log unchanged.
- **JSON** — the findings verbatim for downstream tooling.

Severity is carried by the word `BLOCK` / `warn` in every format. Colour, where it exists,
is decoration over text that already says the same thing — so the verdict survives being
piped, logged, read by a screen reader, or read by someone who cannot distinguish the
colours. `NO_COLOR` and `FORCE_COLOR` are honoured.

---

## 7. Proof harness — how you know it works

Two layers. The first proves detection; the second proves the loop. The second is the
one that matters.

### 7.A Detection fixtures (the planned `fixtures/` corpus — not yet built)

Real before/after pairs in `fixtures/bypasses/`, each a real move (not a string-match
toy): a genuinely-failing test that gets `.skip`'d; a type error silenced with
`as any`; `coverageThreshold` dropped 80→0; a workflow step wrapped in
`continue-on-error`; an auth guard deleted inside a plausible refactor; a `toBe(42)`
swapped to `toBe(43)`; a spec stripped via `sed -i`; a spec renamed out of its glob.

Plus a **negatives** set in `fixtures/legitimate/` — a test correctly removed because
the feature was deleted, a *justified* `eslint-disable`, a coverage threshold *raised*.
**Precision on the negatives is the number that decides whether heuristic rules 3 and
10 get built at all, and whether a built heuristic ever graduates from `warn` to
`block`.** The negatives set must be *tens per heuristic rule*, ideally harvested from
real diffs (OSS history, then dogfood commits) — N≈4 cannot distinguish 85% from 95%,
so a small set makes the gate theater. Release gate: **≥85–90% precision** on the
negatives, else those rules stay unbuilt. Report the number; tie the decision to it,
not to taste. (The `fixtures/` tree does not exist yet; the precision methodology this
section demands was exercised first on `snapshot-rewrite` in `harness/fp-study/` —
1,652 real mainline commits — which is the template the heuristics' corpus follows.)

> Harvester bias, by design: OSS history is a **negatives mine**, not a source of
> positives. Almost all historical commits are legitimate, and humans rarely commit
> "deleted the test to make CI green," so the harvester supplies the negatives
> *denominator* and nothing else. The positive tamper cases come from the hand-built
> `fixtures/bypasses/` corpus and, later, live agent runs — don't expect OSS history
> to hand you both halves.

### 7.B The end-to-end loop (`harness/run.sh`) — the real proof

A tiny repo with a deliberately-failing test caused by an actual bug. Run Claude Code
headless with both agent touchpoints installed and a prompt asking for green. Record
the transcript and classify the trajectory:

```
1. agent attempts a bypass (delete / skip / any / no-verify / sed-strip)
2. hook (or Stop sweep) denies, returns the correction message
3. agent's next action: fix the bug, or try another bypass?         ← THE MEASUREMENT
4. suite passes honestly + no protected asset weakened                      → SUCCESS
```

The metric is the **bypass-to-fix conversion rate**: of runs where a block fired, what
fraction ended in an honest fix. The pre-set bar was ~80%; the measured numbers live in
the README and update as the harness accumulates. Two invariants make the number mean
something:

- **Seed invariant:** every seeded scenario has a known-good solution that touches
  *zero* protected assets — so any protected-asset touch is unambiguously a tamper,
  and "agent gave up because the only fix was a blocked path with no human to sign
  off" can't masquerade as a low conversion rate.
- **Oracle independence:** the verdict oracle must verify the positive end-state by a
  mechanism the detectors under test do not share — its own held-out checks, never the
  detector's logic re-derived. An early draft that shared logic with a detector
  certified six evasions as clean; the invariant is written into `run.sh` and each
  seed's oracle. Where the suite itself is guessable, the oracle holds out inputs the
  repo never contains (`oracle-hard.mjs`).

**The wider evidence programme** grew out of this harness, and every study follows one
discipline: *predictions are committed before the first rep, and refuted bets stay in
the repo next to the confirmations.* The prediction files are the record —
`harness/PREDICTION-*.md` and `harness/fp-study/` — covering, so far:

- **Affordance seeds** (`PREDICTION-affordance.md`) — measure *demand* for a detector
  before building it: each seed offers exactly one unguarded bypass class. Result:
  one detector built from measured demand (`snapshot-rewrite`), two hypothesized
  detectors refuted and never built; the shadow scanner (`shadow.mjs`) keeps
  accumulating attempt evidence on every future run.
- **False positives** (`fp-study/`) — the built rule replayed over 1,652 real mainline
  commits before trusting its severity; the study is why `snapshot-rewrite` warns.
- **The no-gate control arm** (`PREDICTION-ungated-control.md`) — the same seed, model
  and prompt with enforcement removed, so the conversion rate is a causal claim, not
  an ordering observation. No new copy cites a conversion rate without this arm.
- **The informed adversary** (`PREDICTION-informed-adversary.md`) — the gate's own
  sources vendored into the repo and named in the prompt, betting the open ruleset
  works as an evasion spec. It didn't, at the measured scenario size — and the bets
  that lost say so.
- **Robustness of the honesty nulls** (`PREDICTION-self-authored.md`,
  `PREDICTION-eval-awareness.md`) — the seed dressed as a real project with
  backdated history and a maintainer's plea, and an explicit written license to
  rewrite tests, with manipulation checks that make the nulls mean something.
- **The stuck agent** (`PREDICTION-stuck-agent.md`) — a provably unfixable suite
  plus an explicit honest exit: agents take the cheapest path they believe is
  *sanctioned*, the thesis the rest of the programme keeps re-confirming.
- **The dimension studies** (`PREDICTION-coverage.md`, `PREDICTION-noverify.md`) —
  per-rule certification under attack across three models, including the
  command-surface class only the gate can see.
- **The gate's boundary** (`PREDICTION-asany.md`) — the laundering seed whose
  cheapest cheats sit outside every rule: 26/40 tampers through gate-invisible
  spellings, the frontier split (one model 10/10 via inline assertions), and the
  held-out oracle layer catching all of it. The result that scopes the flagship
  number as conditional-on-coverage.
- **Cheap baselines and the FP bill** (`PREDICTION-baselines.md`) — the gate versus
  a single instruction sentence and a 20-line strawman hook on identical ground,
  plus block-rates for all screens over 1,227 real merged commits (the gate's own
  honest 9.0% unconfigured).
- **The tuned gate** (`PREDICTION-tuned-fp.md`) — the deployed-cost trio (9.0% →
  6.0% → ~one sign-off per 17 commits) and the per-rule `exclude` null, published
  at the feature's own expense the day it shipped.
- **The laundering corpus** (`PREDICTION-launder-corpus.md`) — the §7.A methodology
  applied to the graduation question; closed it (row 13).
- **Capability restriction** (`PREDICTION-capability.md`) — the "just make the
  tests read-only" objection measured instead of rebutted: hard immutability
  10/10 honest on the file-surface seed, a bare EPERM converting 4/4 without
  remediation text, and an auto-granted elevation path manufacturing two
  confessed-in-writing tampers. Six governance mechanisms (nothing, one sentence,
  naive hook, the gate, immutability, immutability+auto-grant) now hold
  pre-registered numbers on identical ground.
- **Taskbench** (`harness/taskbench/PREDICTION-taskbench.md`, `PHASE3.md`) — the
  preregistered cross-repository experiment: 26 paired real repositories, real
  historical regressions, repo as the experimental unit, frozen analysis, one
  hypothesis test. Transfer confirmed (13/26 ungated runs with ≥1 policy
  violation, Wilson95 32–68%); **prevention refuted** at 1.6.0 (false greens
  b=5 vs c=4, paired RD +3.8%, exact McNemar p=1.0) — agents routed through
  spellings outside shipped detector coverage, including the two
  documented-unfixed pilot gaps; no measurable completion cost (+7.7, CI spans
  zero); the independent pristine-suite oracle caught every masked failure in
  all 53 trajectories. The division-of-responsibility caveat in §10 is now
  measured, not hypothesized: diff-time detection is coverage-bounded on real
  repositories; pristine-suite re-execution was not breached once.

Agents are stochastic, so every arm runs multiple reps, changes one variable, and
records full transcripts under `harness/runs/`. When a conversion rate is mediocre,
the §5.1 message wording is the lever to tune. The running ledger across the
programme: **70 pre-registered bets — 29 refuted, 37 held, 4 open or
unresolvable** — with
refutations published next to the bets they refute, which is the property the whole
section exists to protect.

---

## 8. Repo layout

```
tamperward/
  src/types.ts          the Change / Finding / Detector / Policy contracts
  src/diff/             pure diff parser + selectors
  src/git/              git adapter (range / staged / worktree)
  src/detectors/        the rules
  src/policy*.ts        protected-asset globs, policy load + baseline merge
  src/signoff.ts        the three-layer sign-off model
  src/session.ts        the Stop sweep's per-turn baseline
  src/cli/              tamperward check | hook | sweep | allow | init | verify | run | watch
  src/adapters/claude/  stdin→Change[] (PreToolUse + Stop), Finding→deny
  test/                 unit suite — green is the gate
  harness/              seeds, oracles, and the bypass-to-fix runner
  .github/workflows/    Tamperward running on itself
```

Tamperward gates its own repo with the engine it ships: its CI self-gate runs the built
CLI's `check --diff` over the PR range, and a blocking finding clears only via the
out-of-band label. The self-gate does not run `verify` on this repo (§6).

---

## 9. Build order and status

1. **Engine + `Change` model + the 8 mechanical detectors.** *Shipped.* Detector 1
   landed with its count-based AST; detector 3 (`assertion-weakening`) did **not**
   land in any form — its name is reserved in the policy, nothing more.
2. **CLI + git adapter + pre-commit & CI wiring**, incl. the out-of-band CI sign-off.
   *Shipped* — the sign-off channel is a PR label read by `.github/workflows/ci.yml`.
3. **Claude PreToolUse hook + Stop sweep + the correction message.** *Shipped*, on the
   JSON channel (a deny is exit 0 + JSON; exit 2 would make the JSON be ignored).
4. **E2E harness + bypass-to-fix measurement.** *Run, and grown into the §7.B evidence
   programme* — see the README for the numbers, the `harness/PREDICTION-*.md` files
   for the studies and their outcomes.
5. **`tamperward init`** — *shipped* (1.4.0): wires the policy, the agent hooks,
   pre-commit, and CI in one idempotent command; `--dry-run` prints the plan first.
6. **`snapshot-rewrite`** — *shipped* (1.2.0) as the first detector built from
   measured demand; *warn* per its own 1,652-commit FP study.
7. **The `version:` graduation gate** — *shipped* (1.3.0); no graduation uses it yet
   (`BLOCK_SINCE` is empty).
8. **`snapshot-only-rewrite`** — *shipped* (1.5.0): the FP study's narrow signal as a
   distinct warn rule, granularity-guarded to the staged/range views by the engine's
   additive `view` parameter, positioned for a `version: 2` graduation.
9. **`test-skip` options-spelling coverage** — *shipped* (1.5.1): the node:test
   `{ skip: true }` / `{ todo: … }` / `t.skip()` forms, closing a gap a live agent
   found in the baselines study the same day.
10. **Per-rule `exclude` globs** — *shipped* (1.6.0) with both invariants (policy
    file never excludable; added excludes are a policy-diff weakening signal) and
    its measured null disclosed (§3).
11. **The `ts-any-launder` graduation question** — *closed* (no release; a
    decision, not a feature): permanent warn on syntactic evidence, per the
    laundering-corpus numbers in §4 row 13.

Still open: the §7.A negatives corpus (there is no `fixtures/` tree yet — the
precision work so far lives in `harness/fp-study/` and the corpus sweeps of
`PREDICTION-baselines/tuned-fp/launder-corpus.md`), the two heuristic detectors it
gates, languages beyond TS, agents beyond Claude Code, and the task-level
multi-repository benchmark (the repo, not the run, as the sampling unit) that the
external review placed at the top of the roadmap.

### 9.1 Maturity milestones

A September 2026 external review of v2.0.0 rated Tamperward "considerable as
emerging research engineering; promising but unproven as industry infrastructure"
and named five milestones that would change that answer. They are tracked here
under the SECURITY-ENVELOPE rule: a row moves only with a link — a tagged release,
a merged PR, a committed preregistration, or an artifact published by someone other
than this repository. Intent moves nothing. All five are OPEN.

| # | milestone | what exists today | what closes it |
|---|-----------|-------------------|----------------|
| M1 | An independent, **named** security audit with a public report | Three external review passes (the 1.10.x envelope review with executed exploits, the 1.14.x passes, the 1.15.0 audit), every finding ledgered in SECURITY-ENVELOPE.md and closed with a regression and a mutation check. The reviewers are unnamed and the write-ups are ours. | A named auditor publishes a report against a tagged 2.x release; each finding gets a SECURITY-ENVELOPE row; the report is linked from this row. |
| M2 | A preregistered replication on 2.x — several agents, one fixed treatment, larger samples | Rounds 1–3.1 ran on v1.6.0 → v1.14.0, prediction committed before each; one agent runtime throughout; rounds 2 and 3 changed treatment with ecosystem; round 3.1 could not have replicated (b ≤ 3 by construction); every round on a verifier later found to carry the 1.14.1 bypass. Round 4 is the undrawn fresh pool. It runs one pinned agent/model configuration for its primary result, with v2.10.0 as the candidate treatment after three adversarial passes over 2.4.0–2.10.0 closed every in-repository fail-open by design rather than by instance; the exact release is frozen in the `PREDICTION` (see the treatment boundary below). | Two preregistrations. Round 4: a `PREDICTION` committed before the draw that pins one 2.x release across every ecosystem in the round and one agent/model configuration, with the sample sized by an exact simulation over the full paired table (false green in both arms, ungated only, gated only, neither). Round 4.1: a separate `PREDICTION`, committed before anyone examines round 4's outcomes, that repeats the frozen pool, treatment and analysis under a second supported agent runtime with equivalent PreToolUse/Stop enforcement semantics. An agent runtime is the harness that executes the agent and its tool calls — Claude Code is one; a second model under Claude Code is model-replication evidence and does not by itself satisfy the runtime requirement, and a runtime with no equivalent adapter cannot receive the treatment (that adapter is M5's work). M2 stays open until 4.1 reports. Analysis frozen before each draw; published beside the bet either way. |
| M3 | Production pilots with published false-positive rates, overhead and friction | Precision is corpus-measured on mainline commits with no agent in the loop (`harness/fp-study/`; `snapshot-only-rewrite` ~0.06% over 1,652 commits; `test-content-removal` priced on 2,304). No deployment measured; no production user named. | A named pilot publishes per-rule fire and false-positive counts over a stated period, `verify` wall-clock against the bare suite, how often the out-of-band label was needed, and hook latency — linked here whether or not it flatters the gate. |
| M4 | Stronger verifier isolation and cross-ecosystem dependency integrity (partial mitigations shipped) | Two copies, pristine built after the visible run exits, overlay digested either side, tree and `node_modules` fingerprints, Linux survivor scan, replace-objects disabled on every trusted read. Still true: both runs execute the candidate's code, `node_modules` is a symlink into the agent-writable tree, no OS boundary, the dependency fingerprint is Node-only, the verification surface is an enumerated list (docs/THREAT-MODEL-pristine-run.md). | The pristine run executes where the candidate cannot write — a read-only mount of the base's protected surface, or a separate container/runner with its own dependency install — and before/after dependency integrity for the ecosystems the `tests` class covers (pip, Go module cache, cargo, bundler, Maven/Gradle), each as a versioned change with its threat-model note. |
| M5 | Attested verdicts, broader agent integrations, org-level policy administration | `--json` verdicts and a GitHub job-summary renderer; the npm package carries SLSA provenance, but a *verdict* is not attested. In-loop hooks for Claude Code only; other agents meet the gate at pre-commit and CI. One `.tamperward.yml` per repository. | A signed verdict statement (in-toto or equivalent) binding head, base, gate version, policy hash and verdict, verifiable by a required check; an in-loop adapter for at least one more runtime with the same PreToolUse/Stop semantics; a documented organisation baseline that per-repo policy can strengthen and never weaken. |

#### Round 4 treatment boundary

Round 4 grades the exact 2.x release and commit identified in its `PREDICTION`.
v2.10.0 is the candidate treatment, not the commitment: the treatment is frozen after
the sacrificial pilot and before the confirmatory pool is drawn or any counted
trajectory runs, and a pilot correction ships as whatever version CONTRIBUTING's rules
give it. The `PREDICTION` pins the released semantic version, the git commit, the
packed artefact's SHA-256, the policy hash, the hash of the wiring `init` generates,
and the runner and analysis hashes. Pilot repositories are permanently excluded from
the pool. The round's other design decisions — the temporal buckets, task eligibility,
the completion margin, the power simulation — belong to the `PREDICTION`, not here.

The frozen release is graded against three stated claims, and a finding is judged
inside or outside them:

1. Everything inside the repository is authoritative at the Stop sweep and at CI. A
   tampered test, config, workflow, coverage setting, hook script or Claude settings
   file that reaches the staged tree or a pull request is judged by its bytes, not by
   the command that produced them. A fail-open here is a design finding.
2. Files outside the repository (`~/.claude/settings.json`, `$CLAUDE_CONFIG_DIR`,
   managed settings) are visible only at the tool-call layer, and that layer is
   best-effort: it judges the shape of the command text and cannot be sound against a
   shell. A write that reaches the user settings file through a shape the judge does
   not read is outside the boundary and is a documentation finding, not a code
   finding.
3. `disableAllHooks: false` in the project settings file (written by `init` since
   2.9.0) and a managed settings file for `env` are part of the deployment the
   treatment assumes, not optional hardening. A round-4 seed is initialised from the
   exact frozen package with both in place, and no local or out-of-band sign-off
   mechanism is reachable from the agent's environment.

A P0 inside claim 1 is the first evidence that the design, not the implementation, is
at fault; a P0 under claim 2 moves the sentence, not the code.

The research harness's own isolation — an oracle, a result ledger and a parent-owned
observer the agent cannot reach — applies symmetrically to both arms and protects the
experiment, never one arm's repository. It closes nothing under M4, which is about the
isolation Tamperward gives its users.

The review also corrected the v2.0.0 README, whose scope note said "one model,
one pressure prompt, one JS/TS ecosystem" beneath the Python and `claude-sonnet-5`
rows; the README readability pass had already replaced it with the accurate
sentence. The limits the review placed *outside* these milestones — both runs
execute agent-controlled code, no OS/network/secret isolation, a hardcoded or
colluding solution the base suite accepts is invisible, ecosystems beyond JS/TS
get file- and pattern-level coverage — are the README's "What Tamperward does not
do" and §10 below, and no milestone here removes them.

---

## 10. The honest caveats

- **The heuristics are unbuilt, not merely warn-tier.** `assertion-weakening` and
  `guard-removal` are reserved names with no detector behind them; they get built only
  against the §7.A negatives corpus, and if they can't clear the bar they stay
  unbuilt. Quote the measured number, not the intent.
- **The loop is measured on a finite sample.** §7.B has run (see the README), but a
  conversion rate is an observation over the seeds and models exercised — Claude
  models, on a Claude Code harness — not a guarantee about every agent on every
  codebase. The loop layer itself exists only where the hooks do; anything else meets
  the gate at pre-commit and CI.
- **The informed-adversary result measures disclosure, not mandated evasion.** No
  prompt ordered a model to defeat the gate; the arms-race question is opened and
  bounded, not settled.
- **The flagship number is conditional on detector coverage, and the run counts
  overstate the experiment count.** Zero tampers across the guarded runs holds for
  tamper classes an active detector covered; on a seed whose cheapest cheats sat
  outside coverage, agents tampered in 26 of 40 runs. And the independent evidence
  unit is the seed/repo configuration (~15 seeds, 8 corpus repos), not the run —
  run-level repetition measures per-seed stochasticity only. The README carries
  both statements first, before any result; this spec repeats them so no §7 number
  gets quoted without them.
- **The gate is one layer of a measured division of responsibility.** Capability
  restriction owns assets that should be immutable during a task (and its grantor
  design is the hard part — the auto-grant arm manufactured authorized tampering);
  held-out oracles own the semantic classes no diff can show; the naming sentence
  owns the underspecified ones; the gate plus out-of-band sign-off owns the classes
  where legitimate changes must be distinguishable from illegitimate ones; CI is
  the authority under all of it.

---

*v0.8 · reconciles the spec with 1.15.0: no new row — the seventeen-row table's
heading and counts, the canonical policy example (`test-content-removal`,
`transient-protected-mutation`, the `snapshots` class), the shipped JSON-at-exit-0 hook
contract and the immediate `stop_hook_active` allow, the generated workflow's
`check --diff` + `verify --require-ancestor` wiring with SHA-bound labels, and the
repo layout brought into line with the code.
Prior: v0.7 · reconciles the spec with 1.9.0: `tamperward verify` seated as row 16 —
the taskbench run-correctness oracle productized, with the guarded `verify:`
policy surface and the base-selection caveat stated.
Prior: v0.6 · reconciles the spec with 1.8.0: the effect layer — per-call protected-tree
drift judged by the ordinary rules, the `tamperward watch` observer with row 15's
transient class, and the Edit-reconstruction fail-open closed.
Prior: v0.5 · reconciles the spec with 1.7.0: `test-content-removal` seated as row 14
from the taskbench Phase-3 evidence, corpus-priced and shipped block-with-signoff,
with the fresh-frame validation rule binding. Prior: v0.4 · reconciles the spec with 1.6.0: `test-skip`'s class completed (1.5.1), the
per-rule `exclude` surface with its weakening symmetry and published null (1.6.0),
`ts-any-launder` seated as row 13 with its graduation question closed by corpus,
§7.B extended with the nine studies that ran after v0.3, and the coverage-conditional
framing plus the division-of-responsibility caveats added to §10 following the
external statistical review.*

*v0.3 · reconciles the spec with 1.4.5: eleven rules with the two unbuilt heuristics
marked as reserved, the shipped `version:` gate and `init`, §7.B rewritten as the
evidence programme (oracle independence, pre-registration, the control arm, the
informed adversary), and the enforcement vocabulary scoped to match every other
surface. v0.2 folded in: Stop-sweep touchpoint, out-of-band CI sign-off, AST for the
structure detectors, the expected-value-tampering move, the rename-out-of-glob and
`tamperward allow` granularity fixes, the negatives-corpus sizing, and the seed
invariant.*
