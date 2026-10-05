# Production pilot protocol

SPEC §9.1 milestone M3 closes when a named pilot publishes, over a stated period, its
per-rule fire and false-positive counts, `verify` wall-clock against the bare suite, how
often the out-of-band sign-off was needed, and hook latency, linked from the research
index whether or not it flatters the gate. No pilot has run (#480). This page is the
pre-registered protocol one follows when it does, written before any pilot data exists,
in the same discipline the corpus studies use: the fields and the adjudication rule are
fixed first, the numbers are read afterwards.

## Opt-in

A pilot is a repository whose owner has agreed, in writing on the tracking issue, to run
TamperWard in the loop for a stated period and to have the aggregate below published
under the repository's name. Nothing is collected from anyone who has not opted in; the
local audit log is off unless `TAMPERWARD_AUDIT_LOG` is set, and `stats` reads only the
file it is pointed at.

The period, the TamperWard version range, the agent runtime(s), and the policy in effect
are recorded on the issue when the pilot starts. A pilot that changes any of them
mid-period reports two periods, not a blended one.

## What is collected

Only `audit-v1` events, as the hooks write them. The writer is allowlist-only; the full
field set is:

| field | what it is | who writes it |
| --- | --- | --- |
| `id`, `timestamp`, `surface`, `agent`, `rule`, `severity`, `decision` | the finding, as a rule name and a verdict | every hook deny or warn |
| `session` | a one-way hash of the runtime session id | every hook event with a session |
| `hook_latency_ms` | whole milliseconds from the hook reading its input to the deny being written | the PreToolUse and Stop hooks, on every deny they record (2.40.0) |
| `verify_wall_clock_ms` | wall-clock of a `tamperward verify` run | a producer the pilot wires; no in-tree producer yet |
| `bare_suite_wall_clock_ms` | wall-clock of the same suite with no TamperWard, the comparison for the row above | the same producer, measured on the same commit and machine |
| `oob_signoff` | whether an out-of-band sign-off (a CI label or a local allow) was needed to clear the finding | a producer the pilot wires; no in-tree producer yet |

Until the two producers exist, a pilot reports `verify` wall-clock and sign-off use from
its own CI logs, by hand, and says so.

## What is never collected

Prompts, tool command bodies, source or evidence text, filenames, absolute paths,
environment values, credentials and the raw session id. The writer cannot serialise them
and the reader (`parseAuditEvent`, the publisher's `audit-verify.mjs`) rejects any field
outside the set above rather than redacting it. A pilot that needs a file-level view
keeps it private and publishes only the aggregate.

## The aggregate that is published

The `tamperward stats --json` document over the period's events (`stats-v1`):

- `events`, `blocked`, `warnings`, `sessions`, and `by_rule` / `by_surface` counts;
- `latency.hook_latency_ms`, `latency.verify_wall_clock_ms` and
  `latency.bare_suite_wall_clock_ms`: nearest-rank p50, p95 and max with the sample count,
  or `null` where nothing was measured;
- `oob_signoffs`.

Beside it, for every rule that fired, the false-positive count under the rule below, with
the denominator (fires adjudicated) and the number left `unclear`.

## False-positive adjudication

The criterion is fixed before any fire is opened, per rule, as
[`harness/fp-study/ADJUDICATION-RULE.md`](https://github.com/hexrift/tamperward/blob/main/harness/fp-study/ADJUDICATION-RULE.md)
does for the corpus studies. For a pilot the question is the same one that file asks:
*would the block have wrongly stopped legitimate work?*

- **FP**: the agent's change was legitimate and the deny cost a human a sign-off or a
  rewrite. The rule's own negative examples in [the rules guide](../guide/rules.md) are the
  reference; a fire that matches one of them is FP without further argument.
- **TP**: the change weakened a protected check, whether or not the agent meant to. Intent
  is not adjudicated; a finding is a signal, not proof of intent, and the aggregate carries
  `interpretation: finding-is-not-proof-of-intent` for that reason.
- **unclear**: the adjudicator cannot tell from the diff alone. Counted and published as
  such, never folded into either side.

The adjudicator is independent of the detector: they read the diff and the rule's stated
negatives, never the detector's own output. Adjudication happens once, after the period
ends, and the verdicts are frozen with the aggregate.

## Publication

The aggregate, the per-rule adjudication counts, the period, the version range, the
runtime and the policy are published as a dated page under `docs/research/` and linked
from the [research index](./index.md), by a maintainer-merged pull request. Weak results
publish too: a pilot that shows a false-positive rate above a block rule's deployable
threshold, a `verify` overhead the team found unacceptable, or sign-offs on most denies
is the finding M3 asks for, and the gate's response is a measured change, never a
quieter report. A pilot that stops early reports the period it ran and why it stopped.

Nothing on this page is a result. When the first pilot publishes, its page links here and
this page gains a row naming it.
