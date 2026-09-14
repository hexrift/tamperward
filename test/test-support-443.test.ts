// #443: a `tests`-category match that is not spec-shaped — a helper, a setup
// module, a JSON fixture — carries no test the block rules could be protecting.
// Deleting `src/test/helpers.ts`, trimming the mock list in `src/test/setup.ts`,
// or shortening `src/__tests__/fixtures/data.json` used to be `test-deletion` /
// `test-content-removal` BLOCKs. The class is routed to `test-support`, a warn:
// a review prompt, not a gate. A real spec under the same globs is untouched.

import { describe, expect, it } from 'vitest';
import { testDeletion } from '../src/detectors/test-deletion';
import { testContentRemoval } from '../src/detectors/test-content-removal';
import { testSupport } from '../src/detectors/test-support';
import { isSpecShaped } from '../src/detectors/spec-shape';
import { allDetectors } from '../src/detectors';
import { evaluate } from '../src/engine';
import { defaultPolicy } from '../src/policy';
import type { Change, FileChange, FileOp } from '../src/types';

const P = defaultPolicy();

function file(path: string, op: FileOp, before: string | null, after: string | null, oldPath: string | null = null): FileChange {
  return { kind: 'file', path, oldPath, op, before, after, binary: false, hunks: [] };
}
const del = (path: string, before: string) => file(path, 'delete', before, null);
const mod = (path: string, before: string, after: string) => file(path, 'modify', before, after);

const rulesOf = (changes: Change[]) => evaluate(changes, P, allDetectors, 'staged').map((f) => `${f.rule}:${f.severity}`);

// --- the three fixtures from the issue ------------------------------------

const HELPERS = `import { vi } from 'vitest';
import type { User } from '../types';

export function makeUser(overrides: Partial<User> = {}): User {
  return { id: 'u1', name: 'Ada', role: 'admin', ...overrides };
}

export function stubClock(now: number): void {
  vi.useFakeTimers();
  vi.setSystemTime(now);
}
`;

const SETUP_BEFORE = `import { vi, afterEach } from 'vitest';

vi.mock('../src/logger', () => ({ log: vi.fn(), warn: vi.fn() }));
vi.mock('../src/metrics', () => ({ record: vi.fn() }));
vi.mock('../src/telemetry', () => ({ emit: vi.fn(), flush: vi.fn() }));
vi.mock('../src/feature-flags', () => ({ isEnabled: () => true }));
vi.mock('../src/clock', () => ({ now: () => 1700000000000 }));

afterEach(() => {
  vi.clearAllMocks();
});
`;
const SETUP_AFTER = `import { vi, afterEach } from 'vitest';

vi.mock('../src/logger', () => ({ log: vi.fn(), warn: vi.fn() }));
vi.mock('../src/clock', () => ({ now: () => 1700000000000 }));

afterEach(() => {
  vi.clearAllMocks();
});
`;

const DATA_BEFORE = `[
  { "input": "/path/to/.config.json", "expected": "application/json" },
  { "input": "CARRIAGERETURN.png", "expected": "image/png" },
  { "input": "LINEFEED.png", "expected": "image/png" },
  { "input": "PARAGRAPH.png", "expected": "image/png" }
]
`;
const DATA_AFTER = `[
  { "input": "/path/to/.config.json", "expected": "application/json" }
]
`;

// --- controls: real specs under the same globs ----------------------------

const SPEC = `import { test, expect } from 'vitest';
test('adds two numbers correctly together', () => {
  const result = addNumbers(2, 3);
  expect(result).toStrictEqual(5);
});
test('rejects a negative input value cleanly', () => {
  expect(() => addNumbers(-1, 2)).toThrowError('negative');
});
`;
const SPEC_GUTTED = `import { test, expect } from 'vitest';
test('adds two numbers correctly together', () => {
  expect(true).toBe(true);
});
test('rejects a negative input value cleanly', () => {
  expect(true).toBe(true);
});
`;

describe('#443 the three fixtures are test-support warns, not spec-rule blocks', () => {
  it('deleting src/test/helpers.ts is not a deleted test file', () => {
    const changes = [del('src/test/helpers.ts', HELPERS)];
    expect(testDeletion.run(changes, P)).toHaveLength(0);
    const rules = rulesOf(changes);
    expect(rules).toEqual(['test-support:warn']);
  });

  it('trimming the mock list in src/test/setup.ts (5 → 2 vi.mock) is not removed test content', () => {
    const changes = [mod('src/test/setup.ts', SETUP_BEFORE, SETUP_AFTER)];
    expect(testContentRemoval.run(changes, P)).toHaveLength(0);
    expect(testDeletion.run(changes, P)).toHaveLength(0);
    expect(rulesOf(changes)).toEqual(['test-support:warn']);
  });

  it('shortening src/__tests__/fixtures/data.json (4 cases → 1) is not removed test content', () => {
    const changes = [mod('src/__tests__/fixtures/data.json', DATA_BEFORE, DATA_AFTER)];
    expect(testContentRemoval.run(changes, P)).toHaveLength(0);
    expect(rulesOf(changes)).toEqual(['test-support:warn']);
  });

  it('every finding of the class carries the test-support id and a warn severity', () => {
    const findings = evaluate(
      [del('src/test/helpers.ts', HELPERS), mod('src/test/setup.ts', SETUP_BEFORE, SETUP_AFTER), mod('src/__tests__/fixtures/data.json', DATA_BEFORE, DATA_AFTER)],
      P,
      allDetectors,
      'staged',
    );
    expect(findings).toHaveLength(3);
    for (const f of findings) {
      expect(f.rule).toBe('test-support');
      expect(f.severity).toBe('warn');
      expect(f.signoff.required).toBe(false);
    }
  });
});

describe('#443 controls: a real spec under src/test/ or __tests__/ is still blocked', () => {
  it('deleting src/test/foo.test.ts still blocks as test-deletion', () => {
    const changes = [del('src/test/foo.test.ts', SPEC)];
    expect(testDeletion.run(changes, P).map((f) => f.severity)).toEqual(['block']);
    expect(rulesOf(changes)).toEqual(['test-deletion:block']);
  });

  it('deleting an unsuffixed file under src/test/ that DEFINES tests still blocks', () => {
    // Maven layout with a JS runner pointed at src/test/**: the file has it() blocks
    const changes = [del('src/test/calc.js', SPEC)];
    expect(rulesOf(changes)).toEqual(['test-deletion:block']);
  });

  it('deleting src/__tests__/calc.ts (jest testMatch runs it; it defines tests) still blocks', () => {
    expect(rulesOf([del('src/__tests__/calc.ts', SPEC)])).toEqual(['test-deletion:block']);
  });

  it('gutting src/test/foo.test.ts still blocks as test-content-removal', () => {
    const changes = [mod('src/test/foo.test.ts', SPEC, SPEC_GUTTED)];
    expect(testContentRemoval.run(changes, P).map((f) => f.severity)).toEqual(['block']);
    expect(rulesOf(changes)).toEqual(['test-content-removal:block']);
  });

  it('removing test blocks from an unsuffixed spec under __tests__/ still blocks', () => {
    const one = `import { test, expect } from 'vitest';
test('adds two numbers correctly together', () => {
  const result = addNumbers(2, 3);
  expect(result).toStrictEqual(5);
});
`;
    expect(rulesOf([mod('src/__tests__/calc.ts', SPEC, one)])).toEqual(['test-deletion:block']);
  });

  it('a JUnit class under src/test/ with @Test methods still blocks on deletion', () => {
    const java = `package app;
import org.junit.jupiter.api.Test;
class CalcTest {
  @Test void adds() { assertEquals(4, Calc.add(2, 2)); }
  @Test void subtracts() { assertEquals(0, Calc.sub(2, 2)); }
}
`;
    expect(rulesOf([del('src/test/java/app/CalcTest.java', java)])).toEqual(['test-deletion:block']);
  });

  it('conftest.py is named by the policy and stays a spec-rule file', () => {
    const conftest = `import pytest

@pytest.fixture(autouse=True)
def isolated_settings(settings):
    settings.DEBUG = False
    yield settings
`;
    expect(rulesOf([del('tests/conftest.py', conftest)])).toEqual(['test-deletion:block']);
  });

  it('a spec renamed into __tests__/fixtures/ keeps its suffix and is still a spec', () => {
    // jest's default testMatch opens `**/__tests__/**/*.ts`; the file still runs
    const changes = [file('src/__tests__/fixtures/a.test.ts', 'rename', SPEC, SPEC, 'src/__tests__/a.test.ts')];
    expect(testDeletion.run(changes, P)).toHaveLength(0);
    expect(rulesOf(changes)).toEqual([]);
  });

  it('a spec whose content the gate cannot read is a spec (fail closed)', () => {
    const changes: Change[] = [file('src/test/helpers.ts', 'delete', null, null)];
    expect(rulesOf(changes)).toEqual(['test-deletion:block']);
  });
});

describe('#443 isSpecShaped', () => {
  it.each([
    'a.test.ts',
    'src/test/foo.spec.tsx',
    'pkg/x_test.go',
    'tests/test_x.py',
    'tests/x_test.py',
    'tests/conftest.py',
    'src/test/java/CalcTest.java',
    'spec/models/user_spec.rb',
    'test/user_test.rb',
    'tests/Unit/CalcTest.php',
    'Calc.Tests/CalcTests.cs',
    'tests/integration.rs',
  ])('%s is spec-shaped by suffix, whatever its content', (p) => {
    expect(isSpecShaped(p, 'nothing here', null)).toBe(true);
  });

  it.each([
    'src/__tests__/fixtures/data.json',
    'src/__tests__/__fixtures__/input.ts',
    'src/__tests__/__mocks__/fs.ts',
    'src/__tests__/__snapshots__/a.ts.snap',
    'src/test/fixtures/cases.ts',
  ])('%s is a support file by directory', (p) => {
    expect(isSpecShaped(p, SPEC, SPEC)).toBe(false);
  });

  it.each(['src/__tests__/data.json', 'src/__tests__/schema.yaml', 'src/test/resources/app.properties', 'src/__tests__/README.md'])(
    '%s is a support file: no language the pattern rules read',
    (p) => expect(isSpecShaped(p, 'x', 'y')).toBe(false),
  );

  it('an unsuffixed code file with no test on either side is support', () => {
    expect(isSpecShaped('src/test/helpers.ts', HELPERS, null)).toBe(false);
    expect(isSpecShaped('src/test/setup.ts', SETUP_BEFORE, SETUP_AFTER)).toBe(false);
  });

  it('an unsuffixed code file with a test on either side is a spec', () => {
    expect(isSpecShaped('src/test/calc.js', SPEC, null)).toBe(true);
    expect(isSpecShaped('src/__tests__/calc.ts', HELPERS, SPEC)).toBe(true);
    expect(isSpecShaped('src/__tests__/calc.ts', SPEC, HELPERS)).toBe(true);
  });

  it('unknown content fails closed', () => {
    expect(isSpecShaped('src/test/helpers.ts', null, null)).toBe(true);
  });
});

describe('#443 the test-support detector', () => {
  it('reports a deleted support file as a warn with the file named', () => {
    const f = testSupport.run([del('src/test/helpers.ts', HELPERS)], P);
    expect(f).toHaveLength(1);
    expect(f[0].rule).toBe('test-support');
    expect(f[0].severity).toBe('warn');
    expect(f[0].file).toBe('src/test/helpers.ts');
  });

  it('reports a support file renamed out of the tests glob', () => {
    const f = testSupport.run([file('src/helpers.ts', 'rename', HELPERS, HELPERS, 'src/test/helpers.ts')], P);
    expect(f).toHaveLength(1);
    expect(f[0].message).toMatch(/renamed out/);
  });

  it('reports net removal of at least three significant lines from a support file', () => {
    expect(testSupport.run([mod('src/test/setup.ts', SETUP_BEFORE, SETUP_AFTER)], P)).toHaveLength(1);
    expect(testSupport.run([mod('src/__tests__/fixtures/data.json', DATA_BEFORE, DATA_AFTER)], P)).toHaveLength(1);
  });

  it('stays silent on a small edit, an addition, and content moved elsewhere in the change', () => {
    const oneLess = SETUP_BEFORE.replace("vi.mock('../src/metrics', () => ({ record: vi.fn() }));\n", '');
    expect(testSupport.run([mod('src/test/setup.ts', SETUP_BEFORE, oneLess)], P)).toHaveLength(0);
    expect(testSupport.run([file('src/test/helpers.ts', 'add', null, HELPERS)], P)).toHaveLength(0);
    const moved = [mod('src/test/setup.ts', SETUP_BEFORE, SETUP_AFTER), file('src/test/mocks.ts', 'add', null, SETUP_BEFORE)];
    expect(testSupport.run(moved, P)).toHaveLength(0);
  });

  it('never speaks for a spec, a snapshot, or a file outside the tests globs', () => {
    expect(testSupport.run([del('src/test/foo.test.ts', SPEC)], P)).toHaveLength(0);
    expect(testSupport.run([del('src/__tests__/__snapshots__/a.test.ts.snap', 'exports[`a 1`] = `x`;\n')], P)).toHaveLength(0);
    expect(testSupport.run([del('src/helpers.ts', HELPERS)], P)).toHaveLength(0);
  });

  it('is a registered warn rule that policy can disable without touching the spec rules', () => {
    expect(P.rules['test-support']?.severity).toBe('warn');
    expect(allDetectors.map((d) => d.id)).toContain('test-support');
    const p = defaultPolicy();
    p.rules['test-support'] = { severity: 'warn', enabled: false };
    expect(evaluate([del('src/test/helpers.ts', HELPERS)], p, allDetectors, 'staged')).toHaveLength(0);
    expect(evaluate([del('src/test/foo.test.ts', SPEC)], p, allDetectors, 'staged').map((f) => f.rule)).toEqual(['test-deletion']);
  });
});
