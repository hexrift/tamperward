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

## Pull requests

- Branch, then open a PR. `main` is protected; CI must be green.
- **Changing a protected asset will block your own PR.** That is working as intended.
  A reviewed, legitimate change is cleared by a maintainer applying a
  `tamperward:allow:<rule>` label — never by weakening the policy to get past the gate.
- Keep the diff to what the change needs. The detectors are the security boundary; a
  drive-by refactor in `src/detectors/` costs more review than it saves.

## Reporting a bypass

Do not open a public issue — see [SECURITY.md](./SECURITY.md).
