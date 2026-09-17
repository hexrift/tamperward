<!--
Thanks for contributing. This template mirrors CONTRIBUTING.md — delete any
section that does not apply, but do not delete a checklist item just to tick it.
Reporting a bypass? Stop: do NOT open a public PR or issue. See SECURITY.md.
-->

## What this changes

<!-- One or two sentences. What behaviour, rule, or surface moves, and why. -->

## Why

<!-- The problem this solves. For a detector change: the move it now catches (or
stops false-firing on), with the smallest diff that reproduces it. -->

## Versioning

<!-- The gate's public API is the CLI, the policy schema, and the hook contract.
The version answers one question: can taking this upgrade turn a green build red
with no other change? See CONTRIBUTING.md "Versioning". Tick exactly one. -->

- [ ] **patch** — closes a bypass at the same severity, fixes a false positive, or docs only
- [ ] **minor** — new surface (a `warn` rule, an adapter, a command/flag, a gated graduation)
- [ ] **major** — turns green builds red uninvited (new `block` rule, `warn`→`block` for v1 policies, or a breaking CLI/exit-code/hook/schema change)
- [ ] **no bump** — no behaviour change (docs, community-health files, CI-only, tests)

If this bumps the version, `CHANGELOG.md` is dated under that version and the
`[Unreleased]` section is not left behind — merging the bump is the release.

## Checklist

- [ ] `npm run typecheck`, `npx vitest run`, and `npm run build` pass locally
- [ ] `node dist/cli/index.js check --staged` is clean (the repo's own gate)
- [ ] A new or changed detector ships **evasion tests** and at least one negative that must not fire; a fixed bypass is now a permanent regression test
- [ ] Measured claims that moved were re-measured — the README/docs do not drift ahead of the code
- [ ] The diff is scoped to what the change needs — no drive-by refactor of `src/detectors/` or other guarded surface
- [ ] No agent attribution and no session links on any surface — PR body, commit messages, and files (CLAUDE.md's standing rule; the `gate` check enforces it mechanically on body/commits/diff)

<!-- Changing a protected asset will block your own PR — that is working as
intended. A reviewed, legitimate change is cleared by a maintainer applying a
`tamperward:allow:<rule>` label, never by weakening the policy to pass the gate. -->
