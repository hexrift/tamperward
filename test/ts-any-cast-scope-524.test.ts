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
// A diff-only change (no before/after content) drives the additive-line fallback, which resolves
// aliases across the change's added lines through the ambiguity-safe cross-tree path.
const runDiffOnly = (added: string[], path = 'src/value.ts') => {
  const lines = added.map((content, i) => ({ type: 'add' as const, content, oldLine: null, newLine: i + 1 }));
  const c: FileChange = {
    kind: 'file',
    path,
    oldPath: null,
    op: 'modify',
    before: null,
    after: null,
    binary: false,
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines }],
  };
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

  // A cast's nearest binding may be a type-namespace declaration that is not a resolvable alias
  // (an interface, a class, a generic alias). Each must shadow an outer `type X = any` so the
  // cast resolves to the real local binding, not the outer launder alias.
  it('does NOT block a cast whose nearest binding is a nested interface, not the outer any alias', () => {
    const before = [
      'type Value = any;',
      'export function make(raw: unknown): unknown {',
      '  interface Value { value: string }',
      '  const v: Value = { value: String(raw) };',
      '  return v;',
      '}',
      '',
    ].join('\n');
    const after = before.replace('return v;', 'return raw as Value;');
    expect(blocks(run(before, after))).toHaveLength(0);
  });

  it('does NOT block a cast whose nearest binding is a nested class, not the outer any alias', () => {
    const before = [
      'type Value = any;',
      'export function make(raw: unknown): unknown {',
      '  class Value { value = "x"; }',
      '  return new Value();',
      '}',
      '',
    ].join('\n');
    const after = before.replace('return new Value();', 'return raw as Value;');
    expect(blocks(run(before, after))).toHaveLength(0);
  });

  it('does NOT block a cast whose nearest binding is a generic alias with a default, not the outer any alias', () => {
    const before = [
      'type Value = any;',
      'export function make(raw: unknown): unknown {',
      '  type Value<T = string> = T;',
      '  const v: Value = String(raw);',
      '  return v;',
      '}',
      '',
    ].join('\n');
    const after = before.replace('const v: Value = String(raw);', 'const v: Value = raw as Value;');
    expect(blocks(run(before, after))).toHaveLength(0);
  });

  it('diff-only: does NOT block `as Value` when an interface Value shadows the any alias among added lines', () => {
    expect(
      blocks(runDiffOnly(['type Value = any;', 'interface Value { value: string }', 'const x = raw as Value;'])),
    ).toHaveLength(0);
  });

  it('diff-only: still blocks `as Value` when Value is unambiguously an any alias among added lines', () => {
    expect(blocks(runDiffOnly(['type Value = any;', 'const x = raw as Value;']))).toHaveLength(1);
  });
});
