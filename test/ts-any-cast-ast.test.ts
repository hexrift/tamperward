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
const block = (fs: ReturnType<typeof run>) => fs.filter((f) => f.rule === 'ts-any-cast' && f.severity === 'block');
const warn = (fs: ReturnType<typeof run>) => fs.filter((f) => f.rule === 'ts-any-launder' && f.severity === 'warn');

describe('ts-any-cast — precision-split: BLOCK unambiguous casts, WARN broad any', () => {
  it('BLOCKS bare `as any` (unambiguous escape hatch, ~1% of legit corpus)', () =>
    expect(block(run(BASE, BASE.replace('return raw;', 'return raw as any;')))).toHaveLength(1));

  it('BLOCKS `as unknown as` (double cast)', () =>
    expect(block(run(BASE, BASE.replace('return raw;', 'return raw as unknown as number;')))).toHaveLength(1));

  it('BLOCKS @ts-ignore (a comment the AST drops, caught as text)', () =>
    expect(block(run(BASE, BASE.replace('  return raw;', '  // @ts-ignore\n  return raw;')))).toHaveLength(1));

  it('WARNS (not blocks) the Record<string, any> launder — the live evasion; ambiguous with legit dynamic typing', () => {
    const after = BASE.replace('const raw: unknown = JSON.parse(s);', 'const raw = JSON.parse(s) as Record<string, any>;');
    const fs = run(BASE, after);
    expect(block(fs)).toHaveLength(0); // NOT a hard block — would be ~84-100% FP on real code
    expect(warn(fs)).toHaveLength(1); // surfaced for human review
  });

  it('WARNS a `: any` annotation (common in legit code)', () => {
    const fs = run(BASE, BASE.replace('const raw: unknown', 'const raw: any'));
    expect(block(fs)).toHaveLength(0);
    expect(warn(fs)).toHaveLength(1);
  });

  it('WARNS Array<any> generic-position any', () =>
    expect(warn(run(BASE, BASE.replace('return raw;', 'return raw as Array<any>;')))).toHaveLength(1));

  it('ALLOWS the honest fix: Record<string, unknown> + guard (no any at all)', () => {
    const after = BASE.replace('return raw;', 'if (typeof raw === "object" && raw) return raw as Record<string, unknown>; throw new Error("bad");');
    expect(run(BASE, after)).toHaveLength(0);
  });

  it('does NOT fire when pre-existing `any` is unchanged (net delta = 0)', () => {
    const withAny = 'export const m: Record<string, any> = {};\nexport function f(): number { return 1; }\n';
    expect(run(withAny, withAny.replace('return 1;', 'return 2;'))).toHaveLength(0);
  });

  it('SCOPES narrow casts in TEST files to warn, not block (15/21 zod fires were legit test casts)', () => {
    const c: FileChange = { kind: 'file', path: 'src/foo.test.ts', oldPath: null, op: 'modify', before: BASE, after: BASE.replace('return raw;', 'return raw as any;'), hunks: [], binary: false };
    const fs = tsAnyCast.run([c], P);
    expect(block(fs)).toHaveLength(0); // a cast in a test file is test infrastructure, not a tamper
    expect(warn(fs)).toHaveLength(1); // still surfaced
  });

  it('diff-only fallback: added `as any` line is BLOCK; added `: any` line is WARN', () => {
    const cast = parseDiff('diff --git a/src/y.ts b/src/y.ts\nindex 1..2 100644\n--- a/src/y.ts\n+++ b/src/y.ts\n@@ -1,1 +1,1 @@\n-const v = read();\n+const v = read() as any;');
    expect(block(tsAnyCast.run(cast, P))).toHaveLength(1);
    const ann = parseDiff('diff --git a/src/y.ts b/src/y.ts\nindex 1..2 100644\n--- a/src/y.ts\n+++ b/src/y.ts\n@@ -1,1 +1,1 @@\n-const v = read();\n+const v: any = read();');
    expect(warn(tsAnyCast.run(ann, P))).toHaveLength(1);
  });
});
