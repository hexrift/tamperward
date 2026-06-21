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

Phase 1 — the engine. The load-bearing piece is built and verified: the `Change`
normalization every adapter manufactures and every detector consumes.

- `src/types.ts` — the `Change` model (the one decision the codebase inherits).
- `src/diff/parse.ts` — pure `git diff` → `Change[]` parser. Handles add / modify /
  delete / **rename (as one change carrying `oldPath`)** / rename+edit / binary, with
  per-line old/new line numbers correct across multiple hunks.
- `src/diff/select.ts` — `addedLines` / `removedLines` selectors for detectors.
- `src/git/build.ts` — the git adapter: range / staged / worktree views, enriching
  `before`/`after` with full file content for the AST detectors.
- `test/parse.test.ts` — proves every awkward case above. `npm test`.

Next: the eight mechanical detectors against a harvested negatives corpus, then the
Claude Code agent layer (PreToolUse + Stop sweep) and the bypass-to-fix harness.

See **[SPEC.md](./SPEC.md)** for the full build spec, the detector table, the
enforcement-point wiring, and the proof harness.

## Develop

```bash
npm install
npm test         # vitest — the parser/normalization suite
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
