// Reachability of test content (#431).
//
// Every block-count and line-count rule read textual presence as execution: an
// `it()` wrapped in `if (false) {}`, written after a `return;` in its describe
// callback, or moved into a function nobody calls was still a test to
// test-deletion's count, and three assertions moved into a template literal
// were still "kept" lines to test-content-removal's excuse pool. This module
// answers one question for both rules: which parts of a spec can run.
//
// JS/TS is read on the TS AST. A node is DEAD when it is the guarded branch of
// a condition that folds to a constant (`if (false)`, `if (0)`, `if (!true)`,
// `false && x`, `x && false`, `1 === 2`, the else of `if (true)`), a statement
// after an unconditional `return` / `throw` / `break` / `continue` in the same
// block (hoisted function declarations excepted — they are judged by whether
// anyone calls them), the body of a loop whose condition folds to false, or the
// body of a named function — a declaration or a variable-bound function
// literal — whose name is referenced nowhere live in the file. Anything that
// genuinely depends on the environment (`if (process.env.CI)`) is reachable:
// the pass folds literals, never guesses.
//
// Python is read by indentation: a `return` / `raise` at indent k kills the
// lines at indent ≥ k that follow it, and `if False:` / `if 0:` / `if None:` /
// `while False:` kills its suite. pytest collection is modelled the same way:
// a `def test_*` inside a class counts only when every enclosing class is one
// pytest collects — named `Test*`, or a `TestCase` subclass.

import type TS from 'typescript';
import { parseSource, ts } from '../ts-lazy';
import { langOf } from './files';

const MAX_ROUNDS = 8;

/** Constant truthiness of an expression, or null when it depends on a value the
 *  file does not carry. Literals, `!`, `void`, `&&` / `||` short-circuits and
 *  comparisons between two literals fold; identifiers other than `undefined` /
 *  `NaN` do not. */
function constTruth(expr: TS.Expression): boolean | null {
  const v = constValue(expr);
  if (v === null) return null;
  return v.kind === 'unknown' ? v.truthy : Boolean(v.value);
}

type ConstValue =
  | { kind: 'value'; value: string | number | boolean | null | undefined }
  | { kind: 'unknown'; truthy: boolean };

function constValue(expr: TS.Expression): ConstValue | null {
  if (ts.isParenthesizedExpression(expr)) return constValue(expr.expression);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'value', value: true };
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'value', value: false };
  if (expr.kind === ts.SyntaxKind.NullKeyword) return { kind: 'value', value: null };
  if (ts.isIdentifier(expr)) {
    if (expr.text === 'undefined') return { kind: 'value', value: undefined };
    if (expr.text === 'NaN') return { kind: 'value', value: NaN };
    return null;
  }
  if (ts.isNumericLiteral(expr)) return { kind: 'value', value: Number(expr.text) };
  if (ts.isBigIntLiteral(expr)) return { kind: 'unknown', truthy: !/^0+n$/.test(expr.text) };
  if (ts.isStringLiteralLike(expr)) return { kind: 'value', value: expr.text };
  if (ts.isVoidExpression(expr)) return { kind: 'value', value: undefined };
  if (ts.isPrefixUnaryExpression(expr)) {
    if (expr.operator === ts.SyntaxKind.ExclamationToken) {
      const inner = constTruth(expr.operand);
      return inner === null ? null : { kind: 'value', value: !inner };
    }
    if (expr.operator === ts.SyntaxKind.MinusToken || expr.operator === ts.SyntaxKind.PlusToken) {
      const inner = constValue(expr.operand);
      if (inner === null || inner.kind !== 'value' || typeof inner.value !== 'number') return null;
      return { kind: 'value', value: expr.operator === ts.SyntaxKind.MinusToken ? -inner.value : inner.value };
    }
    return null;
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      const l = constTruth(expr.left);
      const r = constTruth(expr.right);
      const and = op === ts.SyntaxKind.AmpersandAmpersandToken;
      // `false && x` and `x && false` are both falsy whatever x holds; `true || x`
      // and `x || true` are both truthy. Otherwise the constant side decides only
      // when it lets the other side through unchanged.
      if (and) {
        if (l === false || r === false) return { kind: 'unknown', truthy: false };
        if (l === true) return r === null ? null : { kind: 'unknown', truthy: r };
        if (r === true) return l === null ? null : { kind: 'unknown', truthy: l };
        return null;
      }
      if (l === true || r === true) return { kind: 'unknown', truthy: true };
      if (l === false) return r === null ? null : { kind: 'unknown', truthy: r };
      if (r === false) return l === null ? null : { kind: 'unknown', truthy: l };
      return null;
    }
    const l = constValue(expr.left);
    const r = constValue(expr.right);
    if (l === null || r === null || l.kind !== 'value' || r.kind !== 'value') return null;
    const a = l.value;
    const b = r.value;
    switch (op) {
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
        return { kind: 'value', value: a === b };
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        return { kind: 'value', value: a !== b };
      case ts.SyntaxKind.EqualsEqualsToken:
        // eslint-disable-next-line eqeqeq
        return { kind: 'value', value: a == b };
      case ts.SyntaxKind.ExclamationEqualsToken:
        // eslint-disable-next-line eqeqeq
        return { kind: 'value', value: a != b };
      default:
        break;
    }
    if (typeof a === 'number' && typeof b === 'number') {
      switch (op) {
        case ts.SyntaxKind.LessThanToken:
          return { kind: 'value', value: a < b };
        case ts.SyntaxKind.LessThanEqualsToken:
          return { kind: 'value', value: a <= b };
        case ts.SyntaxKind.GreaterThanToken:
          return { kind: 'value', value: a > b };
        case ts.SyntaxKind.GreaterThanEqualsToken:
          return { kind: 'value', value: a >= b };
        default:
          break;
      }
    }
    return null;
  }
  return null;
}

/** A statement after which the rest of its block never runs. */
function isTerminal(stmt: TS.Statement): boolean {
  return ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt) || ts.isBreakStatement(stmt) || ts.isContinueStatement(stmt);
}

/** The body a named function defines: a declaration's block, or the block /
 *  expression of a function literal bound to a `const` / `let` / `var`. */
function namedFunctionBody(node: TS.Node): { name: string; body: TS.Node; owner: TS.Node } | null {
  if (ts.isFunctionDeclaration(node) && node.name && node.body) return { name: node.name.text, body: node.body, owner: node };
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    let init: TS.Expression = node.initializer;
    while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
    if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) return { name: node.name.text, body: init.body, owner: node };
  }
  return null;
}

function isExportedDeclaration(node: TS.Node): boolean {
  const stmt = ts.isVariableDeclaration(node) ? node.parent.parent : node;
  if (ts.isExportAssignment(stmt)) return true;
  return ts.canHaveModifiers(stmt) && (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/**
 * The nodes of `sf` that can never run: constant-false branches, statements
 * after a terminal in the same block, bodies of loops whose condition folds to
 * false, and bodies of named functions nobody references. A traversal that
 * skips every node in the set walks only reachable code.
 */
export function unreachableNodes(sf: TS.SourceFile): Set<TS.Node> {
  const dead = new Set<TS.Node>();

  const markBranches = (node: TS.Node): void => {
    if (ts.isIfStatement(node)) {
      const t = constTruth(node.expression);
      if (t === false) dead.add(node.thenStatement);
      else if (t === true && node.elseStatement) dead.add(node.elseStatement);
    } else if (ts.isWhileStatement(node) || ts.isForStatement(node)) {
      const cond = ts.isWhileStatement(node) ? node.expression : node.condition;
      if (cond && constTruth(cond) === false) dead.add(node.statement);
    } else if (ts.isConditionalExpression(node)) {
      const t = constTruth(node.condition);
      if (t === false) dead.add(node.whenTrue);
      else if (t === true) dead.add(node.whenFalse);
    } else if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const l = constTruth(node.left);
      if ((op === ts.SyntaxKind.AmpersandAmpersandToken && l === false) || (op === ts.SyntaxKind.BarBarToken && l === true)) {
        dead.add(node.right);
      }
    }
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      let ended = false;
      for (const stmt of node.statements) {
        // A function declaration is hoisted: it exists whatever precedes it, and
        // whether it RUNS is the reference question below.
        if (ended && !ts.isFunctionDeclaration(stmt)) dead.add(stmt);
        if (isTerminal(stmt)) ended = true;
      }
    }
    ts.forEachChild(node, markBranches);
  };
  markBranches(sf);

  // Named functions nobody references. References are counted outside dead code
  // and outside the candidate's own body, to a fixpoint: a helper called only
  // from a dead branch is dead too.
  const candidates: Array<{ name: string; body: TS.Node; owner: TS.Node }> = [];
  const collect = (node: TS.Node): void => {
    const fn = namedFunctionBody(node);
    if (fn && !isExportedDeclaration(fn.owner)) candidates.push(fn);
    ts.forEachChild(node, collect);
  };
  collect(sf);
  if (candidates.length === 0) return dead;

  const inDead = (node: TS.Node): boolean => {
    for (let n: TS.Node | undefined = node; n; n = n.parent) if (dead.has(n)) return true;
    return false;
  };
  const within = (node: TS.Node, owner: TS.Node): boolean => node.pos >= owner.pos && node.end <= owner.end;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const live = new Map<string, TS.Identifier[]>();
    const gather = (node: TS.Node): void => {
      if (dead.has(node)) return;
      if (ts.isIdentifier(node)) {
        const list = live.get(node.text);
        if (list) list.push(node);
        else live.set(node.text, [node]);
      }
      ts.forEachChild(node, gather);
    };
    gather(sf);
    let changed = false;
    for (const fn of candidates) {
      if (dead.has(fn.body) || inDead(fn.owner)) continue;
      const refs = (live.get(fn.name) ?? []).filter((id) => !within(id, fn.owner));
      if (refs.length === 0) {
        dead.add(fn.body);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return dead;
}

/** Character ranges [start, end) of the INTERIOR of every string and template
 *  literal — the text between the delimiters, substitutions excluded. */
function literalInteriors(sf: TS.SourceFile): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const visit = (node: TS.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push([node.getStart(sf) + 1, Math.max(node.getStart(sf) + 1, node.getEnd() - 1)]);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) {
      out.push([node.getStart(sf) + 1, Math.max(node.getStart(sf) + 1, node.getEnd() - 2)]);
    } else if (ts.isTemplateTail(node)) {
      out.push([node.getStart(sf) + 1, Math.max(node.getStart(sf) + 1, node.getEnd() - 1)]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export interface Partition {
  /** The source with every dead region and every line that lies wholly inside a
   *  string or template literal blanked — what can run, line structure kept. */
  live: string;
  /** The complement: the text of dead regions and literal interiors, everything
   *  else blanked. Content found only here is written, not executed. */
  hidden: string;
  /** Per character of `live`, whether it sits inside a literal's interior. A
   *  line partly inside a literal (`const s = "…"`) is kept in `live` with its
   *  string, and this mask says which of its characters are the string. */
  inLiteral: Uint8Array;
}

const blankRange = (chars: string[], start: number, end: number): void => {
  for (let i = start; i < end && i < chars.length; i++) if (chars[i] !== '\n') chars[i] = ' ';
};

function partitionJs(src: string): Partition | null {
  const sf = parseSource('spec.ts', src);
  if (!sf) return null;
  const dead = unreachableNodes(sf);
  const deadRanges: Array<[number, number]> = [];
  for (const n of dead) deadRanges.push([n.getStart(sf), n.getEnd()]);
  const literals = literalInteriors(sf);

  const mask = new Uint8Array(src.length); // 1: dead, 2: literal interior
  for (const [s, e] of deadRanges) for (let i = s; i < e; i++) mask[i] = 1;
  for (const [s, e] of literals) for (let i = s; i < e; i++) if (mask[i] === 0) mask[i] = 2;

  const live = src.split('');
  const hidden = src.split('');
  const inLiteral = new Uint8Array(src.length);
  // Blank dead text from `live`; blank live text from `hidden`.
  for (let i = 0; i < src.length; i++) {
    if (mask[i] === 1) {
      if (live[i] !== '\n') live[i] = ' ';
    } else if (mask[i] === 2) {
      inLiteral[i] = 1;
    } else if (hidden[i] !== '\n') hidden[i] = ' ';
  }
  // A line wholly inside a literal's interior is not code at all.
  let lineStart = 0;
  for (let i = 0; i <= src.length; i++) {
    if (i === src.length || src[i] === '\n') {
      let all = i > lineStart;
      for (let j = lineStart; j < i && all; j++) if (mask[j] !== 2 && /\S/.test(src[j])) all = false;
      if (all) blankRange(live, lineStart, i);
      lineStart = i + 1;
    }
  }
  return { live: live.join(''), hidden: hidden.join(''), inLiteral };
}

const PY_INDENT = (line: string): number => line.length - line.trimStart().length;
const PY_TERMINAL = /^\s*(?:return\b|raise\b)/;
const PY_CONST_FALSE = /^\s*(?:if|while)\s+(?:False|0|None|not\s+True)\s*:/;

function partitionPy(src: string): Partition {
  const lines = src.split('\n');
  const dead = new Array<boolean>(lines.length).fill(false);
  let killIndent: number | null = null; // lines at indent ≥ this are dead (after a terminal)
  let suiteIndent: number | null = null; // lines at indent > this are dead (a constant-false suite)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/\S/.test(l) || /^\s*#/.test(l)) continue;
    const indent = PY_INDENT(l);
    if (killIndent !== null && indent < killIndent) killIndent = null;
    if (suiteIndent !== null && indent <= suiteIndent) suiteIndent = null;
    if ((killIndent !== null && indent >= killIndent) || (suiteIndent !== null && indent > suiteIndent)) {
      dead[i] = true;
      continue;
    }
    if (PY_TERMINAL.test(l)) killIndent = indent;
    else if (PY_CONST_FALSE.test(l)) suiteIndent = indent;
  }
  const live = lines.map((l, i) => (dead[i] ? '' : l)).join('\n');
  const hidden = lines.map((l, i) => (dead[i] ? l : '')).join('\n');
  return { live, hidden, inLiteral: new Uint8Array(live.length) };
}

/** Split a test file into what runs and what is merely written. Languages the
 *  pass does not read (and a JS source the guarded parser declines) are all live. */
export function partition(src: string, path: string): Partition {
  const lang = langOf(path);
  if (lang === 'js' || lang === null) {
    const p = partitionJs(src);
    if (p) return p;
  } else if (lang === 'py') {
    return partitionPy(src);
  }
  return { live: src, hidden: '', inLiteral: new Uint8Array(src.length) };
}

// pytest collects `Test*` classes (the default `python_classes`) and, through
// unittest, any `TestCase` subclass whatever its name; a `def test_*` inside
// any other class is never collected. A class renamed away from the prefix
// takes its tests out of the run without touching a `def`.
const PY_CLASS = /^\s*class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/;
const PY_TEST_DEF = /^\s*(?:async\s+)?def\s+test\w*\s*\(/;
const PY_COLLECTED_CLASS = (name: string, bases: string): boolean => /^Test/.test(name) || /Test/.test(bases);

/** The `def test_*` definitions pytest would collect from a module: every one at
 *  module level, and those inside classes whose whole enclosing chain is collected. */
export function pytestCollectedDefs(src: string): number {
  let n = 0;
  const stack: Array<{ indent: number; collected: boolean }> = [];
  for (const line of src.split('\n')) {
    if (!/\S/.test(line) || /^\s*#/.test(line)) continue;
    const indent = PY_INDENT(line);
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    const cls = PY_CLASS.exec(line);
    if (cls) {
      stack.push({ indent, collected: PY_COLLECTED_CLASS(cls[1], cls[2] ?? '') });
      continue;
    }
    if (PY_TEST_DEF.test(line) && stack.every((c) => c.collected)) n++;
  }
  return n;
}
