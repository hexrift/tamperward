# Enforcement & sign-off

One engine, one `Finding[]`, at every stage a change passes through. CI is the
authority; the earlier layers exist to shorten the feedback loop:

- **Agent loop** — a Claude Code `PreToolUse` hook denies the tool call *before it
  runs* (and the deny holds under `bypassPermissions`), plus an end-of-turn `Stop`
  sweep that diffs the working tree — so a change made through the shell, or committed
  mid-turn, is still the turn's work. This layer exists only where the hooks do —
  Claude Code today. Any other agent, and any human, meets the gate at pre-commit and
  CI instead, where a denial arrives later and redirects less.
- **Run envelope** — `tamperward run -- <agent command...>` wraps the whole agent
  invocation and treats the runtime's exit as untrusted: the trusted base is
  recorded before the agent starts, and whatever tree exists at termination —
  committed or not — is re-adjudicated against it (policy over `base...HEAD`,
  policy over the worktree, pristine verification). The measured reason this
  layer exists: in our round-2 experiment, a hook denied 42 mutations and
  rejected every one of 25 stop attempts, and the session still completed with
  a masked-green tree, because hooks decide but runtimes terminate. The
  envelope owns the boundary from outside; the hooks remain the in-session
  fast path that steers the agent toward honest work.
- **Pre-commit** — `tamperward check --staged` catches what the agent layer missed:
  human commits, other agents.
- **CI** — `tamperward check --diff base...head`, the authority for `main`. The policy
  is read from the **merge-base**, so the PR under review cannot govern its own
  verdict: an `ignore:` line or a lowered severity on the branch is reported, and takes
  effect only after a human merges it.

## The sign-off model

The escape valve exists — legitimate exceptions are real — but the agent can never
author its own:

- **Agent layer**: honours nothing. A block is a block.
- **Local**: `tamperward allow <rule> --reason "..."` writes a fingerprint-bound ledger
  entry — a human at a keyboard.
- **CI**: out-of-band only — a PR label (`tamperward:allow:<rule>@<head-sha>`) applied
  by someone with triage access or higher (label permission is approval permission —
  restrict it accordingly), never a committed file. Applying **or revoking** the
  label re-evaluates the gate. `verify` reads the same labels: `tamperward:allow:verify@<head-sha>`
  accepts a masked failure a reviewer has judged — the original suite is genuinely wrong
  for an intended behaviour change — and clears nothing else. A red suite, or a run
  that could not verify, stays red.

## Fail closed

If Tamperward cannot evaluate a change — an unparseable policy, a git failure — the
change is denied, not waved through. A crashed gate must never become an absent gate.
At the CLI that means exit 2 with one `tamperward: …` line on stderr, whatever threw
(a revision git cannot resolve, a directory where `init` expected a file); the hook
and the sweep deny as JSON at exit 0 instead, as their wire contract requires.

The generated local wiring also protects the step before that contract begins. npm
[does not read a project `.npmrc` in global mode](https://docs.npmjs.com/cli/v11/configuring-npm/npmrc#per-project-config-file),
so candidate `call`, workspace, proxy, CA and startup settings cannot control the pinned
`npx` authority. If npm still cannot start it, the hook command converts that launcher
failure to Claude's blocking-error exit channel rather than leaving an ordinary non-zero
exit that the runtime could treat as non-blocking. Generated CI installs before checkout
and invokes the installed binary directly.

Generated local shell wiring requires a POSIX host with `/dev/null`. The user rc
is fixed to that OS device; the global rc is fixed to
`/dev/null/npmrc-global`, which cannot exist below a device. Distinct paths
avoid npm's double-load error. HOME cannot select those sources.
The invoking environment and Node/npm installation remain
trusted prerequisites. Native Windows launchers need a separate template.

The policy loader is strict for the same reason: an unknown top-level key (`Rules:`,
`ignored:`) is refused rather than silently ignored, and `signoff.ledger` must stay
inside the repository. A leading `/` on a `protected`, `ignore` or `exclude` glob is
dropped when the policy loads — paths in every git view are repo-relative, so
`/e2e/**` and `e2e/**` are the same rule.

The same holds for a protected file that changes where git cannot see it: the hook
judges it from the trusted content when it can, and blocks as `hidden-drift` when it
cannot (see [the rules](./rules.md#two-findings-that-are-not-rules)) — and for a
protected path that is not a regular file the gate can read. A symbolic link is never
followed (git records it as its target text), a FIFO, a socket or a device is never
opened for content, and a file above 64 MiB is not read: a new or changed one at a
protected path is blocked by name, not read through.

## The persistent hook service (opt-in, off by default)

Every Claude Code tool call launches the pinned hook as a fresh Node process, and
most of the call's wall time was process startup rather than gate work. Since
**2.21.0** two things address that, in order of how little they ask you to trust:

1. **The `typescript` parser (and `yaml`, `picomatch`) are loaded lazily.** The eight
   AST detectors used to import the parser at startup, so every hook call — a `Bash`
   command, an edit to a Python test, `--help` — paid to read and evaluate a 9 MB module
   it might never use. It is now read on first use, through `require`, which also skips
   the ESM named-export discovery pass; a protected JS/TS edit reaches the same AST path
   with the same verdict (`test/ts-lazy.test.ts`). On a 1,000-protected-file fixture a
   `Bash`-payload hook call went from ~600 ms to ~190 ms, and a JS edit (which still
   needs the parser) from ~600 ms to ~400 ms. Nothing to enable; nothing about trust
   changes.
2. **An optional persistent hook service** amortises the remaining startup across
   calls: `tamperward hook-service start` keeps one warm process per user and
   repository, and the hook hands it the stdin payload over a private unix socket
   instead of loading the engine itself (~115–135 ms per call on the same fixture,
   whatever the payload).

### Enabling the service

```bash
tamperward hook-service start --dir /path/to/repo   # foreground; run it from a terminal,
                                                    # a SessionStart hook, or a supervisor
TAMPERWARD_HOOK_SERVICE=1 claude                    # hooks consult the service only under this
tamperward hook-service status                      # pid, version, served count, cache hit rate
tamperward hook-service stop                        # SIGTERM; the socket and state file are removed
```

Both halves are required: a running service is never consulted unless
`TAMPERWARD_HOOK_SERVICE=1` is in Claude Code's own environment (a hook inherits it
from there; the hook command `init` writes is unchanged), and the variable does
nothing without a service. The socket lives at `$XDG_RUNTIME_DIR/tamperward-hook/hook.sock`
or `<tmpdir>/tamperward-hook-<uid>/hook.sock` (`TAMPERWARD_HOOK_SERVICE_DIR` overrides
the directory), mode `0600`, in a directory the service holds at `0700`. Not available
on Windows: `hook-service start` refuses with a clear message, and the hook runs
in-process there as it always has.

### What the service is, and is not, trusted with

The service runs **the same functions on the same bytes**: `hook claude` reads stdin,
sends the raw payload with its cwd and the three per-session variables the hook honours
(`TAMPERWARD_DENYLOG`, `TAMPERWARD_FSEVENTS`, `TAMPERWARD_TRANSIENT`), and the service
runs `preToolUseFromRaw` / `stopFromRaw` — the in-process entry points — and relays the
`HookResult` unchanged. The wire contract with Claude Code (JSON on stdout at exit 0)
is untouched; only where the evaluation happens moves. A parity test replays a fixture
set through both paths and requires byte-identical verdicts.

**The hook never fails open on the service's account.** The client refuses — and
"refuses" means it loads the engine and evaluates in-process, exactly as before —
when the opt-in is absent; when the socket's directory or the socket is not owned by
the hook's own uid, is not a directory / not a socket (a planted symlink is not a
socket), or is readable or connectable by any other user; when the service is of another
TamperWard version or protocol than the pinned hook; when it refuses the request (a cwd
outside the repository it was started for); when it does not answer in time; or when
its answer is not a `HookResult`. A dead service, a stale socket and a crashed one are
the same fallback. `stop` removes the socket and state file even when nothing was
running, so a stale socket is never what the next client meets.

**The snapshot cache never believes the stat triple.** The one thing the service keeps
warm besides the process is the protected-tree snapshot, in its own memory, and the
P1-8 lesson stands: mtime, size and mode are the candidate's to set
(`touch -r` restores an mtime byte for byte; a same-length rewrite keeps the size), so
a hash remembered against them is a hash the candidate can keep alive over content it
changed. The cache key is `(device, inode, size, mode, mtime, ctime)` at nanosecond
precision, and **ctime is not settable from user space** — every write, rename, chmod
and `utimes` call, the `touch -r` itself, moves it to the kernel clock. An entry is
reused only when all six match *and* the file had been stable for two seconds when its
hash was taken (git's own "racy" rule, wider than any filesystem's timestamp
granularity); anything younger is rehashed every call. The whole map is dropped every
minute, so a full content verification is never further away than that, and the map
lives only in the service's memory — never on disk, where a same-uid candidate could
write an entry into it. The in-process hook has no cache at all and hashes every
protected file every time, as it always has. `test/hook-service.test.ts` proves the
`touch -r` same-size rewrite is still reported as drift through the cache.

**Residual, stated plainly.** The service runs as the same uid as the candidate. A
candidate that can kill a same-uid process and start its own listener on the socket
can answer "allow" to the hook — the same class of move as rewriting
`.git/tamperward/*` or the settings file that wires the hook, which the loop layer has
never been able to prevent and CI has never depended on. The service adds no
authority: the Stop sweep, `run`, pre-commit and CI read none of its state. The
ownership and mode checks close the cross-uid case (a shared `/tmp` on a multi-user
host) and the accidental one (a stale socket, a wrong version); they do not, and cannot,
make the loop layer the authority.

