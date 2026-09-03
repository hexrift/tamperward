# FRAME5 amendment 1 — extending the frame

**Status: disclosed BEFORE any additional mapping.** This document is committed
first, and only then is the tail mapped. The order matters: an amendment written
after seeing what the extension yields is not an amendment, it is a selection.

Round 4's freeze 1 is no longer pristine. It is an **amended freeze**, and that
is stated plainly here and in `ROUND4-PREP.md` rather than smoothed over.

## Why the frame must be extended

Two independent reasons, both measured rather than estimated:

1. **The original 500 was never enough for the registered N.** Round 3's own
   attrition gives the yield: 281 substantive repository decisions produced 20
   tasks, about **14.05 decisions per task**. The power simulation asks for 110
   counted pairs, and the pilot needs 10 validated tasks, so the round needs on
   the order of **1,686 substantive decisions**. A 500-repository frame caps out
   near 35 tasks whatever else is true.
2. **The D3 incident spent 254 of the 500.** Those repositories are development
   data under FRAME5's provenance rule and can never be counted, leaving **246**
   available from the original frame — a shortfall of about **1,440**.

## What this amendment does, and does not do

**Does not touch anything already frozen.** `frame/frame.json` (the original
500), `frame/walk-order.json` and `frame/pilot-walk-order.json` are preserved
**byte-for-byte**. No repository is remapped and no existing rank moves.

**Appends a newly mapped tail.** Mapping resumes at the ranked package list
position where the original build stopped (**rank 1,306**), under the identical
rules of `FRAME5.md` — same pinned snapshot, same PyPI project-URL resolution,
same `github.com`-only normalisation, same monorepo dedup — with the dedup
pre-seed extended by:

- every repository of the original 500, so the tail cannot duplicate the prefix;
- every repository in `frame/pilot-dedup.json`, the 254 burnt by D3.

**Target: extend the frame to 2,000 repositories** (append ~1,500). That covers
the 1,686 substantive decisions the yield implies, with headroom for the tail's
own attrition, and leaves the ranked list far from exhausted (15,000 packages
are available; roughly 3,900 more will be walked).

**Walk orders are extended by appending, never by reshuffling.** The extended
counted walk is the **original 500-entry order unchanged as its prefix**,
followed by the newly admitted repositories shuffled under the same seed. A
repository's position in the registered prefix is therefore identical before and
after this amendment. The same construction is applied to the pilot walk. The
original artefacts remain on disk under their existing names; the extended ones
are new files.

## What this costs, stated honestly

- Freeze 1 is now an **amended** freeze, disclosed here and dated.
- 254 repositories are permanently spent for a pilot that produced no counted
  outcome and no official pilot task.
- The extension is mapped from a **deeper, less-downloaded part of the ranked
  list** than the original 500. That is a real population difference: tail
  packages are smaller and less active on average, so the yield per repository
  may differ from round 3's. It is disclosed rather than corrected for, and the
  mapping log records every rank so the composition can be examined afterwards.

## What is still not amended

Nothing about the treatment, the arms, the endpoint, the analysis or the counted
N. Freeze 2 remains unregistered and untouched. No counted trajectory has run.

## The extension as built (2026-09-03, after this amendment was committed)

Mapping resumed at ranked position **1,306** and admitted **1,500** repositories
by position **3,443**, bringing the frame to **2,000**. Outcomes over the tail:

| outcome | count |
| --- | --- |
| admitted | 1500 |
| no GitHub repository | 240 |
| spent in rounds 1–3 | 247 |
| already in the original 500 | 11 |
| burnt by D3 | 17 |
| monorepo duplicate | 0 |
| registry error | 0 |

**Verified after the build, not asserted:**

- `frame/frame.json`, `frame/walk-order.json` and `frame/pilot-walk-order.json`
  are **unchanged** — checksums taken before the run still match.
- The appended set is **disjoint** from the original 500 and from the 254 burnt
  repositories, and contains no duplicates.
- Both extended walks hold 2,000 entries, cover the extended frame exactly, and
  carry the **frozen order as an identical prefix**; the counted and pilot walks
  remain different orders over the same set.

Artefacts: `frame/frame-ext.json`, `frame/mapping-log-ext.jsonl`,
`frame/walk-order-ext.json`, `frame/pilot-walk-order-ext.json`. The originals
keep their names and their contents.
