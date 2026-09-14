// #441 — test-skip: Go `tb.Skip()` / testify `s.T().Skip()` and pytest conftest hooks
// (`pytest_collection_modifyitems`, `pytest_runtest_makereport`, `pytest_pycollect_makeitem`,
// `add_marker(mark.skip)`, an aliased `mark.skip`, a hookwrapper rewriting `rep.outcome`)
// were silent: the Go receiver was one letter and the pytest set knew only the decorator
// spelling. Each fixture from the issue blocks; the controls stay clean.

import { describe, expect, it } from 'vitest';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy } from '../src/policy';
import { testSkip } from '../src/detectors/test-skip';
import type { Change } from '../src/types';

const P = defaultPolicy();

const added = (path: string, ...lines: string[]): Change[] =>
  parseDiff(`diff --git a/${path} b/${path}
index 1..2 100644
--- a/${path}
+++ b/${path}
@@ -1,0 +1,${lines.length} @@
${lines.map((l) => `+${l}`).join('\n')}`);

const rules = (c: Change[]) => testSkip.run(c, P).map((f) => f.rule);
const lines = (c: Change[]) => testSkip.run(c, P).map((f) => f.line);

describe('#441 · Go: any receiver name reaches Skip/Skipf/SkipNow', () => {
  it.each([
    ['tb.Skip()', '\ttb.Skip("later")'],
    ['tb.Skipf()', '\ttb.Skipf("no %s", why)'],
    ['tb.SkipNow()', '\ttb.SkipNow()'],
    ['tt.Skip() (a subtest receiver)', '\t\ttt.Skip("flaky")'],
    ['testingT.Skip() (a long receiver)', '\ttestingT.Skip()'],
    ['testify s.T().Skip()', '\ts.T().Skip("later")'],
    ['testify suite.T().Skipf()', '\tsuite.T().Skipf("no %s", why)'],
    ['testify s.T().SkipNow()', '\ts.T().SkipNow()'],
    ['t.Skip() still covered', '\tt.Skip("later")'],
    ['b.Skip() still covered', '\tb.Skip("later")'],
  ])('flags %s', (_label, line) => {
    expect(rules(added('pkg/x_test.go', line))).toEqual(['test-skip']);
  });

  it.each([
    ['a Skip( inside a string', '\tt.Log("call t.Skip() to bypass")'],
    ['a Skip( inside a string, non-t receiver', '\ttb.Logf("tb.Skip(%q)", why)'],
    ['a helper named skip in lower case', '\tskip.Run(t)'],
    ['a plain func declaration', 'func TestAdds(t *testing.T) {'],
    ['a comment mentioning tb.Skip()', '\t// tb.Skip() used to live here'],
  ])('does not flag %s', (_label, line) => {
    expect(rules(added('pkg/x_test.go', line))).toEqual([]);
  });
});

describe('#441 · pytest: conftest hooks that drop or rewrite tests', () => {
  it.each([
    ['pytest_collection_modifyitems', 'def pytest_collection_modifyitems(config, items):'],
    ['pytest_collection_modifyitems (session form)', 'def pytest_collection_modifyitems(session, config, items):'],
    ['pytest_runtest_makereport', 'def pytest_runtest_makereport(item, call):'],
    ['pytest_pycollect_makeitem', 'def pytest_pycollect_makeitem(collector, name, obj):'],
    ['pytest_ignore_collect still covered', 'def pytest_ignore_collect(collection_path, config):'],
    ['add_marker(pytest.mark.skip)', '        i.add_marker(pytest.mark.skip)'],
    ['add_marker(pytest.mark.skip(reason=...))', '        item.add_marker(pytest.mark.skip(reason="slow"))'],
    ['add_marker(mark.xfail)', '        item.add_marker(mark.xfail)'],
    ['add_marker(pt.mark.skipif(...))', '        item.add_marker(pt.mark.skipif(True, reason="x"))'],
    ['an aliased mark.skip', 'sk = pytest.mark.skip'],
    ['an aliased mark.skip(reason=...)', 'later = pytest.mark.skip(reason="later")'],
    ['an aliased mark.xfail', 'xf = mark.xfail'],
    ['an aliased mark.skipif', 'win_only = pytest.mark.skipif(sys.platform != "win32", reason="win")'],
    ['rep.outcome = "passed" in a hookwrapper', "    rep.outcome = 'passed'"],
    ['report.outcome = "skipped"', '    report.outcome = "skipped"'],
    ['outcome forced on a report object', '    call.excinfo = None; rep.outcome = "passed"'],
  ])('flags %s', (_label, line) => {
    expect(rules(added('tests/conftest.py', line))).toEqual(['test-skip']);
  });

  it('a whole conftest that filters items and marks the rest blocks on each hook line', () => {
    const c = added(
      'tests/conftest.py',
      'import pytest',
      '',
      'def pytest_collection_modifyitems(config, items):',
      '    keep = [i for i in items if "slow" not in i.keywords]',
      '    items[:] = keep',
      '    for i in items:',
      '        i.add_marker(pytest.mark.skip)',
    );
    expect(lines(c)).toEqual([3, 7]);
  });

  it('a hookwrapper that rewrites the report outcome blocks', () => {
    const c = added(
      'tests/conftest.py',
      '@pytest.hookimpl(hookwrapper=True)',
      'def pytest_runtest_makereport(item, call):',
      '    outcome = yield',
      '    rep = outcome.get_result()',
      "    if rep.when == 'call' and rep.failed:",
      "        rep.outcome = 'passed'",
    );
    expect(lines(c)).toEqual([2, 6]);
  });

  it('an alias declared in the change and then used as a decorator flags both lines', () => {
    const c = added(
      'tests/test_x.py',
      'import pytest',
      'sk = pytest.mark.skip',
      '',
      '@sk',
      'def test_adds():',
      '    assert 1 + 1 == 2',
    );
    expect(lines(c)).toEqual([2, 4]);
  });

  it('a decorator using an alias declared earlier in the file (only the @ line is added) flags', () => {
    const before = 'import pytest\nsk = pytest.mark.skip\n\ndef test_adds():\n    assert 1 + 1 == 2\n';
    const after = 'import pytest\nsk = pytest.mark.skip\n\n@sk\ndef test_adds():\n    assert 1 + 1 == 2\n';
    const c = parseDiff(`diff --git a/tests/test_x.py b/tests/test_x.py
index 1..2 100644
--- a/tests/test_x.py
+++ b/tests/test_x.py
@@ -3,0 +4,1 @@
+@sk`);
    const [fc] = c;
    if (fc.kind !== 'file') throw new Error('file change expected');
    const enriched: Change[] = [{ ...fc, before, after }];
    expect(lines(enriched)).toEqual([4]);
  });

  it.each([
    ['a conftest that only registers fixtures', '@pytest.fixture', 'def db():', '    return object()'],
    ['a session fixture with a scope', '@pytest.fixture(scope="session", autouse=True)', 'def env(monkeypatch):', '    monkeypatch.setenv("TZ", "UTC")'],
    ['a plugin hook that adds a CLI option', 'def pytest_addoption(parser):', '    parser.addoption("--runslow", action="store_true")'],
    ['a configure hook that registers a marker', 'def pytest_configure(config):', '    config.addinivalue_line("markers", "slow: slow tests")'],
    ['add_marker with a custom marker', '        item.add_marker(pytest.mark.slow)'],
    ['an alias of a non-skip marker', 'slow = pytest.mark.slow'],
    ['a decorator whose name is not a skip alias', '@slow', 'def test_big():', '    assert True'],
    ['a comparison against outcome', "    assert rep.outcome == 'passed'"],
    ['the outcome word in a string', '    log.info("rep.outcome = passed")'],
    ['a comment naming the hook', '# def pytest_collection_modifyitems used to filter here'],
    ['a plain test function', 'def test_adds():', '    assert 1 + 1 == 2'],
  ])('does not flag %s', (_label, ...src) => {
    expect(rules(added('tests/conftest.py', ...src))).toEqual([]);
  });
});
