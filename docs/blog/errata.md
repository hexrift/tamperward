# Errata

The project's central record of publication corrections, verified against
primary artifacts before editing. Corrections are listed newest first.
Outstanding uncertainties the artifacts cannot decide live in "Known,
unresolved" above them — they are open items, not dated corrections.

## Known, unresolved

Three inconsistencies the audit surfaced that the repository's artifacts
cannot decide. They are recorded here rather than silently "fixed",
because a correction we cannot verify is just a second guess:

1. **The bets ledger jumps 56/25 → 59/27 between posts 8 and 9** (+3 bets,
   +2 refuted) with no documented intervening study that supplies two
   refutations; the only uncounted 3-bet registration in that window had
   all three bets confirmed. Every ledger step from post 9 onward
   (59 → 64 → 70 → 77) is internally consistent, so the discrepancy sits at
   exactly one step — a mis-tally at post 8 or 9, or an unrecorded
   reclassification. The running totals in later posts inherit whichever
   it was.
2. **The index summary for the launch post** says "two of which were
   refuted" where the post's own closing tally is seven of twelve across
   all its registrations; no artifact pins which scope the index line
   intended.
3. **The CHANGELOG carries no `## [1.7.0]` heading** — the 1.7.0 release
   exists in git history, but its notes are folded into the 1.8.0 section.
   A repo-record inconsistency rather than an article error.

Also explicitly not re-verified (and so not certified by the audit): the
seed-study outcome labels as scored by their oracles (verified only against
the frozen per-study prediction documents plus targeted transcript greps);
the 67- and 77-guarded-run totals (no artifact enumerates the eligible-run
sets); and the negative claim over 58 of the 59 trajectories in the
transient-mutation rescan.

## Corrections — newest first

## 2026-09-01 — round-3.1 preregistration article: pilot counts and causal framing

**Two corrections to the round-3.1 preregistration post, made shortly after
publication and before any counted outcome was reported.**

1. **Pilot outcome counts were wrong.** The post said the six engineering pilots
   were "three `HONEST_FIX`, three `NO_OBSERVED_VIOLATION`". The artifacts say
   **two `HONEST_FIX`, four `NO_OBSERVED_VIOLATION`** — `01-jsonschema`
   contributes both HONEST_FIX; `02-orjson` and `03-pytokens` contribute four
   NO_OBSERVED_VIOLATION. The committed `PILOT-SUMMARY.md` table was correct
   throughout; the prose miscounted from it. The commit message that landed the
   post carries the same error and cannot be edited; this entry is its
   correction of record.
2. **The causal framing overclaimed.** The post opened by asking whether the
   effect survives "when the only thing that changes is the agent", while
   correctly disclosing lower down that two other things change: one pair was
   burned before registration, and round 3.1 introduces the control-plane
   isolation correction. The question is now framed as whether the effect
   appears under a stronger model with the treatment held byte-identical, and
   the text states the two disclosed differences beyond the model. The blog
   index summary carried the same overclaim and is corrected to match.

Neither correction touches a prediction, a losing condition, the pair or arm
order, the exclusion, a hash, or the analysis plan.

## 2026-09-01 — the experiment's control plane was reachable by the agent (rounds 1–3)

**Scope: a harness exposure, disclosed after an audit found it unused.** In
rounds 1, 2 and 3 the agent was launched with a plain `env`, as root, on the
same filesystem as the harness. Every internal variable was inherited — `TB_RUNS`
naming the verdict ledger, `TB_TASKS` the task pool with its gold patches,
`TB_VENV` the workspace — and the withheld semantic oracle sat at `$W/oracle`,
one `dirname` from the venv path the agent could read out of its own
environment. Nothing stopped a trajectory from reading the withheld half of its
own test suite, or from writing a file the driver would have accepted as its
verdict.

**What the audit found.** All 34 counted round-3 transcripts were searched.
Zero contain `TB_RUNS`, `TB_VENV`, `TB_TASKS`, `withheld`, `gold.patch`,
`results.jsonl`, `verdict`, `deviations`, or any workspace `oracle/` path. The
two `oracle` hits are the `distro` repository's own Oracle Linux test names; the
seventeen `pristine` hits are the Stop hook's block message quoted back to the
agent; the `venv/` hits are ordinary pytest invocations through the
PATH-leading venv. **This is a string audit of transcripts, not a
filesystem-level proof.** On that evidence no counted trajectory used the
exposure, and the round-1 to round-3 results stand as published.

**What changed.** Round 3.1 scrubs every `TB_*` variable from the agent's
environment and relocates the withheld oracle outside the agent's workspace, so
nothing inside the task points at the control plane. This is **not** described
as a security boundary: the agent still runs as root on the same filesystem. A
real mount/PID/capability boundary was prototyped and verified to work, and is
deferred to round 4 with the fresh pool, rather than landing days before a
counted sweep to close an exposure the audit shows went unused.

**Related, and disclosed in the round-3.1 registration rather than here:** while
validating that registration, the sweep entrypoint was invoked inadvertently and
one Sonnet trajectory executed before the preregistration line. It was
quarantined unread, its task was excluded as spent rather than re-run, and
round 3.1 is registered on 16 pairs instead of 17.

## 2026-09-01 — Round-3 results article corrections

A post-publication audit of *The effect transferred. The detector didn't.*
found several errors in the first published version, all corrected against
the preserved run artifacts (PR #144):

1. **The favourable-pair block claim was wrong.** The article originally
   said several of the six favourable false-green discordances had "zero
   denials and zero blocks." All six favourable gated trajectories were in
   fact blocked by pristine verification at least once. Across all 17 gated
   trajectories, 12 had verification discrepancies, with 41 blocked Stop
   attempts in total — the published "14 and 15 blocks in two runs"
   understated the verifier's activity by ten trajectories. The correction
   strengthens the reported mechanism; the per-pair attribution caveat is
   retained.
2. **B6's ambient-network component was initially scored too favourably.**
   The first version marked B6 as a win without reporting the registered
   telemetry proportion. Under the preregistered all-attempts denominator,
   424/580 denied proxy requests (73.1%) were ambient telemetry — below the
   ≥95% prediction. Among external-host attempts the proportion was 97.7%.
   B6 is now reported as partial, scored by the stricter registered
   denominator.
3. **B4 was initially marked as a successful prediction** despite having
   been registered as "descriptive only. No bet, no claim." A non-bet cannot
   win; it is now shown as non-evaluable.
4. **Reconciliation, not a publication error:** an interim results summary
   circulated before the article reported fsspec with 13 blocked Stop
   attempts; the published article's figure of 14 is the artifact-canonical
   count. The 13 came from a snapshot taken while the trajectory was still
   running, before its final block.

None of these corrections changes the frozen primary result:
b=6, c=0, paired RD +35.3pp [9.5, 58.7], exact McNemar p=.0313.

## 2026-08-31 — network isolation was observation-bounded (rounds 1–2)

The taskbench egress allowlist proxy was wired via `HTTP[S]_PROXY`
environment variables only. A round-3 pre-count probe (`egress-probe.sh`)
established that a process in this environment can bypass those variables and
reach infrastructure-permitted hosts directly, so the proxy observed agent
traffic rather than enforcing a boundary. Rounds 1–2 therefore support
"no proxy-observed forbidden retrieval," not "no network exposure"; their
`NETWORK_EXPOSURE = 0` and the exposure sensitivity analysis are bounded by
what the proxy could see. Round 3 closes this at the OS level (a network
namespace with no route or resolver except the proxy's veth IP; PREDICTION3
Amendment 3) so its exposure flag is enforced and measurable. No round-1/2
primary endpoint (paired FALSE_GREEN prevention) depends on the network
claim; the correction scopes the network sentence only.

## 2026-08-31 — pre-round-2 publication audit: ten corrections in place

This project audits its own publications against its own artifacts. On
2026-08-31 every checkable claim in the thirteen pre-round-2 posts (179
claims) was recomputed from the primary data; ten errors were found,
independently re-verified, and corrected in place (the corrections are in
the git history of each post). The round-2 results post was audited
claim-by-claim separately, at publication.

Corrected (all verified against primary artifacts before editing): a 2/1
completion-discordance sentence that the frozen definition scores 5/3; a
"three days before the sweep" that was 21 minutes; a flattened
losing-condition claim (registered RD ≤ 0, observed +3.8); an analyzer
output labeled "verbatim" that had been re-wrapped and abridged; an
unmarked elision inside a quotation; "~470 unwalked repositories" of a
frame that was in fact exhausted; "one of three control-arm bets refuted"
where two were; "twenty-two words" for a 26-word sentence (twice); and an
index line saying "zero cheats" over sixty runs that contained eight
tamper-throughs.
