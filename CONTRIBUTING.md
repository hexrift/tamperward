# Contributing

## The one rule that shapes everything else

**Every `block`-severity rule must be mechanical.** If a signal cannot be decided from the
diff or the command with certainty, it ships as `warn` until its precision is measured —
no exceptions, however good the heuristic feels. A false-firing block rule is poison: it
gets the whole gate switched off, and then nothing is protected.

That is why `assertion-weakening` and `guard-removal` are still `warn`. They graduate on a
number from a negatives corpus (SPEC §7.A), not on taste.

## Getting set up

```bash
npm install
npm test          # vitest — 158 tests
npm run typecheck
npm run build     # bundles the CLI to dist/cli/index.js
```

Tamperward gates its own repo, so you can run it on your own change:

```bash
node dist/cli/index.js check --staged
node dist/cli/index.js check --diff "main...HEAD"
```

## Adding or changing a detector

1. Implement the `Detector` interface in `src/detectors/` (`src/types.ts` has the
   contract). Declare `surface` and `certainty` honestly — `certainty: 'mechanical'` is a
   claim that it cannot false-fire.
2. Register it in `src/detectors/index.ts` and give it a severity in `src/policy.ts`.
3. Prefer the AST over a regex wherever a comment, a string literal, or a `describe` title
   could contain the pattern you are matching. Regex is fine for additive tokens.
4. **Write the evasion tests, not just the happy path.** Assume a motivated agent reads
   your regex: alternate spellings, whitespace, unicode, multi-line forms, indirect
   mutation through the shell, renaming a file out of its glob.
5. Add at least one negative — ordinary, legitimate code that must *not* fire.

## Tests are the deliverable, not the evidence

- **Every fixed bypass becomes a permanent test.** See `test/audit-fixes.test.ts` and
  `test/audit-fixes-high.test.ts`: each case there is an exploit that once worked.
- **Never fix a test to make the suite pass.** If a test breaks, either the behaviour
  regressed or the test encoded the old contract — say which, in the commit message. Two
  tests in this repo once asserted a bug; they were rewritten deliberately, not deleted.
- If you change a measured claim, re-run the measurement and update the number. Do not let
  the README drift ahead of the code.

## Measurement discipline

If you touch precision or the correction loop:

- **Pre-register the criterion before you label.** `harness/fp-study/ADJUDICATION-RULE.md`
  is the pattern — decide what counts as a true positive first, then adjudicate.
- **Keep the oracle independent of the detector under test.** A verdict oracle that
  re-derives the detector's own check will certify its own blind spots. This has happened.
- Agents are stochastic: run several reps and report the denominator, not just the rate.

## Versioning

SemVer, but the obvious reading is wrong for a gate: nothing here is imported, so the
usual "did the function signature change" test does not apply. **The public API is the
CLI, the policy schema, and the hook contract** — specifically:

- the `tamperward` commands, their flags, and their **exit codes**
- the hook wire format: a deny is JSON on stdout at **exit 0** (exit 2 makes the agent
  runtime ignore the JSON)
- the `.tamperward.yml` schema — `protected`, `rules`, `ignore`, `signoff`
- the `Finding` shape emitted by `--json`

Everything under `src/` is internal. The package publishes no `main` and no `exports`; it
is a binary, not a library, so refactoring internals is never a breaking change.

The version answers one question: **can taking this upgrade turn a green build red without
me changing anything?**

- **major** — yes. A new `block` rule, a rule promoted `warn` → `block`, an existing block
  rule made stricter in a way that fires on code it previously passed, or a breaking change
  to the CLI, exit codes, hook contract or policy schema.
- **minor** — no, but there is new surface. A new `warn` rule, a new adapter, a new command
  or flag, a detector that catches more only in changes that already violated the policy.
- **patch** — no. Closing a bypass in an existing rule at the same severity, fixing a false
  positive, docs.

Two consequences worth stating plainly:

1. **Bypass fixes are patches on purpose.** A closed evasion should reach people
   automatically; if it arrived as a major, it would sit unapplied.
2. **`assertion-weakening` and `guard-removal` graduating to `block` is a major**, because
   it will turn green builds red. The `version:` field in `.tamperward.yml` is reserved for
   an opt-in mechanism that would let new blocking rules land on a minor for policies that
   have not raised it. **That mechanism is not implemented yet** — until it is, the rule
   above holds without exception.

Every release with a behaviour change gets a `CHANGELOG.md` entry naming what it closes.
Security advisories reference versions, so "which release fixed that bypass" must be
answerable from the changelog alone.

## Pull requests

- Branch, then open a PR. `main` is protected; CI must be green.
- **Changing a protected asset will block your own PR.** That is working as intended.
  A reviewed, legitimate change is cleared by a maintainer applying a
  `tamperward:allow:<rule>` label — never by weakening the policy to get past the gate.
- Keep the diff to what the change needs. The detectors are the security boundary; a
  drive-by refactor in `src/detectors/` costs more review than it saves.

## Reporting a bypass

Do not open a public issue — see [SECURITY.md](./SECURITY.md).
