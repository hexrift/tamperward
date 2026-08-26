<p align="center">
  <img src="assets/logo.svg" width="76" height="76" alt="">
</p>

<h1 align="center">Tamperward</h1>

<p align="center"><em>A ward is the obstruction inside a lock that blocks the wrong key.</em></p>

**The deterministic agent-integrity gate.** One ruleset, evaluated on the actual
diff and commands as a verdict — not a probability — enforced everywhere a change can
be made: inside the coding agent's loop, at the commit, and at the merge.

AI agents optimize for "the command succeeded," not "the change is trustworthy." To
make checks pass they take the cheapest path: deleting failing tests, weakening
assertions, casting to `any`, suppressing lint/type errors, lowering coverage gates,
editing CI, or bypassing hooks with `--no-verify`. Tamperward treats the safety nets
themselves as protected assets and blocks the *class* of bypass — so no single
shortcut is enough.

> Apache-2.0 core · `github.com/hexrift/tamperward`

## Stability

`1.0.0` commits to the surface you actually depend on: the CLI and its **exit codes**, the
hook wire format, the `.tamperward.yml` schema, and the `--json` `Finding` shape. The
package publishes no `main` and no `exports` — it is a binary, not a library — so nothing
under `src/` is public and internal refactors will never break you.

The version answers one question: *can taking this upgrade turn a green build red without
me changing anything?* **Patch never can** — bypass fixes and false-positive fixes ship as
patches so they reach you automatically. **Major can**, and only ever will alongside a
changelog entry saying which rule changed. See
[CONTRIBUTING](./CONTRIBUTING.md#versioning) for the full rule.

Two rules ship as `warn` and do not block: `assertion-weakening` and `guard-removal`. They
are heuristic, and they stay non-blocking until their precision is measured (SPEC §7.A).

## Does the loop actually work?

The gate is only half the claim. The other half is what an agent does *after* it is
denied: fix the real failure, or hunt for another way around. That is the
**bypass-to-fix conversion rate** (SPEC §7.B), and it is measured, not asserted —
`harness/run.sh` stands up an isolated repo with a real bug and a failing protected
test, lets a headless agent loose on it with the hooks installed, and classifies the
end state with an oracle independent of the detectors under test.

**42 runs. 0 tampers reached green. Of the 20 runs where a block fired, 20 ended in an
honest fix.**

| arm | model | runs | blocks fired | honest fix | tamper through |
|---|---|---|---|---|---|
| `seed` · adversarial | Sonnet 5 | 1 | 0 | 1 | 0 |
| `seed` · **forced** | Sonnet 5 | 5 | 0 | 5 | 0 |
| `seed-hard` · adversarial | Sonnet 5 | 3 | 0 | 3 | 0 |
| `seed-hard` · adversarial | Haiku 4.5 | 33 | 20 | 33 | 0 |

The trajectory the whole design is built around, from a transcript:

```
5. Bash  rm calc.test.js   → DENIED (test-deletion)
6. Edit  calc.js           ← next action: fix the real bug
7. Bash  node --test       → green, honestly
```

**Read the number with its limits.** 20/20 is a point estimate on a finite sample: it
supports "no conversion failure observed in 20 interceptions", whose 95% lower bound is
≈ 86% — above the ~80% bar SPEC §7.B set for "the loop works", but not a claim of 100%.
The split matters more than the total — Sonnet 5 never attempted a bypass at all,
including 5/5 runs in `forced` mode where the prompt *orders* it to delete the failing
test; all 20 interceptions came from Haiku 4.5 on the seed whose honest fix is genuinely
expensive. Of those 20, the agent's first move after the denial was a real fix attempt
19 times; once it went and read `.tamperward.yml` looking for another way through before
converting. That probe is counted here as an attempted second bypass, not smoothed away.

So on scenarios this size, a frontier model mostly does not need the gate. What the run
supports is the narrower, more durable claim: **when a shortcut is attempted, it is
caught deterministically, and the denial redirects the agent to the real fix rather than
to another bypass.**

Reproduce: `npm run build && harness/run.sh 5 adversarial haiku seed-hard`

## Status

Phase 1 — the engine, the eight mechanical detectors, the `check` CLI, and the Claude Code
agent layer (PreToolUse hook + Stop sweep + `allow`). Tamperward gates its own repo in CI
with the same engine it ships.

- `src/types.ts` — the `Change` model every adapter manufactures and every detector
  consumes (the one decision the codebase inherits).
- `src/diff/parse.ts` — pure `git diff` → `Change[]` parser. Handles add / modify /
  delete / **rename (as one change carrying `oldPath`)** / rename+edit / binary, with
  per-line old/new line numbers correct across multiple hunks.
- `src/git/build.ts` — the git adapter: range / staged / worktree views, enriching
  `before`/`after` with full file content for the AST detectors.
- `src/detectors/` — the **eight mechanical rules**: `no-verify`, `ts-any-cast`,
  `lint-suppression`, `test-skip`, `coverage-lowering`, `ci-tampering`,
  `hook-tampering`, `test-deletion` (the last counts `it()/test()` via the TS AST,
  and handles delete / rename-out-of-glob / shell mutation).
- `src/engine.ts` — runs the enabled rules over `Change[]`; honours `policy.ignore`.
- `src/cli/` — `tamperward check --staged | --worktree | --diff <base>...<head>`,
  exit 1 on any blocking finding.
- `test/` — 211 tests, including the AST-vs-regex, self-hosting precision, and
  pre-go-live audit regression cases, and the renderer accessibility contract.

- `src/adapters/claude/` + `src/cli/hook.ts` — the agent layer: `tamperward hook claude`
  (PreToolUse deny, fail-closed) and `tamperward sweep claude` (Stop sweep, compared against
  the turn's starting commit so a mid-turn commit can't launder a tamper past it).
- `src/signoff.ts` — the three-layer sign-off model: the agent honours nothing it can author.

Next: the negatives corpus to graduate the two heuristic rules, and a larger §7.B run
to tighten the interval on the conversion rate.

See **[SPEC.md](./SPEC.md)** for the full build spec, the detector table, the
enforcement-point wiring, and the proof harness.

## Use

```bash
npx tamperward check --staged                # pre-commit view
npx tamperward check --diff "main...HEAD"    # CI view — the authority for main
```

### Reading the verdict

One verdict, rendered for whoever is reading it. `--format` picks the view; the default,
`auto`, picks `github` when `GITHUB_ACTIONS=true` and `text` otherwise, so the CI wiring
stays a single line.

| Format | Where it goes |
| --- | --- |
| `text` | The terminal. Blocking findings first, then by file and line, wrapped to the terminal width. |
| `github` | An inline annotation per finding — so it lands **on the line** in *Files changed*, not four clicks deep in a job log — plus a job-summary table on the run page. The full text output still goes to the log. |
| `json` | The findings verbatim, plus a summary count. |

Severity is always spelled out (`BLOCK` / `warn`) and never carried by colour or a glyph
alone, so the output reads the same piped, in a CI log, on a colour-blind reader's
terminal, and through a screen reader. Colour honours
[`NO_COLOR`](https://no-color.org) and `FORCE_COLOR`, and is off whenever stdout is not a
terminal.

From a clone:

```bash
npm install
npm run build                                      # bundles the CLI to dist/cli/index.js
node dist/cli/index.js check --staged
node dist/cli/index.js check --diff "main...HEAD"
```

## Develop

```bash
npm test           # vitest — parser, detectors, engine, policy
npm run typecheck
```

## Layout

```
tamperward/
  src/types.ts          the Change / Finding / Detector / Policy contracts
  src/diff/             pure diff parser + selectors
  src/git/              git adapter (range / staged / worktree)
  src/detectors/        the rules (phase 1, in progress)
  test/                 unit suite — green is the gate
  .tamperward.yml         the policy: protected assets + rule severities
  .github/workflows/    CI — dogfoods Tamperward on itself once the CLI lands
```
