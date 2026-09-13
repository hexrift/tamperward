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
