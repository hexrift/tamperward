// #440 ts-any-cast — row 4's escapes beyond the literal `any` / `unknown` spellings.
//
// `x as never`, `(x as {}) as T` (and through `object` / `Object`), a local
// `type A = any` alias, a live `@ts-*` directive offset by a removed comment that
// merely MENTIONED one, and the JSDoc `{*}` / `{?}` spellings of `any` all walked
// past the block rule. Each fixture here blocks on the full-content (AST) path AND
// on the diff-only fallback, and the controls beside them stay clean.
import { describe, expect, it } from 'vitest';
import { tsAnyCast } from '../src/detectors/ts-any-cast';
import { tsCastGrowth } from '../src/detectors/ts-cast-growth';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy } from '../src/policy';
import type { Change, FileChange, Finding } from '../src/types';

const P = defaultPolicy();
const change = (path: string, before: string, after: string): FileChange => ({ kind: 'file', path, oldPath: null, op: 'modify', before, after, hunks: [], binary: false });
const content = (before: string, after: string, path = 'src/x.ts'): Finding[] => tsAnyCast.run([change(path, before, after)], P);
const block = (fs: Finding[]) => fs.filter((f) => f.rule === 'ts-any-cast' && f.severity === 'block');
const growth = (before: string, after: string): Finding[] => tsCastGrowth.run([change('src/x.ts', before, after)], P).filter((f) => f.rule === 'ts-cast-growth');
const added = (path: string, ...lines: string[]): Change[] =>
  parseDiff(`diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`);
const diffOnly = (line: string, path = 'src/x.ts'): Finding[] => block(tsAnyCast.run(added(path, line), P));

const BASE = 'export function f(raw: string): unknown {\n  const parsed: unknown = JSON.parse(raw);\n  return parsed;\n}\n';
const withReturn = (expr: string): string => BASE.replace('return parsed;', `return ${expr};`);

describe('ts-any-cast (#440): `as never` and the double cast through {} / object / Object are row 4', () => {
  const laundering = [
    'parsed as never',
    '(parsed as never)',
    '<never>parsed',
    'parsed as (never)',
    'parsed as never as { a: number }',
    '(parsed as {}) as { a: number }',
    'parsed as {} as { a: number }',
    '(parsed as object) as { a: number }',
    '(parsed as Object) as { a: number }',
    '(parsed as ({})) as { a: number }',
    '<{ a: number }>(<{}>parsed)',
    '(<object>parsed) as { a: number }',
    '<{ a: number }>(parsed as never)',
  ];

  it.each(laundering)('full content: `%s` blocks and is not also warned as ordinary growth', (expr) => {
    const after = withReturn(expr);
    expect(block(content(BASE, after))).toHaveLength(1);
    expect(growth(BASE, after)).toHaveLength(0);
  });

  it.each(laundering)('diff-only fallback: `%s` is the same block', (expr) => {
    expect(diffOnly(`const v = ${expr};`)).toHaveLength(1);
    expect(diffOnly(`  ${expr},`), 'partial line').toHaveLength(1);
  });

  it('controls: `as unknown` alone, `as {}` alone, `as object` alone and `satisfies` are not row 4', () => {
    for (const expr of ['parsed as unknown', 'parsed as {}', 'parsed as object', 'parsed as Object', 'parsed as { a: number }', 'parsed satisfies unknown']) {
      expect(block(content(BASE, withReturn(expr))), expr).toHaveLength(0);
      expect(diffOnly(`const v = ${expr};`), expr).toHaveLength(0);
    }
    // `as {}` / `as object` alone stay in the row-18 budget: an ordinary assertion.
    expect(growth(BASE, withReturn('parsed as {}'))).toHaveLength(1);
    expect(growth(BASE, withReturn('parsed as object'))).toHaveLength(1);
  });

  it('controls: the spellings inside a comment or a string are text', () => {
    for (const line of ['// (parsed as never) as T', 'const s = "(parsed as {}) as T";', 'const t = `x as never`;']) {
      expect(block(content(BASE, BASE + line + '\n')), line).toHaveLength(0);
      expect(diffOnly(line), line).toHaveLength(0);
    }
  });

  it('a pre-existing `as never` left untouched does not fire (net delta = 0)', () => {
    const before = withReturn('parsed as never');
    expect(block(content(before, before.replace('raw: string', 'raw: string, _n = 1')))).toHaveLength(0);
  });
});

describe('ts-any-cast (#440): a local type alias of any / never / unknown is resolved within the file', () => {
  it('`type A = any; x as A` is `as any` on the full-content path, and not ordinary growth', () => {
    const after = 'type A = any;\n' + withReturn('parsed as A');
    const before = 'type A = any;\n' + BASE;
    expect(block(content(before, after))).toHaveLength(1);
    expect(growth(before, after)).toHaveLength(0);
  });

  it('the alias may be declared after its use, exported, parenthesised, or reached through another alias', () => {
    for (const decl of ['type A = any;', 'export type A = any;', 'type A = (any);', 'type A = B; type B = any;', 'type B = any; type A = (B);']) {
      const before = BASE + decl + '\n';
      const after = withReturn('parsed as A') + decl + '\n';
      expect(block(content(before, after)), decl).toHaveLength(1);
      expect(growth(before, after), decl).toHaveLength(0);
    }
  });

  it('`type N = never; x as N` and `type U = unknown; (x as U) as T` are the laundering casts', () => {
    for (const [decl, expr] of [
      ['type N = never;', 'parsed as N'],
      ['type N = never;', '<N>parsed'],
      ['type U = unknown;', '(parsed as U) as { a: number }'],
      ['type U = unknown;', 'parsed as U as { a: number }'],
      ['type E = {};', '(parsed as E) as { a: number }'],
      ['type O = object;', '(parsed as O) as { a: number }'],
    ]) {
      const before = decl + '\n' + BASE;
      const after = decl + '\n' + withReturn(expr);
      expect(block(content(before, after)), `${decl} ${expr}`).toHaveLength(1);
      expect(growth(before, after), `${decl} ${expr}`).toHaveLength(0);
    }
  });

  it('controls: an alias of an honest type, a generic alias, an unresolved name and `type U = unknown; x as U` are clean', () => {
    for (const [decl, expr] of [
      ['type U = unknown;', 'parsed as U'],
      ['type R = { a: number };', 'parsed as R'],
      ['type Id<T> = T;', 'parsed as Id<any>'],
      ['', 'parsed as A'],
      ['type A = B;', 'parsed as A'],
      ['type A = B; type B = A;', 'parsed as A'],
    ]) {
      const before = decl + '\n' + BASE;
      const after = decl + '\n' + withReturn(expr);
      expect(block(content(before, after)), `${decl} ${expr}`).toHaveLength(0);
    }
  });

  it('diff-only fallback: an alias declared on the change\'s own added lines is resolved', () => {
    expect(block(tsAnyCast.run(added('src/x.ts', 'type A = any;', 'const v = parsed as A;'), P))).toHaveLength(1);
    expect(block(tsAnyCast.run(added('src/x.ts', 'const v = parsed as A;', 'type A = never;'), P))).toHaveLength(1);
    expect(block(tsAnyCast.run(added('src/x.ts', 'type U = unknown;', 'const v = (parsed as U) as T;'), P))).toHaveLength(1);
    expect(block(tsAnyCast.run(added('src/x.ts', 'type U = unknown;', 'const v = parsed as U;'), P))).toHaveLength(0);
    expect(block(tsAnyCast.run(added('src/x.ts', 'type R = { a: number };', 'const v = parsed as R;'), P))).toHaveLength(0);
  });
});

describe('ts-any-cast (#440): @ts-* directives are counted live, on the comments, outside strings', () => {
  it('removing a comment that merely mentions @ts-ignore does not offset adding a live one', () => {
    const before = BASE.replace('  return parsed;', '  // never use @ts-ignore here\n  return parsed;');
    const after = BASE.replace('  return parsed;', '  // @ts-ignore\n  return parsed;');
    expect(block(content(before, after))).toHaveLength(1);
  });

  it.each([
    '// @ts-ignore',
    '//@ts-expect-error',
    '/// @ts-nocheck',
    '// @ts-expect-error: reason',
    '/* @ts-ignore */',
    '/** \n * @ts-expect-error\n */',
    'return; // @ts-ignore',
  ])('a live directive blocks on both paths: %s', (line) => {
    expect(block(content(BASE, BASE.replace('  return parsed;', `  ${line}\n  return parsed;`)))).toHaveLength(1);
    for (const l of line.split('\n')) if (/@ts-/.test(l)) expect(diffOnly(l), l).toHaveLength(1);
  });

  it.each([
    '// never use @ts-ignore here',
    '/* do not add @ts-expect-error */',
    'const s = "// @ts-ignore";',
    "const s = '/* @ts-nocheck */';",
    'const re = /@ts-ignore/;',
  ])('a mention that suppresses nothing is clean on both paths: %s', (line) => {
    expect(block(content(BASE, BASE.replace('  return parsed;', `  ${line}\n  return parsed;`)))).toHaveLength(0);
    expect(diffOnly(line)).toHaveLength(0);
  });

  it('a directive inside a multi-line template literal is text on the full-content path', () => {
    expect(block(content(BASE, BASE.replace('  return parsed;', '  const t = `\n// @ts-ignore\n`;\n  return parsed;')))).toHaveLength(0);
  });

  it('a comment that mentions `as unknown as` is text, not the double cast', () => {
    expect(block(content(BASE, BASE.replace('  return parsed;', '  // never write x as unknown as T here\n  return parsed;')))).toHaveLength(0);
  });

  it('`// @ts-nocheck` at the top of the file is live', () => {
    expect(block(content(BASE, '// @ts-nocheck\n' + BASE))).toHaveLength(1);
  });
});

describe('ts-any-cast (#440): JSDoc `{*}` and `{?}` are the `any` cast in a JS file', () => {
  const js = 'export function f(x) { return x.length; }\n';
  it.each(['*', '?', 'any'])('`/** @type {%s} */ (x)` blocks in .js on both paths', (t) => {
    expect(block(content(js, js.replace('return x.length', `return /** @type {${t}} */ (x).length`), 'src/x.js'))).toHaveLength(1);
    expect(diffOnly(`const n = /** @type {${t}} */ (x).length;`, 'src/x.js')).toHaveLength(1);
  });

  it('is inert in a .ts file, and an annotation without the cast parens is not a cast', () => {
    expect(block(content(BASE, BASE.replace('return parsed', 'return /** @type {*} */ (parsed)')))).toHaveLength(0);
    expect(diffOnly('const n = /** @type {?} */ (x).length;')).toHaveLength(0);
    expect(block(content(js, '/** @type {*} */\nlet y = 1;\n' + js, 'src/x.js'))).toHaveLength(0);
  });
});
