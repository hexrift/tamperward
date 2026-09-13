# assertion-weakening — detector-specific precision replay

This artifact is the first committed measurement for the JS/TS
`assertion-weakening` detector introduced for #323. It is intentionally narrower
than the semantic rule name and ships as **warn only**.

## Provenance

The ordinary-maintenance negative slice comes from the already-adjudicated
`test-content-removal` false-positive study in
[`TCR-CORPUS.md`](./TCR-CORPUS.md): 2,304 adjacent mainline diffs across immer,
zustand, zod and prettier, with 47 legitimate detector fires. Twenty retained
records touched assertion semantics closely enough to exercise the proposed
assertion-weakening predicate. Those twenty are normalized into minimal
before/after reproductions in
[`assertion-weakening-corpus.json`](./assertion-weakening-corpus.json).

This is **not** presented as a fresh independent 2,304-diff replay. The 2,304
figure is the parent ordinary-maintenance frame from which the 20 relevant
negative records were adjudicated. The committed JSON is the detector-specific
replay surface and CI executes it on every change.

Twelve positive mutation controls cover only the detector's supported one-way
subset: statically proven equality/structural value to truthy/defined, positive
`toThrow(message|regexp)` to bare `toThrow()`, and pure assertion removal.

## Measured result

The result below is enforced by
`test/assertion-weakening-corpus.test.ts`, which recomputes it from the
committed JSON and the shipping detector:

| measure | result |
|---|---:|
| parent ordinary-maintenance frame | 2,304 diffs |
| detector-specific legitimate negatives | 20 |
| mutation positives | 12 |
| fires | 12 |
| adjudicated true positives | 12 |
| adjudicated false positives | 0 |
| true negatives | 20 |
| measured precision among fires | **100% (12/12)** |
| false-positive rate on retained ordinary-maintenance slice | **0/20** |

## Threshold and severity decision

The predeclared **build threshold is 90% precision** on this labeled replay.
The current 100% measurement clears that threshold for shipping the detector,
but **does not authorize `block` severity**.

The rule remains `heuristic` / `warn` because:

1. the 20 negatives are a relevant slice of an earlier study, not a new
   independent corpus selected after this exact implementation;
2. the supported subset is intentionally conservative and therefore recall is
   not established by this precision result;
3. future live warnings and a larger independent ordinary-maintenance replay
   are required before any block-graduation proposal.

Any move to `block` is a separate policy/version decision with its own
measurement. Pristine verification remains the authority.

## Precision changes forced by review

The first implementation was rejected before merge because it treated syntax
shape as direction even when logic ran the other way. The committed corpus and
unit regressions now include:

- `expect(flag).toBe(false)` → `toBeTruthy()`: **not** weakening;
- `expect(x).toBe(undefined)` → `toBeDefined()`: **not** weakening;
- `.not.toThrow(/boom/)` → `.not.toThrow()`: **not** weakening;
- duplicate test titles under reordered suites: no positional pairing;
- ambiguous duplicate fully-qualified test identities: decline comparison.

That is the intended design bias: miss uncertain cases rather than manufacture
high-confidence-looking warnings.
