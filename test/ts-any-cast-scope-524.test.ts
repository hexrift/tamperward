// #524: a cast to a `type X = string` alias was blocked as `as any` when an unrelated
// function happened to declare its own `type X = any`. The alias map was keyed by name
// only, so a nested/sibling declaration overwrote the outer binding. Alias resolution is
// now lexical: a name resolves against the scope of the assertion that uses it.
import { describe, it, expect } from 'vitest';
import { tsAnyCast } from '../src/detectors/ts-any-cast';
import { defaultPolicy } from '../src/policy';
import type { FileChange } from '../src/types';

const P = defaultPolicy();
const run = (before: string, after: string, path = 'src/value.ts') => {
  const c: FileChange = { kind: 'file', path, oldPath: null, op: 'modify', before, after, hunks: [], binary: false };
  return tsAnyCast.run([c], P);
};
const blocks = (fs: ReturnType<typeof run>) => fs.filter((f) => f.rule === 'ts-any-cast' && f.severity === 'block');

describe('ts-any-cast alias scope (#524)', () => {
  it('does NOT block a cast to an alias only shadowed in an unrelated sibling scope', () => {
    const before = [
      'type Value = string;',
      'export const parseValue = (raw: unknown): Value => String(raw);',
      'function unrelated() {',
      '  type Value = any;',
      '  const local: Value = 1;',
      '  return local;',
      '}',
      '',
    ].join('\n');
    const after = before.replace('String(raw)', 'raw as Value');
    expect(blocks(run(before, after))).toHaveLength(0);
  });

  it('still blocks a genuine cast to a `type X = any` declared in the SAME scope', () => {
    const before = 'export function f(raw: unknown): number {\n  return 0;\n}\n';
    const after = 'export function f(raw: unknown): number {\n  type X = any;\n  return raw as X as number;\n}\n';
    expect(blocks(run(before, after))).toHaveLength(1);
  });

  it('does NOT block a cast to an enclosing type parameter, even when a same-named alias exists', () => {
    const before = 'type Value = any;\nexport function id<Value>(raw: unknown): unknown {\n  return raw;\n}\n';
    const after = 'type Value = any;\nexport function id<Value>(raw: unknown): Value {\n  return raw as Value;\n}\n';
    expect(blocks(run(before, after))).toHaveLength(0);
  });

  it('preserves the same-scope alias control: `type A = any; x as A` still blocks', () => {
    const before = 'type A = any;\nexport function f(raw: unknown): number {\n  return 0;\n}\n';
    const after = 'type A = any;\nexport function f(raw: unknown): number {\n  return raw as A;\n}\n';
    expect(blocks(run(before, after))).toHaveLength(1);
  });
});
