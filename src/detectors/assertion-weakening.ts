// #3 assertion-weakening (file surface, heuristic/warn).
//
// This detector is intentionally narrower than the semantic class named by the
// rule. It handles only JS/TS expectation changes for which the AST proves a
// one-way weakening without guessing what the correct value should be:
//
//   proven exact/structural value -> toBeTruthy()/toBeDefined()
//   positive toThrow(message|regexp) -> positive toThrow()
//   pure assertion removal from a kept, same-qualified test block
//
// Literal-to-literal expected-value edits are deliberately NOT findings in this
// first release. The existing OSS negatives corpus contains ordinary maintainer
// commits that update exact expectations as behavior changes; treating those as
// mechanically malicious would turn this warning into an FP factory. Pristine
// verification remains the authority.
//
// Test identity includes literal describe/suite ancestry. If that identity is
// ambiguous on either side, comparison is declined rather than pairing blocks
// by array position. This deliberately biases toward misses.

import ts from 'typescript';
import type { Change, Detector, Finding, Policy } from '../types';
import { isProtected } from '../policy';
import { makeFinding } from './finding';
import { langOf } from './files';

const RULE = 'assertion-weakening';

const TEST_CALLS = new Set(['it', 'test']);
const SUITE_CALLS = new Set(['describe', 'suite', 'context']);
const EXACT_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toMatchObject']);
const WEAK_MATCHERS = new Set(['toBeTruthy', 'toBeDefined']);

interface StaticFacts {
  defined: boolean;
  truthy: boolean | null;
}

interface Assertion {
  subject: string;
  polarity: '' | 'not';
  matcher: string;
  args: string[];
  firstArgFacts: StaticFacts | null;
  canonical: string;
  text: string;
}

interface TestBlock {
  title: string;
  identity: string;
  assertions: Assertion[];
}

const compact = (s: string): string => s.replace(/\s+/g, '');

function literalTitle(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function scriptKindForPath(path: string): ts.ScriptKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) {
    return ts.ScriptKind.TS;
  }
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function staticFacts(node: ts.Expression | undefined): StaticFacts | null {
  if (!node) return null;

  if (node.kind === ts.SyntaxKind.TrueKeyword) return { defined: true, truthy: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { defined: true, truthy: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { defined: true, truthy: false };

  if (ts.isIdentifier(node) && node.text === 'undefined') {
    return { defined: false, truthy: false };
  }
  if (ts.isVoidExpression(node)) return { defined: false, truthy: false };

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { defined: true, truthy: node.text.length > 0 };
  }
  if (ts.isNumericLiteral(node)) {
    return { defined: true, truthy: Number(node.text) !== 0 };
  }
  if (ts.isBigIntLiteral(node)) {
    return { defined: true, truthy: node.text.replace(/n$/i, '') !== '0' };
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(node.operand)
  ) {
    const value = Number(node.operand.text) * (node.operator === ts.SyntaxKind.MinusToken ? -1 : 1);
    return { defined: true, truthy: value !== 0 };
  }

  // Object-producing syntax is always defined/truthy. We intentionally do not
  // infer arbitrary identifiers/calls because their runtime values are unknown.
  if (
    ts.isObjectLiteralExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isRegularExpressionLiteral(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isClassExpression(node) ||
    ts.isNewExpression(node)
  ) {
    return { defined: true, truthy: true };
  }

  return null;
}

function expectAssertion(node: ts.CallExpression, sf: ts.SourceFile): Assertion | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  const matcher = node.expression.name.text;
  let receiver: ts.Expression = node.expression.expression;
  let polarity: '' | 'not' = '';

  if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'not') {
    polarity = 'not';
    receiver = receiver.expression;
  }

  // Deliberately do not reason about resolves/rejects/custom chained APIs yet.
  if (
    !ts.isCallExpression(receiver) ||
    !ts.isIdentifier(receiver.expression) ||
    receiver.expression.text !== 'expect' ||
    receiver.arguments.length !== 1
  ) {
    return null;
  }

  const subject = compact(receiver.arguments[0].getText(sf));
  const args = node.arguments.map((arg) => compact(arg.getText(sf)));
  return {
    subject,
    polarity,
    matcher,
    args,
    firstArgFacts: staticFacts(node.arguments[0]),
    canonical: [subject, polarity, matcher, ...args].join('|'),
    text: node.getText(sf).replace(/\s+/g, ' '),
  };
}

function simpleCallName(node: ts.CallExpression): string | null {
  return ts.isIdentifier(node.expression) ? node.expression.text : null;
}

function callbackFor(node: ts.CallExpression): ts.ArrowFunction | ts.FunctionExpression | null {
  const cb = node.arguments[1];
  return cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) ? cb : null;
}

function blocks(src: string, path: string): Map<string, TestBlock[]> {
  const out = new Map<string, TestBlock[]>();
  if (langOf(path) !== 'js') return out;

  try {
    const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, scriptKindForPath(path));

    const visit = (node: ts.Node, suites: string[]): void => {
      if (ts.isCallExpression(node)) {
        const call = simpleCallName(node);
        const title = literalTitle(node.arguments[0]);
        const cb = callbackFor(node);

        if (call && SUITE_CALLS.has(call) && title !== null && cb) {
          const nextSuites = [...suites, title];
          ts.forEachChild(cb, (child) => visit(child, nextSuites));
          return;
        }

        if (call && TEST_CALLS.has(call) && title !== null && cb) {
          const assertions: Assertion[] = [];
          const collect = (child: ts.Node): void => {
            if (child !== cb && ts.isCallExpression(child)) {
              const nestedCall = simpleCallName(child);
              if (nestedCall && (TEST_CALLS.has(nestedCall) || SUITE_CALLS.has(nestedCall))) {
                return;
              }
            }
            if (ts.isCallExpression(child)) {
              const a = expectAssertion(child, sf);
              if (a) assertions.push(a);
            }
            ts.forEachChild(child, collect);
          };
          collect(cb);

          const identity = [...suites, title].join(' > ');
          const list = out.get(identity) ?? [];
          list.push({ title, identity, assertions });
          out.set(identity, list);
          return;
        }
      }

      ts.forEachChild(node, (child) => visit(child, suites));
    };

    visit(sf, []);
  } catch {
    // Heuristic detector: malformed/unsupported source is not evidence of this
    // rule. Other syntax/verification boundaries fail closed where appropriate.
  }
  return out;
}

function pureRemoval(before: Assertion[], after: Assertion[]): Assertion | null {
  if (after.length >= before.length) return null;
  const remaining = new Map<string, number>();
  for (const a of before) remaining.set(a.canonical, (remaining.get(a.canonical) ?? 0) + 1);

  for (const a of after) {
    const n = remaining.get(a.canonical) ?? 0;
    if (n <= 0) return null; // replacement/rewrite, not pure removal
    remaining.set(a.canonical, n - 1);
  }

  for (const a of before) {
    const n = remaining.get(a.canonical) ?? 0;
    if (n > 0) return a;
  }
  return null;
}

function factsProveWeakMatcher(oldA: Assertion, newMatcher: string): boolean {
  if (!EXACT_MATCHERS.has(oldA.matcher) || oldA.args.length !== 1) return false;

  // toMatchObject with an object literal proves a defined/truthy received value
  // even though the expected object is not an equality value.
  const facts = oldA.firstArgFacts;
  if (!facts) return false;
  if (newMatcher === 'toBeDefined') return facts.defined;
  if (newMatcher === 'toBeTruthy') return facts.truthy === true;
  return false;
}

function directionalWeakening(before: Assertion[], after: Assertion[]): {
  before: Assertion;
  after: Assertion;
  kind: 'matcher' | 'throw-specificity';
} | null {
  for (const oldA of before) {
    for (const newA of after) {
      if (oldA.subject !== newA.subject) continue;

      // The direction rules below are proven only for positive assertions.
      // Under .not, removing specificity can strengthen or invert the contract.
      if (oldA.polarity !== '' || newA.polarity !== '') continue;

      if (
        WEAK_MATCHERS.has(newA.matcher) &&
        newA.args.length === 0 &&
        factsProveWeakMatcher(oldA, newA.matcher)
      ) {
        return { before: oldA, after: newA, kind: 'matcher' };
      }

      if (
        oldA.matcher === 'toThrow' &&
        oldA.args.length > 0 &&
        newA.matcher === 'toThrow' &&
        newA.args.length === 0
      ) {
        return { before: oldA, after: newA, kind: 'throw-specificity' };
      }
    }
  }
  return null;
}

function findingForBlock(
  path: string,
  before: TestBlock,
  after: TestBlock,
  policy: Policy,
): Finding | null {
  const weakened = directionalWeakening(before.assertions, after.assertions);
  if (weakened) {
    const message =
      weakened.kind === 'throw-specificity'
        ? `Assertion weakened in test "${before.identity}": exception-message specificity was removed from toThrow().`
        : `Assertion weakened in test "${before.identity}": ${weakened.before.matcher} was replaced by weaker ${weakened.after.matcher} on the same subject.`;
    return makeFinding(RULE, policy, {
      file: path,
      message,
      evidence: `${weakened.before.text} -> ${weakened.after.text}`,
      remediation:
        'Keep the stronger expectation and fix the code under test. If the contract genuinely changed, review the test change explicitly; this rule is warning-only while its precision is measured.',
    });
  }

  const removed = pureRemoval(before.assertions, after.assertions);
  if (removed) {
    return makeFinding(RULE, policy, {
      file: path,
      message: `Assertion removed from kept test "${before.identity}" without a replacement assertion.`,
      evidence: removed.text,
      remediation:
        'Keep the assertion and fix the code under test. If the assertion is genuinely obsolete, review the test change explicitly; this rule is warning-only while its precision is measured.',
    });
  }
  return null;
}

export const assertionWeakening: Detector = {
  id: RULE,
  surface: ['file'],
  certainty: 'heuristic',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];
    for (const c of changes) {
      if (
        c.kind !== 'file' ||
        (c.op !== 'modify' && c.op !== 'rename') ||
        c.before == null ||
        c.after == null ||
        langOf(c.path) !== 'js' ||
        !isProtected(c.path, policy, 'tests') ||
        isProtected(c.path, policy, 'snapshots')
      ) {
        continue;
      }

      const beforeBlocks = blocks(c.before, c.path);
      const afterBlocks = blocks(c.after, c.path);

      for (const [identity, oldList] of beforeBlocks) {
        const newList = afterBlocks.get(identity);

        // Ambiguous identity is not evidence. Do not pair duplicate titles by
        // array position; a suite reorder would manufacture a false warning.
        if (!newList || oldList.length !== 1 || newList.length !== 1) continue;

        const f = findingForBlock(c.path, oldList[0], newList[0], policy);
        if (f) out.push(f);
      }
    }
    return out;
  },
};
