# Changelog

## [2.30.x] — Unreleased

- Codex shell enforcement now blocks protected-test deletion, renames out of the
  test glob, and destructive checkout/restore/reset operations while leaving
  path-limited non-destructive `git reset` operations allowed.

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) as scoped in
[CONTRIBUTING](./CONTRIBUTING.md#versioning).

## [2.30.1] — 2026-09-16

### Changed

- **cli: one shared status palette and renderer across surfaces** (#543). A new
  `src/cli/render/status.ts` owns the accessible 24-bit palette and the
  `severity → colour` map as the single source of truth; `check`, `onboard`,
  `doctor`, and `verify` now draw from it instead of re-declaring their own
  schemes (`onboard` no longer duplicates the palette or its tone map, and
  `doctor`/`verify` gain the same accessible colour treatment as the verdict).
  Presentation only — no change to exit codes, `--json` output, or any message
  text; the accessibility contract is preserved (the word carries severity,
  colour strips to a byte-identical line, and `NO_COLOR`/pipe/`TERM=dumb` drop
  all colour), and `test/render-status.test.ts` asserts the strip-to-identical
  invariant and the severity map.

## [2.30.0] — 2026-09-16

### Added

- **adapters: an EXPERIMENTAL Codex runtime adapter plus a real qualification probe**
  (#482, #563). A new `CodexRuntimeAdapter` (`src/adapters/codex/*`) implements the neutral
  `RuntimeAdapter` contract, grounded against the real Codex protocol (`openai/codex`
  `codex-rs/hooks/schema/generated` and `codex-rs/core/src/tools`), not guessed. It
  normalizes Codex hook payloads into the shared `SteeringEvent` shape using the canonical
  **hook-facing** tool names (`Bash` → `shell`; `apply_patch`, with `Write`/`Edit` matcher
  aliases → `file-edit`; `mcp__<server>__<tool>` → `mcp`; `view_image` → `file-read`),
  reconstructs shell and file-edit operations into the shared `Change[]` via `synthFileChange`
  (reading the real `apply_patch` payload from `tool_input.command`, with a parser that fails
  **closed** on a hunk it cannot locate), runs the **same** engine as the Claude path for its
  pre-action content decision, pins the Stop-sweep baseline at turn start, and delegates the
  end-of-turn sweep to the canonical git sweep. The deny wire is **phase-split** to match the
  real Codex output schemas: PreToolUse denies with `hookSpecificOutput.permissionDecision:
  "deny"` (plus the deprecated top-level `decision:"block"`), Stop denies with
  `{decision:"block", reason}` and no `hookSpecificOutput`. Identity is validated as an
  untrusted claim exactly as the Claude adapter does, and every failure state
  (`parse-failure`, `transport-failure`, `not-invoked`, an unreconstructable edit, a rejected
  identity) fails closed to a deny. Capabilities are deliberately **conservative and honest**:
  `preDeny` is **empty** because pre-action deny enforcement is not yet proven on a pinned
  Codex build (Codex currently fails open on some hook failures), and `unsupported` names that
  gap along with fail-closed hook transport (openai/codex#41979), network-egress control, and
  identity/authentication. Qualification is **three-layered**: (a) protocol-conformance tests
  validate inputs and deny wire against the real Codex schemas copied into
  `test/fixtures/codex-schemas`; (b) a probe self-test asserts the probe's classifiers against
  every deterministic mode and exercises the real driver end-to-end so the probe itself cannot
  false-green — both run in CI; (c) `probe:codex-runtime`
  (`harness/adapters/codex-probe.mjs`) is the real gate on a pinned Codex build, using a
  parent-owned append-only ledger (evidence, not `specIntact` alone), CONTROL-vs-GATED
  mutation pairs, an **observed** fail-closed-transport suite (each broken hook — including a
  missing executable — writes a positive `hook-failure` marker before the fault, the protected
  command drops a parent-owned **dispatch sentinel** so a PASS proves the tool was not
  dispatched rather than inferring it from an intact file, and an outer-timeout kill is treated
  as inconclusive, never a PASS), a real **Stop-block** qualification that requires Codex to
  **honour** the block by continuing (`stop_hook_active:true`), and an honest **multiple
  protected mutations** check (two distinct *denied* protected `tool_use_id`s) — all required
  for FULL, and a **provenance gate** (pinned `CODEX_VERSION_EXPECTED`/`CODEX_MODEL` passed
  operatively to `codex exec` as `--model`/`CODEX_HOME` with a version match, plus the canonical
  gated `.codex/hooks.json` SHA-256 that every qualifying run binds to) that caps at PARTIAL
  when unpinned — with no Codex CLI it reports PARTIAL and exits non-zero. An `apply_patch`,
  `Write`, `Edit` or `Bash` event whose required payload is missing now **fails closed** (deny)
  rather than reconstructing to an empty change set. The real-runtime qualification binds each
  proof to what it measures: the version pin is matched **exactly** (no `0.9.1`/`0.9.10`
  collision), the multiple-mutation case requires a denied op against **each** protected file,
  fail-closed `protectedToolAttempted` is bound to the **specific** Bash command with a
  pass-through control, and detached/background mutations are judged only after a **settle
  interval** so an ignored deny cannot escape by mutating after the command returns. Green CI proves
  build/unit/static + layers (a) and (b) only, **not** runtime qualification. This is milestone one: the adapter exists but is
  **not** 4.1-eligible — Codex stays `neutral` in `src/runtimes.ts` and no research round is
  registered. Wiring `.codex/hooks.json` from `init`/`onboard` and protecting that control
  surface (and full parity with `effectDriftBlocks`/`sanctionPredictedWrites`) is a **PR 2**
  follow-up.
## [2.29.21] — 2026-09-16

### Fixed

- **stats: mixed timestamp precision no longer reverses `first_event` and `last_event`**
  (#530). `summarizeAudit` ordered events by `timestamp.localeCompare`, so a whole-second
  timestamp (`2026-09-15T12:00:00Z`) sorted after a later fractional one
  (`2026-09-15T12:00:00.500Z`) and the reported first event could be later than the last.
  The published audit schema deliberately permits both representations. Events are now
  ordered by parsed instant (`Date.parse`) with the existing `id` tie-break for equal
  instants, so bounds follow real time regardless of wire precision. Counts and `--since`
  semantics are unchanged.
## [2.29.20] — 2026-09-16

### Fixed

- **watch: handle asynchronous FSWatcher errors instead of letting them bypass health
  reporting** (#550). Both filesystem-watcher backends handled synchronous setup failures
  but registered no `error` listener on the returned `FSWatcher`, so an error emitted
  *after* creation succeeded (e.g. `ENOSPC`/`EMFILE` watch-limit exhaustion) became an
  unhandled `EventEmitter` error that could terminate the observer while its last health
  record still described the earlier healthy state. Every watcher now attaches an `error`
  handler immediately and routes the failure through the existing degradation callback:
  the record goes `degraded`, the error count and `last_error` update, and a warning is
  emitted. The failed handle is closed and removed — the recursive backend reports lost
  coverage (`watched_dirs` → 0) rather than silently claiming complete coverage, and the
  fallback backend decrements its watched-directory count. Cleanup is idempotent: a
  repeated error on an already-removed handle is not re-counted and the handle is not
  re-closed.
## [2.29.19] — 2026-09-16

### Fixed

- **hook-service: bound shutdown so an open client socket cannot stall `stop`/restart**
  (#551). Graceful shutdown resolved only in `server.close`'s callback, which waits for
  every accepted connection to finish; the service tracked no active sockets and set no
