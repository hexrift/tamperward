// Tests left textually present but unreachable (#431). Every block-count and
// line-count rule read textual presence as execution: an `it()` inside
// `if (false) {}`, after a `return;`, or in a function nobody calls still
// counted; three assertions moved into a template literal still "kept" their
// lines; a pytest class renamed away from `Test*` kept its `def test_` count;
// a Go `TestMain` that never calls `m.Run()`, a build tag, a Rust `#[cfg(...)]`
// on the test module, a JUnit `@EnabledIf…`, an RSpec `if: false` were not
// skips. Each fixture from the issue is a positive below; the controls pin the
// legitimate neighbours that must stay counted / stay green.

import { describe, expect, it } from 'vitest';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy } from '../src/policy';
import { countTests, testDeletion } from '../src/detectors/test-deletion';
import { testContentRemoval } from '../src/detectors/test-content-removal';
import { testSkip } from '../src/detectors/test-skip';
import type { Change, FileChange } from '../src/types';

const P = defaultPolicy();

function file(path: string, before: string, after: string): FileChange {
  return { kind: 'file', path, oldPath: null, op: 'modify', before, after, binary: false, hunks: [] };
}
const rules = (fs: unknown[]) => (fs as Array<{ rule: string; severity: string }>).map((f) => `${f.rule}[${f.severity}]`);
const deletion = (before: string, after: string, path = 'src/a.spec.ts') => rules(testDeletion.run([file(path, before, after)], P));
const removal = (before: string, after: string, path = 'src/a.spec.ts') => rules(testContentRemoval.run([file(path, before, after)], P));
const added = (path: string, ...lines: string[]): Change[] =>
  parseDiff(`diff --git a/${path} b/${path}
index 1..2 100644
--- a/${path}
+++ b/${path}
@@ -1,0 +1,${lines.length} @@
${lines.map((l) => `+${l}`).join('\n')}`);
const skip = (path: string, ...lines: string[]) => rules(testSkip.run(added(path, ...lines), P));

const THREE = `
describe('calc', () => {
  it('adds', () => { expect(add(1, 1)).toBe(2); });
  it('subs', () => { expect(sub(1, 1)).toBe(0); });
  it('muls', () => { expect(mul(2, 2)).toBe(4); });
});`;

describe('countTests counts only reachable it()/test() calls (#431)', () => {
  it('a block wrapped in if (false) defines no test', () => {
    const src = `
describe('calc', () => {
  if (false) {
    it('adds', () => { expect(add(1, 1)).toBe(2); });
    it('subs', () => { expect(sub(1, 1)).toBe(0); });
  }
  it('muls', () => { expect(mul(2, 2)).toBe(4); });
});`;
    expect(countTests(src, 'a.test.ts').min).toBe(1);
  });

  it.each([
    'if (0) {',
    'if ("") {',
    'if (null) {',
    'if (undefined) {',
    'if (!true) {',
    'if (false && process.env.CI) {',
    'if (process.env.CI && false) {',
    'if (1 === 2) {',
    'if (true) { /* live */ } else {',
  ])('%s hides the tests it guards', (head) => {
    const src = `${head}\n  it('a', () => { expect(1).toBe(1); });\n  it('b', () => { expect(2).toBe(2); });\n}\nit('c', () => { expect(3).toBe(3); });`;
    expect(countTests(src, 'a.test.ts').min).toBe(1);
  });

  it('statements after an unconditional return in a describe callback are dead', () => {
    const src = `
describe('calc', () => {
  it('adds', () => { expect(add(1, 1)).toBe(2); });
  return;
  it('subs', () => { expect(sub(1, 1)).toBe(0); });
  it('muls', () => { expect(mul(2, 2)).toBe(4); });
});`;
    expect(countTests(src, 'a.test.ts').min).toBe(1);
  });

  it('statements after a throw are dead too, at the module top level as well', () => {
    const src = `
it('adds', () => { expect(add(1, 1)).toBe(2); });
throw new Error('stop');
it('subs', () => { expect(sub(1, 1)).toBe(0); });`;
    expect(countTests(src, 'a.test.ts').min).toBe(1);
  });

  it('tests inside a function nobody calls are not defined', () => {
    const src = `
it('adds', () => { expect(add(1, 1)).toBe(2); });
function later() {
  it('subs', () => { expect(sub(1, 1)).toBe(0); });
  it('muls', () => { expect(mul(2, 2)).toBe(4); });
}
const alsoLater = () => {
  it('divs', () => { expect(div(4, 2)).toBe(2); });
};`;
    expect(countTests(src, 'a.test.ts').min).toBe(1);
  });

  it('a function called from the top level or a describe callback is live (control)', () => {
    const src = `
function cases() {
  it('subs', () => { expect(sub(1, 1)).toBe(0); });
  it('muls', () => { expect(mul(2, 2)).toBe(4); });
}
describe('calc', () => {
  cases();
});
const more = () => { it('divs', () => { expect(div(4, 2)).toBe(2); }); };
more();
(function () { it('iife', () => { expect(1).toBe(1); }); })();`;
    expect(countTests(src, 'a.test.ts').min).toBe(4);
  });

  it('a helper that IS called from a test keeps its body live, and the test counts (control)', () => {
    const src = `
function checkAdd() { expect(add(1, 1)).toBe(2); }
it('adds', () => { checkAdd(); });
it('adds by reference', checkAdd);`;
    expect(countTests(src, 'a.test.ts').min).toBe(2);
    expect(countTests(src, 'a.test.ts', true).min).toBe(2);
  });

  it('a hoisted function declared after a return is still live when called before it (control)', () => {
    const src = `
describe('calc', () => {
  cases();
  return;
  function cases() { it('adds', () => { expect(add(1, 1)).toBe(2); }); }
});`;
    expect(countTests(src, 'a.test.ts').min).toBe(1);
  });

  it('an environment-guarded block stays counted (control)', () => {
    const src = `
if (process.env.CI) {
  it('adds', () => { expect(add(1, 1)).toBe(2); });
}
if (!process.env.SKIP_SLOW) {
  it('slow', () => { expect(slow()).toBe(1); });
}
it('subs', () => { expect(sub(1, 1)).toBe(0); });`;
    expect(countTests(src, 'a.test.ts').min).toBe(3);
  });

  it('a test whose own body returns early is still a test (that is test-content-removal)', () => {
    const src = `it('adds', () => { return; expect(add(1, 1)).toBe(2); });`;
    expect(countTests(src, 'a.test.ts').min).toBe(1);
  });
});

describe('test-deletion fires when tests are made unreachable (#431)', () => {
  it('if (false) around two of three tests', () => {
    const after = `
describe('calc', () => {
  it('adds', () => { expect(add(1, 1)).toBe(2); });
  if (false) {
    it('subs', () => { expect(sub(1, 1)).toBe(0); });
    it('muls', () => { expect(mul(2, 2)).toBe(4); });
  }
});`;
    expect(deletion(THREE, after)).toEqual(['test-deletion[block]']);
  });

  it('an early return in the describe callback', () => {
    const after = `
describe('calc', () => {
  it('adds', () => { expect(add(1, 1)).toBe(2); });
  return;
  it('subs', () => { expect(sub(1, 1)).toBe(0); });
  it('muls', () => { expect(mul(2, 2)).toBe(4); });
});`;
    expect(deletion(THREE, after)).toEqual(['test-deletion[block]']);
  });

  it('tests moved into an uncalled function', () => {
    const after = `
describe('calc', () => {
  it('adds', () => { expect(add(1, 1)).toBe(2); });
  function later() {
    it('subs', () => { expect(sub(1, 1)).toBe(0); });
    it('muls', () => { expect(mul(2, 2)).toBe(4); });
  }
});`;
    expect(deletion(THREE, after)).toEqual(['test-deletion[block]']);
  });

  it('tests moved into a helper that is called stay counted (control)', () => {
    const after = `
describe('calc', () => {
  it('adds', () => { expect(add(1, 1)).toBe(2); });
  function rest() {
    it('subs', () => { expect(sub(1, 1)).toBe(0); });
    it('muls', () => { expect(mul(2, 2)).toBe(4); });
  }
  rest();
});`;
    expect(deletion(THREE, after)).toEqual([]);
    expect(removal(THREE, after)).toEqual([]);
  });

  it('a CI guard added around tests stays green (control)', () => {
    const after = `
describe('calc', () => {
  it('adds', () => { expect(add(1, 1)).toBe(2); });
  if (process.env.CI) {
    it('subs', () => { expect(sub(1, 1)).toBe(0); });
    it('muls', () => { expect(mul(2, 2)).toBe(4); });
  }
});`;
    expect(deletion(THREE, after)).toEqual([]);
  });
});

describe('test-content-removal: content hidden in a string, a template literal or a dead branch (#431)', () => {
  const BODY = `
it('totals', () => {
  const r = compute(order);
  expect(r.total).toBe(42);
  expect(r.tax).toBe(4.2);
  expect(r.lines).toHaveLength(3);
});`;

  it('three assertions moved into a template literal', () => {
    const after = `
it('totals', () => {
  const r = compute(order);
  const _pending = \`
    expect(r.total).toBe(42);
    expect(r.tax).toBe(4.2);
    expect(r.lines).toHaveLength(3);
  \`;
});`;
    expect(removal(BODY, after)).toEqual(['test-content-removal[block]']);
  });

  it('three assertions moved into a single-line string', () => {
    const after = `
it('totals', () => {
  const r = compute(order);
  const _pending = "expect(r.total).toBe(42);\\n expect(r.tax).toBe(4.2);\\n expect(r.lines).toHaveLength(3);";
});`;
    expect(removal(BODY, after)).toEqual(['test-content-removal[block]']);
  });

  it('three assertions wrapped in if (false)', () => {
    const after = `
it('totals', () => {
  const r = compute(order);
  if (false) {
    expect(r.total).toBe(42);
    expect(r.tax).toBe(4.2);
    expect(r.lines).toHaveLength(3);
  }
});`;
    expect(removal(BODY, after)).toEqual(['test-content-removal[block]']);
  });

  it('three assertions after an early return in the test body', () => {
    const after = `
it('totals', () => {
  const r = compute(order);
  return;
  expect(r.total).toBe(42);
  expect(r.tax).toBe(4.2);
  expect(r.lines).toHaveLength(3);
});`;
    expect(removal(BODY, after)).toEqual(['test-content-removal[block]']);
    expect(deletion(BODY, after)).toEqual([]);
  });

  it('the //-commented version of the same edit still blocks (control)', () => {
    const after = `
it('totals', () => {
  const r = compute(order);
  // expect(r.total).toBe(42);
  // expect(r.tax).toBe(4.2);
  // expect(r.lines).toHaveLength(3);
});`;
    expect(removal(BODY, after)).toEqual(['test-content-removal[block]']);
  });

  it('a python test body gutted behind a bare return', () => {
    const before = `
def test_add(self):
    r = add(1, 1)
    assert r == 2
    assert isinstance(r, int)
    assert r != 3
`;
    const after = `
def test_add(self):
    r = add(1, 1)
    return
    assert r == 2
    assert isinstance(r, int)
    assert r != 3
`;
    expect(removal(before, after, 'tests/test_a.py')).toEqual(['test-content-removal[block]']);
  });

  it('an unchanged multi-line template literal fixture is not removed content (control)', () => {
    const before = `
const input = \`
  line one of the fixture text
  line two of the fixture text
  line three of the fixture text
\`;
it('parses', () => {
  expect(parse(input)).toEqual(expected);
  expect(parse(input).length).toBe(3);
});`;
    const after = `
const input = \`
  line one of the fixture text
  line two of the fixture text
  line three of the fixture text
\`;
it('parses', () => {
  expect(parse(input)).toEqual(expected);
});`;
    expect(removal(before, after)).toEqual([]);
  });

  it('joining a multi-line call with string arguments onto one line is still a reformat (control)', () => {
    const before = `
it('throws', () => {
  throws(
    "unclosed attribute at end of input",
    "a[href",
    "Expected a closing square bracket one.",
  );
  throws(
    "unclosed attribute with value at end of input",
    "a[href=x",
    "Expected a closing square bracket two.",
  );
});`;
    const after = `
it('throws', () => {
  throws("unclosed attribute at end of input", "a[href", "Expected a closing square bracket one.");
  throws("unclosed attribute with value at end of input", "a[href=x", "Expected a closing square bracket two.");
});`;
    expect(removal(before, after)).toEqual([]);
  });
});

describe('pytest: a def test_ inside a class that lost its Test prefix is removed (#431)', () => {
  const before = `
class TestMath:
    def test_add(self):
        assert add(1, 1) == 2

    def test_sub(self):
        assert sub(1, 1) == 0
`;

  it('counts the class-bound tests only under a Test* class', () => {
    expect(countTests(before, 'tests/test_math.py').min).toBe(2);
    expect(countTests(before.replace('class TestMath:', 'class MathTests:'), 'tests/test_math.py').min).toBe(0);
  });

  it('the rename is a test-deletion finding', () => {
    const after = before.replace('class TestMath:', 'class MathTests:');
    expect(deletion(before, after, 'tests/test_math.py')).toEqual(['test-deletion[block]']);
  });

  it('a rename that keeps the Test prefix stays green (control)', () => {
    const after = before.replace('class TestMath:', 'class TestArithmetic:');
    expect(deletion(before, after, 'tests/test_math.py')).toEqual([]);
  });

  it('a unittest.TestCase subclass is collected whatever its name (control)', () => {
    const src = `
import unittest

class MathTests(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(1, 1), 2)
`;
    expect(countTests(src, 'tests/test_math.py').min).toBe(1);
  });

  it('a module-level def test_ after a non-test class is still counted (control)', () => {
    const src = `
class Helper:
    def test_helper_only(self):
        return 1

def test_add():
    assert add(1, 1) == 2
`;
    expect(countTests(src, 'tests/test_math.py').min).toBe(1);
  });
});

describe('test-skip: collection-time and configuration-time skips (#431)', () => {
  it('Go TestMain without m.Run() runs no test', () => {
    expect(skip('a_test.go', 'func TestMain(m *testing.M) {', '\tos.Exit(0)', '}')).toEqual(['test-skip[block]']);
  });

  it('Go TestMain that calls m.Run() is set-up (control)', () => {
    expect(skip('a_test.go', 'func TestMain(m *testing.M) {', '\tsetup()', '\tos.Exit(m.Run())', '}')).toEqual([]);
  });

  it.each(['//go:build never', '//go:build integration', '// +build never', '//go:build !ci'])(
    'any build constraint added to a _test.go excludes it from the default run: %s',
    (line) => {
      expect(skip('pkg/a_test.go', line)).toEqual(['test-skip[block]']);
    },
  );

  it('a build constraint on a non-test Go file is not this rule (control)', () => {
    expect(skip('pkg/a.go', '//go:build never')).toEqual([]);
  });

  it.each([
    ['#[cfg(all(test, feature = "never"))]', 'mod tests {'],
    ['#[cfg(feature = "never")]', '#[test]'],
    ['#[cfg(not(test))]', 'fn adds() {'],
  ])('Rust %s on %s', (attr, next) => {
    expect(skip('tests/a.rs', attr, next)).toEqual(['test-skip[block]']);
  });

  it('Rust #[cfg(test)] on the test module is the idiom (control)', () => {
    expect(skip('tests/a.rs', '#[cfg(test)]', 'mod tests {')).toEqual([]);
  });

  it.each([
    '  @EnabledIfEnvironmentVariable(named = "NEVER", matches = "1")',
    '  @EnabledIfSystemProperty(named = "run.slow", matches = "true")',
    '  @EnabledIf("neverTrue")',
    '  @DisabledIf("alwaysTrue")',
    '  @org.junit.jupiter.api.condition.DisabledIfEnvironmentVariable(named = "CI", matches = ".*")',
  ])('JUnit conditional execution: %s', (line) => {
    expect(skip('src/test/java/CalcTest.java', line, '  @Test void adds() {}')).toEqual(['test-skip[block]']);
    expect(skip('src/test/kotlin/CalcTest.kt', line, '  @Test fun adds() {}')).toEqual(['test-skip[block]']);
  });

  it.each([
    "  it 'adds', if: false do",
    '  it "adds", unless: true do',
    "  it 'adds', :if => false do",
    "  describe 'calc', if: false do",
  ])('RSpec conditional metadata: %s', (line) => {
    expect(skip('spec/calc_spec.rb', line)).toEqual(['test-skip[block]']);
  });

  it.each(["  it 'adds', if: ENV['RUN_SLOW'] do", "  it 'adds', :aggregate_failures do"])('RSpec metadata that is not a constant skip (control): %s', (line) => {
    expect(skip('spec/calc_spec.rb', line)).toEqual([]);
  });
});
