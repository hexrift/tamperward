# Codex runtime integration status

TamperWard's Codex integration is intentionally staged.

## Current status

The experimental adapter in `src/adapters/codex/` normalizes Codex hook events into the shared runtime-adapter contract and reuses TamperWard's canonical change evaluation and denial formatting.

It is not yet a fully qualified second runtime. In particular, a pinned authenticated `codex exec` run must still prove:

- deny-before-execute for every supported mutation path;
- reliable detached/background observation after a bounded settle interval;
- Stop denial and post-block continuation;
- fail-closed behavior for hook crashes, timeouts, missing executables, malformed output, and transport failures;
- independent validation of working-directory and repository identity.

Until those checks pass, Codex remains experimental and pre-commit/CI plus post-exit verification remain authoritative.

## Configuration boundary

Codex project hooks are configured through the project's `.codex/config.toml` hook entries. The probe uses this documented project configuration surface and records the exact effective configuration in its provenance output.

Do not treat a legacy or undocumented hook filename as equivalent configuration. A runtime adapter must verify that the hook is actually invoked in the execution mode being qualified.

## Capability reporting

Capabilities must be reported per operation, not inferred from the existence of an adapter:

| Capability | Status |
| --- | --- |
| Bash pre-action denial | Probe-dependent |
| `apply_patch`/native write denial | Probe-dependent |
| Delete/rename/Git mutation denial | Probe-dependent |
| MCP mutation denial | Probe-dependent |
| Detached/background enforcement | Probe-dependent |
| End-of-turn/Stop enforcement | Probe-dependent |
| Broken-hook fail-closed transport | Not qualified |

A missing capability or inert positive control is evidence that the run is inconclusive; it is not evidence that TamperWard enforcement failed. Conversely, observed dispatch or a landed protected mutation remains a failure.

## Qualification command

Use the exact headless mode intended for the experiment:

```bash
CODEX_BIN="$(command -v codex)" \
CODEX_VERSION_EXPECTED="$(codex --version | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1)" \
CODEX_MODEL="<pinned model>" \
CODEX_HOME="$HOME/.codex" \
CODEX_EXEC_ARGS="exec --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust" \
npm run probe:codex-runtime
```

A `FULL` result is required before claiming Round 4.1 eligibility or changing the conservative runtime declaration.

## References

- [Runtime-adapter guide](./runtime-adapters.md)
- [OWASP ACS mapping](../ACS-mapping.md)
- [Codex hooks documentation](https://github.com/openai/codex/blob/main/docs/hooks.md)
- [Codex issue #41979: fail-closed hook transport](https://github.com/openai/codex/issues/41979)
- [Codex issue #27833: tool denial behavior](https://github.com/openai/codex/issues/27833)
- [Codex issue #26452: headless hook dispatch](https://github.com/openai/codex/issues/26452)

This document describes the integration boundary and evidence requirements. It does not claim OWASP ACS compliance or Codex equivalence.
