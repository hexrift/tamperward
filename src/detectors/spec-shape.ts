// Spec-shaped or support-shaped: the one question the spec rules (test-deletion,
// test-content-removal) ask before they block on a `tests`-category file (#443).
//
// The protected `tests` globs are deliberately wide — `**/__tests__/**`,
// `**/src/test/**` — because a repository whose layout they miss gets rules that
// can never fire. The price was that everything under them read as a spec:
// deleting `src/test/helpers.ts`, trimming the `vi.mock` list in
// `src/test/setup.ts`, shortening `src/__tests__/fixtures/data.json` were
// "A test file was deleted" / "Test content removed" BLOCKs, on files that define
// no test. A support file is routed to `test-support` (warn) instead; a real spec
// under the same globs is judged exactly as before.
//
// Kept in its own module so the spec rules change by one predicate each and the
// test-counting code (`countTests`) is not reshaped.

import { countTests } from './test-deletion';
import { langOf } from './files';

/** The file names every ecosystem's runner selects BY NAME: a file so named is a
 *  spec whatever its content (the rules cannot read a `.test.ts` any other way,
 *  and jest opens it wherever it sits). `conftest.py` is named by the policy
 *  itself — pytest's fixture wiring, protected by name for that reason. */
const SPEC_SUFFIX =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.py$|(?:^|\/)conftest\.py$|_test\.go$|_spec\.rb$|_test\.rb$|Tests?\.java$|Tests?\.kts?$|Test\.php$|Tests?\.cs$|(?:^|\/)tests\/[^/]+\.rs$|(?:^|\/)tests\/[^/]+\/main\.rs$)/;

/** Directories under a test tree that hold data FOR the specs, never specs: the
 *  same set `OTHER_RUNNER_DIR` keeps out of the runner's sample listing. */
const SUPPORT_DIR = /(?:^|\/)(?:fixtures|__fixtures__|__mocks__|__snapshots__)\//;

/** Whether a `tests`-category path is a spec the block rules protect, judged by
 *  name first and by content second:
 *
 *   - a test-file suffix (`.test.ts`, `_test.go`, `test_*.py`, `*Test.java`,
 *     `*_spec.rb`, `tests/<name>.rs`, …) is a spec whatever it contains — the
 *     runner opens it by name, and a suffixed file under `fixtures/` still runs;
 *   - otherwise a `fixtures/` / `__fixtures__/` / `__mocks__/` / `__snapshots__/`
 *     component makes it support, by the directory's meaning;
 *   - otherwise a file in no language the pattern rules read (JSON, YAML, a
 *     `.properties`, a Markdown note) is support: it can define no test;
 *   - otherwise the content decides: no test defined on either side is support.
 *     A side the gate cannot read (`null`) or cannot count (a declined parse, an
 *     open count) is a spec — unknown content fails closed. */
export function isSpecShaped(path: string, before: string | null, after: string | null): boolean {
  if (SPEC_SUFFIX.test(path)) return true;
  if (SUPPORT_DIR.test(path)) return false;
  if (langOf(path) === null) return false;
  if (before === null && after === null) return true;
  for (const src of [before, after]) {
    if (src === null) continue;
    const n = countTests(src, path);
    if (n.min > 0 || n.open) return true;
  }
  return false;
}
