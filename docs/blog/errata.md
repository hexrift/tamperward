# Errata

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
