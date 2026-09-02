# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) as scoped in
[CONTRIBUTING](./CONTRIBUTING.md#versioning).

## [Unreleased]

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
