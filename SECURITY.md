# Security Policy

Tamperward is a security control, so a defect in it is usually a *silence* rather than a
crash: a change that weakens a safety net and is allowed through anyway. Reports of that
kind are the most valuable thing anyone can send this project.

## Reporting a vulnerability

**Please do not open a public issue for a bypass.** Use GitHub's private vulnerability
reporting on this repository: **Security → Report a vulnerability**. That opens a private
advisory visible only to the maintainers.

Include, where you can:

- the exact diff or command that gets through (or wrongly fires),
- which enforcement point it passes — agent hook, Stop sweep, `--staged`, or `--diff`,
- the `.tamperward.yml` in effect, since policy shape changes what is protected.

A minimal reproduction against a throwaway repo is worth more than a description; the
detectors are deterministic, so a concrete case either reproduces or it doesn't.

## What counts as a vulnerability here

- **Detector evasion (false negative).** Any realistic way to delete, skip, or gut a
  protected test, silence the type checker or linter, lower a coverage gate, neuter a
  hook or CI check, or skip the hooks — without a blocking finding.
- **Fail-open.** Any path where the gate *allows* because something went wrong: an
  exception, a malformed policy, an unreadable blob, a git failure. A gate that cannot
  evaluate must deny, never pass.
- **Self-authorisation.** Any way a change can weaken the policy that governs its own
  verdict, clear its own blocking finding, or launder a tamper past the Stop sweep.
- **Sign-off escape.** Any way to clear a `block` without the human step the layer
  requires — a committed ledger honoured in CI, a forged or replayed entry, an
  out-of-band approval that covers more than it was granted for.

False positives are also worth reporting. A gate that blocks honest work gets switched
off, which is a security failure by a slower route.

## What is not a vulnerability

- **`assertion-weakening` and `guard-removal` shipping as `warn`.** Both are heuristic and
  stay non-blocking until their precision is measured against a negatives corpus. This is
  documented in SPEC §7 and in `.tamperward.yml`; a miss by a `warn` rule is expected.
- **A repo weakening its own policy.** `ignore` globs, lowered severities and disabled
  rules are the owner's call. Tamperward reports the count it ignored and treats a
  weakening edit as a finding — it does not stop a maintainer who means it.
- **An approver clearing a real finding.** The out-of-band label is the designed escape
  valve for a reviewed, legitimate change. Its security rests on branch protection and
  `CODEOWNERS`, not on the label being unusable.
- **Coverage gaps outside the shipped slice.** JavaScript/TypeScript is the fully
  supported surface. Other ecosystems (Python, Go, Rust, Ruby, Java/Kotlin/Scala, PHP,
  C#) get file-level protection — their conventional test layouts are in the baseline
  `protected.tests` globs, so deleting, renaming out, or gutting such a file fires — plus
  the documented skip and suppression patterns; the AST-level rules (block counting,
  `any` detection) are JS/TS only. Agents other than Claude Code meet the gate only at
  pre-commit, CI and the `run` envelope. These are stated boundaries, not evasions; a
  miss inside a boundary this file names is still a report we want.

## Supported versions

The latest published minor of the current major line receives fixes, as patches — a bypass fix
is always a patch (CONTRIBUTING, "Versioning") so it reaches you on an ordinary update.
Older minors are not patched; upgrade to the current one.

## Disclosure

We aim to acknowledge a report within a few days, and to agree a disclosure timeline with
you. Once a fix ships, the bypass is added to the regression suite — every accepted report
becomes a permanent test, and we would rather credit you in the advisory than not.
