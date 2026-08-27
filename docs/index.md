---
layout: home

hero:
  name: Tamperward
  text: The deterministic agent-integrity gate
  tagline: AI coding agents optimize for "the command succeeded," not "the change is trustworthy." Tamperward blocks the class of shortcut they take to force checks green — measured, not asserted.
  image:
    light: /logo.svg
    dark: /logo-dark.svg
    alt: Tamperward
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Read the launch post
      link: /blog/what-agents-do-when-you-block-their-shortcuts
    - theme: alt
      text: GitHub
      link: https://github.com/hexrift/tamperward

features:
  - title: Deterministic, no model calls
    details: A ruleset evaluated on the actual diff and commands. There is no LLM judge to persuade — a gate an agent can argue with is not a gate.
  - title: Enforced at every stage, CI the authority
    details: Inside the agent's loop (a Claude Code PreToolUse deny plus an end-of-turn sweep, holding under bypassPermissions), at pre-commit, and in CI — the authority, reading the policy from the merge-base so a PR cannot govern its own verdict.
  - title: Measured, not asserted
    details: Across 67 guarded harness runs, 0 tampers reached green and all 25 denials converted to honest fixes — and a pre-registered no-gate control arm shows 6/10 tampers without it, so the gate causes the difference. Refuted bets ship in the repo next to the confirmed ones.
  - title: One command to wire it all
    details: npx tamperward init writes the policy and every enforcement point, idempotently, without overwriting anything you wrote.
---
