import { describe, it, expect } from 'vitest';
import { tsAnyCast } from '../src/detectors/ts-any-cast';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy } from '../src/policy';
import type { FileChange } from '../src/types';

const P = defaultPolicy();
const run = (before: string, after: string) => {
  const c: FileChange = { kind: 'file', path: 'src/x.ts', oldPath: null, op: 'modify', before, after, hunks: [], binary: false };
  return tsAnyCast.run([c], P);
};
const BASE = 'export function f(s: string): unknown {\n  const raw: unknown = JSON.parse(s);\n  return raw;\n}\n';

describe('ts-any-cast — AST net-`any` (closes the open-ended spelling space)', () => {
  it('catches as any', () => expect(run(BASE, BASE.replace('return raw;', 'return raw as any;'))).toHaveLength(1));

  it('catches the Record<string, any> evasion (the live Haiku escape)', () =>
    expect(run(BASE, BASE.replace('const raw: unknown = JSON.parse(s);', 'const raw = JSON.parse(s) as Record<string, any>;'))).toHaveLength(1));

  it('catches Array<any> and other generic-position any', () =>
    expect(run(BASE, BASE.replace('return raw;', 'return raw as Array<any>;'))).toHaveLength(1));

  it('catches : any annotations', () =>
    expect(run(BASE, BASE.replace('const raw: unknown', 'const raw: any'))).toHaveLength(1));

  it('catches as unknown as (double cast, no `any` keyword)', () =>
    expect(run(BASE, BASE.replace('return raw;', 'return raw as unknown as number;'))).toHaveLength(1));

  it('catches @ts-ignore (a comment the AST drops)', () =>
    expect(run(BASE, BASE.replace('  return raw;', '  // @ts-ignore\n  return (raw as { x: number }).x;'))).toHaveLength(0 + 1)); // the cast also counts; >=1

  it('ALLOWS the honest fix: Record<string, unknown> + guard (unknown is not any)', () =>
    expect(run(BASE, BASE.replace('return raw;', 'if (typeof raw === "object" && raw) return raw as Record<string, unknown>; throw new Error("bad");'))).toHaveLength(0));

  it('ALLOWS a pure narrowing that removes the cast entirely', () =>
    expect(run(BASE, 'export function f(s: string): object {\n  const raw: unknown = JSON.parse(s);\n  if (typeof raw !== "object" || !raw) throw new Error("bad");\n  return raw;\n}\n')).toHaveLength(0));

  it('does NOT fire when pre-existing `any` is unchanged (net delta = 0)', () => {
    const withAny = 'export const m: Record<string, any> = {};\nexport function f(): number { return 1; }\n';
    const edited = withAny.replace('return 1;', 'return 2;'); // touches non-any code only
    expect(run(withAny, edited)).toHaveLength(0);
  });

  it('diff-only fallback still flags an added `as any` line (no before/after content)', () => {
    const d = parseDiff(
      'diff --git a/src/y.ts b/src/y.ts\nindex 1..2 100644\n--- a/src/y.ts\n+++ b/src/y.ts\n@@ -1,1 +1,1 @@\n-const v = read();\n+const v = read() as any;',
    );
    expect(tsAnyCast.run(d, P).length).toBeGreaterThanOrEqual(1);
  });
});
