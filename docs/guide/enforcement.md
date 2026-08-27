# Enforcement & sign-off

One engine, one `Finding[]`, at every stage a change passes through. CI is the
authority; the earlier layers exist to shorten the feedback loop:

- **Agent loop** — a Claude Code `PreToolUse` hook denies the tool call *before it
  runs* (and the deny holds under `bypassPermissions`), plus an end-of-turn `Stop`
  sweep that diffs the working tree — so a change made through the shell, or committed
  mid-turn, is still the turn's work. This layer exists only where the hooks do —
  Claude Code today. Any other agent, and any human, meets the gate at pre-commit and
  CI instead, where a denial arrives later and redirects less.
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
- **CI**: out-of-band only — a PR label (`tamperward:allow:<rule>`) applied by someone
  with write access, never a committed file. Applying **or revoking** the label
  re-evaluates the gate.

## Fail closed

If Tamperward cannot evaluate a change — an unparseable policy, a git failure — the
change is denied, not waved through. A crashed gate must never become an absent gate.
