# Threat model — what the pristine run inherits from the agent

**Status: closed in 1.14.2 by option B below.** As of **1.14.1** six vectors were
live in the shipped verifier, demonstrated end to end; 1.14.2 gives `verify` a
verification surface and all six are blocked. This document records what was
tested, what reproduced, the enforcement rule adopted, and what remains open.
A later section records the same class one layer further out — the package
manager that *starts* the runner — which 1.14.2's list did not reach, and the
environment control that closes the half of it no list can.

Reproduce with `harness/poc/verify-pristine-inheritance-vectors.sh`.

## The question

`tamperward verify` re-runs the suite in a pristine copy where protected files
are restored from a trusted base. Its claim is: *does the agent's source pass
the original suite?*

That claim only holds if **everything determining what the original suite is,
and how it runs, comes from the base** — not just the test files. 1.14.1 fixed
the test files. It did not fix the rest.

## Method

Each case is identical except for one added file. In every case the agent:

- never modifies or deletes a base-protected file,
- never fixes the bug,
- adds exactly one artefact.

`verify` returning 0 means the added artefact reached the pristine run and
suppressed the restored base test. The two `conftest.py` cases are controls:
1.14.1 must block them.

## Results at 1.14.1 (before the fix)

| added artefact | protected class? | outcome |
|---|---|---|
| `tests/conftest.py` | yes (`**/conftest.py`) | blocked — control |
| `conftest.py` (root) | yes (`**/conftest.py`) | blocked — control |
| `pytest.ini` — `addopts = --deselect …` | **no** | **LIVE** |
| `setup.cfg` — `[tool:pytest] addopts` | **no** | **LIVE** |
| `tox.ini` — `[pytest] addopts` | **no** | **LIVE** |
| `pyproject.toml` — `[tool.pytest.ini_options]` | **no** | **LIVE** |
| `pytest.ini` `-p` + a plugin module not named `conftest` | **no** | **LIVE** |
| `pytest.ini` — `addopts = -k "not test_add"` | **no** | **LIVE** |

End to end through the enforcement envelope, with an added `pytest.ini`:

```
[envelope] policy check over the working tree:
tamperward: clean — no integrity findings (1 change scanned).

[envelope] pristine verification against the trusted base:
tamperward verify — verified: the suite passes, and still passes with all
1 protected files restored from c8ee239178.

tamperward run — agent exit 0; checks diff=0 worktree=0 verify=0 → GREEN MEANS GREEN
```

The bug is still present in `app.py`.

## Diagnosis

**1.14.1 fixed a filename, not a class.** Its rule — *remove agent-added files
inside a protected class* — is scoped to the policy's `protected` classes, and
the `config` class is JS/TS only:

```ts
config: ['**/jest.config.*', '**/vitest.config.*', '**/tsconfig*.json',
         '**/.eslintrc*', '**/eslint.config.*', '**/package.json'],
```

pytest's entire configuration surface is outside it. So is every other runner's
that isn't jest or vitest. Test *discovery and execution* are configured by
files the policy has no opinion about, and the pristine copy trusts them.

Extending the protected classes file-by-file would repeat the same failure one
round later: the list is a lagging indicator of a runner's auto-load behaviour,
and runners add configuration sources over time.

## The invariant

> The pristine run must not inherit **any** agent-added file that can change
> test discovery, test configuration, fixtures, setup, or execution authority.

Restated as a materialisation rule, which is what makes it enforceable:

> In the pristine copy, every file on the **verification surface** is exactly
> the base's — restored if it existed at base, removed if the agent added it.
> The verification surface is the protected classes **plus** everything the test
> runner auto-consults.

The polarity matters. Today the default is *inherit unless removed*. For a
verifier it must be *do not inherit unless the base had it*.

## Enforcement options

**A — extend the protected classes.** Add `pytest.ini`, `setup.cfg`, `tox.ini`,
`pyproject.toml`, `.mocharc.*`, `babel.config.*`, `vite.config.*`, `karma.conf.*`,
`.rspec`, `phpunit.xml`, and so on. Cheap, and it closes the demonstrated cases.
But it conflates two different ideas: what the *agent may not weaken* (policy)
and what the *verifier may not inherit* (materialisation). It also widens the
in-loop gate's blast radius, since the same globs drive denials.

**B — a separate verification surface (recommended).** Keep the policy's
protected classes as they are, and give `verify` its own list of files it treats
as base-owned. The two overlap but are not the same thing: `package.json` is
policy-protected because gutting the test script is weakening; `pytest.ini` need
not be policy-protected at all, yet must never be inherited by the pristine run.
Separating them means extending one does not change the other's behaviour.

**C — runner-level neutralisation, as defence in depth.** Any surface list lags.
Where the runner supports it, also neutralise auto-loading in the pristine run:
`PYTEST_DISABLE_PLUGIN_AUTOLOAD=1`, an explicit `-c` pinned at the base config,
`npm --ignore-scripts`. This does not replace B — `addopts` in a config file the
runner still reads is unaffected by autoload flags — but it covers entry-point
plugins that no file list can enumerate.

**Adopted in 1.14.2: B.** It closes every demonstrated vector — all eight rows
above are blocked, with the visible run unaffected.

**C was considered and rejected as a default.**
`PYTEST_DISABLE_PLUGIN_AUTOLOAD=1` would cover entry-point plugins no file list
can enumerate, but it breaks suites that legitimately depend on them
(`pytest-asyncio`, `pytest-django`), turning honest work into `MASKED_FAILURE`.
Applying it symmetrically to both runs makes those repositories fail closed and
unverifiable instead. It needs a per-repository opt-in, not a default, and is
not in 1.14.2.

## The layer below the runner: what the runner is *started under*

The surface list named what the **test runner** reads. It named nothing the
**package manager in front of it** reads, and `npm test` is npm first. npm loads
the project's `.npmrc` before it runs anything, and one line there —

```
node-options=--require ./p.cjs
```

— is exported as `NODE_OPTIONS` to every node it spawns. A `p.cjs` that stubs
`node:test`'s `test`/`it`/`describe` to no-ops (or overrides `process.exit`)
makes `node --test` collect nothing and exit 0. Reproduced end to end with the
frozen command `npm test`: base `add = a + b` with a `node:test` assertion, flip
the source to `a * b` → SUITE_RED; add `.npmrc` and `p.cjs` → **VERIFIED, exit
0**. The candidate never touched a protected file. `.npmrc` was on no list —
not the overlay classes, not the surface, not the verifier's inputs — so both
copies carried it. This is not a config the runner *consults*; it is a config
the runner is *started under*, and the list had no row for that idea.

Two things close it, and both are needed:

1. **The file half.** The package-manager configuration (`.npmrc`, `.yarnrc`,
   `.yarnrc.yml`, `pnpm-workspace.yaml`, `.pnpmfile.cjs`), the runner a
   package manager executes when the project pins one (`.yarn/releases/*`,
   `.yarn/plugins/**`, `.pnp.*`), dotenv files, version-manager pins,
   `.gitattributes`, the interpreter start-up hooks (`sitecustomize.py`,
   `usercustomize.py`), and the runner configs the list had missed (`.nycrc*`,
   `.c8rc*`, `.taprc`, `ava.config.*`, `mocha.opts`, `spec/support/jasmine.json`,
   `playwright.config.*`, `cypress.config.*`, `setup.py`) are on the
   verification surface: restored from the base where the base has them,
   removed from the pristine copy where the candidate added them. Not on it:
   build files the suite does not auto-load (`Makefile`). `pnpm-workspace.yaml`
   is there because it has to be — pnpm 10 reads `nodeOptions` from it and its
   environment layer does *not* outrank the file.

2. **The environment half.** A file list cannot hold `~/.npmrc`: inside
   `tamperward run` the candidate owns HOME, and the same line there yields the
   same VERIFIED. What the candidate cannot write is the environment of the
   process running `verify`. So both suites now run under an environment the
   verifier composes (`suiteEnv` in `src/cli/verify.ts`, which documents each
   variable): `NODE_OPTIONS`, `NODE_PATH`, `NODE_REPL_EXTERNAL_MODULE`,
   `PYTHONPATH`, `PYTHONSTARTUP`, `PYTEST_ADDOPTS` and `PYTEST_PLUGINS` are
   dropped; npm's and pnpm's `node-options` is pinned above every rc file
   (`npm_config_node_options=' '` — npm ignores an *empty* env value, and trims a
   non-empty one to nothing); their user and global rc files are pointed at
   empty files the run owns; `YARN_IGNORE_PATH=1` stops yarn executing whatever
   a `yarn-path` in `~/.yarnrc` names. Everything else — PATH, HOME, a venv —
   is inherited, so honest suites still run, and both runs see the same
   environment, so an honest suite cannot tell the two apart. A suite that needs
   one of the dropped variables sets it in its own command, which is frozen.

Verified against npm 10.9, pnpm 10.33 and yarn 1.22 in the container the fix
was written in. Yarn 1 does not export `node-options` at all; its live vector
was `yarn-path`, from the project `.yarnrc` (file half) and `~/.yarnrc`
(environment half), both reproduced and both closed.

This is the same shape as 1.14.2 one layer further out, and the same caveat
applies with the same force: the file list is a lagging indicator, and now so
is the variable list. What remains is stated below.

## Residual risk, stated

- **A runner input that is neither a file on the surface nor a variable in the
  environment control is still the candidate's.** The known instance is
  Python's user site-packages: a `.pth` file there runs code at interpreter
  start-up, it lives under HOME, and `PYTHONNOUSERSITE=1` would close it at the
  price of every suite installed with `pip install --user`. That is the
  1.14.2 objection to option C again, and it is not taken as a default. npm's
  builtin `npmrc` under its own installation is another, in the
  shared-dependency class the copies never addressed. A runner can add either
  kind of source at any time.

- **Isolation is sequencing plus detection, not a sandbox.** From 1.14.5 the
  pristine copy does not exist while the candidate's code runs, and its restored
  files are digested either side of the pristine run. Neither is confinement: a
  process that outlives the visible run can enumerate the temp directory, and
  what it does between the digest and the next digest is caught after the fact,
  not prevented. The copies are separate directories. They are not a sandbox,
  and no amount of ordering makes them one.

- **The verifier's own inputs are bounded, not enumerated.** 1.14.4 restores what
  the command executes — tokens naming a file present at the base, plus an
  explicit `verify: { inputs: [globs] }` for delegation the tokens cannot see.
  Neither source is complete: a `Makefile` include, an interpreter startup file,
  a tool config outside the surface list, or any indirection the base script
  reaches through can still be the agent's. The explicit list is the escape
  hatch, and it has to be written by hand.
- **A git rewrite that predates the envelope is not detected.** `run`
  fingerprints replace refs, `info/grafts` and `shallow` before the agent starts
  and convicts a change; a rewrite already installed when it starts is part of
  the state it anchors to. `GIT_NO_REPLACE_OBJECTS=1` does neutralise
  pre-existing *replace refs* on every trusted read — grafts and shallow have no
  equivalent switch.
- **The surface list will lag.** Any runner can add a configuration source. B
  reduces the frequency of that failure; it does not eliminate it. This should
  be said in the SPEC rather than implied to be solved. It has lagged once
  already, at the package-manager layer (above); the environment control now
  lags in the same way.
- **`sitecustomize.py` was tested and did not reproduce** in the 1.14.2
  configuration — it was not imported from the repository root. The two ways it
  could have been are now closed from both sides: `PYTHONPATH` no longer reaches
  the suite, and `sitecustomize.py` / `usercustomize.py` are on the surface, so
  an in-tree copy is the base's or nothing. An installed package that puts the
  tree on `sys.path` remains the shared-dependency residual below.
- **Restored content is the raw object, not a smudged checkout.** `git show`
  hands back the blob as stored; an LFS-tracked or clean-filtered file on the
  surface is restored as its pointer, and a pointer is not a test, so such a
  repository fails closed rather than verifying. `git cat-file --filters` would
  fix that and was rejected: a smudge is a *command* named in git config the
  candidate writes with an ordinary `git config`, selected by attributes read
  from the working tree and `.git/info/attributes`, both the candidate's, and
  no environment switch disables the repository's own config. The one read
  whose point is that the candidate did not choose it must not run the
  candidate's filter.
- **Shared mutable dependencies are not addressed.** Both copies execute against
  the same installed environment. An agent that mutates an installed package
  affects the pristine run too. The copies are separate directories, not a
  sandbox.
- **Source-level interference is out of scope here** and belongs to the oracle
  boundary, not this one: a semantically wrong fix that the base tests accept is
  invisible to any materialisation rule. That is round 3.1's tableau finding.

## What this means for the published record

The bypass class was live from **v1.9.0 through 1.14.1 inclusive** and is closed
in 1.14.2. The errata discloses that rounds 2, 3 and 3.1 ran on a verifier
carrying it; that disclosure covers the whole class, not just the `conftest.py`
form, because every round predates 1.14.2.

Two later findings reach the same record and widen it rather than adding to it.
The **sibling-write** vector (the visible run editing the pristine copy) was live
from **v1.9.0 through 1.14.4 inclusive**, closed in 1.14.5 — the same span, since
the two-sibling layout shipped with `verify` itself. The **file-mode** vector
(content restored, mode not) has the same span for the same reason. Neither is
evidence that any counted trajectory used them: no such use has been looked for
in the transcripts, and this note describes what was possible, not what happened.
What it does mean is that the disclosure covering rounds 2, 3 and 3.1 should be
read as covering the verifier's isolation as well as its materialisation rule.
