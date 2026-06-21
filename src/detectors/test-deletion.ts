// #1 test-deletion (file + command surface, mechanical, AST).
// The class, not the flag — a test disappears whether by deleting the file, renaming
// it out of the glob, removing it()/test() blocks inside it, or stripping it from the
// shell (rm/sed/truncate/redirect/mv-out).
//
// The block count uses the TS AST, not a line regex: `it(` in a comment or string, or
// "describe what it does" in a test name, must not register as a test. A false-firing
// BLOCK rule is poison, so this one is parsed properly.

import ts from 'typescript';
import { Change, Detector, Finding } from '../types';
import { isProtected } from '../policy';
import { makeFinding } from './finding';
import { segments, tokens, unquote } from './command';

const RULE = 'test-deletion';

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text; // it(...)
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    return expr.expression.text; // it.skip(...), it.each(...), test.only(...)
  }
  // NOT recursing into a CallExpression callee on purpose: `it.each(table)(body)`
  // is two nested calls, and the inner `it.each(table)` already counts as the one
  // test definition. Recursing would count the outer invocation a second time.
  return null;
}

/** Count it()/test() invocations via the AST — skips/onlys still count as present. */
export function countTestBlocks(src: string): number {
  const sf = ts.createSourceFile('spec.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let n = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name === 'it' || name === 'test') n++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

export const testDeletion: Detector = {
  id: RULE,
  surface: ['file', 'command'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];

    for (const c of changes) {
      if (c.kind === 'file') {
        const isTest = isProtected(c.path, policy, 'tests');

        if (c.op === 'delete' && isTest) {
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              message: 'A test file was deleted.',
              evidence: c.path,
              remediation: 'Fix the code under test, not the suite. Deleting a failing test to pass is the move this blocks.',
            }),
          );
        } else if (
          c.op === 'rename' &&
          c.oldPath &&
          isProtected(c.oldPath, policy, 'tests') &&
          !isTest
        ) {
          // renamed OUT of the test glob — a deletion git would otherwise hide
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              message: `A test file was renamed out of the test glob (${c.oldPath} → ${c.path}).`,
              evidence: `${c.oldPath} → ${c.path}`,
              remediation: 'Restoring the path. Renaming a spec out of the glob silently removes it from the suite.',
            }),
          );
        } else if (c.op === 'modify' && isTest && c.before != null && c.after != null) {
          const before = countTestBlocks(c.before);
          const after = countTestBlocks(c.after);
          if (after < before) {
            out.push(
              makeFinding(RULE, policy, {
                file: c.path,
                message: `Test blocks removed: ${before} → ${after} it()/test() in this spec.`,
                evidence: `${before - after} test block(s) removed from ${c.path}`,
                remediation: 'Keep the assertions and fix the code. Removing test blocks to go green is the tamper.',
              }),
            );
          }
        }
      } else {
        for (const seg of segments(c.raw)) {
          const toks = tokens(seg).map(unquote);
          const testToks = toks.filter((t) => isProtected(t, policy, 'tests'));
          if (testToks.length === 0) continue;

          let why: string | null = null;
          let evidence = seg;

          // a redirect only tampers if its TARGET is the test (`cat x.spec.ts > /tmp/y`
          // reads the test and writes elsewhere — not a tamper)
          const redirectTarget = seg.match(/>\s*(\S+)/)?.[1];
          const redirectsOntoTest = redirectTarget ? isProtected(unquote(redirectTarget), policy, 'tests') : false;

          if (/\brm\b/.test(seg)) {
            why = 'rm deletes a test file';
          } else if (/\bsed\b/.test(seg) && /(?:^|\s)-i\b/.test(seg)) {
            why = 'sed -i rewrites a test file in place';
          } else if (/\btruncate\b/.test(seg)) {
            why = 'truncate empties a test file';
          } else if (redirectsOntoTest) {
            why = 'a redirect overwrites/empties a test file';
          } else if (/\bmv\b/.test(seg)) {
            const dest = toks[toks.length - 1];
            if (dest && !isProtected(dest, policy, 'tests')) {
              why = 'mv renames a test file out of the test glob';
              evidence = `${testToks[0]} → ${dest}`;
            }
          }

          if (why) {
            out.push(
              makeFinding(RULE, policy, {
                message: `Test removed via shell: ${why}.`,
                evidence,
                remediation:
                  'Fix the code under test. Mutating a spec from the shell is still deleting the test — and is blocked the same way.',
              }),
            );
          }
        }
      }
    }
    return out;
  },
};
