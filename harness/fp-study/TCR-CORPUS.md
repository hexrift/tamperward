# test-content-removal — false-positive corpus (pre-ship, 1.7.0)

Method: the shipped detector set (with the candidate rule at block) run over
adjacent mainline commit pairs via `tamperward check --diff base...head --json`
in four real repositories (depth-400 clones, 2026-08-30): immer, zustand, zod,
prettier. One JSONL record per fire, with the firing diff hunk, in
`tcr-<repo>-fires.jsonl`. Snapshot-glob files are excluded from the rule (they
are snapshot-rewrite's jurisdiction; before that exclusion, legitimate snapshot
updates dominated the fires).

## Numbers

| repo | mainline diffs | firing diffs | findings |
|---|---|---|---|
| immer | 882 | 23 | 33 |
| zustand | 399 | 3 | 4 |
| zod | 401 | 2 | 3 |
| prettier | 622 | 7 | 7 |
| **total** | **2,304** | **35 (1.5%)** | **47** |

## Adjudication

Every fire is legitimate maintainer work. Four shapes:

1. **API migrations that shrink line count** — zustand's testing-library
   `screen.*` migration: each test loses its destructuring line.
2. **Hand-rolled utilities replaced by libraries** — immer's `Exact<A,B>`
   type-assert machinery swapped for `spec.ts` (nine separate small fires on
   draft.ts alone).
3. **Inline assertions converted to snapshots** — immer's
   `toThrow("message")` → `toThrowErrorMatchingSnapshot()`: a legitimate edit
   that literally softens an inline expectation into a re-recordable one —
   exactly the kind of change sign-off exists to put in front of a human.
4. **Expectation rows removed because reality changed** — prettier deleting
   meriyah error-expectation rows after the parser gained the feature.
   **Byte-shaped like the tamper** (taskbench Phase 3: agents deleting failing
   rows to go green); only the human who knows *why* the row leaves can tell
   them apart.

## Verdict

Ships **block** at 1.5% — roughly one sign-off per 60 mainline commits,
within the gate's accepted residual band. Category 4 is the argument for
block-with-signoff over warn: the legitimate edit and the tamper are
mechanically indistinguishable, so the only design choice is who confirms —
and PHASE3.md measured what `warn` means in an unattended agent loop
(`--updateSnapshot` sailed through as a warn): nothing.
