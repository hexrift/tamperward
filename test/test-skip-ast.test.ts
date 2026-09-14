import { describe, expect, it } from 'vitest';
import { defaultPolicy } from '../src/policy';
import { testSkip } from '../src/detectors/test-skip';
import type { FileChange, Hunk } from '../src/types';

const P = defaultPolicy();

function addedFile(path: string, source: string): FileChange {
  const lines = source.split('\n');
  const hunk: Hunk = {
    oldStart: 1,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    lines: lines.map((content, i) => ({
      type: 'add' as const,
      content,
      oldLine: null,
      newLine: i + 1,
    })),
  };
  return {
    kind: 'file',
    path,
    oldPath: null,
    op: 'add',
    before: null,
    after: source,
    binary: false,
    hunks: [hunk],
  };
}

function modifiedFile(
  path: string,
  before: string,
  after: string,
  addedLineNumbers: number[],
): FileChange {
  const afterLines = after.split('\n');
  const added = new Set(addedLineNumbers);
  const hunk: Hunk = {
    oldStart: 1,
    oldLines: before.split('\n').length,
    newStart: 1,
    newLines: afterLines.length,
    lines: afterLines.map((content, i) => ({
      type: added.has(i + 1) ? ('add' as const) : ('context' as const),
      content,
      oldLine: added.has(i + 1) ? null : i + 1,
      newLine: i + 1,
    })),
  };
  return {
    kind: 'file',
    path,
    oldPath: null,
    op: 'modify',
    before,
    after,
    binary: false,
    hunks: [hunk],
  };
}

const findings = (c: FileChange) => testSkip.run([c], P);

describe('test-skip AST semantics (#330)', () => {
  it('finds a skip modifier split across physical lines', () => {
    const f = findings(addedFile('src/a.spec.ts', [
      'test',
      '  .skip("x", () => {});',
    ].join('\n')));
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(2);
  });

  it('resolves statically computable bracket properties', () => {
    const f = findings(addedFile('src/a.spec.ts', [
      "const mode = 'sk' + 'ip';",
      "test[mode]('x', () => {});",
    ].join('\n')));
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(2);
  });

  it('resolves imported aliases from known test APIs', () => {
    const f = findings(addedFile('src/a.spec.ts', [
      "import { test as check } from 'vitest';",
      "check.only('x', () => {});",
    ].join('\n')));
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(2);
  });

  it('resolves destructured node:test aliases and option-object skip/focus', () => {
    const skip = findings(addedFile('src/a.test.ts', [
      "const { test: check } = require('node:test');",
      "check('x', { skip: process.env.CI }, () => {});",
    ].join('\n')));
    expect(skip).toHaveLength(1);
    expect(skip[0].line).toBe(2);

    const focus = findings(addedFile('src/b.test.ts', [
      "import { test as check } from 'node:test';",
      "check('x', { only: true }, () => {});",
    ].join('\n')));
    expect(focus).toHaveLength(1);
    expect(focus[0].line).toBe(2);
  });

  it('does not guess dynamic computed properties', () => {
    const f = findings(addedFile('src/a.spec.ts', [
      'const mode = getMode();',
      "test[mode]('x', () => {});",
    ].join('\n')));
    expect(f).toHaveLength(0);
  });

  it('does not re-report an unchanged existing skip when another line changes', () => {
    const before = [
      "test.skip('existing', () => {});",
      'const n = 1;',
    ].join('\n');
    const after = [
      "test.skip('existing', () => {});",
      'const n = 2;',
    ].join('\n');
    expect(findings(modifiedFile('src/a.spec.ts', before, after, [2]))).toHaveLength(0);
  });

  it('does not resolve a shadowed computed-property identifier to a top-level const', () => {
    const f = findings(addedFile('src/a.spec.ts', [
      "const mode = 'skip';",
      'function helper(mode: string) {',
      "  test[mode]('x', () => {});",
      '}',
    ].join('\n')));
    expect(f).toHaveLength(0);
  });

  it('does not resolve shadowed imported or implicit runner names', () => {
    const imported = findings(addedFile('src/a.spec.ts', [
      "import { test as check } from 'vitest';",
      'function helper(check: SomeOtherApi) {',
      "  check.only('x');",
      '}',
    ].join('\n')));
    expect(imported).toHaveLength(0);

    const implicit = findings(addedFile('src/b.spec.ts', [
      'function helper(test: SomeOtherApi) {',
      "  test.only('x');",
      '}',
    ].join('\n')));
    expect(implicit).toHaveLength(0);
  });

  it('attributes a newly-static skip to the changed binding when the call site is unchanged', () => {
    const before = [
      "const mode = 'concurrent';",
      "test[mode]('x', () => {});",
    ].join('\n');
    const after = [
      "const mode = 'skip';",
      "test[mode]('x', () => {});",
    ].join('\n');
    const f = findings(modifiedFile('src/a.spec.ts', before, after, [1]));
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(1);
  });

  it('attributes a newly-resolved runner alias to the changed import when the call site is unchanged', () => {
    const before = [
      "import { test as check } from './helper';",
      "check.only('x', () => {});",
    ].join('\n');
    const after = [
      "import { test as check } from 'vitest';",
      "check.only('x', () => {});",
    ].join('\n');
    const f = findings(modifiedFile('src/a.spec.ts', before, after, [1]));
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(1);
  });

  it('does not re-block a pre-existing imported focus for formatting-only edits', () => {
    const before = [
      "import { test as check } from 'vitest';",
      "check.only('x', () => {});",
    ].join('\n');
    const after = [
      "import { test as check } from 'vitest';",
      'check',
      "  .only('x', () => {});",
    ].join('\n');

    expect(findings(modifiedFile('src/a.spec.ts', before, after, [2, 3]))).toHaveLength(0);
  });

  it('does not block shorthand skip/only options whose bound value is statically false', () => {
    const f = findings(addedFile('src/a.spec.ts', [
      'const skip = false;',
      'const only = false;',
      "test('x', { skip }, () => {});",
      "test('y', { only }, () => {});",
    ].join('\n')));

    expect(f).toHaveLength(0);
  });

  it('declines AST-only classification when TypeScript reports parse diagnostics', () => {
    const f = findings(addedFile('src/a.spec.ts', [
      "const mode = 'skip';",
      "test[mode]('x', () => {};",
    ].join('\n')));
    expect(f).toHaveLength(0);
  });

  it('keeps diff-only regex fallback without pretending it can resolve AST-only forms', () => {
    const direct = addedFile('src/a.spec.ts', "test.skip('x', () => {});");
    direct.after = null;
    expect(findings(direct)).toHaveLength(1);

    const computed = addedFile('src/b.spec.ts', [
      "const mode = 'skip';",
      "test[mode]('x', () => {});",
    ].join('\n'));
    computed.after = null;
    expect(findings(computed)).toHaveLength(0);
  });
});

// #428: the AST path claimed ownership of every `x.skip(...)` call whose root it
// could not resolve to a known runner module, and in doing so also silenced the
// regex that catches the call on diff-only input. Ownership is now claimed only
// for a proven non-runner; an unknown root falls through to the regex, and the
// runner bindings the Playwright/vitest fixture convention produces are followed.
describe('test-skip AST runner binding (#428)', () => {
  const withFixture = (spec: string, fixtureSource: string, fixturePath = 'e2e/fixtures.ts') =>
    testSkip.run([addedFile('e2e/a.spec.ts', spec)], P, undefined, {
      trackedContents: { [fixturePath]: fixtureSource },
    });

  it('blocks a skip reached through a namespace import of a known runner module', () => {
    const f = findings(addedFile('src/a.spec.ts', [
      "import * as v from 'vitest';",
      "v.it.skip('x', () => {});",
    ].join('\n')));
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(2);
  });

  it('blocks a skip on a runner imported from an unresolvable relative fixture module (regex fallback)', () => {
    const f = findings(addedFile('e2e/a.spec.ts', [
      "import { test } from './fixtures';",
      "test.skip('x', async () => {});",
    ].join('\n')));
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(2);
  });

  it('blocks a skip on `base.extend({})` from @playwright/test and from vitest', () => {
    for (const mod of ['@playwright/test', 'vitest']) {
      const f = findings(addedFile('e2e/a.spec.ts', [
        `import { test as base } from '${mod}';`,
        'const test = base.extend({});',
        "test.skip('x', async () => {});",
      ].join('\n')));
      expect(f, mod).toHaveLength(1);
      expect(f[0].line, mod).toBe(3);
    }
  });

  it('blocks a skip on a generic `base.extend<T>({})` initialiser', () => {
    const f = findings(addedFile('e2e/a.spec.ts', [
      "import { test as base } from '@playwright/test';",
      'const test = base.extend<{ page: unknown }>({});',
      "test.skip('x', async () => {});",
    ].join('\n')));
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(3);
  });

  it('follows `export const test = base.extend(...)` through a relative fixture module', () => {
    const fixture = [
      "import { test as base } from '@playwright/test';",
      'export const test = base.extend<{ user: string }>({ user: async ({}, use) => use("u") });',
      "export { expect } from '@playwright/test';",
    ].join('\n');
    const f = withFixture([
      "import { test, expect } from './fixtures';",
      "test.skip('x', async () => {});",
    ].join('\n'), fixture);
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(2);
    expect(f[0].message).toContain('.skip/.only/.todo');
  });

  it('follows a fixture module supplied by the same change, and a `.js` specifier to a `.ts` file', () => {
    const fixture = addedFile('e2e/fixtures.ts', [
      "import { test as base } from '@playwright/test';",
      'export const test = base.extend({});',
    ].join('\n'));
    const spec = addedFile('e2e/a.spec.ts', [
      "import { test } from './fixtures.js';",
      "test.only('x', async () => {});",
    ].join('\n'));
    const f = testSkip.run([fixture, spec], P);
    expect(f).toHaveLength(1);
    expect(f[0].file).toBe('e2e/a.spec.ts');
    expect(f[0].line).toBe(2);
  });

  it('keeps a fixture-module export that is proven not to be a runner clean', () => {
    const fixture = [
      'export const test = { skip(_name: string, _fn: () => void) {} };',
    ].join('\n');
    const f = withFixture([
      "import { test } from './fixtures';",
      "test.skip('x', () => {});",
    ].join('\n'), fixture);
    expect(f).toHaveLength(0);
  });

  it('keeps a local `function it()` shadow clean', () => {
    const f = findings(addedFile('src/a.spec.ts', [
      'function it(_name: string, _fn: () => void) {}',
      'it.skip = () => {};',
      "it.skip('x', () => {});",
    ].join('\n')));
    expect(f).toHaveLength(0);
  });

  it('keeps a local object shadow of a runner clean', () => {
    const f = findings(addedFile('src/a.spec.ts', [
      'const test = { skip: (_n: string) => {} };',
      "test.skip('x');",
    ].join('\n')));
    expect(f).toHaveLength(0);
  });

  it('resolves `const { it } = require("vitest")` and a destructured relative fixture require', () => {
    const direct = findings(addedFile('src/a.spec.ts', [
      "const { it } = require('vitest');",
      "it.skip('x', () => {});",
    ].join('\n')));
    expect(direct).toHaveLength(1);
    expect(direct[0].line).toBe(2);

    const viaFixture = withFixture([
      "const { it } = require('./fixtures');",
      "it.only('x', () => {});",
    ].join('\n'), "const { it: base } = require('vitest'); module.exports = { it: base.extend({}) };");
    expect(viaFixture).toHaveLength(1);
    expect(viaFixture[0].line).toBe(2);
  });

  it('blocks a chained `test.describe.skip` under Playwright', () => {
    const f = findings(addedFile('e2e/a.spec.ts', [
      "import { test } from '@playwright/test';",
      "test.describe.skip('group', () => {",
      "  test('x', async () => {});",
      '});',
    ].join('\n')));
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(2);
  });

  it('falls through to the regex for a runner whose binding is unknown on the AST', () => {
    const f = findings(addedFile('src/a.spec.ts', [
      "import { test } from 'some-runner-wrapper';",
      "test.skip('x', () => {});",
    ].join('\n')));
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(2);
  });

  it('does not re-report a pre-existing fixture-bound skip when another line changes', () => {
    const before = [
      "import { test } from './fixtures';",
      "test.skip('existing', () => {});",
      'const n = 1;',
    ].join('\n');
    const after = [
      "import { test } from './fixtures';",
      "test.skip('existing', () => {});",
      'const n = 2;',
    ].join('\n');
    expect(findings(modifiedFile('e2e/a.spec.ts', before, after, [3]))).toHaveLength(0);
  });
});
