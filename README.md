# Holdfast

**The deterministic agent-integrity gate.** One ruleset, evaluated on the actual
diff and commands as a verdict — not a probability — enforced everywhere a change can
be made: inside the coding agent's loop, at the commit, and at the merge.

AI agents optimize for "the command succeeded," not "the change is trustworthy." To
make checks pass they take the cheapest path: deleting failing tests, weakening
assertions, casting to `any`, suppressing lint/type errors, lowering coverage gates,
editing CI, or bypassing hooks with `--no-verify`. Holdfast treats the safety nets
themselves as protected assets and blocks the *class* of bypass — so no single
shortcut is enough.

> Apache-2.0 core · `github.com/hexrift/holdfast`

## Status

Phase 1 — the engine, the eight mechanical detectors, and the `check` CLI. Holdfast
gates its own repo in CI with the same engine it ships.

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
- `src/cli/` — `holdfast check --staged | --worktree | --diff <base>...<head>`,
  exit 1 on any blocking finding.
- `test/` — 71 tests, including the AST-vs-regex and self-hosting precision cases.

Next: the negatives corpus to graduate the two heuristic rules, then the Claude Code
agent layer (PreToolUse hook + Stop sweep) and the bypass-to-fix harness.

See **[SPEC.md](./SPEC.md)** for the full build spec, the detector table, the
enforcement-point wiring, and the proof harness.

## Use

```bash
npm install
npm run build                                   # bundles the CLI to dist/cli/index.js
node dist/cli/index.js check --staged           # pre-commit view
node dist/cli/index.js check --diff "main...HEAD"  # CI view
```

## Develop

```bash
npm test           # vitest — parser, detectors, engine, policy
npm run typecheck
```

## Layout

```
holdfast/
  src/types.ts          the Change / Finding / Detector / Policy contracts
  src/diff/             pure diff parser + selectors
  src/git/              git adapter (range / staged / worktree)
  src/detectors/        the rules (phase 1, in progress)
  test/                 unit suite — green is the gate
  .holdfast.yml         the policy: protected assets + rule severities
  .github/workflows/    CI — dogfoods Holdfast on itself once the CLI lands
```
