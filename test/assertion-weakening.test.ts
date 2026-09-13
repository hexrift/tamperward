import { describe, expect, it } from 'vitest';
import { assertionWeakening } from '../src/detectors/assertion-weakening';
import { defaultPolicy } from '../src/policy';
import type { Change, FileChange } from '../src/types';

const P = defaultPolicy();

function file(before: string, after: string, path = 'test/value.test.ts'): FileChange {
  return {
    kind: 'file',
    path,
    oldPath: null,
    op: 'modify',
    before,
    after,
    binary: false,
    hunks: [],
  };
}

const run = (before: string, after: string, path?: string) =>
  assertionWeakening.run([file(before, after, path)], P);

describe('assertion-weakening AST detector (#323): one-way weakening signals', () => {
  it('warns when exact equality becomes truthiness on the same subject', () => {
    const findings = run(
      `it('value', () => { expect(result.value).toBe(42); });`,
      `it('value', () => { expect(result.value).toBeTruthy(); });`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'assertion-weakening', severity: 'warn' });
    expect(findings[0].message).toMatch(/toBe.*toBeTruthy/i);
  });

  it('warns when structural equality becomes merely defined', () => {
    expect(
      run(
        `test('shape', () => { expect(build()).toEqual({ ok: true, count: 3 }); });`,
        `test('shape', () => { expect(build()).toBeDefined(); });`,
      ),
    ).toHaveLength(1);
  });

  it('warns when exception-message specificity is removed', () => {
    const findings = run(
      `it('throws', () => { expect(() => parse('!')).toThrow(/invalid token/); });`,
      `it('throws', () => { expect(() => parse('!')).toThrow(); });`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toMatch(/exception.*specific/i);
  });

  it('warns when an assertion disappears from a kept named test', () => {
    const findings = run(
      `it('pair', () => {
        expect(pair.left).toBe(1);
        expect(pair.right).toBe(2);
      });`,
      `it('pair', () => {
        expect(pair.left).toBe(1);
      });`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toMatch(/assertion.*removed/i);
  });

  it('reports at most one finding per test block even with multiple weakenings', () => {
    expect(
      run(
        `it('many', () => {
          expect(a).toBe(1);
          expect(b).toEqual({ x: 2 });
          expect(() => f()).toThrow('boom');
        });`,
        `it('many', () => {
          expect(a).toBeTruthy();
          expect(b).toBeDefined();
          expect(() => f()).toThrow();
        });`,
      ),
    ).toHaveLength(1);
  });
});

describe('assertion-weakening AST detector (#323): precision negatives', () => {
  it('does not call literal-to-literal expectation correction a weakening', () => {
    expect(
      run(
        `it('percentile', () => { expect(percentile([1,2,3], .75)).toBe(2); });`,
        `it('percentile', () => { expect(percentile([1,2,3], .75)).toBe(2.5); });`,
      ),
    ).toHaveLength(0);
  });

  it('does not flag a stronger matcher migration to strict equality', () => {
    expect(
      run(
        `it('value', () => { expect(value).toEqual({ x: 1 }); });`,
        `it('value', () => { expect(value).toStrictEqual({ x: 1 }); });`,
      ),
    ).toHaveLength(0);
  });

  it('does not flag message assertions migrated to snapshots', () => {
    expect(
      run(
        `it('throws', () => { expect(() => parse('!')).toThrow('invalid token'); });`,
        `it('throws', () => { expect(() => parse('!')).toThrowErrorMatchingSnapshot(); });`,
      ),
    ).toHaveLength(0);
  });

  it('does not flag assertion relocation when the same assertion survives in the same test', () => {
    expect(
      run(
        `it('value', () => {
          const value = make();
          expect(value).toBe(42);
          cleanup();
        });`,
        `it('value', () => {
          const value = make();
          cleanup();
          expect(value).toBe(42);
        });`,
      ),
    ).toHaveLength(0);
  });

  it('does not flag a renamed test whose assertions are unchanged', () => {
    expect(
      run(
        `it('old wording', () => { expect(value).toBe(42); });`,
        `it('clearer wording', () => { expect(value).toBe(42); });`,
      ),
    ).toHaveLength(0);
  });

  it('does not call opposite false -> truthy a weakening', () => {
    expect(
      run(
        `it('flag', () => { expect(flag).toBe(false); });`,
        `it('flag', () => { expect(flag).toBeTruthy(); });`,
      ),
    ).toHaveLength(0);
  });

  it('does not call undefined -> defined a weakening', () => {
    expect(
      run(
        `it('missing', () => { expect(value).toBe(undefined); });`,
        `it('missing', () => { expect(value).toBeDefined(); });`,
      ),
    ).toHaveLength(0);
  });

  it('does not invert throw specificity under .not', () => {
    expect(
      run(
        `it('throws', () => { expect(() => parse('!')).not.toThrow(/boom/); });`,
        `it('throws', () => { expect(() => parse('!')).not.toThrow(); });`,
      ),
    ).toHaveLength(0);
  });

  it('still warns when a statically truthy exact value becomes truthiness', () => {
    expect(
      run(
        `it('flag', () => { expect(flag).toBe(true); });`,
        `it('flag', () => { expect(flag).toBeTruthy(); });`,
      ),
    ).toHaveLength(1);
  });

  it('still warns when a statically defined exact value becomes definedness', () => {
    expect(
      run(
        `it('nil', () => { expect(value).toBe(null); });`,
        `it('nil', () => { expect(value).toBeDefined(); });`,
      ),
    ).toHaveLength(1);
  });

  it('pairs tests by suite ancestry rather than duplicate title order', () => {
    expect(
      run(
        `describe('alpha', () => { it('same', () => { expect(value).toBe(1); }); });
         describe('beta', () => { it('same', () => { expect(value).toBeTruthy(); }); });`,
        `describe('beta', () => { it('same', () => { expect(value).toBeTruthy(); }); });
         describe('alpha', () => { it('same', () => { expect(value).toBe(1); }); });`,
      ),
    ).toHaveLength(0);
  });

  it('declines ambiguous duplicate identities instead of pairing by index', () => {
    expect(
      run(
        `describe('same-suite', () => {
           it('dup', () => { expect(value).toBe(1); });
           it('dup', () => { expect(value).toBeTruthy(); });
         });`,
        `describe('same-suite', () => {
           it('dup', () => { expect(value).toBeTruthy(); });
           it('dup', () => { expect(value).toBe(1); });
         });`,
      ),
    ).toHaveLength(0);
  });

  it.each([
    ['test/value.test.js', `const n = 1;`],
    ['test/value.test.jsx', `const el = <div />;`],
    ['test/value.test.ts', `const n: number = 1;`],
    ['test/value.test.tsx', `const el: JSX.Element = <div />;`],
    ['test/value.test.mts', `const n: number = 1;`],
    ['test/value.test.cts', `const n: number = 1;`],
  ])('parses the protected JS/TS extension correctly: %s', (path, prefix) => {
    expect(
      run(
        `${prefix}\nit('value', () => { expect(value).toBe(42); });`,
        `${prefix}\nit('value', () => { expect(value).toBeTruthy(); });`,
        path,
      ),
    ).toHaveLength(1);
  });

  it('does not inspect non-test source even if it contains expect-shaped calls', () => {
    expect(
      run(
        `export const x = expect(value).toBe(42);`,
        `export const x = expect(value).toBeTruthy();`,
        'src/runtime.ts',
      ),
    ).toHaveLength(0);
  });

  it('fails silent when full before/after content is unavailable', () => {
    const change: Change = {
      kind: 'file',
      path: 'test/value.test.ts',
      oldPath: null,
      op: 'modify',
      before: null,
      after: null,
      binary: false,
      hunks: [],
    };
    expect(assertionWeakening.run([change], P)).toEqual([]);
  });
});
