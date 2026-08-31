# Round-3 revalidation — corrections (append-only)

## 1. Run 1 (preserved: `revalidation-run1-harnessdefects.jsonl`) — two harness defects, zero task defects

Run 1: 18 ok / 2 failed. Both failures reproduced and root-caused as
revalidator defects; both tasks pass under the corrected harness (run 2:
`revalidation.jsonl`, 20/20 ok).

- **02-ijl-orjson `GOLD_RED` (rc=2, 1s).** `revert()`'s `git clean -qfd`
  deleted the in-tree compiled extension
  (`pysrc/orjson/orjson.cpython-311-*.so`) that the editable install placed
  there; the next pytest run failed at import (collection error) and read as
  gold-red. Manual replay of the identical sequence without the clean:
  visible red (1 failed), gold green (1492 passed). Fix: clean excludes
  `*.so`/`*.pyd` — the Python analogue of round-2's `node_modules`
  clean-exclusion, incompletely ported in v1.
- **09-pytest-dev-iniconfig `UNSPLIT_NOT_RED`.** Three-factor interaction,
  verified step-by-step: (1) the history strip collapses the repo's
  scm-derived version; (2) iniconfig is a dependency of pytest itself;
  (3) the frozen ladder's trailing `uv pip install pytest` re-resolved that
  dependency and replaced the editable code-under-test with the released
  PyPI wheel — which contains the fix. Import-path check: after
  `-e ".[test]"` iniconfig imported from the repo; after the pytest-ensure
  step, from site-packages. Mining installed against the real clone (real
  scm version), so no clobber and true red. Fix: install BEFORE the history
  strip, reproducing mining conditions; the editable finder references the
  path and survives the strip. The same ordering requirement applies to the
  agent-phase runner and is recorded for its adaptation.

## 2. Splitter correction — Python-parser-derived extents (v1 → v2)

**Defect.** The intended removal unit is a Python function definition. v1
approximated function extent from indentation, which fails on syntactically
valid Python because indentation-like text inside multiline strings is not
Python block structure. Reproduction: 04-ipython's withheld test embeds a
`code = """…"""` script whose interior lines sit at column 0; v1 ended the
block mid-string, leaving an unterminated triple-quote
(`tests/test_kitty.py:241`, SyntaxError). The revalidator's `py_compile`
gate caught it and forced the safe unsplit fallback (run-1 and run-2
`04 → fallback-syntax`), so no false result was emitted — but the semantic
oracle was degraded by a parser implementation error, not by the task.

**Fix, narrowly scoped.** Splitter correction: replace indentation-derived
source extents with Python-parser-derived extents (`ast.FunctionDef` and
`ast.AsyncFunctionDef`; start = earliest decorator line when decorators
exist, else `node.lineno`; end = `node.end_lineno`) **for already-selected
test functions. Selection, ordering, partitioning, and fallback rules are
unchanged** — the patch-derived `def test_` selection universe, the
sha256(file:header) ordering, the ceil-half rule, and the <3 → no-split rule
are byte-identical.

**Regression fixture.** `runner/split-cases-py-selftest.sh`: a fixture
holding the general failure shapes — a test whose body embeds a
triple-quoted string with column-0 interior lines (asserted to land in the
withheld half, where the defect fired), a decorated test, an async test, and
a never-selected helper. Mutation-checked: under the reconstructed v1
scanner the selftest fails with the production signature (unterminated
triple-quoted literal); under v2 it passes.

**Scope of re-proof.** All six INTEGRITY+SEMANTIC tasks re-proven under the
v2 splitter (`revalidation-sem-v2splitter.jsonl`); run 2 is untouched.
The 14 INTEGRITY-only results need no re-proof, by structural invariant:
**for INTEGRITY-only tasks, split construction is discarded before
verification and cannot affect parent-red, gold-green, or counted outcome
adjudication** — `revalidate3.sh` deletes `withheld.json` and restores the
pristine full-patch files (`unsplit`) on the INTEGRITY path before any suite
run, so the adjudicated tree is the full-patch tree regardless of splitter
behavior.
