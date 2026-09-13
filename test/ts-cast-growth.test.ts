// #383 ts-cast-growth — the bounded "cast budget" rule.
//
// A cast is a promise to the compiler, not a runtime proof. The unambiguous
// escapes (`as any`, `as unknown as T`, `@ts-ignore`) are row 4 (`ts-any-cast`,
// block). This rule covers what row 4 deliberately leaves alone: ORDINARY
// `x as T` / `<T>x` assertions and non-null `x!` assertions, counted on the
// TypeScript AST BEFORE and AFTER a change. It fires only on NET GROWTH of that
// surface in a non-test source file, and only as a warning: the measured fire
// rate on legitimate TypeScript mainlines is far above any deployable block
// threshold (harness/fp-study/CAST-GROWTH-CORPUS.md).
import { describe, expect, it } from 'vitest';
import { tsCastGrowth } from '../src/detectors/ts-cast-growth';
import { tsAnyCast } from '../src/detectors/ts-any-cast';
import { allDetectors } from '../src/detectors';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy } from '../src/policy';
import type { FileChange, Finding } from '../src/types';

const P = defaultPolicy();
const RULE = 'ts-cast-growth';

function change(path: string, before: string | null, after: string | null, op: FileChange['op'] = 'modify'): FileChange {
  return { kind: 'file', path, oldPath: null, op, before, after, hunks: [], binary: false };
}
const run = (before: string | null, after: string | null, path = 'src/x.ts'): Finding[] =>
  tsCastGrowth.run([change(path, before, after, before === null ? 'add' : 'modify')], P);
const fires = (fs: Finding[]) => fs.filter((f) => f.rule === RULE);

const BASE = [
  'export function read(raw: string): unknown {',
  '  const parsed: unknown = JSON.parse(raw);',
  '  return parsed;',
  '}',
  '',
].join('\n');

describe('ts-cast-growth — registration and identity (#383)', () => {
  it('is registered, is a file-surface rule, and ships warn by default', () => {
    expect(allDetectors.some((d) => d.id === RULE)).toBe(true);
    expect(tsCastGrowth.surface).toEqual(['file']);
    expect(P.rules[RULE]?.severity).toBe('warn');
  });

  it('every fire is a warn carrying the file, a line, the net counts and a remediation', () => {
    const after = BASE.replace('return parsed;', 'return parsed as { ok: boolean };');
    const [f] = fires(run(BASE, after));
    expect(f).toBeDefined();
    expect(f.severity).toBe('warn');
    expect(f.file).toBe('src/x.ts');
    expect(f.line).toBe(3);
    expect(f.message).toMatch(/\+1 type assertion/);
    expect(f.remediation).toMatch(/narrow|guard|parse/i);
    expect(f.signoff.required).toBe(false);
  });
});

describe('ts-cast-growth — what counts as growth', () => {
  it('fires on a net-new ordinary `as T` assertion', () => {
    expect(fires(run(BASE, BASE.replace('return parsed;', 'return parsed as { ok: boolean };')))).toHaveLength(1);
  });

  it('fires on a net-new angle-bracket `<T>x` assertion in a .ts file', () => {
    expect(fires(run(BASE, BASE.replace('return parsed;', 'return <{ ok: boolean }>parsed;')))).toHaveLength(1);
  });

  it('fires on a net-new non-null assertion, reported separately from type assertions', () => {
    const before = 'export function f(m: Map<string, number>): number | undefined {\n  return m.get("a");\n}\n';
    const after = before.replace('return m.get("a");', 'return m.get("a")!;');
    const [f] = fires(run(before, after));
    expect(f).toBeDefined();
    expect(f.message).toMatch(/\+1 non-null assertion/);
    expect(f.message).not.toMatch(/type assertion/);
  });

  it('a newly added source file counts its whole assertion surface as growth', () => {
    const fresh = 'export const v = JSON.parse("{}") as { a: number };\n';
    expect(fires(run(null, fresh))).toHaveLength(1);
  });

  it('counts growth per file: two files each get their own finding, one clean file gets none', () => {
    const grown = BASE.replace('return parsed;', 'return parsed as { ok: boolean };');
    const fs = tsCastGrowth.run(
      [change('src/a.ts', BASE, grown), change('src/b.ts', BASE, grown), change('src/c.ts', BASE, BASE + '// touched\n')],
      P,
    );
    expect(fires(fs).map((f) => f.file).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('ts-cast-growth — what does NOT count', () => {
  it('a cast removed in the same change offsets a cast added elsewhere (net growth is zero)', () => {
    const before = 'const a = x as A;\nconst b = y;\n';
    const after = 'const a = x;\nconst b = y as B;\n';
    expect(run(before, after)).toHaveLength(0);
  });

  it('a net REDUCTION of the assertion surface is silent (the hardening direction)', () => {
    const before = 'const a = JSON.parse(s) as { k: string };\nconst b = e as { code?: string };\n';
    const after = 'const a: unknown = JSON.parse(s);\nconst b = e as { code?: string };\n';
    expect(run(before, after)).toHaveLength(0);
  });

  it('pre-existing casts left untouched do not fire when unrelated code changes', () => {
    const withCasts = 'const a = x as A;\nconst b = <B>y;\nconst c = z!;\nexport function f() { return 1; }\n';
    expect(run(withCasts, withCasts.replace('return 1;', 'return 2;'))).toHaveLength(0);
  });

  it('`satisfies` is not a cast', () => {
    expect(run(BASE, BASE.replace('return parsed;', 'return { ok: true } satisfies { ok: boolean };'))).toHaveLength(0);
  });

  it('`as const` is not a cast', () => {
    expect(run(BASE, BASE.replace('return parsed;', 'return ["a", "b"] as const;'))).toHaveLength(0);
  });

  it('`as unknown` (widening to the honest narrowing target) is not counted', () => {
    expect(run(BASE, BASE.replace('return parsed;', 'return parsed as unknown;'))).toHaveLength(0);
  });

  it('`as any` and `as unknown as T` belong to ts-any-cast (row 4) and are not double-counted here', () => {
    const anyCast = BASE.replace('return parsed;', 'return parsed as any;');
    const double = BASE.replace('return parsed;', 'return parsed as unknown as { ok: boolean };');
    expect(run(BASE, anyCast)).toHaveLength(0);
    expect(run(BASE, double)).toHaveLength(0);
    expect(tsAnyCast.run([change('src/x.ts', BASE, anyCast)], P).some((f) => f.rule === 'ts-any-cast')).toBe(true);
    expect(tsAnyCast.run([change('src/x.ts', BASE, double)], P).some((f) => f.rule === 'ts-any-cast')).toBe(true);
  });

  it('cast-like text inside comments and strings is not a cast', () => {
    const after = BASE.replace(
      'return parsed;',
      '// the old code did `parsed as Foo` here\n  const note = "x as Bar and <Baz>y and z!";\n  return parsed;',
    );
    expect(run(BASE, after)).toHaveLength(0);
  });

  it('a `!` that is a logical not or an inequality is not a non-null assertion', () => {
    const before = 'export function f(a: boolean, b: number): boolean {\n  return a;\n}\n';
    const after = before.replace('return a;', 'return !a && b !== 1 && b != 2;');
    expect(run(before, after)).toHaveLength(0);
  });

  it('TSX: a generic component or generic call is not an angle-bracket cast', () => {
    const before = 'export const A = () => <div />;\n';
    const after = 'type P = { v: number };\nconst List = <T,>(p: { items: T[] }) => <ul>{p.items.length}</ul>;\nexport const A = () => <List<number> items={[1]} />;\n';
    expect(run(before, after, 'src/view.tsx')).toHaveLength(0);
  });

  it('JSX files are parsed as JSX (no angle-bracket casts) and still count `as` in .jsx via JSDoc-free syntax only', () => {
    const before = 'export const A = () => <div />;\n';
    const after = 'export const A = () => <div className="x" />;\nexport const B = () => <span>{"<T>x"}</span>;\n';
    expect(run(before, after, 'src/view.jsx')).toHaveLength(0);
  });
});

describe('ts-cast-growth — scope exclusions', () => {
  const grown = BASE.replace('return parsed;', 'return parsed as { ok: boolean };');

  it('declaration files are not counted', () => {
    expect(run(BASE, grown, 'src/types.d.ts')).toHaveLength(0);
    expect(run(BASE, grown, 'src/types.d.mts')).toHaveLength(0);
  });

  it('generated and vendored paths are not counted', () => {
    for (const p of [
      'src/generated/api.ts',
      'src/__generated__/schema.ts',
      'src/client.generated.ts',
      'vendor/lib/index.ts',
      'third_party/x.ts',
      'node_modules/pkg/index.ts',
      'dist/cli/index.js',
    ]) {
      expect(run(BASE, grown, p), p).toHaveLength(0);
    }
  });

  it('a file whose header declares itself generated is not counted', () => {
    const header = '/* eslint-disable */\n// @generated by protoc-gen-ts. DO NOT EDIT.\n';
    expect(run(header + BASE, header + grown, 'src/proto/x.ts')).toHaveLength(0);
  });

  it('protected test files are not counted (casts there do not affect production type safety)', () => {
    expect(run(BASE, grown, 'src/x.test.ts')).toHaveLength(0);
    expect(run(BASE, grown, 'test/x.spec.tsx')).toHaveLength(0);
  });

  it('non-code files and deletes are ignored', () => {
    expect(run(BASE, grown, 'docs/x.md')).toHaveLength(0);
    expect(tsCastGrowth.run([change('src/x.ts', grown, null, 'delete')], P)).toHaveLength(0);
  });

  it('a change that does not parse cleanly on either side declines rather than guessing', () => {
    expect(run(BASE, grown.replace('}', ''))).toHaveLength(0);
    expect(run(BASE.replace('}', ''), grown)).toHaveLength(0);
  });

  it('diff-only changes (no BEFORE/AFTER content) are silent: net growth needs both sides', () => {
    const d = parseDiff(
      'diff --git a/src/y.ts b/src/y.ts\nindex 1..2 100644\n--- a/src/y.ts\n+++ b/src/y.ts\n@@ -1,1 +1,1 @@\n-const v = read();\n+const v = read() as Foo;\n',
    );
    expect(tsCastGrowth.run(d, P)).toHaveLength(0);
  });
});

describe('ts-cast-growth — the legitimate interop assertion', () => {
  it('a genuinely necessary boundary assertion still fires, as a warning a human can accept; it never requires sign-off by default', () => {
    // A library boundary that returns `unknown` and is narrowed with an assertion
    // rather than a guard. Legitimate, sometimes unavoidable — and exactly the
    // surface an operator wants to see grow, not a reason to stop the commit.
    const before = 'import { load } from "lib";\nexport function cfg(): unknown {\n  return load();\n}\n';
    const after = 'import { load } from "lib";\nexport function cfg(): { port: number } {\n  return load() as { port: number };\n}\n';
    const [f] = fires(run(before, after));
    expect(f).toBeDefined();
    expect(f.severity).toBe('warn');
    expect(f.signoff.required).toBe(false);
  });

  it('a policy may raise the rule to block, at which point sign-off is required like any other block', () => {
    const strict = { ...P, rules: { ...P.rules, [RULE]: { severity: 'block' as const } } };
    const after = BASE.replace('return parsed;', 'return parsed as { ok: boolean };');
    const [f] = tsCastGrowth.run([change('src/x.ts', BASE, after)], strict).filter((x) => x.rule === RULE);
    expect(f.severity).toBe('block');
    expect(f.signoff.required).toBe(true);
  });
});
