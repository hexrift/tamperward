// One reader for a test runner's member chain (#429). `describe.only.each(table)`,
// `it.concurrent.skip('x')`, `test.describe.serial.only(...)`, `it.for(rows)`: the
// runners compose their modifiers in any order before the table method, and the
// three rules that read such a chain — test-skip (is a skip/focus marker in it?),
// test-deletion (how many tests does it define?) and assertion-weakening (which
// block is it?) — used to read it three different ways. They read it here.
//
// The reader is purely syntactic: it says what shape a chain has, never whether its
// root is really a runner. test-skip resolves the root by symbol first and hands the
// reader the property names; test-deletion and assertion-weakening read the callee
// as spelled.

import type TS from 'typescript';
import { ts } from '../ts-lazy';

/** The runner names a chain may start with or hop through (`test.describe.only`). */
export const RUNNER_NAMES: ReadonlySet<string> = new Set(['it', 'test', 'describe', 'suite']);

/** Modifiers a runner accepts between itself and the table method or the call, in any
 *  order: vitest's concurrency modes, Playwright's describe modes, the skip/focus
 *  markers and the expected-failure marker. */
export const CHAIN_MODIFIERS: ReadonlySet<string> = new Set([
  'concurrent', 'sequential', 'shuffle', 'serial', 'parallel',
  'skip', 'only', 'todo',
  'fails', 'failing',
]);

/** `it.each(table)` and vitest 3's `it.for(table)`: one test per row alike. */
export const TABLE_METHODS: ReadonlySet<string> = new Set(['each', 'for']);

export type SkipMarker = 'skip' | 'only' | 'todo';
export type TableMethod = 'each' | 'for';

export interface RunnerChain {
  /** The innermost runner name: `it` for `it.concurrent.each`, `describe` for
   *  `test.describe.only`. */
  runner: string;
  /** The modifiers between the runner and the table method (or the call), in
   *  source order. */
  modifiers: string[];
  /** The table method the chain ends in, if any. */
  table: TableMethod | null;
  /** The first skip/focus marker among the modifiers, if any. */
  skipMarker: SkipMarker | null;
  /** Index into the chain's property list of `skipMarker` (-1 when none), so a
   *  caller holding the property nodes can point a finding at the marker itself. */
  skipIndex: number;
}

const skipMarkerOf = (name: string): SkipMarker | null =>
  name === 'skip' || name === 'only' || name === 'todo' ? name : null;

const tableOf = (name: string): TableMethod | null =>
  name === 'each' || name === 'for' ? name : null;

/**
 * Read a chain from its root name and the property names after it, in source
 * order. null when a property is none of a runner hop (allowed before any
 * modifier: `test.describe`), a modifier, or a table method — `it.extend`,
 * `test.describe.configure`, `expect.any` — or when the table method is not the
 * last hop. A bare root (`it`) is the chain with nothing on it.
 */
export function readRunnerChain(root: string, props: readonly string[]): RunnerChain | null {
  let runner = root;
  const modifiers: string[] = [];
  let table: TableMethod | null = null;
  let skipMarker: SkipMarker | null = null;
  let skipIndex = -1;
  for (let i = 0; i < props.length; i++) {
    const p = props[i];
    if (table) return null; // nothing follows `.each` / `.for`
    if (RUNNER_NAMES.has(p) && modifiers.length === 0) {
      runner = p;
      continue;
    }
    if (CHAIN_MODIFIERS.has(p)) {
      modifiers.push(p);
      const marker = skipMarkerOf(p);
      if (marker && !skipMarker) {
        skipMarker = marker;
        skipIndex = i;
      }
      continue;
    }
    const t = tableOf(p);
    if (t) {
      table = t;
      continue;
    }
    return null;
  }
  return { runner, modifiers, table, skipMarker, skipIndex };
}

/**
 * Read a call's callee as spelled: dot access or a string-literal bracket access
 * down to an identifier root. null for any other shape (a call result, a computed
 * property, `this.x`), and for a chain `readRunnerChain` rejects.
 */
export function readCallee(expr: TS.Expression): RunnerChain | null {
  const props: string[] = [];
  let cur: TS.Expression = expr;
  while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    if (ts.isPropertyAccessExpression(cur)) {
      props.unshift(cur.name.text);
    } else {
      const arg = cur.argumentExpression;
      if (!ts.isStringLiteralLike(arg)) return null;
      props.unshift(arg.text);
    }
    cur = cur.expression;
  }
  if (!ts.isIdentifier(cur)) return null;
  return readRunnerChain(cur.text, props);
}

/**
 * For a call whose callee is itself a table call — `describe.each(rows)('t', fn)`,
 * `it.for(rows)('t', fn)`, `` it.each`…`('t', fn) `` — the chain of that inner
 * table call. null when the callee is not one.
 */
export function readTableCallee(expr: TS.Expression): RunnerChain | null {
  const head = ts.isCallExpression(expr)
    ? expr.expression
    : ts.isTaggedTemplateExpression(expr) ? expr.tag : null;
  if (!head) return null;
  const chain = readCallee(head);
  return chain?.table ? chain : null;
}
