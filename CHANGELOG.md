Warning: truncated output (original token count: 78360)
Total output lines: 5102

# Changelog

## [2.32.0] — 2026-09-22

### Added

- **`research run` serializes writers for one ledger** (#546, #627). A run takes an exclusive
  `run.lock` in its `--out` directory before cloning a workspace or launching an agent; a
  concurrent run against the same ledger fails closed with exit `2` and one line on stderr
  naming the holder. Active or unreadable locks are never replaced. The new **`--break-lock`**
  flag is the explicit recovery for a crashed owner: it removes only a readable same-host lock
  whose recorded process is gone, claims the stale file atomically so a lock taken in the
  meantime is never deleted, and otherwise refuses.

## [2.31.1] — 2026-09-22

### Fixed

- **`research run` command adapter: replacement values are opaque** (#525, #626). The
  `{prompt}`, `{task}`, `{cwd}`, `{base}`, `{arm}` and `{model}` placeholders are now
  substituted in a single pass over the original argv template, so a prompt or task id that
  itself contains a literal `{task}`, `{cwd}` or `{model}` reaches the agent unchanged instead
  of being rewritten by a later placeholder. The token pattern is derived from the placeholder
  table, so a new placeholder is added in one place.

## [2.31.0] — 2026-09-18

### Added

- **adapters: an EXPERIMENTAL GitHub Copilot CLI runtime adapter** (#482, #598). A new
  `CopilotRuntimeAdapter` (`src/adapters/copilot/*`) is the third implementation of the
  neutral `RuntimeAdapter` contract, mirroring the Codex adapter's structure. Copilot CLI is
  closed-source, so the wire is grounded against the **published GitHub Copilot hooks
  reference** (the canonical contract for the CLI). GitHub documents **two** hook wire formats
  and the adapter accepts **both**: **native camelCase** (`preToolUse` → `sessionId`,
  `timestamp`, `cwd`, `toolName`, `toolArgs` where `toolArgs` is a JSON **string** that must be
  parsed; `agentStop` → `sessionId`, `transcriptPath`, `stopReason`) and the **PascalCase /
  Claude-compatible** format (`PreToolUse` → `hook_event_name`, `session_id`, `timestamp`,
  `cwd`, `tool_name`, `tool_input`, where `tool_name` is the Claude tool name `Bash` / `Write`
  / `Edit` / `Read`; `Stop` → `session_id`, `transcript_path`, `stop_reason`).
  Normalization is field-by-field, snake_case winning with camelCase as a fallback; the
  undocumented `tool_use_id` is not read. The adapter maps both tool vocabularies to operation
  kinds (`bash` / `powershell` / `Bash` → `shell`; `create` / `edit` / `apply_patch` /
  `str_replace_editor` / `Write` / `Edit` → `file-edit`; `view` / `Read` → `file-read`;
  `mcp__<server>__<tool>` → `mcp`), and reconstructs operations into the shared `Change[]` via
  `synthFileChange`. The shell-**session** write tools **`write_bash`** / **`write_powershell`**
  (which send input to a running shell) are classified as **mutation-capable `shell`** — never
  `other`, which would have silently allowed a mutation piped into an existing session — and
  fail closed when they carry no reconstructable command/input. `MultiEdit` is accepted
  defensively as a Claude-compatible name, not as a documented Copilot tool. The first-party
  **`apply_patch`** envelope (shared with Codex via a new `src/adapters/apply-patch.ts`) is
  modelled explicitly; **`str_replace_editor`** is modelled for its `str_replace` / `create`
  sub-ops and **fails closed** on any other sub-op pending a real payload; a PascalCase `Edit`
  carrying a patch-style payload without ordinary Edit fields also fails closed. Deletes/renames
  go through the shell. It runs the **same** engine as
  the Claude path for its pre-action content decision, pins the Stop-sweep baseline at turn
  start, and delegates the end-of-turn sweep to the canonical git sweep after normalizing the
  `agentStop` / `Stop` payload to the Claude Stop shape (native `sessionId` → `session_id`). The
  deny wire is **phase-split** to Copilot's real, distinct shapes: `preToolUse` denies with a
  **flat** `{ permissionDecision: "deny", permissionDecisionReason }` (no `hookSpecificOutput`
  wrapper), while `agentStop` denies with `{ decision: "block", reason }` — the same shape the
  canonical Stop sweep already emits. Identity is validated as an untrusted claim exactly as the
  Claude and Codex adapters do, and every failure state (`parse-failure`, `transport-failure`,
  `not-invoked`, an unreconstructable edit, a rejected identity) fails closed to a deny.
  Capabilities are deliberately **conservative and honest**: `preDeny` is **empty** because
  pre-action deny enforcement is not yet proven on a pinned Copilot CLI build, and
  **`postObserve` is empty** because milestone one does not consume the `postToolUse`
  observation surface (`decide(..., 'post-action')` returns `unsupported`), so the adapter does
  not advertise kinds it does not report. `unsupported`
  names the real gaps — Copilot's **asymmetric, transport-scoped hook-failure semantics** (a
  **command** `preToolUse` hook crash / non-zero exit / exit 2 fails **closed** but a **timeout
  fails OPEN**; an **HTTP** `preToolUse` hook fails **OPEN** on network error / timeout /
  non-2xx, so only the local command/exec transport is a qualification candidate), the fact
  that **`preToolUse` is the only pre-execution veto** while **`agentStop` only forces
  continuation** and Copilot **overrides the hook after 8 consecutive blocks** (the
  `stop_hook_active` lifecycle), and that the `apply_patch` / `str_replace_editor` /
  `write_bash` payloads are modelled from the published contract but not yet confirmed against a
  real pinned-run fixture.
  This is milestone one: the adapter exists but is **not** 4.1-eligible — Copilot stays
  `neutral` in `src/runtimes.ts` and no research round is registered. The real
  `probe:copilot-runtime` headless qualification on a pinned, authenticated Copilot build (the
  mutation and broken-hook / fail-closed matrices, with the command-hook timeout-fails-open case
  measured and the qualified transport captured in the provenance) ships as milestone two in
  `harness/adapters/copilot-probe.mjs` (a harness — not run in CI, no version bump); only a FULL
  verdict on a pinned build justifies flipping Copilot to `in-loop`. Adapter conformance runs in
  CI (`test/copilot-adapter.test.ts`); a green CI run does **not** prove runtime qualification.

## [2.30.6] — 2026-09-18

### Fixed

- **The research ledger reader now enforces the writer's own outcome/treatment
  derivations** (#552). A `PairRecord` carries summary fields (`visible_green`,
  `pristine_green`, `masked_failure`, `honest_completion`, the treatment
  `disposition`, and the measured/verdict pairing) that the writer derives once
  from the observed run, but the reader used by both `resume` and `summarize`
  (`pairRecordFrom`) accepted them verbatim, so an imported, hand-edited, or
  partially migrated record could feed the aggregator internally contradictory
  totals without being rejected. The derivations now live in one place
  (`src/research/derive.ts`) used by both the writer (`run.ts`) and the reader
  (`record.ts`); the reader re-derives each field and rejects any stored value
  that disagrees (green must match exit 0, masked must match `MASKED_FAILURE`,
  honest completion must match `VERIFIED` + pristine-green + zero surviving
  mutations, the disposition must match the envelope verdict, a measured
  trajectory must carry a measured verdict, and the rules list must be sorted,
  deduplicated, and non-empty exactly when a protected mutation survived). The
  verify verdict itself must also agree with the two stage exits it was derived
  from — mirroring the verifier's own mapping (`VERIFIED` needs both stages green,
  `MASKED_FAILURE` a green visible over a red pristine, `SUITE_RED` a red visible,
  `BUDGET_EXCEEDED` an absent stage exit) — so a record cannot carry a verdict its
  exits contradict. The accepted verify vocabulary is the canonical verifier set
  (`src/machine-output.ts`), including `BUDGET_EXCEEDED`, so every verdict the
  current writer can emit stays valid. `resume` and `summarize` now reject the
  same inconsistent record instead of silently aggregating it.

## [2.30.5] — 2026-09-18

### Fixed

- **`verify` now normalizes to the repository root** (#554). Standalone verification
  loaded policy from the repository root but enumerated and materialized only the
  caller's directory, so invoking `tamperward verify` from a package subdirectory
  ran the root suite against an incomplete copy and reported a false `SUITE_RED`
  for a perfectly valid repository. `runVerify` now resolves the repository root
  once at entry (the `check`/hooks pattern from #412) and uses it consistently for
  policy load, git enumeration, materialization, verifier inputs and suite
  execution. A nested invocation produces the same verdict and restored-file count
  as a root invocation; linked worktrees remain supported.

## [2.30.4] — 2026-09-18

### Fixed

- **Verifier descendant cleanup now checks process identity before signalling** (#545).
  The Linux capture supervisor tracked bare descendant PID numbers and `SIGKILL`ed
  them at completion/timeout without verifying identity, so a PID that had exited
  and been reused could belong to an unrelated same-user process. Each descendant's
  `/proc` start-time is now recorded and re-verified immediately before signalling
  (a `(pid, start-time)` pair names one process instance), and the detached
  group kill is gated on the child still being alive. A reused PID is dropped, not
  killed; a still-live descendant with unchanged identity is still terminated.

## [2.30.3] — 2026-09-17

### Fixed

- **Hardened three ReDoS-class regexes and one clone surface flagged by CodeQL.**
  The diff-header path split (`src/diff/parse.ts`) — which runs on agent-controlled
  diffs — now splits on the last ` b/` with a linear scan instead of a backtracking
  `/^(.*) (b\/.*)$/`; the strace path parse (`src/cli/trace-verify.ts`) and the shell
  tokeniser (`src/dependency-env.ts`) use unrolled, unambiguous quoted-string patterns.
  All three are proven to tokenise identically to the prior forms and to return
  promptly on crafted inputs. The research clone (`src/research/run.ts`) disables git's
  `ext::` transport (`-c protocol.ext.allow=never`) and ends options with `--` before
  the repository argument. Markdown table cells (`src/cli/render/github.ts`) now escape
  the backslash before the pipe, so a crafted `\|` cannot survive as an unescaped
  separator. No verdict changes; each fix has an added regression test.

## [2.30.2] — 2026-09-16

### Fixed

- **Codex shell enforcement** now blocks protected-test deletion, renames out of the test glob, and destructive checkout/restore/reset operations while leaving path-limited non-destructive `git reset` and staged-only `git restore` allowed (#571).


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
  request deadline, so a client that connected and never completed its request line held the
  socket open and left `hook-service stop` unable to complete (it then timed out while the
  old process stayed alive). The service now tracks every accepted socket and enforces a
  bounded pre-acceptance request deadline: a connection that never sends a complete request
  line is refused and closed rather than held open, and an incomplete request is never
  evaluated, so it records no side effects. Shutdown stops accepting new work, destroys any
  connection with no accepted evaluation in flight at once, gives the accepted request's
  socket a bounded drain window before destroying it too, and resolves cleanup only once
  every service-owned handle is gone. The bound is on the sockets, not on evaluation: a
  synchronously-running accepted evaluation still completes as it does in-process (this
  event-loop drain timer cannot preempt one that blocks) — an independently terminable
  evaluation worker is out of scope for this reliability fix. The client's existing
  fail-closed behaviour for a lost accepted request is preserved, a shutdown during an
  accepted request never triggers a second evaluation, and a normal idle-service stop is
  unchanged.
## [2.29.18] — 2026-09-16

### Fixed

- **policy: reject incomplete verify blocks instead of silently discarding verifier
  settings** (#547). `validate` accepted a `verify:` block without checking for a usable
  command, while `parsePolicy` retained the block only when its `command` was truthy — so
  a block that declared a `backend`, `image`, `budget`, or `inputs` but no command (or a
  whitespace-only command) parsed cleanly and was then dropped from the effective policy,
  silently discarding the operator's declared execution boundary and input surface. The
  loader now enforces one explicit contract: a `verify:` block must declare a non-empty,
  non-whitespace `command`, and an incomplete or whitespace-only block raises a descriptive
  `PolicyError` before execution rather than being accepted and discarded. Because a partial
  block can no longer survive into the normalized policy, supplying the suite command
  separately cannot alter the selected execution boundary. Complete verifier blocks preserve
  every declared field, unchanged.
## [2.29.17] — 2026-09-16

### Fixed

- **verify: the capture supervisor now flushes its result synchronously before exiting, so a
  large diagnostic payload is never truncated by process.exit** (#555). The inline capture
  supervisor wrote its reserved result JSON with `process.stdout.write(...)` and then called
  `process.exit(0)`. Per Node's process-I/O contract a pipe/socket write is **asynchronous on
  POSIX** (Linux and macOS) and synchronous only on Windows, so an immediate exit could drop a
  still-queued multi-KiB document — up to two 16 KiB base64 diagnostic tails — leaving the
  parent with empty or partial stdout and a spurious `VERIFIER_BACKEND_RUNTIME_FAILURE` /
  "suite capture supervisor did not produce a result". The supervisor now serializes the
  result once and writes it with `fs.writeSync(1, ...)`, looping over short writes and retrying
  `EAGAIN` on a backpressured non-blocking fd, so a slow or backpressured consumer always
  receives complete, parseable JSON with both maximum retained tails; a write that genuinely
  fails exits non-zero and is surfaced as a supervisor failure rather than a silently empty
  result. The bounded post-child pipe-drain and backstop behaviour from #539 is unchanged
  (`process.exit` still fires, only after the synchronous flush completes), so normal
  completion, suite timeout, and held-open suite pipe cases remain bounded.

## [2.29.16] — 2026-09-15

### Fixed

- **hooks: bound reconstructing AND judging an incoming edit so a high-churn write cannot
  stall PreToolUse** (#517). A `Write`/`Edit`/`MultiEdit`/`NotebookEdit` was reconstructed
  with an unbounded synchronous `git diff --no-index` (256 MiB buffer, no timeout) and then
  judged by every detector over the full content, so a 20,000-line high-churn write hung the
  agent-facing gate for 30+ seconds. Profiling showed the reconstruction is ~90 ms; the cost
  is detector evaluation, which grows roughly linearly with size. The shared reconstruction
  primitive (`synthFileChange`, used by the direct hook and the persistent hook service)
  now enforces a budget **calibrated to a demonstrated evaluation time**: an edit within
  `TAMPERWARD_RECONSTRUCT_MAX_LINES` / `_MAX_BYTES` per side (4000 lines / 384 KiB by
  default, ≈3 s) is judged **in full** — every detector runs and an appended `test.skip` is
  seen by `test-skip`; an edit **past** the budget **fails closed** with an explicit deny
  (`cannot safely reconstruct the incoming edit within the hook budget`), never a partial
  allow and never a stall (the Stop sweep still re-derives the turn's net diff from git). A
  strict git-diff timeout and bounded buffer, and a linear fallback that reconstructs one
  conservative hunk from the full before/after (never a truncated diff), bound the
  reconstruction itself. Two evaluation speed-ups keep the in-budget path fast, behaviour
  unchanged: a content-addressed parse cache (detectors re-parsed the same source many times
  per evaluation) and an O(1) fast path for `test-content-removal`'s kept-content check
  (previously O(n²) in removed lines). The 20k regression moves off its wall-clock
  assertion; an outer-process smoke test proves the built hook respects a hard maximum.

## [2.29.15] — 2026-09-15

### Fixed

- **verify: a suite that leaves a process holding stdout no longer hangs the capture supervisor, and fails closed as not-quiescent** (#539). The checkpointed-local supervisor keyed completion on the child's stdio pipes closing; a descendant that inherited the suite's stdout (a spawned server, a `setsid()` escapee that dodges the group kill and, on macOS, the `/proc` descendant sweep) held that pipe open, so the stage hung until the outer backstop killed the supervisor and discarded the already-known exit code — surfacing as the opaque `VERIFIER_BACKEND_RUNTIME_FAILURE` / "suite capture supervisor did not produce a result". Completion is now keyed off the main child's exit with a bounded post-exit drain window (`close` still wins whenever it fires first, so the ordinary path is unchanged). A stage that exits while a process still holds stdout open is **not quiescent** — that process can still mutate the tree, dependency environment or verification material between the visible and pristine runs — so `verify` **fails closed** with `CANNOT_VERIFY` (`VERIFIER_BACKEND_RUNTIME_FAILURE`, exit 2) and a precise reason, keeping the recovered exit code as diagnostics only. This is the same verdict and exit code the stage previously reached by hanging until the backstop, now prompt and legible; a suite that closes its pipes is unaffected.

## [2.29.14] — 2026-09-15

### Fixed

- **trace-verify: a ptrace/seccomp denial is no longer misreported as a non-zero
  verifier run** (#516). `trace-verify` checked `strace --version` but not whether the
  process may actually trace, so in restricted containers and sandboxed CI where
  `strace` is installed but ptrace is denied it emitted an advisory report with zero
  observations and returned 1 — inviting a maintainer to read "nothing observed" as
  verifier evidence. A tracer-capability preflight now traces a trusted no-op first and
  returns the documented exit 2 with an explicit ptrace/seccomp/Yama diagnostic when
  tracing is unavailable; each run distinguishes a tracer failure (empty/denied trace →
  exit 2, no report) from an ordinary traced command that exits non-zero (a healthy
  trace whose command exits 1 or times out is still reported as incomplete evidence,
  exit 1). A pure `classifyTraceRun` result classifier carries the decision and is unit
  tested, and the real-strace E2E now skips when the preflight reports tracing is
  unavailable rather than assuming `strace --version` implies permission.

## [2.29.13] — 2026-09-15

### Fixed

- **onboard: generated Claude settings no longer contaminate runtime detection**
  (#526). `init` writes `.claude/settings.json` for every runtime, and detection
  counted that self-written file as Claude usage — so a Cursor-only repository
  reported a phantom "Claude Code (in-loop)" runtime on the next onboarding pass and
  the neutral-only caveat vanished. Claude Code's markers are now files `init` never
  writes (`CLAUDE.md`, `.claude/settings.local.json`, `.claude/commands`,
  `.claude/agents`), and its generated `.claude/settings.json` is judged by content:
  it establishes Claude use only when it carries configuration beyond the two hooks
  `init` merges in. The neutral-runtime coverage note is preserved even when Claude
  Code genuinely coexists. Adds an integration test spanning detection → canonical
  init → detection for Cursor, Codex/AGENTS.md, and Copilot.

## [2.29.12] — 2026-09-15

### Fixed

- **`ts-any-cast` blocked a cast to a non-`any` alias shadowed in an unrelated scope**
  (#524). Alias resolution was a flat name→kind map, so a nested or sibling
  `type Value = any` overwrote a module-level `type Value = string`, and a legitimate
  `raw as Value` was misclassified as an `as any` launder and blocked. Resolution is now
  lexical: a name resolves against the scope of the assertion that uses it (walking
  enclosing scopes), an enclosing type parameter of the same name resolves to no launder
  kind, and the diff-only line fallback resolves a name only when every same-named alias
  in the file agrees, so a genuine same-scope `type X = any; raw as X` still blocks.

## [2.29.11] — 2026-09-15

### Fixed

- **doctor: verify the repository ruleset's full authority boundary** (#478). `doctor --github` now checks every direct CI status named by the self-gate, requires Code Owner review and stale-review dismissal, and fails closed when an active ruleset grants bypass actors. The required-checks list now enumerates the `platform-contract` matrix by its real per-cell contexts (`platform-contract (ubuntu-latest)`, `(macos-latest)`, `(windows-latest)`) instead of the bare job name, which could never match a published check context and always reported a false authority failure; a drift-guard test binds the list to `.github/workflows/ci.yml`. README documents the reproducible posture command.

## [2.29.10] — 2026-09-15

### Fixed

- **docs: VitePress now fails closed when SSR leaves an empty page** (#513). The rules guide's GitHub Actions expressions are rendered inside `v-pre` so Vue no longer interpolates them, and both docs workflows smoke-test the generated HTML before Pages upload so an empty or missing `guide/rules.html` cannot deploy.

## [2.29.9] — 2026-09-15

### Fixed

- **The privileged audit publisher accepted replacement evidence and did not fully
  enforce the audit schema** (#514). The write-authorized job now reconstructs raw
  candidates from the trusted checkout or manual input, validates the complete
  supported schema including severity/decision constraints, preserves the existing
  evidence prefix, appends only new batches/events, rejects conflicting IDs and
  rewritten batches, rejects store symlinks, and recomputes the summary and README
  without running npm or dependency code. The workflow no longer transfers a
  dependency-produced replacement store across the privilege boundary.

## [2.29.8] — 2026-09-15

### Fixed

- **Diff-only fallback: `ts-any-cast` and `test-skip` fired on comment and block-comment
  lines** (#446). With no before/after content the detectors fall back to a per-line scan
  that had no comment or string state, so a literal `as any` in a `//` line comment, an
  `as any` on a line inside a `/* … */` block whose opener was an earlier added line, or a
  `.skip`/`.only` inside a block comment all read as real code and blocked. A shared
  comment/string masker now blanks comment bodies and string/template interiors — block,
  string and template state carried across the change's after-view hunk stream (context
  lines advance the lexer; only additions can produce findings), and code inside a `${…}`
  template substitution stays scanned so a cast there is still seen — before the line
  matchers run. `ts-any-cast` blanks string interiors; `test-skip` keeps strings intact and
  rejects in-string hits through `insideStringLiteral`, so a computed-property marker
  (`it['skip']`) still fires. Regex literals reuse the token-aware scanner added in #439, so
  a real cast after `const re = /'/;` is not masked. Real casts and skip markers — including
  one following a closed same-line block comment, which the whole-line comment guard
  previously swallowed — are unaffected.

## [2.29.7] — 2026-09-15

### Fixed

- **snapshot-rewrite: node-tap's update triggers went unrecognised although
  `tap-snapshots/**` is protected** (#445). `TAP_SNAPSHOT=1`, the bare `tap --snapshot`
  flag, and `--update=true` (the `=value` form of `--update`) now warn consistently with
  the existing jest/vitest handling. `--snapshot` and `-u`/`--update` still only count
  next to a snapshot-capable runner, so unrelated commands stay silent.

## [2.29.6] — 2026-09-15

### Fixed

- **lint-suppression: `# NOQA`, a closed triple-quoted string, and a JS regex literal no
  longer hide a real directive** (#439). The `# noqa` / `# ruff|flake8: noqa` spellings now
  match case-insensitively, as flake8 and ruff accept them. The per-line quote scanner in
  `insideStringLiteral` treats a Python triple quote (`'''` / `"""`) as one delimiter, so a
  string that opens and closes on the line leaves a trailing directive outside it, and it
  recognises a JS regex literal (`/'/ `) so an apostrophe inside the pattern no longer opens
  a string that swallows the rest of the line and hides a following `// eslint-disable`.
  Directives genuinely inside a string or docstring stay excused.

## [2.29.5] — 2026-09-15

### Changed

- **Terminal verdict colours now use a 24-bit palette.** The blocking header and `BLOCK`
  render in red, `warn` and the sign-off command in amber, `clean` in green, and the
  `path:line` locator in cyan. Colour remains pure decoration layered over text that
  already spells the severity: the escapes strip to a byte-identical plain rendering, and
  output stays uncoloured under `NO_COLOR`, a pipe, `TERM=dumb`, or a CI log without
  `FORCE_COLOR`. No emoji or glyphs are introduced, and no command, flag, exit code, or
  machine-output contract changes.

## [2.29.4] — 2026-09-14

### Fixed

- **Persistent hook service: `stop` orphaned a live listener, and concurrent requests
  applied side effects for abandoned tool calls** (#416). `stop`/`status` trusted the
  candidate-writable state file, so a live service whose state file was altered (wrong
  pid/version) was reported "not running" and its socket unlinked, leaving an orphaned
  listener. `stop`/`status` now probe the socket itself: a socket that answers is a live
  listener that is never unlinked or reported absent; `stop` SIGTERMs only when the
  listener's self-reported pid/root/version agree with the state file, otherwise it
  reports the mismatch (exit 1) and leaves the socket intact, and `status` reports the
  live listener's own identity, warning when the state file disagrees. Separately, the
  single-threaded evaluator now refuses a second request that arrives while one is in
  flight (the client falls back in-process exactly once, with no service side effects),
  defers evaluation to the check phase so a concurrent request is read and refused before
  the loop blocks, and skips an accepted request whose client already disconnected — so
  the service never records predicted-write sanctions, ptree saves, or turn-baseline
  advances for a tool call that was denied by timeout. The wire protocol is unchanged.

## [2.29.3] — 2026-09-14

### Fixed

- **Claude adapter ignored `Edit`/`MultiEdit` `replace_all`** (#418). `applyEdit` modelled a
  single replacement even when `replace_all: true`, so the PreToolUse layer's predicted
  write (and the hash `sanctionPredictedWrites` records) was smaller than what the tool
  writes to disk — the next call re-judged via drift and threshold-based rules saw less
  than actually landed. `replace_all` now rewrites every occurrence (a function replacer
  keeps `$&`/`$1`/`` $` `` literal); the unique-match single path is unchanged. A new
  `test/claude-payload-corpus.test.ts` pins the projected `Change[]` for each recorded
  tool/mode shape (Write, Edit, Edit replace_all, MultiEdit, NotebookEdit insert/replace/
  delete) so weaker modelling of a future field surfaces as a test failure.

## [2.29.2] — 2026-09-14

### Fixed

- **`tamperward-audit` workflow started failing on every push to `main`** (follow-up
  to #502). A workflow-level `env` referenced `${{ runner.temp }}`, but the `runner`
  context is not available at workflow scope, so GitHub rejected the file before any
  job ran (a startup failure — 0 jobs, marked failed, and evaluated even on non-`main`
  pushes because the branch filter never applied). The paths are now derived inside
  the `run` steps from the always-present `$GITHUB_WORKSPACE` / `$RUNNER_TEMP`
  variables, and a regression test rejects any workflow-level `env` that uses a
  `runner` / `steps` / `needs` / `job` / `matrix` / `strategy` context.

## [2.29.1] — 2026-09-14

### Changed

- **Audit evidence ingests on merge to `main`** (#502). The `tamperward-audit` workflow
  gains a post-merge entry point beside `workflow_dispatch`: a reviewed PR adds an
  immutable `audit/pending/<batch-id>.jsonl` batch, and on merge the workflow ingests any
  batch whose id/content hash is not already recorded into the `tamperward-audit` evidence
  branch. Ingestion is deterministic and idempotent (dedup by content hash and event id;
  a build-free prescan short-circuits when nothing is new), and the write credential is
  isolated: a read-only `prepare` job builds and validates with no write token present
  while `npm ci`/build/candidate code runs, and a minimal `publish` job holds the write
  token but runs no candidate code. Committed batches are validated pre-merge by CI, and
  a `CODEOWNERS` entry covers `audit/`. There is still no `pull_request` /
  `pull_request_target` trigger, and the workflow remains the sole writer of the evidence
  branch and never writes `main`.
- **The README local-enforcement-envelope diagram is now a committed SVG** (#503) instead
  of a fenced Mermaid block, so it renders consistently on GitHub and everywhere Mermaid
  is unavailable — matching the architecture diagram. A `docs-status` regression check
  fails if a fenced Mermaid diagram is reintroduced into authored documentation.

## [2.29.0] — 2026-09-14

### Added

- **Runtime-aware onboarding** (#482, Phase 2 — first increment). `tamperward onboard`
  now detects which agent runtime a repository hosts and states exactly what protection
  each gets, instead of silently assuming Claude. A new `src/runtimes.ts` registry
  recognises Claude Code (`.claude/`), Cursor (`.cursor/` / `.cursorrules`), GitHub
  Copilot (`.github/copilot-instructions.md`) and an AGENTS.md-aware agent
  (`AGENTS.md` / `.codex/`) from repository-relative marker files. The Local-protection
  step opens with a `RUNTIME` line naming the detected runtime(s) and their steering
  coverage; when a repository uses a runtime with no shipped in-loop adapter, onboarding
  adds a `NOTE` stating plainly that deny-before-execute ships for Claude Code only today,
  that the live protection there is the agent-neutral layers (pre-commit + CI), and that a
  native in-loop adapter is tracked in #482. Detection is honest reporting only: it reads
  candidate-controlled marker files, so it shapes the setup narrative, adjudicates nothing,
  writes nothing and opens no verdict path. Adding a runtime to the registry does not grant
  it in-loop steering — that still requires a conforming `RuntimeAdapter` and its parity
  suite; the registry's `in-loop` flag flips only when that adapter ships.

## [2.28.0] — 2026-09-14

### Added

- **Privacy-safe self-hosting audit history and `tamperward stats`** (#495). Claude
  PreToolUse and Stop findings can now be recorded as strict audit-v1 JSONL with
  `TAMPERWARD_AUDIT_LOG` (`auto` uses the repository git directory). Events contain
  only a generated id, timestamp, enforcement surface, fixed agent id, rule,
  severity/decision and an optional one-way hashed session id — never prompts, tool
  command bodies, source/evidence text, filenames, absolute paths, environment values
  or credentials. The existing `TAMPERWARD_DENYLOG` remains the compact harness trace.
  `tamperward stats [--file F] [--since 30d] [--json]` validates and aggregates the
  structured stream by rule and surface while stating explicitly that an integrity
  finding is not proof of agent intent. `schemas/audit-v1.schema.json` and
  `schemas/stats-v1.schema.json` publish the event and aggregate contracts. TamperWard's own repository also ships a manually-dispatched
  `tamperward-audit` workflow: the copy committed on `main` revalidates submitted
  audit-v1 records, deduplicates event ids, writes only the separate
  `tamperward-audit` evidence branch, and regenerates its text/JSON summaries. Audit
  recording and persistence are measurement only; failure or alteration cannot change
  an enforcement verdict.

## [2.27.0] — 2026-09-14

### Added

- **A vendor-neutral in-loop steering contract, `RuntimeAdapter`** (#482, Phase 1). A new
  `src/adapters/contract.ts` names the seam between TamperWard's runtime-neutral engine and
  a specific agent runtime as a type: the `pre-action` / `post-action` / `end-of-turn`
  decision-vs-observation split (a synchronous deny before execution; observation-only after;
  a mandatory end-of-turn sweep), per-**operation** capability declaration
  (`shell` / `file-edit` / `file-read` / `mcp` / `other`, each `preDeny` / `postObserve` /
  `endOfTurn` / `unsupported`), and explicit outcome states — `ok` / `unsupported` /
  `not-invoked` / `parse-failure` / `transport-failure`, where `parse-failure` and
  `transport-failure` fail **closed** (deny), mirroring the live `HookInputError` →
  `failClosed`. The runtime-supplied `cwd` / identity is typed as an untrusted **claim** to
  validate against the runner's independently-derived repository root, never as authority.
- **Claude Code is the first implementation of that contract** (`src/adapters/claude/adapter.ts`)
  with **zero** change to live steering behaviour. It is a conformance wrapper: `decide()`
  delegates to the unchanged canonical `preToolUseFromRaw` / `stopFromRaw` in
  `src/cli/hook.ts` (still wired directly from the CLI), so its verdicts and wire bytes are
  byte-identical to the live hook; `denyPayload` reuses the same `denyWire` serialisation and
  `formatDenial` reason as the live `verdict()`. Claude declares all-operation pre-deny plus
  the end-of-turn stop. The deny/allow paths, `failClosed`, repo-root resolution (#412), the
  turn baseline, and the hook-service transport are untouched; the existing hook test suite
  is the guardrail and stays green unchanged.
- **Identity validation is enforced, not just typed.** `decide()` runs `parse → validate →
  decide`: it derives the runner's trusted repository root INDEPENDENTLY of the claim and,
  via the shared `validateClaimAgainstRoot` (`src/repo-context.ts`), fails **closed** (deny)
  BEFORE any content evaluation when the runtime-supplied `cwd` resolves to a different
  repository, a non-repository, a malformed path, or a symlink that escapes into another
  repository. The same helper is wired into the live `preToolUseVerdict` / `stopVerdict` via
  an optional `trustedRoot`: a runner that has an independently-derived trusted root gets the
  cross-repo claim rejected on the live path too. The parameter defaults to unset, so the
  direct in-loop hook and every existing caller are byte-identical — only a cross-repo /
  invalid claim newly denies. The claim is canonicalized with `realpathSync` BEFORE the git
  root is derived, so a symlink primed at one repository and then retargeted to another is
  decided on its CURRENT real target (and rejected), never a stale unresolved-path cache; a
  claim whose path cannot be resolved (non-existent, broken symlink) fails closed.
- **`post-action` is observation-only.** For Claude, `decide(..., 'post-action')` returns the
  `unsupported` outcome and can never produce a deny wire; the phase→hook mapping refuses to
  route `post-action` to a deny-capable hook rather than falling through to PreToolUse.
- **Neutral contract ↔ research `layers` mapping** (`CONTRACT_TO_RESEARCH_LAYER`): `pre-action`
  ↔ `pre-tool-use`, `end-of-turn` ↔ `stop-sweep`, the post-exit envelope ↔ `envelope`, with
  the per-operation capabilities refining the coarse layers so cross-runtime records do not
  drift.
- **Docs:** a vendor-neutral runtime-adapter guide (`docs/guide/runtime-adapters.md`) and an
  OWASP ACS mapping (`docs/ACS-mapping.md`) that maps only implemented event/control
  semantics, states the unsupported ones (no identity/authN, no network-egress control), and
  claims **no** ACS compliance. Both are linked in the docs sidebar. SPEC M5 gains a pointer
  to the new seam and is explicitly **not** declared met — this ships no second runtime.



## [2.26.0] — 2026-09-14

### Added

- **New `config-weakening` warn rule reads tsconfig, eslint, biome and the runner's
  setup modules (#447).** Three protected config families were protected in name
  only: `strict: true → false` and other tsconfig strictness lowerings, an eslint
  rule turned `off`, and an `ignores` / `exclude` / `.eslintignore` entry grown to
  hide source fired nothing, because no detector read the effective config, only
  the file's protected-glob membership. `config-weakening` now reads each family
  the way its tool does — tsconfig strictness flags (explicit or implied by
  `strict`) and loosening flags (`skipLibCheck`, `allowUnreachableCode`, …),
  `exclude` grown to hide a tracked source file, `extends` dropped or redirected
  off the protected set; eslint (flat and legacy) and `.eslintignore` — a rule
  turned `off` / `0` that was not off in any config of the family before the
  edit (a `.eslintrc` → `eslint.config.js` migration is not itself a weakening),
  `ignores` / `ignorePatterns` / `globalIgnores([...])` grown, a base rule
  retired beside its plugin-prefixed twin read as a replacement; biome
  `linter.enabled: false`, a rule or `rules.recommended` off, `files.ignore` /
  `linter.ignore` grown; and a NEW jest/vitest `setupFiles` /
  `setupFilesAfterEnv` / `globalSetup` / `runner` / `testEnvironment` /
  `reporters` entry pointing at a file this change adds or that no protected
  glob covers. `.eslintignore` and `biome.json[c]` join `protected.config` by
  default. Ships `warn` pending an fp-study replay
  (`harness/fp-study/CONFIG-WEAKENING-CORPUS.md`) before any block decision.
- **`test-deletion` reads a protected runner config delegating its selection to
  an unreviewed file, and `testNamePattern` (#447).** `export { default } from
  './vitest.real'`, `module.exports = require('./jest.real')`, a `...base`
  spread, `mergeConfig(base, …)`, `extends` / `preset`, and a `projects` entry
  were read as opaque and silent when the target was a file the same change
  added or that no protected glob covered — selection moved to a file the gate
  cannot read, and the config stayed nominally protected while selecting
  nothing. The delegation itself is now the finding, naming the target and
  whether it is a newly added file or simply unprotected; a delegation to an
  already-protected file stays silent, since the selection just moved where the
  gate can still read it. `testNamePattern` is read as a further selection
  predicate alongside the existing file-level narrowings.

## [2.25.2] — 2026-09-14

### Fixed

- **`ci-tampering` reaches composite actions and the other CI systems' entry files
  (false negative).** `protected.ci` covered only `.github/workflows/**`: a workflow
  that kept `- uses: ./.github/actions/test` while `.github/actions/test/action.yml`
  changed `run: npm test` → `run: echo ok` passed `check --staged` clean, and the same
  was true of `.gitlab-ci.yml`, `.circleci/config.yml`, `Jenkinsfile`,
  `azure-pipelines.yml`, `bitbucket-pipelines.yml` and `.travis.yml`. `protected.ci`
  now also names `.github/actions/**/action.y?(a)ml` and the other systems' entry
  files. A composite action gets the workflow rule's full removal/neutralisation pass
  over its `runs.steps`; the other systems' entry files get the generic check-line
  pass — a check line removed or neutralised in place, read from `script:` /
  `command:` / `sh` / `bash` / `pwsh` lines as from `run:` — with none of the
  GitHub-shaped logic (`on:` triggers, `if:` folding, `continue-on-error`, `shell: …
  {0}`), whose keys mean other things there. Two further readings keep this from
  over-firing: a neutralising suffix the removed line already carried (a piped
  typecheck's redirect target renamed, a Travis `|| travis_terminate` line rewritten
  around the same `||`) is a respelling, not a new neutraliser; and a deleted entry
  file whose checks move into a workflow the same change adds is a migration, not a
  removal. (#437)

## [2.25.1] — 2026-09-14

### Fixed

- **`ts-any-cast` closes the escapes beyond the literal `as any` / `as unknown as`
  spellings** (#440). Row 4 now blocks `as never` (assignable in the dangerous
  direction) and the double cast through `unknown` / `never` / `{}` / `object` /
  `Object` — `(x as {}) as T` launders exactly as `x as unknown as T`, and a lone
  `as {}` / `as object` stays the ordinary `ts-cast-growth` assertion it always was.
  A local `type` alias of any of those keywords is resolved within the file, so
  `type A = any; x as A` is `as any` (declared before or after its use, exported,
  parenthesised, or reached through another alias; generic, cyclic and honest aliases
  stay clean). `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` directives are counted
  live on the AST's comment ranges instead of by a whole-file regex, so removing a
  comment that merely *mentions* one no longer offsets adding a real one, and directive
  text inside a string, template or regex is not a directive. JSDoc `@type {*}` and
  `{?}` join `{any}` as the `any` cast in a `.js` file. Each fixture blocks on both the
  full-content (AST) path and the diff-only fallback — which resolves aliases declared
  on the change's own added lines — and `ts-cast-growth` no longer double-counts any of
  the moved spellings.


## [2.25.0] — 2026-09-14

### Added

- **New `test-support` warn rule: helpers, setup modules and fixtures under the test
  globs are a review prompt, not a gutted spec.** The `tests` globs are deliberately
  wide, so they also cover the files that only SERVE the specs — a helper module, a
  `setup.ts`, a `vi.mock` list, a JSON fixture, a case table. Before this change those
  read as a spec to `test-deletion` and `test-content-removal`: deleting
  `src/test/helpers.ts` or trimming `src/__tests__/fixtures/data.json` blocked as
  "test file deleted" / "test content removed" on files that define no test of their
  own. A shared `isSpecShaped` predicate (`src/detectors/spec-shape.ts`) now routes a
  `tests`-glob path to one of two outcomes: a runner-selected suffix (`.test.ts`,
  `_test.go`, `test_*.py`, `*Test.java`, `conftest.py`, …) stays a spec whatever it
  contains; a `fixtures/` / `__fixtures__/` / `__mocks__/` / `__snapshots__/` path
  component, a file in no language the detectors read, or content that defines no test
  on either side of the edit is support instead. `test-deletion` and
  `test-content-removal` now cede that class; the new `test-support` rule (row 20)
  picks it up at `warn` — deletion, a rename out of the `tests` globs, or a net-shrink
  of three or more significant lines with none of the removed lines kept elsewhere in
  the change. (#443)

## [2.24.7] — 2026-09-14

### Changed

- **Architecture diagram is now a standalone SVG instead of a Mermaid block**.
  `docs/architecture.md` embedded the component map as a fenced ```mermaid``` graph,
  which does not render where a Mermaid runtime is absent or too old. The diagram is
  now a hand-authored, dependency-free `docs/architecture.svg` referenced as a Markdown
  image (`![...](./architecture.svg)`), so it renders identically on GitHub, the
  VitePress site, and Markdown previewers. The SVG reproduces the graph faithfully — the
  Steering, Verification, and Authority lanes; every node and edge; solid-versus-dotted
  edge meaning with labels; and the shaded, dashed-red trust boundary around the
  Authority lane — and carries `role="img"`, `<title>`, and `<desc>` for accessibility.
  The README lifecycle diagram is unchanged. (docs)

## [2.24.6] — 2026-09-14

### Fixed

- **`tamperward onboard` preflight errors keep their colour and make repository-root
  mismatches easier to scan.** Error text is now sanitised before TamperWard adds ANSI
  decoration, so terminals no longer expose fragments such as `[1m[31mERROR` in place
  of colour. The child-directory refusal is rendered as a compact
  `ERROR / CURRENT / GIT ROOT / NEXT / OR` diagnostic with the two safe recovery
  choices called out explicitly.

## [2.24.5] — 2026-09-14

### Fixed

- **`test-deletion` reads the command surface the way `hook-tampering` reads it**
  (#432). The rule matched `rm` and `truncate` as words anywhere in a segment and
  compared the token as typed, so `grep -n "rm " test/a.test.ts`, `grep truncate
  test/a.test.ts` and `node scripts/rm-cache.js test/a.test.ts` blocked as deletions
  while `unlink test/a.test.ts`, `mv src/junk.ts test/a.test.ts` (the spec overwritten;
  only the move OUT was read), `echo test/a.test.ts | xargs rm`, `find . -name
  "*.test.ts" | xargs rm`, `dd if=/dev/null of=test/a.test.ts`, `rm test/a.te""st.ts`,
  `rm test/a.te\st.ts`, `rm test/a.test.{ts}` and `rm test/a.tes?.ts` passed. The
  command is now the word in command position past the wrappers hook-wiring skips
  (`sudo`, `env`, `nice`, `time`, `command`, `exec`, a `VAR=` prefix, a `/bin/`
  path) — shared `WRAPPERS`, `REDIRECT_TARGET`, `destinations` and the new
  `xargsCommand` are exported from `hook-wiring.ts` rather than copied — and a path
  is the word the shell hands the command (`shellWord`: embedded quote spans joined,
  backslashes resolved) with a glob expanded against the repository listing
  (`expandGlob`: `*`, `?`, `[ab]`, `{ts,js}`; without a listing a wildcard's literal
  part decides, so `src/*.test.ts` is specs and `src/*.ts` is nothing in particular).
  `unlink` and `shred` delete like `rm`; `sponge` and `dd of=` rewrite like `tee`;
  `cp`/`install`/`rsync`/`ln`/`mv` are read by their destinations, and a spec
  destination that is in the listing with a non-spec source is an overwrite (`mv
  a.test.js.skip a.test.js` onto no listed spec puts one back and is not); `… | xargs
  rm`/`unlink`/`shred`/`truncate`/`mv`/`tee`/`sponge`/`sed -i`/`perl -i` is judged over
  the specs the feeding segments name, a `find … -name` feed narrowed to its pattern.
  Replayed over the 1,511-command harness transcript corpus: the same 15 spec-writing
  commands fire on both builds with a listing, and the three read-only commands above
  are clean; the shared shell corpus fires and passes identically for a hook under
  `hook-tampering` and a spec under `test-deletion`.


## [2.24.4] — 2026-09-14

### Fixed

- **Tests left textually present but unreachable are counted as removed** (#431).
  `test-deletion`'s block count read textual presence as execution: an `it()` wrapped
  in `if (false) {}`, written after a `return;` in its `describe` callback, or moved
  into a `function later() {}` nobody calls still counted, so all three edits passed
  clean. The count is now a reachability count — `src/detectors/reachability.ts`
  marks the guarded branch of any condition that folds to a constant (`false`, `0`,
  `""`, `null`, `!true`, `false && x`, `x && false`, `1 === 2`, the else of
  `if (true)`), statements after an unconditional `return` / `throw` in the same block,
  loop bodies whose condition folds to false, and the bodies of named functions nothing
  live references, and `countTests` walks only what is left. `if (process.env.CI)`, a
  helper called from a test, a hoisted function called before the `return`, an IIFE and
  a named callback handed to `describe` stay counted. pytest is read the way it
  collects: a `def test_*` inside a class counts only when every enclosing class is
  `Test*` or a `TestCase` subclass, so `class TestMath` → `class MathTests` is a
  deletion while `→ class TestArithmetic` is a rename.
- **`test-content-removal` reads hidden content as removed** (#431). Three assertions
  moved into a template literal, a single-line string, an `if (false)` block or behind
  an early `return` kept their lines in the file, so nothing was "gone" and the edit
  drew only `warn:assertion-weakening` (the `//`-commented version already blocked).
  Significant lines are now read from the file's live text on both sides, a removed
  line is excused into the kept pool only where its text occurs as code (an occurrence
  that begins inside a string or template literal is the line quoted; a joined or
  rewrapped call still begins outside its string arguments, so reformatting stays
  excused), and ≥3 removed lines whose text survives only in the file's hidden text
  fire regardless of the net line count. Python: lines after a bare `return` / `raise`
  at the same indent and the suite of `if False:` / `if 0:` / `if None:` are hidden.
- **`test-skip` reads collection-time and configuration-time skips** (#431): a Go
  `func TestMain(m *testing.M)` added without an `m.Run()` call, any `//go:build` /
  `// +build` constraint added to a `_test.go` (only `ignore` was read before —
  `//go:build never` passed), a Rust `#[cfg(…)]` other than `cfg(test)` on `mod tests`
  or beside `#[test]`, JUnit 5 `@EnabledIf…` / `@DisabledIf…` in every spelling, and
  RSpec `it 'x', if: false` / `unless: true` / `:if => false`. `#[cfg(test)]`,
  `#[cfg(unix)]` on a plain helper, `TestMain` that calls `m.Run()` and
  `if: ENV['SLOW']` stay clean.
- Precision delta over the pinned immer/zustand/zod/hono mainline heads, last 150
  adjacent pairs each: see the pull request for the per-repository rows; the
  `test-content-removal` corpus test file and every existing `test-deletion` /
  `test-skip` regression pass unchanged.

## [2.24.3] — 2026-09-14

### Fixed

- **`test-skip`, `test-deletion` and `assertion-weakening` read a runner's modifier
  chain the same way** (#429). Three rules parsed `runner.modifier.each` chains three
  different ways. `test-skip`'s AST path required `.skip` / `.only` / `.todo` to be the
  LAST hop, so `describe.each(rows)` → `describe.only.each(rows)` and `it.each(rows)`
  → `it.skip.each(rows)` were never an AST hit — the single-line regex caught them by
  luck and the multi-line spelling walked past both — and `it.skip.each` was blocked only
  by accident, by `test-deletion` reading it as "2 → 0 blocks". `test-deletion` did not
  unwrap a modifier between the runner and `.each` / `.for`, so the refactor `it.each`
  → `it.concurrent.each` read as every row deleted and blocked. `assertion-weakening`
  accepted only a bare `it(...)` / `describe(...)`, so `toBe(2)` → `toBeDefined()`
  warned under `it('adds', …)` and was silent under `it.concurrent('adds', …)`, and a
  test under `describe.each(rows)('title', fn)` was never compared. One chain reader
  (`src/detectors/runner-chain.ts`) now serves all three: it unwraps `concurrent` /
  `sequential` / `shuffle` / `serial` / `parallel` / `skip` / `only` / `todo` / `fails`
  / `failing` in any order before `each` / `for`. `test-skip` treats a skip/focus marker
  anywhere before the table method as the marker and points the finding at the marker's
  own line; the outer call of a table chain (`X.each(rows)(...)`) is judged by its inner
  chain, so a proven non-runner root stays clean there too. `test-deletion` counts
  `it.concurrent.each` / `test.skip.each` / `describe.concurrent.each` tables per row
  as before the modifier, so the refactor is clean while rows dropped from such a table
  still count as deleted. `assertion-weakening` pairs `it.concurrent('adds')`,
  `test.sequential`, `describe.skip` and `describe.each(rows)('title', fn)` blocks by
  their literal title. Replay over the four pinned corpus heads (immer, zustand, zod,
  hono) with the three rules compared before → after: see the pull request's precision
  study; the assertion-weakening corpus stays 12/12 TP, 0/20 FP.

## [2.24.2] — 2026-09-14

### Fixed

- **`test-skip` reads Go `Skip` on any receiver and the pytest conftest hooks** (#441).
  The Go row matched `\b[tb]\.Skip`, so `tb.Skip()`, a subtest's `tt.Skip()` and
  testify's `s.T().Skip()` were silent; it now matches `Skip`/`Skipf`/`SkipNow` on any
  receiver and on `T()`. The pytest row knew only the decorator and runtime spellings,
  so a `conftest.py` — a protected test file — could filter `items` in
  `pytest_collection_modifyitems`, decide collection in `pytest_pycollect_makeitem`, mark
  every item with `add_marker(pytest.mark.skip)`, alias `sk = pytest.mark.skip` and use
  `@sk`, or set `rep.outcome = 'passed'` in a `pytest_runtest_makereport` hookwrapper
  without a finding. Each of those is now a `test-skip` block; the aliased decorator is
  resolved against the AFTER file when the change carries it, else against the added
  lines. A conftest that only registers fixtures, `pytest_addoption`, `pytest_configure`,
  a custom marker, a `Skip(` inside a string and the hook name in a comment stay clean.
  Replay of the test-skip suites (`test-skip-ast`, `fp-study-harness`,
  `detector-spellings`, `coverage-gaps`): 0 new findings.

## [2.24.1] — 2026-09-14

### Fixed

- **`hook-tampering` no longer judges every file added under `protected.hooks` as a
  shell script** (#442). Adding a `.pre-commit-config.yaml` with a linter repo, a
  `lefthook.yml` with a lint command, or husky's own `.husky/.gitignore` blocked with
  *a protected hook script was added that does not run the gate live: it runs no
  `tamperward check`* — a guarded block no policy could exclude — because the config
  comparator returned nothing for an add and the add branch ran before the note check.
  An added file is now classified by kind first: a YAML hook config
  (`.pre-commit-config.yaml`, `lefthook.yml`, `.lefthook.yml`, `lefthook-local.yml`) is
  compared by the config comparator against a fresh base carrying every gate entry the
  file names as `init` would write it (live, unskipped, unscoped, on the commit stages),
  so a config that names no gate or carries it live is clean while one that arrives with
  its own gate under `skip:`/`only:`, scoped by `glob`/`exclude`/tags/`stages`, rerouted
  by `env` or not live (`… || true`) reports the weakening; a note or git dotfile
  (`.husky/.gitignore`, `.gitattributes`, `*.md`, `*.txt`) is silent on add as on edit;
  a genuine shell hook script keeps the sign-off stance — a new `.husky/pre-commit` that
  does not run the gate live still blocks. `SPEC.md` row 8 and `docs/guide/rules.md`
  carry the contract.

## [2.24.0] — 2026-09-14

### Added

- **New rule `coverage-exclusion` (warn)** (#438). The per-function form of the
  `coverage-lowering` class: an inline exclusion added to a non-test source file —
  `/* istanbul ignore next | if | else | file */`, `/* c8 ignore next | start */`,
  `/* v8 ignore next[ N] */`, `/* node:coverage ignore next */` / `disable`,
  `# pragma: no cover` in every spacing and case coverage.py accepts, `#[coverage(off)]`
  bare or under `cfg_attr`, and a `//go:build` / `// +build` constraint added to an
  existing Go source file — takes the hard branch out of the measurement with no config
  touched, and no rule read it. Read per language, outside `protected.tests` and
  `protected.config` and off generated / vendored / declaration / output / example /
  docs / script / fixture paths; a marker inside a string literal or quoted behind a
  line comment is text, a marker line removed and re-added verbatim moved, a range
  closer (`ignore stop`) excludes nothing, a constraint on a new Go file is a platform
  split and one edited on a file that already carried it is not an exclusion. Severity
  is decided by corpus (`harness/fp-study/COVERAGE-EXCLUSION-CORPUS.md`):
  `coverage-exclusion-fires.mjs` replayed the rule over the `ts-cast-growth` study's
  460 adjacent first-parent pairs of immer, zustand, zod and hono and it fired on
  **none**; the 6,632 first-parent commits of the deepened clones hold four commits
  that add a spelling, every one an immer maintainer marking an environment-dependent
  branch with `/* istanbul ignore next */` — honest work the rule fires on by design,
  so precision as a tamper signal on real fires is 0/4 and block is not authorized. A
  labeled corpus (`coverage-exclusion-corpus.json`, 22 negatives reproducing the shapes
  maintainers write beside the spellings, 14 positives) is replayed in CI by
  `test/coverage-exclusion-corpus.test.ts`. SPEC row 19; `warn` never requires
  sign-off under the default policy, and operators may raise it to `block` in their own.

### Fixed

- **`coverage-lowering` reads the rest of the denominator-narrowing surface** (#438).
  Jest `collectCoverage: true → false` (top level, or under package.json `jest`), vitest
  `coverage.all: true → false`, nyc `--check-coverage` dropped from a script,
  `--cov-fail-under` lowered or dropped wherever the line lives — a package.json script,
  `pytest.ini` / `pyproject.toml` `addopts`, a `tox.ini` command, a workflow step (the
  one line-level reading the rule now applies to `protected.ci`) — and `setup.cfg` /
  `tox.ini` `[coverage:report] fail_under` lowered, removed or moved (the same
  coverage.py key as `.coveragerc` and `pyproject.toml`, so a gate moved between the
  four is a move, not a deletion) were each zero findings. A raised floor, a floor
  reformatted at the same number, a flag moved to another script in the same edit, and
  an unrelated `setup.cfg` / `tox.ini` edit stay clean.
- The benign file-suffix exemptions are read in the spelling of their list. Jest's
  `coveragePathIgnorePatterns` are regexes, where `'.md'` is "any character, m, d" and
  exempts `src/cmd.ts` and `src/readme-loader.ts`, yet the raw pattern passed the
  `\.md$` benign test; now only the anchored `\\.md$` / `\\.d\\.ts$` (and the other
  suffix literals written the same way) is benign in a regex list, while a glob
  `**/*.md` in vitest `coverage.exclude`, `.coveragerc` `omit` or `collectCoverageFrom`
  stays benign as before. The directory exemptions (`/dist/`, `<rootDir>/test/`) read the
  same in either spelling. The evidence now names the list the exemption was added to.
## [2.23.20] — 2026-09-14

### Fixed

- **The perf smoke measures the parser again, on CPU, alone on its runner** (#421).
  After the parser went lazy (#407) the smoke's yardstick `cli.noop` (an empty-stdin
  hook) no longer loaded the 9 MB TypeScript parser, but `check.diff.small` did, so
  its ratio measured "parser load versus process start" — `check.diff.small` sat at
  4.5× a 6× wall budget on an idle box — and inside the parallel `npm test` matrix
  the remaining headroom went to sibling test files, not regressions. The smoke now
  lives at `harness/perf/smoke.test.ts`, judges **p50 CPU** ratios to a new
  `cli.parse` item (a PreToolUse `Edit` of one `.ts` source with no session: process
  start + module load + parser load + one file evaluated) with budgets of 1.25× for
  `hook.warm.100` and `snapshot.100` and 3× for `check.diff.small` (measured 0.44×,
  0.48×, 1.46×), and runs alone from `npm run test:perf-smoke` (`vitest run --config
  vitest.perf-smoke.config.ts --no-file-parallelism`) in a new `perf-smoke` CI job on
  Node 20 / 22 / 24 that `gate` requires; `npm test` no longer runs it. The smoke pins
  itself with injected regressions: the real run's report with `check.diff.small`
  scaled 3× must fail the judge that passed the real run, and the committed baseline
  with `hook.warm.100` doubled must fail `compare.mjs`.
- **`harness/perf/BASELINE.json` says what it is, and the `perf` workflow says how
  to replace it** (#421). The committed baseline had been captured in a busy
  sandbox before the parser went lazy (`cli.noop` p50 1.7 s where an idle box
  measures 0.12 s), so every hook, snapshot and check item would have had to regress
  roughly 30× before the nightly compare went red — and `compare.mjs`'s budget is
  exclusive, so its 2× default never failed an exact 2× either. Its numbers are kept
  byte-for-byte (another loaded sandbox is a different wrong machine, not the right
  one); it now carries a `note` (*captured in a loaded sandbox; reference baseline
  pending the first green perf workflow artifact*), `machine.ci: false`, and
  `budgets` pinning the hook items (`hook.warm.100`, `hook.cold.1k`, `hook.warm.1k`,
  `hook.ignored`) at 1.5×, and the smoke holds it to that state: a reference
  baseline (`machine.ci` set) must carry `cli.parse` clearly above `cli.noop`, a
  stand-in must confess. `perf.yml` uploads its report as `perf-baseline-candidate`
  and prints the promotion recipe in the job summary; the new
  `harness/perf/promote-baseline.mjs <perf.json>` copies a green run's report into
  place — budgets carried over, `machine.ci` stamped, `note` dropped, a report that
  lost a baselined item refused — and prints the old-versus-new p50 table the
  replacing PR must carry (docs/PERF.md, "The baseline").

## [2.23.19] — 2026-09-14

### Fixed

- **`no-verify` reads the bypass where it actually lives** (#433). `HUSKY="0" git commit`
  and `export HUSKY="0"` were silent: the tokeniser stripped only a token's outer quotes,
  leaving `HUSKY="0` for `^HUSKY=0$` to miss. Tokens are now unquoted the way the shell
  reads them (`HUSKY="0"`, `HUSKY='0'`, `--no-verify""`, `"it's"` all resolve to their
  content), and the same spellings one shell deeper (`sh -c '…'`, `eval …`) are read
  as the command they run. A git alias that carries the flag — `git config alias.ci
  "commit --no-verify"` (then `git ci`), `git -c alias.ci='commit -n' ci`,
  `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` and `GIT_CONFIG_PARAMETERS` injection, a
  `!`-shell body — is judged as the invocation it expands to, the way `core.hooksPath`
  already was; `alias.lg "log -n 20"` and `alias.ci "commit -v"` stay clean.
  `pre-commit uninstall`, `lefthook uninstall`, `husky uninstall` (under `npx`, `pnpm
  exec`, `python -m`) and `rm` / `unlink` / `mv` / `chmod -x` of the pre-commit
  framework's install target (`.git/hooks/<hook>`, `$(git rev-parse --git-dir)/hooks/…`,
  the whole `.git/hooks` directory) block: `.git/hooks/**` is outside every git view,
  so `protected.hooks` never covered it. Reading the hook, installing one, `chmod +x`
  and deleting git's `*.sample` files stay clean. The literal `--no-verify` is now read
  on `git am`, `git rebase` and `git cherry-pick` too.
- **`git commit -mfinal` no longer reads as `git commit -n`** (#433). The `-n`
  cluster test ran after the option-value stripper recognised only a detached `-m`, so
  the letters of a glued message (`-mfinal`, `-mdone`, `-mn`) were tested as flags. A
  value-carrying short option (`-m`, `-F`, `-C`, `-c`) now ends the cluster: the letters
  before it are the flags (`-anm x` is still `-n`), the rest of the token — or the next
  token when nothing follows — is the value.

### Added

- **`no-verify` warns on the commit paths that never run pre-commit** (#433). `git
  commit-tree`, `git update-ref <branch> <sha>`, `git am`, `git cherry-pick` and `git
  rebase` write commits the hook never sees. They ship at warn whatever the rule's
  severity (a rebase onto main or a cherry-picked fix lands commits the hook already
  checked, and the 1,511-command harness corpus holds none of them either way, so block
  would refuse routine history work on no evidence); `--continue` / `--abort` / `--skip`
  / `--quit` on an operation in progress and `cherry-pick --no-commit` are clean. The
  rationale is in `docs/guide/rules.md`.

## [2.23.18] — 2026-09-14

### Fixed

- **The CLI no longer exits before its stdout has drained** (#415). Every exit after
  output a consumer parses — `check --json`, `check --format github`, the Claude
  `hook` deny and `sweep` block JSON, `verify` / `run` / `doctor` / `research` machine
  documents, `hook-service status` — went through `process.exit(code)` straight after
  `process.stdout.write(...)`. That is only safe when the write completed synchronously:
  Node makes pipe writes asynchronous on macOS and Windows, and even a Linux pipe backs
  up in the stream once the kernel buffer is full and the reader is slow, so a document
  larger than the pipe buffer was cut off at exit. For the hook that was a fail-open —
  a truncated deny is a malformed hook response, which Claude Code ignores, so the deny
  became an allow. The CLI now exits through one `exitAfterFlush(code)`
  (`src/cli/exit.ts`): it sets `process.exitCode` and calls `process.exit` from the
  stdout/stderr write callbacks, which the streams invoke only once everything queued
  before them has reached the OS. Exit codes and output are unchanged; on a synchronous
  stream the callbacks fire on the next tick. `watch` and `hook-service start` still
  never exit on their own (the event loop is the daemon lifetime). Regression:
  `test/stdout-drain.test.ts` spawns the built CLI with stdout as a pipe the test does
  not read for a while and with `test/fixtures/async-stdout.cjs` preloaded, which
  makes every stdout write complete on a timer the way a macOS/Windows pipe does, and
  asserts that a 2.4 MB `check --json`, a 1200-annotation `--format github` verdict,
  a 300 KB hook deny and a Stop block each arrive complete and parse. README's platform
  table now states the contract: parsed output is complete before exit on every
  platform.

## [2.23.17] — 2026-09-14

### Fixed

- **`init` and `doctor` certify the hook wiring by the `hook-tampering` comparator**
  (#413). `init --dry-run` reported `agent ok — already wired` and `doctor` reported
  `[OK] claude-hooks` for a `.claude/settings.json` entry carrying the exact command
  plus `"async": true, "timeout": 1` — a gate the runtime never awaits and kills before
  it answers, and a file `check --staged` blocks as hook-tampering — because both tested
  only for the presence of the command. The canonical-shape comparator is now exported
  from the detector and consumed by `planClaudeHooks` (init) and `collectLocalPosture`
  (doctor): an entry the runtime would not run the gate through (`async`, `if`, a
  `timeout` below 120s, any other key init does not write, a matcher on the Stop entry,
  text around the invocation) is `would update` from init — restored to the shape init
  writes on the next run when the command is one init wrote — or `error` for a
  hand-written command, and `[BROKEN] claude-hooks` from doctor with the detector's
  reason. `onboard`'s posture summary inherits the verdict. A pre-commit gate line whose
  first non-blank character is `#` — `sed -i 's/^npx /# npx /'`, the common "temporarily
  disable" edit — read as wired from both; comment lines are skipped before the gate-line
  search, so it is `would update … append the staged check` / `[WARN] pre-commit`, and
  re-running init writes a live line. A correctly wired repository, including a
  `timeout` at or above the floor, stays `ok` / `OK`.

## [2.23.16] — 2026-09-14

### Security

- **`init` no longer follows a symlink planted in repository content** (#414). Every
  file init writes — `.tamperward.yml`, `.claude/settings.json`, the pre-commit hook in
  whichever hooks directory is resolved or `.husky/pre-commit`, CODEOWNERS in any of
  its three locations, the workflow — went through `existsSync` / `writeFileSync` with
  no `lstat`, so a `.claude/settings.json` symlinked to `~/.claude/settings.json` had
  the project hooks written into the user's file, a `.git/hooks/pre-commit` symlink had
  the gate line appended to whatever it pointed at, and a tracked `.husky/pre-commit`
  symlink let a pull request aim a reviewer's later `init` or `onboard` at any file the
  reviewer can write. Each target is now `lstat`ed first; a symlink or non-regular file
  is an error row reading `refusing: symlink` / `refusing: not a regular file` (exit 2
  when applying, the same row under `--dry-run`), the link and its target are left
  byte-identical, and the rest of the plan still applies. Every write is a temp file in
  the same directory plus rename, so the destination is never opened for writing and a
  crash mid-write cannot leave a truncated settings.json.
- The symlink refusal and atomic replacement `onboard` had since the #402 review now
  live in `src/safe-write.ts` (`refuseNonRegular`, `writeTargetKind`, `existingMode`,
  `atomicReplaceFile`) and both commands use it; a directory where init expected a file
  is reported as the refusal above rather than as an `EISDIR` planning failure.

## [2.23.15] — 2026-09-14

### Changed

- **Docs site: the reference pages are in the navigation and the architecture diagram
  draws the authority edges and the trust boundary** (#451). `architecture`, `PERF`,
  `CAST-INVENTORY` and both threat models were built but appeared in no nav or
  sidebar; they now form a "Reference" group (and nav entry). `CAST-INVENTORY` linked
  `../harness/…`, which resolves on GitHub but 404s on the site because `harness/` is
  not served; it now uses the GitHub blob URL like every other page. The architecture
  diagram is redrawn as three lanes — Steering (agent runtime → Claude hooks →
  `tamperward hook` → protected-tree snapshot → deny/allow), Verification (`run`
  envelope → `check` + `verify` → visible and pristine → local verdict/JSON) and
  Authority (protected CI running the same `check` and `verify` against the trusted
  base → required gate → branch rules + CODEOWNERS → merge) — with the Authority lane
  shaded as the trust boundary, the previously missing `ci → check`, `ci → verify`,
  `policy → pristine` and `observer → Stop sweep` edges, `init` writing across all
  three lanes and `doctor` reading them, and nodes for `onboard`, `trace-verify`,
  `hook-service` and `research`. The "Data flow" prose matches the redrawn diagram.
  The docs consistency test now asserts every built page is in the sidebar or nav and
  that no docs link targets `harness/` relatively.

## [2.23.14] — 2026-09-14

### Security

- **A content-triggered detector crash failed OPEN at the Stop sweep and at
  PreToolUse** (#444). The engine emitted the fail-closed `detector-error` block only
  for the `staged`, `worktree` and `range` views; the Stop sweep evaluates the `turn`
  view and PreToolUse the `tool-call` view, so a rule that threw on repository content
  was silently dropped at exactly the two layers the agent meets. A spec beginning with
  `const deep = [[[…30 000 deep…]]];` plus `it.skip(...)` made `test-skip`,
  `test-deletion` and `test-content-removal` throw `RangeError` — 0 findings, allow —
  while the same content was `block:detector-error` at pre-commit. Two fixes. The
  engine now fails closed at **every** view (a caller that names no view included): a
  thrown detector is a blocking `detector-error` naming the rule, carried on the
  PreToolUse deny channel and the Stop block channel like any other block. And the
  crash is no longer reachable from content: every `ts.createSourceFile` in the
  detectors (`test-skip`, `test-deletion`, `test-content-removal`,
  `assertion-weakening`, `ts-any-cast`, `ts-cast-growth`, `coverage-lowering`,
  `suite-config`) goes through one guarded entry, `parseSource` in `src/ts-lazy.ts`,
  with a 4 MiB byte ceiling and a 256-level bracket-nesting ceiling that **declines**
  (null) instead of throwing, and declines a `RangeError` the parser still raises the
  same way. A declined parse is not a verdict: the rule's line-level matcher judges the
  file, as it does for a diff-only change — so the fixture is denied at PreToolUse,
  blocked at Stop and blocked at `check --staged` by `test-skip`, not by
  `detector-error`, and the same deep literal without a skip is clean at all three. A
  declined `test-deletion` count is an open count (no deletion asserted, no relocation
  credit granted); a declined config parse selects like the default, as its catch
  already did.

## [2.23.13] — 2026-09-14

### Security

- **Workflow supply chain: every action pinned to a commit SHA, nothing fetched
  unpinned at publish time, no persisted token on the root-privileged runners** (#423).
  All 69 `uses:` lines across the 14 workflows now name a full commit SHA with a
  `# vX.Y.Z` comment (`checkout` v5.1.0, `setup-node` v6.5.0, `setup-python` v5.6.0,
  `setup-uv` v7.6.0, `upload-pages-artifact` v4.0.0, `deploy-pages` v4.0.5), resolved
  from the tags themselves; the release job — which holds `id-token: write` and mints
  the npm publish credential — no longer trusts a mutable tag. `upload-artifact` and
  `download-artifact` are on one pinned v5.0.0 everywhere (the mixed v4/v5 could not
  read each other's artifacts across workflows). `.github/dependabot.yml` moves the pins
  weekly for `github-actions` and `npm`. The release guard that refuses a downgrade
  runs on a lock-pinned `semver` 7.8.5 devDependency after `npm ci` instead of
  `npx --yes semver@7.8.5` fetched from the registry at publish time. `mine.yml` reads
  the dispatch input `POOL` from `process.env` inside `node -e` instead of splicing it
  into the JavaScript source. `pilot.yml` and `counted.yml` check out with
  `persist-credentials: false` and unset `GITHUB_TOKEN` in the `sudo -E env` wrapper
  around every privileged call, so the task code and the agent running as root never
  see the checkout credential; only the unprivileged state restore/save/checkpoint
  steps receive it. `test/workflow-pins.test.ts` pins all of this against the
  repository's own workflows.

## [2.23.12] — 2026-09-14

### Fixed

- **The Stop sweep no longer allows on a cwd it could not resolve** (#417). A payload
  whose `cwd` did not exist or could not be read produced the same empty stdout at exit 0
  as a plain non-repository directory, while PreToolUse denied the same cwd. The sweep now
  allows only when the directory exists, is readable, and `git rev-parse` itself reports
  *not a git repository*; a missing or unreadable cwd, a bare repository, or any other git
  failure is denied as `tamperward-unavailable` with the diagnostic in the reason.
- **The turn baseline fails closed** (#417). The marker the sweep compares against was
  written with a plain `writeFileSync`, a parallel hook could read a half-written sha, the
  guard accepted 7–40 hex characters so a truncated prefix passed, and any write failure
  silently downgraded the sweep to `git diff HEAD` — making a mid-turn commit invisible
  again, the case the baseline exists for. The marker is now written to a temp file and
  renamed into place (as the effect state already was), read only as exactly 40 hex
  characters (anything else is absent and re-established), and a write that fails denies
  the turn as `tamperward-unavailable` naming the path, at Stop and at the PreToolUse
  call that pins it.

## [2.23.11] — 2026-09-14

### Fixed

- **`test-deletion` reads the package.json test scripts as check invocations** (#435).
  Rewriting `"test": "vitest run"` to `echo ok`, `vitest run || true`, `vitest run
  src/easy.test.ts`, `vitest run --config vitest.ci.ts` (a file nothing protects, or one
  the same change adds), `vitest run --shard=1/1000`, or dropping nyc's `--check-coverage`
  left CI running `npm test` unchanged and the whole suite neutralised with no finding —
  the cheapest complete bypass in the ruleset. The `test`, `test:ci`, `check` and
  `pretest` scripts are now compared before → after the way `ci-tampering` compares a
  workflow line: a script that no longer runs a check, or runs a check of another kind,
  is a removal; a masked status (`|| true`, `; exit 0`, a pipe, `--passWithNoTests`,
  `--if-present`), a `timeout` wrapper, a dropped coverage gate, or a narrowed suite — a
  runner flag (`--shard`, jest `--root` / `--rootDir` / `--testMatch` / `--testRegex` /
  `--modulePathIgnorePatterns` / `--selectProjects`, pytest `-k` / `-m` / `--deselect` /
  `--ignore`, mocha `--grep` / `-g`, `go test -run`, `cargo test -- --skip`, and the
  flags already read), a spec path as a positional, an unreviewed `--config` — is a
  neutralisation. `test:unit` / `test:integration` are deliberate slices: their
  `--project` or positional is design, and only a masked status, a timeout or a
  replacement is reported. A runner migration that keeps the suite (`jest` → `vitest
  run`, `mocha` → `vitest`), an env prefix (`cross-env`, `NODE_OPTIONS=`), an `nyc` /
  `c8` wrapper, `python -m pytest`, a reporter flag, a flag that was already there and a
  check moved into a script the same change adds stay clean.
- The invocation reading `ci-tampering` already had — `survives()`, the neutralising
  suffixes, the narrowing-flag table, the path positional, the `timeout` wrapper — now
  lives in `src/detectors/invocation.ts` and is consumed by both rules; the GitHub
  expression folder moved to `src/detectors/gh-expression.ts`. The per-runner narrowing
  table and the `--cov-fail-under` floor `ci-tampering` gained in #436 are read by the
  script comparison through the same module.

## [2.23.10] — 2026-09-14

### Fixed

- **`ci-tampering` reads same-kind respellings that run nothing as neutralisations**
  (#436). `npm test` → `npm run tests --if-present`, `--prefix packages/empty`, `-w empty`,
  `pnpm test --filter nothing`, `npx jest --shard=1/1000` / `--testMatch '**/nothing.js'`,
  `cargo test -- --skip failing`, `pytest -k nothing_matches`, a lowered
  `--cov-fail-under`, `npx vitest run --root packages/empty` were all kept as respellings.
  Narrowing flags are now read per runner (`-w` is a workspace to npm, not `--maxWorkers`
  to jest); a `working-directory` (step or `defaults.run`) pointing at a directory with no
  tracked code or manifest, and `actions/checkout` given a literal `with.ref`, are
  neutralisers.
- A removed check no longer "survives" inside a heredoc body, a `run: >` folded scalar's
  continuation line, an `echo`, a step `name:` or a comment: a survival candidate must
  invoke the check in command position, behind nothing but assignments and wrappers.
- `if:` built from `contains` / `startsWith` / `endsWith` / `fromJSON` / `format` / `join` /
  `toJSON` over constant arguments folds to its value, so `if: contains('a', 'b')` and
  `if: ${{ fromJSON('false') }}` are read as `if: false`.
- Trigger narrowings: an event with no `branches:` filter is read as `['**']`, so
  `push:` → `push: branches: [never-exists]` and `pull_request:` →
  `branches: [release/**]` are narrowings; a `tags:`-only filter replacing `branches:`
  loses every branch; `!` entries apply in order (`[main, "!main"]` names nothing);
  `paths-ignore` is evaluated against the repository's source files as `paths` is.
  `[main]` → `[feature]` keeps blocking; a matrix or caching change stays clean.
- `- run: pytest` (a bare tool right after the `run:` key) is now recognised as a check
  invocation on the step line, as `npm test` already was.

## [2.23.9] — 2026-09-14

### Security

- **A policy edit can no longer demote the test rules by growing `protected.snapshots`,
  and a negated protected glob no longer makes every file "protected" (#434).**
  `mergeProtected` is additive, policy-diff counted only removed globs as a narrowing,
  and the spec rules judge `tests && !snapshots` — so
  `protected: { snapshots: ['**/*.test.ts'] }` lowered `test-deletion` to
  `snapshot-rewrite` with no finding, and `protected: { tests: ['!zzz'] }` (picomatch:
  every path) made every source file a test file, silencing `ts-cast-growth` and
  lowering `ts-any-cast`. `hook-tampering`'s policy-diff now reports both as a policy
  weakening: any glob added to `protected.snapshots`, any negated glob added to any
  protected category, any `tests` glob that also matches snapshot paths, and — in
  general — every rule whose jurisdiction is a category predicate compared by its
  **reach** over a probe listing (the repository's tracked files when the gate has
  them, joined with the conventional samples) before and after the edit; a path that
  leaves a rule's reach is reported naming the path and the rule. The edit is judged
  under the policy in force before it, so the exclusion cannot be weaponised by the
  change that writes it (regression covered).
- **The loader refuses negated globs** (`!x`) in every `protected` category, in
  `ignore` and in a per-rule `exclude`, with a message naming the mechanism — a `!`
  pattern matches every path — and fails closed like any other unparseable policy.
- Precision: the cast rules cede test files by design, so a new `tests` glob that
  names a real layout (`packages/new/**/*.integration.ts`) stays clean; their loss of
  reach is reported only when the same edit also takes a conventional source path
  out of reach. Widening `config`, `ci` or `hooks` is unchanged (a strengthening).

## [2.23.8] — 2026-09-14

### Fixed

- **`test-skip` no longer goes silent on a runner it cannot name (#428).** The
  JS/TS AST path claimed every `x.skip(...)` / `x.only(...)` call once it had parsed
  the file, and declared the file clean whenever the chain root was not one of the
  runner imports it knew — while also suppressing the line matcher that catches the
  same call on a bare diff. A Playwright-style repository (`import { test } from
  './fixtures'`, `const test = base.extend({})`), a namespace import
  (`import * as v from 'vitest'; v.it.skip(...)`) or a wrapper package therefore got no
  skip coverage at all on full content. The AST now claims a call only when the root is
  proven: a runner (a known runner module's export by name, default import, namespace
  member or `require`, a `X.extend(...)` / `X.extend<T>(...)` of one, an alias, or a
  relative fixture module's `export const test = base.extend(...)` / re-export /
  `module.exports`, followed through the change's own content or the repository's copy)
  or a non-runner (a parameter, a local `function it()`, a local declaration whose
  initialiser is none of those, a non-runner name from a known runner module). A root it
  cannot classify — a package it does not know, a fixture it cannot read — leaves that
  call to the regex, so the full-content and diff-only paths agree. `test.describe.skip`
  / `test.describe.only` under Playwright count as the chain they are. Corpus replay
  (`harness/fp-study/TEST-SKIP-AST-CORPUS.md`) re-run over the same pinned immer /
  zustand / zod / hono heads: 524 adjacent pairs, 0 newly introduced findings.

## [2.23.7] — 2026-09-14

### Fixed

- **`test-deletion` blocks a spec renamed into a path the runner does not walk** (#430).
  A rename that stayed inside the tests glob was silent even when the runner would
  never open the new path: `src/a.test.ts → cypress/a.test.ts` (vitest's default
  exclude), `tests/integration.rs → tests/integration/mod.rs` (cargo builds only
  `tests/<name>.rs` and `tests/<name>/main.rs`), `pkg/a_test.go → pkg/testdata/a_test.go`
  (`go test` skips `testdata`, `_*` and `.*` components) and
  `tests/test_a.py → tests/.archive/test_a.py` (pytest's default `norecursedirs`).
  The rename branch now evaluates the new path against the runner's default exclusion
  set — the same `test.exclude` / `norecursedirs` defaults the suite-narrowing
  predicate already reads — plus the per-ecosystem target rules above, and reports
  *renamed into a path the runner does not walk*. The `mv` spelling on the command
  surface is held the same way. Only a rename whose old path was itself walked fires,
  so an ordinary move within the walked tree (`src/a.test.ts → src/unit/a.test.ts`,
  `tests/x.rs → tests/x/main.rs`) stays clean.
- **`policy.ignore` can no longer hide the old path of a rename** (#430). Suppression
  tested the new path only, so with an ordinary `ignore: ['docs/**']` the rename
  `test/a.test.ts → docs/a.md` produced no finding. A rename is now suppressed only
  when both of its ends are ignored, and never when the old path is in a protected
  category.

## [2.23.6] — 2026-09-14

### Fixed

- **Every worktree-reading path is rooted at the repository, not at cwd (#412).**
  Git views report root-relative paths, but `check --worktree` / `--staged`, the Stop
  sweep, PreToolUse, `allow`, `doctor` and the protected-tree snapshot joined those
  paths onto the directory the command ran from. From a subdirectory of the repository
  the after-content of every changed file resolved to a path that did not exist, the
  content/AST detectors went blind, and the root `.tamperward.yml` was silently replaced
  by the baseline — `check --worktree` and `sweep claude` failed OPEN for a monorepo or
  subdirectory session, and `hook claude` enforced the wrong policy. A shared
  `repoContext(cwd)` resolver (`git rev-parse --show-toplevel` / `--absolute-git-dir`,
  cached per cwd) now anchors policy loading, every disk read, the snapshot, the sign-off
  ledger, the hook service's root binding and `init`. Verdicts and plans from `r1/pkg`
  equal those from `r1`; a policy file planted in a subdirectory governs nothing; a
  relative tool path in a hook payload still resolves against the session's own cwd.
- `init` run from a subdirectory wires the repository root (and says so on stderr)
  instead of planning `.tamperward.yml` and the CI files under the subdirectory while
  installing the pre-commit hook into the parent's `.git/hooks`.
- A directory outside any repository keeps its previous behaviour: `check` refuses with
  the not-inside-a-repository message, and a policy file beside it is read as before.

## [2.23.5] — 2026-09-14

### Fixed

- **The pristine overlay no longer unlinks the file it just restored on a
  case-insensitive filesystem** (#426). `verify` keyed the base-protected set on
  exact-case paths while macOS-default and Windows filesystems collapse case, so a
  case-only rename of a base test (`test/foo.test.js` → `test/FOO.test.js`, gutted)
  resolved to the restored inode and the removal loop deleted it; a runner that exits
  0 on an empty set then reported VERIFIED over an unfixed bug. The destination
  filesystem's case sensitivity is now probed once per verify (a probe file and its
  case variant, removed afterwards). When it is case-insensitive, overlay/surface
  membership and the base-protected set are case-folded, so the case variant is never
  removed and an agent-added `CONFTEST.PY` or `Pytest.ini` is removed like its
  lower-case spelling; two in-tree paths that collide under folding are refused
  before any candidate code runs as `CANNOT_VERIFY` / `PATH_CASE_COLLISION`. On a
  case-sensitive filesystem (Linux) the fold is the identity and behaviour is
  unchanged.
- `verify --json` reports the probed assumption as `filesystem_case_sensitive`
  (additive optional boolean in `verify-v1.schema.json`; `PATH_CASE_COLLISION` is an
  additive `reason` value). No schema major.

## [2.23.4] — 2026-09-14

### Fixed

- **The release workflow is re-entrant and publishes only the reviewed bump commit**
  (#420). `release.yml` now gates each of its three records on its own absence — the
  registry for `npm publish`, `git ls-remote --tags origin` for the `v<version>` tag,
  `gh release view` for the GitHub release — instead of gating all three on "the
  registry lacks this version". A run that published and then failed to push the tag
  (or tagged and failed to create the release) converges on re-run rather than
  reporting "nothing to release" forever. The `plan` step records the commit that last
  changed `package.json` and refuses to publish, tag or release when `GITHUB_SHA` is
  not that commit, printing both SHAs; a `workflow_dispatch` input
  `allow_non_bump_head: true` overrides it as a conscious act. Ordinary non-bump
  merges remain a quiet no-op.
- The release gate no longer re-runs `npm test` on the release runner: the exact-head
  PR CI already ran the suite on Node 20/22/24 for that commit, and the timing-sensitive
  `test/perf-smoke.test.ts` is what held 2.23.0 unpublished. `npm ci` and the typecheck
  stay. The checkout now uses `fetch-depth: 0` and `fetch-tags: true`, so the
  bump-commit check sees history and the release notes' "Full Changelog" compare link
  is actually written.

## [2.23.3] — 2026-09-14

### Fixed

- **Fresh Node repositories no longer trip the staged gate on installed dependencies.**
  When `node_modules/` exists and is not already repository-ignored,
  `tamperward init` / `tamperward onboard` add it to `.gitignore` as a normal
  setup change before the first commit. This prevents third-party dependency source
  from producing a cascade of lint/type-suppression findings after `git add .`.
- The fix does **not** add a TamperWard detector blind spot. If `node_modules` is
  already tracked/staged, or `.gitignore` explicitly negates a `node_modules`
  path, init leaves repository intent untouched and reports the item for operator
  attention. Tracked dependencies continue to be scanned.
- Existing `.gitignore` content is preserved; symlink and non-regular
  `.gitignore` paths are refused rather than followed or overwritten.

## [2.23.2] — 2026-09-14

### Changed

- **First-commit onboarding is treated as first-commit onboarding, not a dirty tree.**
  When a repository has no `HEAD` yet, `tamperward onboard` reports that the current
  paths are not part of a committed baseline and proceeds to the setup plan without
  asking whether to continue with "existing working-tree changes". Pristine verify and
  the safe demo remain unavailable until the initial commit exists.
- The safe tamper demo is now skipped directly when no first commit exists instead of
  asking a question whose only possible result is a skip.
- A missing trusted verifier remains a fail-closed `doctor` condition and keeps
  onboarding `INCOMPLETE`, but the first-run summary renders it as an expected
  `ACTION` rather than an alarming `ERROR`.
- The compact summary no longer repeats the non-Linux `run` limitation already shown
  in Environment, and GitHub guidance is conditional: without a github.com origin it
  explains what to configure *if* GitHub will provide repository authority rather than
  claiming those controls are definitely missing.

## [2.23.1] — 2026-09-14

### Changed

- **A quieter, clearer `tamperward onboard`.** The guided first run is now five compact
  sections instead of nine verbose ones. Terminal output uses the same
  `NO_COLOR`/`FORCE_COLOR` convention as the verdict renderer and spells every state
  out (`OK`, `ACTION`, `LIMITED`, `ERROR`, `READY`) so colour is never the only
  signal. Onboarding renders the canonical init plan itself, applies it silently, runs
  the first verification silently and reports its verdict once, suppresses successful
  doctor detail, and ends with only the remaining actions. macOS is described as a
  `run` limitation rather than dumping the subreaper/ECHILD implementation detail.
- **Repository-root safety.** `onboard` now refuses when invoked from a child directory
  of another Git repository. The previous behaviour could write policy/CI files into
  the child while installing the pre-commit hook and inferring the GitHub remote from
  the parent. The refusal prints both paths and tells the operator to run from the Git
  root or initialise the child as its own repository.
- The displayed local setup plan now defaults to apply on Enter; inferred verifier
  commands still require explicit acceptance because they are part of the trust anchor.
- Compact onboarding treats repository-derived paths, commands and doctor detail as
  untrusted terminal text: control bytes and embedded line breaks are neutralised before
  rendering. Its final commit instruction also excludes local-only `.git/` files, and
  partial init failures only report files that actually became wired as written.

## [2.23.0] — 2026-09-14

**`tamperward research`: a first-class …28360 tokens truncated…its own hook decision is
  hook-tampering. The user file and managed settings are judged by path shape
  at the tool-call layer, outside the repository or not. Hooks merge across
  the settings files, so the "sibling shadow" finding for an added local file
  that declares other hooks is gone — it was a false positive.
- **The pre-commit script init wrote must stay byte-equal to what init
  writes**, modulo an upward pin. A hand-written hook is judged by whether the
  gate still runs live under the way that hook is executed (husky's `sh -e`,
  git's direct exec): function or alias shadowing of a word of the invocation,
  a function nobody calls, an `else` after an always-true branch, an empty
  `for` or never-true `while`, `exec`, a passing `trap`, `set +e`, the `||`
  chain evaluated in order (`|| false || true`, `|| true; exit $?`,
  `|| kill -0 $$`, `|| exit $status` with status=0), a trailing `&`, a `!`
  prefix, heredoc bodies as data, `pipefail` only from a real `set -o
  pipefail`, a lowered pin, `--cwd` as identity, a `cd` away from the root, a
  non-shell shebang, and a gate that is not the last statement without
  `set -e` on a directly-exec'ed hook. Thirty of these were verified against a
  real shell before the model was rebuilt.
- **lefthook, pre-commit and package.json compared by the command they run**,
  not the word: `run: npx tamperward --version` and `entry: 'true'` under
  `id: tamperward` are removals; `skip`/`only` in any non-false shape at
  command and section level, `tags` against `exclude_tags`,
  `lefthook-local.yml` as the overlay it is (now in the hooks baseline),
  `stages` inherited from `default_stages ?? all`, `types`/`exclude_types`
  without `always_run`, and `prepare: echo husky` / `HUSKY=0 husky` /
  `husky uninstall` as the removals they are.
- **CODEOWNERS evaluated over the concrete gate files** with GitHub's glob
  semantics, so a later ownerless `/.husky/pre-commit`, `*.yml` or
  `**/pre-commit` un-owning the gate is reported.
- **Command surface:** absolute paths under the repository relativised;
  `>|`/`>&`/`&>` kept with their redirection; `install -t`, `cp -t`, `rsync`,
  `git checkout <rev> -- .`, `git restore --source=<rev> .`, `git apply` /
  `patch` / `git am`, inline `python -c` / `node -e` / `perl -e` / `ruby -i` /
  `ex` / `ed` scripts naming a hook, `xargs rm|chmod`, `find -exec chmod -x` /
  `-delete`, multi-group symbolic chmod (`u+rw-x`), `setfacl`. Every
  command-surface finding carries the repo-relative target, so the engine pin
  applies to it.

### Fixed

- **The docs site failed to build after 2.6.0.** The rules guide's
  ci-tampering row carried `${{ <ctx> || true }}` inside a table cell: the
  unescaped `||` split the cell and the angle-bracket placeholder was then read
  as a tag, so the page broke the Vue template compile. The pipes are escaped
  and the placeholder is spelled `context`. The site now builds in the PR
  workflow's `build` job as well, so a broken page cannot merge.

### Sign-off

Customised wiring needs a sign-off once (docs/guide/rules.md, "Customised
wiring needs a sign-off"): a linter step added before the gate in the
init-written script, `npx` → `pnpm exec` in that script, a matcher spelled as
a regex. A hand-written script that was never init's is judged by liveness
alone and stays clean when the gate is live.

## [2.6.0] — 2026-09-02

**Every dial of the selection predicate is modelled, the CI expression folder
short-circuits the way GitHub does, and the coverage denominator is compared
as a predicate. From the adversarial pass over 2.5.0. A minor: these rules
now fire on config keys they previously passed.**

### Added

- **test-deletion reads the rest of the runner's selection.** jest `roots`,
  `rootDir`, `modulePathIgnorePatterns` and `projects`; vitest `test.dir`,
  a `!` negation inside `include`, `test.projects` and `vitest.workspace.*`
  (evaluated as the union of project predicates; a project named by path
  makes the config opaque and silent); `vite.config.*` carrying a `test:`
  key is a vitest config; `typecheck.*`, `benchmark.*` and `coverage.*`
  under `test` no longer collide with `test.include`. Runner flags added to
  a `package.json` test script (`--testPathPattern`, `-t`, `--exclude`,
  `--dir`, `--project`) are narrowing. `git checkout <rev> <path>` without
  `--`, `git checkout <rev> -- .`, and `rm -rf .` / `*` / a `..`-containing
  token from the repo root are erasures. `describe.each` rows multiply the
  enclosed tests; rows dropped from a table that stays open are counted;
  only an added block with a significant body counts toward relocation, so
  a stub `it("noop", () => {})` no longer excuses a deletion.
- **coverage-lowering reads vitest's denominator and switches:**
  `coverage.include` narrowed, `coverage.enabled` off, `thresholds.perFile`
  removed; `.coveragerc [run] omit`, codecov `target: auto` / `project: off`
  / `ignore:`, and nyc thresholds inside `package.json`. The patch-threshold
  evidence reports the numbers it saw.
- **ci-tampering folds `&&` and `||` the way GitHub does**: `<ctx> && false`
  is always false and `<ctx> || true` always truthy, so
  `if: ${{ github.event_name == 'push' && false }}` and
  `continue-on-error: ${{ <ctx> || true }}` are reported; anything whose value
  depends on the unknown side stays reachable. `on.<event>.paths:` that cannot
  match source and `pull_request.types:` replacing the defaults are trigger
  narrowing; a path-shaped positional after `--` (`npm test -- test/a.test.ts`)
  is narrowing; `timeout 1 npm test` reports as neutralised.

### Fixed

- **Routine work that blocked:** a check moved into a reusable workflow added
  in the same change; a job-level `if: false` on a job with no check step;
  `npm test` → `npm run test:ci` or `npx vitest run` (a respelling, not a
  removal); `.coveragerc` → `pyproject.toml` carrying the same `fail_under`;
  `collectCoverageFrom` `src/**` → `src/**/*.{ts,tsx}` (compared over tracked
  source, not entry by entry); a jest ignore of a `fixtures/` directory;
  vitest `typecheck.exclude` read as a test exclude; `branches: [main]` →
  `[master]` when the default branch is unknown.

## [2.5.1] — 2026-09-02

**A protected file created where git will not list it is judged, never
absorbed. A patch: a bypass fix at the same severity, found by the adversarial
pass over 2.4.0's untracked sweep.**

### Fixed

- **An ignored new protected file was judged by nobody.** One line in the
  agent-writable `.git/info/exclude` (or a `.gitignore` edit) made a
  `conftest.py` created during the turn invisible: the untracked view drops
  ignored files, the hidden-tracked probe lists tracked files only, and the
  effect layer saw the file but treated an addition as something to absorb
  into the sanctioned tree. The turn ended green. The same applies to the
  gitignored `.claude/settings.local.json` Claude Code itself excludes. Now:
  the effect layer reports additions, any protected addition the turn view
  does not carry is reconstructed as the add it is and run through the
  detectors, and the git views (`turnView`, the envelope, `check --worktree`
  with untracked) list ignored files under the protected globs as adds — in
  two passes, with wholly-ignored trees collapsed and `node_modules` never
  walked, so a 100k-file package tree costs three milliseconds.
- **A forged turn tree could excuse a new file.** The turn-start snapshot is
  `.git` state; it now excuses an untracked or ignored file only when the
  per-call tree sanctions the same hash, the turn-start exemption is limited
  to a predicted edit that never landed, a turn tree that outlives its ptree
  is dropped, and tree saves are atomic. The residual — an agent that
  rewrites both trees consistently — stays documented; CI is the authority.
- **Command-surface hook-tampering findings carried no file**, so the engine
  pin that keeps findings on the gate's own wiring out of the policy's reach
  did not apply to them: with a policy that had lowered the rule to warn,
  `rm .claude/settings.json` through Bash was allowed at the hook. They now
  carry the repo-relative target and are pinned like the file-surface ones.

## [2.5.0] — 2026-09-02

**The config-narrowing class: a runner told not to open a spec, a coverage
denominator quietly shrunk, a workflow that keeps its check line and never
runs it. Closed across test-deletion, coverage-lowering and ci-tampering,
with the two most routine maintainer edits — splitting a spec and touching a
CI check line — no longer blocking. A minor: these rules now fire on config
shapes they previously passed.**

### Added

- **test-deletion reads runner selection.** jest `testPathIgnorePatterns`,
  `testMatch`, `testRegex` and vitest `test.exclude` / `test.include` are
  evaluated as the selection predicate over the repository's own spec files:
  a spec that was collected before the edit and is not collected after it is
  a deletion, with the count. A glob respelled to select the same files, or
  an ignore that matches nothing in the tree, is silent. Shell spellings that
  erase a spec join the command surface: `cp /dev/null`, `sed --in-place`,
  `tee`, `find -delete` / `-exec rm`, `truncate`, `perl -pi`, `git checkout
  <rev> --`, and a directory token that holds a protected spec (`rm -rf test`;
  `dist/__tests__` is silent).
- **coverage-lowering reads the denominator and the switches.**
  `collectCoverageFrom` entries dropped or source exempted,
  `coveragePathIgnorePatterns` / `coverage.exclude` grown, `--coverage=false`
  and `--coverageThreshold=` in a script, vitest `thresholds.autoUpdate`,
  and `passWithNoTests` as a config key. Python `.coveragerc` /
  `pyproject.toml` `fail_under`, nyc thresholds and `check-coverage`, and
  codecov `target` / `threshold` / `informational` join the protected config
  baseline and are compared.
- **ci-tampering reads the block, the expression and the trigger.** A kept
  check line preceded by `set +e`, `exit 0`, `if false; then`, a heredoc
  comment or `shell: bash {0}`, or followed by `|| true` or
  `--passWithNoTests`, is neutralised in place. `continue-on-error` and
  `if:` are constant-folded (quoted booleans, `${{ 1 == 1 }}`, `${{ 'a' ==
  'b' }}`, `${{ !true }}`); anything with a context reference stays
  reachable. `on:` narrowed so the workflow no longer runs — `push` /
  `pull_request` removed, `paths-ignore: ['**']`, `branches:` no longer
  naming main — is reported.

### Fixed

- **Splitting or merging a spec blocked as a deletion.** Added lines of every
  added AND modified protected spec in the change are the relocation set, so
  a split (modify + add), a merge (delete + modify) and two `it`s folded into
  one `it.each` are relocations; a literal `it.each` table counts one test per
  row; the Java anchor accepts `@Timeout(5) @Test` on one line.
- **Editing a check line in place blocked as a removal.** A flag added, `npm
  test` → `npm run test` / `npm t` / `pnpm test`, `npx` → `pnpm exec` /
  `yarn` / `bunx`, quoting, and an action bumped `@v3` → `@v4` (Dependabot's
  daily move) are kept; `continue-on-error` / `if:` on an unrelated step no
  longer fire.
- **Three table rows removed plus one line lengthened** slipped under
  test-content-removal's net threshold; rows inside a literal `each` table
  are counted on their own.
- **Removing `console.log` lines from a spec** no longer counts as content
  removal; a stricter one-metric coverage override, an override removed for a
  file no longer in the repo, and a `{ ...base }` spread refactor no longer
  report metrics as removed.

## [2.4.1] — 2026-09-02

**The enforcement wiring is read for what it does, not for the words in it.
Six bypasses of `hook-tampering` closed and three false positives fixed. A
patch: bypass fixes at the same severity, and the guard on the gate's own
wiring is pinned where the policy under judgment could previously switch it
off.**

### Fixed

- **Claude Code settings were scanned as a shell script.** Narrowing the
  PreToolUse matcher from `Bash|Edit|Write|MultiEdit|NotebookEdit` to `Bash`
  removed no invocation and added no `exit 0`, so nothing fired and the
  file-edit tools were ungated. Setting the hook command to `true` while
  adding a junk field that quoted the invocation excused the removal, because
  survival was judged on any added line containing the token. A new
  `settings.local.json` that declared empty hook arrays, shadowing the
  wiring, was an add with nothing removed. `.claude/settings.json` and
  `settings.local.json` are now parsed on both sides and compared as
  (matcher tool set, command) pairs: an entry removed, a tool lost from the
  matcher, an event emptied, `disableAllHooks`, a parseable-before file made
  unparseable, and an add or modify that shadows the sibling's gate are all
  hook-tampering; survival is judged only on parsed command-type hooks.
- **Shell hook scripts were scanned for words too.** `|| true` after the
  invocation, `exit 0  # comment`, `exit 0;`, bare `exit`, `[ -n "$X" ] ||
  exit 0`, `if false; then` ahead of it, `npx tamperward --version` in its
  place, and `echo "npx tamperward …"` all read as a kept check. Scripts are
  reduced to their live check identities (runner, pin, redirects stripped;
  argument position and `--version` are not invocations) with a liveness
  state — live, neutered, unreachable, comment — and only a live survivor
  with the same identity excuses a removal.
- **A fresh `.tamperward.yml` was never compared to the baseline.** Adding a
  policy with `ignore: ['**']` or a lowered severity reported nothing because
  the comparison needed a `before`; an added policy is now judged against the
  effective baseline exactly like an edit.
- **The policy under judgment could silence the judgment.** At the local
  layers, `rules: { hook-tampering: { enabled: false } }` (or `severity:
  warn`) in the head policy switched off the findings about that very edit.
  Hook-tampering findings on the policy file and on the baseline hooks class
  can no longer be disabled, excluded or lowered by policy.
- **`git update-index --skip-worktree` was not a command anyone modelled.**
  It, `--assume-unchanged` and `--chmod=-x` on a protected path are
  hook-tampering, through `git -C`, `git -c`, an absolute `git` and `cd x &&`.
  Also `chmod 0`, `chmod 00644`, `chmod --reference=`, `perl -pi`, `awk -i
  inplace`, `sponge`, `ln -sf`, `git checkout <rev> -- <hook>` and
  `git restore --source` against a hook.
- **lefthook, pre-commit and package.json wiring:** an entry removed,
  `skip: true`, a narrowing `glob`/`exclude`/`only`, `stages` without a commit
  or push stage, a top-level `exclude`, and `prepare: husky` (or its
  lefthook/simple-git-hooks/pre-commit equivalent) dropped from every
  install-phase script are hook-tampering.
- **False positives:** `chmod +x`/`u+x` on a hook no longer fires (only a lost
  execute bit does); `cat hook > /tmp/backup`, `cp hook /tmp/`, `sed -n` and
  other read-only uses no longer fire (only a write whose target is the hook
  does); removing a CODEOWNERS line is judged by last-match-wins ownership of
  gate-critical paths rather than as "a check invocation (`husky`) removed";
  `lefthook.yml → .yaml` and `npx → pnpm exec` (or `yarn`, `bunx`) of the same
  command are kept.

## [2.4.0] — 2026-09-02

**The Stop sweep scans untracked protected files, the per-call drift check
fails closed on a change git cannot see, and the pytest collection knobs are
test-skip spellings. A minor: `hidden-drift` is a new, non-configurable
finding on the hook path, and an agent-created protected file is now judged
at Stop where it was invisible before.**

### Fixed

- **The Stop sweep ignored untracked files.** It fed the detectors from
  `git diff`, so a new protected file the turn created — a shadowing
  `vitest.config.ts`, a `.claude/settings.local.json`, a `conftest.py` carrying
  `collect_ignore` — was invisible to it (the `run` envelope already scanned
  them). The sweep and the per-call drift check now share one turn view:
  tracked changes since the turn baseline, plus every untracked file under a
  protected glob that the turn created (a turn-start snapshot of the protected
  tree, advanced only on a clean Stop, tells a new file from one that was
  there before), plus the hidden tracked files below. An untracked file
  outside the protected globs is not scanned, and a new test with ordinary
  content is not a finding.
- **A protected change git could not see was absorbed as the new baseline.**
  After `git update-index --skip-worktree test/a.test.ts` (or
  `--assume-unchanged`), git omits the file from every diff; the drift check
  saw the hash move, asked git for the change, got nothing, evaluated nothing,
  and saved the tampered tree as sanctioned. The Stop sweep then had nothing
  to compare. Hidden tracked files are now diffed by hand — the trusted blob at
  the base against the disk — and judged by the ordinary rules; any remaining
  drift is reconstructed from a blob whose hash equals the sanctioned one, a
  restore to the base or turn-start content is accepted, and anything else is
  a blocking `hidden-drift` finding that no policy can lower or disable. A
  block never advances the baseline.
- **A new file reached the hunk-based rules as an empty edit.** The untracked
  view carried full content but no hunks, so test-skip and the added-line half
  of hook-tampering read a brand-new file as nothing; hunks for an add are now
  synthesised from its content.
- **pytest collection is a skip.** `collect_ignore` / `collect_ignore_glob`
  (assignment, `+=`, `.append`, `.extend`), `def pytest_ignore_collect(`, and
  the parametrize `marks=` form join test-skip's Python patterns beside the
  2.2.1 spellings.
- **`passWithNoTests: true` in a jest or vitest config** is the CLI flag's
  twin and is now coverage-lowering, so a brand-new config carrying it — which
  has no `before` to compare thresholds against — is still a weakening.

## [2.3.0] — 2026-09-02

**`verify` runs both suites under the operator's environment, not the
candidate's, and the verification surface covers what the package manager
reads before the runner starts. A minor: the suite no longer inherits
`NODE_OPTIONS` or `PYTHONPATH`, and yarn's `yarn-path` is ignored, so a suite
that leaned on any of those from the ambient environment goes red until it sets
them in its own frozen command.**

### Fixed

- **An agent-added `.npmrc` made both runs green.** `node-options=--require
  ./p.cjs` in a project `.npmrc` is exported by npm as `NODE_OPTIONS` to every
  node it spawns, so with the frozen command `npm test` a two-line preload that
  stubs the runner's `test`/`it`/`describe` to no-ops made `node --test` find
  nothing and exit 0 in the visible AND the pristine copy: VERIFIED over a
  source the base suite fails, with no protected file touched. `.npmrc` was on
  no list — it is not a file the runner consults but the file the runner is
  started under. The same line in `~/.npmrc`, which the candidate owns inside
  `tamperward run`, worked identically and no in-tree list can cover it.
  Two layers close the class: the package-manager and runner files
  (`.npmrc`, `.yarnrc`, `.yarnrc.yml`, `pnpm-workspace.yaml`, `.pnpmfile.cjs`,
  `.pnp.*`, `.yarn/releases`, `.yarn/plugins`, `.env*`, `.nvmrc`,
  `.node-version`, `.python-version`, `setup.py`, `sitecustomize.py`,
  `usercustomize.py`, `.gitattributes`, `.nycrc*`, `.c8rc*`, `.taprc`,
  `ava.config.*`, `mocha.opts`, jasmine, playwright and cypress configs) join
  the verification surface; and both suites run under a sanitised environment
  — `NODE_OPTIONS`, `NODE_PATH`, `NODE_REPL_EXTERNAL_MODULE`, `PYTHONPATH`,
  `PYTHONSTARTUP`, `PYTEST_ADDOPTS` and `PYTEST_PLUGINS` dropped; npm's
  `node-options` pinned to nothing (a single space: npm skips an empty env
  value) and its user and global config pointed at empty files; yarn's
  `yarn-path` ignored. Verified against npm 10.9, pnpm 10.33 and yarn 1.22;
  the residual (a runner input that is neither a file here nor a variable
  there, Python's user site-packages among them) is stated in
  docs/THREAT-MODEL-pristine-run.md.
- **`git show` stays, deliberately.** `git cat-file --filters` was considered
  for LFS-tracked overlay files and rejected: a smudge is a command read from
  repository config the candidate writes, selected by working-tree attributes
  the candidate writes. An LFS pointer on the surface restores as a pointer
  and fails closed.
- **`verify --base --json`** read the base as `--json`; a value-taking flag now
  refuses a following flag or a missing value and verify exits 2.

## [2.2.1] — 2026-09-02

**Five block rules closed against their one-token neighbours, and three
routine edits that blocked no longer do. A patch: bypass fixes at the same
severity and false-positive fixes, nothing else.**

### Fixed

- **`no-verify` matched raw text, not git.** `git commit --no-veri` (git
  accepts any unambiguous prefix), a quoted `'--no-verify'`, and
  `export SKIP=tamperward; git commit` all walked past it, while
  `git log -n 5 -- src/commit.ts`, a commit message quoting `--no-verify`,
  and `grep -- --no-verify docs/` blocked. Flags are now matched as unquoted
  tokens of the `commit`/`push`/`merge` subcommand with option values dropped;
  env hatches as whole assignment tokens; `SKIP=` carries to a later segment
  only when exported or assigned bare.
- **`test-skip` spellings:** vitest `skipIf`/`runIf`/`fails`, jest
  `test.failing`, mocha `this.skip()`, `it.each([])`, `concurrent.skip`, a
  non-literal `{ skip: expr }`; Python `pytestmark`, bare `@skip`, an aliased
  `pytest`, `__test__ = False`; Go `testing.Short()` guards and
  `//go:build ignore`; Rust `cfg_attr(…, ignore)`; Ruby `before { skip }` and
  a block-less example; Java `assumeTrue(false)` and a fully-qualified
  `@Ignore`; C# `[Explicit]` and `Assert.Inconclusive()`. False positives
  fixed: `fit`/`xit`/`xdescribe` require call position, comment-only lines are
  skipped, and `skip:` counts only in a test's options.
- **`lint-suppression` spellings:** ESLint inline config (`/* eslint rule: off */`),
  `# ruff: noqa`, `# flake8: noqa`, `# mypy: ignore-errors`, `# pylint:
  skip-file`, `//lint:ignore`, `@file:Suppress`, `NOSONAR`, `ReSharper disable`,
  `@codingStandardsIgnore*`. A marker inside a string literal or docstring no
  longer fires.
- **`ts-any-cast`:** `x as (any)` reached only the warn rule because the
  parenthesised type was not unwrapped; JSDoc `/** @type {any} */ (x)` in
  JavaScript files is the same cast.
- **`snapshot-rewrite`:** `npm test -- -u` (the most common spelling) and its
  yarn/pnpm/bun forms, `find … -name '*.snap' -delete`, `git checkout --` on a
  snapshot path, `cargo insta accept`, `pytest --snapshot-update`,
  `UPDATE_EXPECT=1`.

## [2.2.0] — 2026-09-02

**`init` wires the hook where git actually runs it, the CLI fails closed on
every crash path, and the policy loader refuses what it cannot vouch for. A
minor, per CONTRIBUTING and the 1.15.0 precedent: the loader now rejects two
shapes it used to accept silently (an unknown top-level key, a ledger path
outside the repository), so a policy carrying either goes from "loaded, not in
force" to exit 2 — visible, where it was invisible.**

### Fixed

- **`init` wrote `.git/hooks/pre-commit` that git never ran.** With
  `core.hooksPath` set (lefthook, simple-git-hooks, a custom `.githooks/`) the
  hook landed in the wrong directory and every re-run reported "already runs
  the staged check". The hooks directory now comes from
  `git rev-parse --git-path hooks`; a lefthook or pre-commit-framework repo gets
  a `skip` with the exact config line to add.
- **`init` appended the gate after an `exec`/`exit` that made it dead code**,
  and later reported it as wired. The gate is inserted above the first
  unconditional exit; an unreachable gate that init wrote is moved, a
  hand-written one is reported as an error.
- **Crash paths exited 1 with a stack trace.** A bad `--diff` revision, a
  `--worktree` outside a repository, an invalid policy reaching `allow`, a
  directory where `init` expected a file: each is now one line on stderr and
  exit 2 (cannot evaluate, failing closed), never 1 (a blocking finding) and
  never 0. `init` plans every change before writing any; an apply failure is an
  error row, not an abort. `hook`/`sweep` are unchanged: a deny is JSON at exit 0.
- **`signoff.ledger` could point outside the repository, unreported.** The
  local layer trusts that file, so `../../shared.jsonl` handed the sign-off
  channel to whoever controls that path. The loader rejects absolute or
  escaping ledger paths (exit 2), and policy-diff reports any ledger change.
- **An `exclude`-only override produced a false "lowered block → undefined"
  finding** because the override replaced the whole rule object and dropped the
  baseline severity. Rule overrides are field-merged; the exclude addition is
  still reported, once.
- **Policy-derived strings reached the terminal unescaped.** A crafted
  `ignore` glob could carry a terminal escape sequence into a finding's
  message. Control characters are stripped from every rendered field, in the
  text and GitHub renderers.
- **`init` inferred `@org` as a CODEOWNERS owner** for an organisation remote,
  which GitHub rejects silently. The owner is confirmed against `github.user`
  or `user.name`; otherwise the rule gets a TODO comment and init warns.
  `/dir/**` patterns are recognised so re-runs stop appending duplicates.
- **Silent config footguns.** An unknown top-level key (`Rules:`, `ignored:`)
  fails closed naming the accepted set; a leading `/` on a protected, ignore or
  exclude glob is normalised away instead of matching nothing; `init` loads an
  existing policy and reports its error instead of "left untouched";
  `check --diff` prints a stderr note when a range scans zero changes.

## [2.1.1] — 2026-09-02

**Two bypasses of every git view, closed. A patch: bypass fixes at the same
severity, and nothing that was green turns red.**

### Fixed

- **git's binary heuristic blinded every content detector.** A committed
  `.gitattributes` line (`x.spec.ts -diff`, or the `binary` macro) — or simply
  a NUL byte anywhere in the file — made git print "Binary files differ" instead
  of hunks. The parser marked the change binary, the builder skipped loading its
  content, and test-skip, test-content-removal, ci-tampering, coverage-lowering
  and hook-tampering's content branch all went silent on that file, in the
  range, staged and worktree views alike; through the hook, a Write adding
  `it.skip` plus `\0` was allowed. Every `git diff` Tamperward runs now passes
  `--text`, which overrides both the attribute and the heuristic, and content is
  loaded regardless of the binary flag. A modified binary golden file still
  produces only the snapshot-rewrite warning it did before.
- **A path containing a space was invisible.** git appends a tab to an unquoted
  path with a space in the `---`/`+++` lines; the parser kept it, so
  `my tests/b.test.ts\t` matched no protected glob and a deletion or `.skip`
  under such a directory reported clean. The tab is stripped; quoted paths are
  decoded as before, and the header split no longer mis-parses a directory
  containing ` b/`.

## [2.1.0] — 2026-09-02

**`verify` gains the out-of-band sign-off channel `check --diff` has had since
1.13.0. A minor, per CONTRIBUTING: new surface, and nothing that was green turns
red — a masked failure that no label covers exits 1 exactly as before.**

### Added

- **`tamperward:allow:verify@<head-sha>` clears a `verify` masked failure.**
  Until now a MASKED_FAILURE had no human escape at all: the one case where the
  original suite is genuinely wrong for the change — an intended behaviour change
  whose old expectations must fail — could only be merged by switching the
  verify step off. `verify` now reads the same `TAMPERWARD_OOB_SIGNOFF` and
  `TAMPERWARD_OOB_HEAD` the diff gate reads, with the same rules: once the
  workflow names the head it is adjudicating, only a token bound to that commit
  counts, so the approval dies with the next push. The verdict is still
  reported as `MASKED_FAILURE` (with `oob_signoff` in `--json`); only the exit
  code changes. It clears nothing else — SUITE_RED and cannot-verify are not
  approvable states, so a label cannot make a red suite green or turn "could
  not run" into "verified". The committed ledger is never consulted.
- The generated CI workflow passes both variables to its verify step. Re-run
  `tamperward init` to migrate a workflow it wrote; a hand-edited one is left
  alone, as before.

## [2.0.0] — 2026-09-02

**Node 18 is no longer supported. That is the whole of the breaking change, and
it is a major because CONTRIBUTING's test says so: a user on Node 18 who takes
this upgrade gets a red build without changing anything.**

Node 18 reached end of life in April 2025; the CI matrix had gone on proving a
runtime that no longer receives security fixes, and the dev toolchain was
pinned back to the last lines that still ran on it. The floor is the lowest
Node the current toolchain runs on, not the newest LTS: Node 20 stays
supported and tested. Nothing in `src/` changes — the gate's behaviour on Node
20, 22 and 24 is exactly 1.15.0's.

### Changed (breaking)

- `engines.node` is `>=20.19`. The CI matrix tests Node 20, 22 and 24.
  `init`'s generated workflow already ran on 22; nothing it writes changes.

### Changed

- Dev dependencies: `vitest` 2 → 4 and `vitepress` 1.6 → 2.0 (their vite 7
  line, whose own floor is Node 20.19 and is what set this one), `@types/node`
  20 → 22 (type definitions only; the floor is unaffected). `npm audit` is
  clean, dev dependencies included.

## [1.15.0] — 2026-09-02

**A third external audit. Five fail-open paths closed, the pattern rules read
the language of the file, and the project's own gate binds its labels to the
head SHA. A minor, per CONTRIBUTING: the rules catch more only in changes that
already violated the policy they declare, and `init` gains a pin, not a rule.**

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


### Fixed

- **This repository's own gate did not bind approval labels to the head SHA.**
  `ci.yml` set `TAMPERWARD_OOB_SIGNOFF` but never `TAMPERWARD_OOB_HEAD`, so a
  `tamperward:allow:<rule>` label earned for one benign finding cleared every
  later one pushed to the same PR — the P1-6 hole the shipped template closed in
  1.12, still open on the project's own CI. Labels on this repo now read
  `tamperward:allow:<rule>@<head-sha>`, as the generated workflow requires.
- **ci-tampering read a YAML comment as a removed check.** A comment that quoted
  `tamperward:allow:<rule>` in a code span satisfied the invocation-position test
  through the backtick before the word, and rewording it was a blocking finding.
  Comment lines are never steps.

### Changed

- **`init` pins the local hooks to the version that wrote them**, as it already
  pinned the workflow (P2-15). `npx --yes tamperward hook claude` with no
  version resolved `latest` on every call in a repo where the package was not
  a devDependency, so the gate changed under the repo without anyone changing
  anything. Re-running `init` re-pins an install it wrote for another version
  (or wrote unpinned) in `.claude/settings.json` and the pre-commit script; a
  command someone wrote by hand is left exactly as it is.
- Dev dependencies: `esbuild` 0.24 → 0.25. `vitest` stays on 2.x and `vitepress`
  on 1.6.4: every later vitest, and vitepress's only fixed line (the 2.0 alpha),
  pull in a vite that drops Node 18, which this package still supports
  (`engines >=18`, tested in CI). `npm audit` therefore still reports the vite
  dev-server advisories through those two; none of them reach the published
  package (`npm audit --omit=dev` is clean).

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
