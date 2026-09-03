# FRAME5 amendment 2 — extending the frame a second time

**Status: disclosed BEFORE any additional mapping.** As with amendment 1, this
document is committed first and the tail is mapped only afterwards. An amendment
written after seeing what the extension yields is not an amendment, it is a
selection.

Freeze 1 was already an amended freeze (amendment 1). This is the second
amendment to it, on the same append-only terms, and it is disclosed rather than
smoothed over.

## Why a second extension

Amendment 1 sized the frame at 2,000 against the registered 110 pairs. That
sizing used the yield as a point estimate and left no room for it being wrong.
With the D3 burn now accounted and the pilot's cost included, the margin is
about **3 tasks in 110**, which is not a margin.

The arithmetic, all of it measured:

| quantity | value | source |
| --- | --- | --- |
| amended frame | 2,000 | `frame/walk-order-ext.json` |
| burnt (D3 + the resumed pilot so far) | 266 | `frame/pilot-dedup.json` |
| unburnt available | 1,734 | |
| repositories processed per validated task | **14.0** | round 3: 280 processed for 20 tasks |
| pilot still to spend (10 tasks) | ~140 | |
| available to the counted round | ~1,594 | |
| expected counted tasks | **~113** | against a registered need of **110** |

Round 3's ledger is the whole basis for that 14.0: 500 repositories walked, 220
`QUOTA_FULL` recorded once its need was met, **280 substantively processed**,
20 validated tasks.

**Three tasks of headroom is not enough, for two independent reasons.**

1. **Sampling.** The yield is one round's 20 tasks. As a proportion,
   p̂ = 20/280 = 0.071 with a standard error of 0.015, so a 95% interval runs
   roughly **0.041 to 0.102** — between about 10 and 24 repositories per task.
   At the pessimistic end 1,594 repositories yield **~65 tasks**, not 110. The
   point estimate clearing the bar by 3% says almost nothing about whether the
   frame is adequate.
2. **Population.** Amendment 1 already disclosed that its tail was mapped from a
   deeper, less-downloaded part of the ranked list, where packages are smaller
   and less active. That difference pushes the yield **down**, not up, and this
   amendment's tail is deeper still.

## What this amendment does, and does not do

**Does not touch anything already frozen.** The original 500 (`frame/frame.json`,
`frame/walk-order.json`, `frame/pilot-walk-order.json`) and amendment 1's
extension (`frame/frame-ext.json`, `frame/walk-order-ext.json`,
`frame/pilot-walk-order-ext.json`) are preserved **byte-for-byte**. No
repository is remapped and **no existing rank moves**. The pilot is running on
`frame/pilot-resume-walk.json` and this amendment does not alter it: the
extension appends beyond everything the pilot will reach.

**Appends a newly mapped tail** from the same pinned snapshot
(`hugovk/top-pypi-packages@6becf8c3`) under the identical rules of `FRAME5.md`,
resuming at the ranked position where amendment 1's mapping stopped, with the
dedup pre-seed extended by every repository already in the frame and every
repository in `frame/pilot-dedup.json`.

**Target: extend the frame to 3,200 repositories** (append ~1,200). That is
sized against the **pessimistic end** of the yield interval rather than its
point estimate: ~2,900 unburnt repositories after the pilot covers 110 tasks at
roughly 24 repositories per task, and leaves the ranked list far from exhausted.

**Walk orders are extended by appending, never by reshuffling** — the existing
order is preserved unchanged as the prefix, and newly admitted repositories are
shuffled under the same seeds and appended. A repository's position in the
registered prefix is identical before and after.

## What this costs, stated honestly

- Freeze 1 carries a **second** amendment, disclosed here and dated.
- The tail is mapped from a still deeper part of the ranked list, so the
  population drifts further from the original 500. This is disclosed, not
  corrected for; the mapping log records every rank so composition can be
  examined afterwards.
- Sizing against the pessimistic end means the counted round will very likely
  **not** exhaust the frame. Unused frame is not a cost to the inference: the
  counted pool is the first N validated tasks in walk order, and where the walk
  stops is a consequence of the registered N, not a choice made later.

## What is still not amended

Nothing about the treatment, the arms, the endpoint, the analysis or the counted
N. Freeze 2 remains unregistered and untouched. No counted trajectory has run,
and no counted task has been mined.

## Sequencing

The mapping runs **after the pilot completes and before counted mining begins**.
It is API-only (no clones), so it cannot contend with the clone path; it is
sequenced after the pilot anyway, because running two things at once is the
shape D3 is best explained by.

## The extension as built

*(To be filled in after this amendment is committed and the mapping has run —
admitted count, resumed rank, ending rank, dedup outcomes, and verification that
the frozen prefixes are byte-identical.)*
