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
import { Lang, isSignificantLine, langOf } from './files';

const RULE = 'test-deletion';

// Test definitions per language, for the block count. The TS AST does the
// JavaScript case; these are the equivalent definition sites elsewhere, matched
// at line start where each ecosystem's convention puts them. Counting the same
// way on both sides is what matters: a definition that disappears is a deletion.
const TEST_DEFS: Record<Exclude<Lang, 'js'>, RegExp> = {
  py: /^\s*(?:async\s+)?def\s+test\w*\s*\(/,
  go: /^func\s+(?:Test|Example|Fuzz)\w*\s*\(/,
  rs: /^\s*#\[[\w:]*test[\w:]*(?:\(|\])/,
  rb: /^\s*(?:(?:it|specify|test|scenario|example)\s*(?:\(\s*)?['"]|def\s+test_\w+)/,
  java: /^\s*@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/,
  kt: /^\s*@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/,
  php: /^\s*(?:(?:public\s+)?function\s+test\w*\s*\(|#\[Test\]|\*\s*@test\b)/,
  cs: /^\s*\[(?:Fact|Theory|Test|TestMethod|TestCase|DataTestMethod)\b/,
};

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

/** Count test definitions — it()/test() via the AST for JS/TS, the language's own
 *  definition sites otherwise. Skips/onlys still count as present. */
export function countTestBlocks(src: string, path = 'spec.ts'): number {
  const lang = langOf(path);
  if (lang && lang !== 'js') {
    const re = TEST_DEFS[lang];
    let n = 0;
    for (const line of src.split('\n')) if (re.test(line)) n++;
    return n;
  }
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

/** Significant content lines (test bodies/assertions), ignoring imports/comments/bare braces.
 *  Used to detect a RELOCATION: a deleted test whose content reappears in a test file ADDED in
 *  the same changeset is a move, not a tamper (multi-repo FP study: hono#59, nest#25 were real
 *  relocations git didn't link). Line-overlap resists the empty-stub dodge (a stub shares ~none). */
function significantLines(src: string, path: string): Set<string> {
  const out = new Set<string>();
  const lang = langOf(path);
  for (const raw of src.split('\n')) {
    const l = raw.trim();
    if (isSignificantLine(l, lang)) out.add(l);
  }
  return out;
}

export const testDeletion: Detector = {
  id: RULE,
  surface: ['file', 'command'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];

    // Pool test files ADDED in this changeset, to recognize relocations of deleted tests.
    const addedTestLines = new Set<string>();
    let addedTestBlocks = 0;
    for (const c of changes) {
      if (c.kind === 'file' && c.op === 'add' && c.after != null && isProtected(c.path, policy, 'tests')) {
        for (const l of significantLines(c.after, c.path)) addedTestLines.add(l);
        addedTestBlocks += countTestBlocks(c.after, c.path);
      }
    }
    const isRelocation = (before: string, path: string): boolean => {
      const sig = significantLines(before, path);
      if (sig.size === 0 || addedTestLines.size === 0) return false;
      let hit = 0;
      for (const l of sig) if (addedTestLines.has(l)) hit++;
      // ≥60% of the deleted test's body reappears in added tests AND no blocks were dropped in
      // the move (the block-count guard stops a "move that guts assertions" from being excused).
      return hit / sig.size >= 0.6 && addedTestBlocks >= countTestBlocks(before, path);
    };

    for (const c of changes) {
      if (c.kind === 'file') {
        const isTest = isProtected(c.path, policy, 'tests');

        if (c.op === 'delete' && isTest) {
          if (c.before != null && isRelocation(c.before, c.path)) continue; // moved, not deleted
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
        } else if ((c.op === 'modify' || c.op === 'rename') && isTest && c.before != null && c.after != null) {
          // A rename WITHIN the glob is content-inspected exactly like a modify.
          // Gating this on 'modify' alone let `git mv spec.js spec2.js` carry an
          // arbitrary block deletion past the rule: git -M links the pair, the
          // rename-out branch above does not fire (the new path is still a test),
          // and nothing compared the bodies. (P0-7, external review.)
          const before = countTestBlocks(c.before, c.path);
          const after = countTestBlocks(c.after, c.path);
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
