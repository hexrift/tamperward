// #1 test-deletion (file + command surface, mechanical, AST).
// The class, not the flag — a test disappears whether by deleting the file, renaming
// it out of the glob, removing it()/test() blocks inside it, stripping it from the
// shell (rm/sed/truncate/redirect/mv-out and their spellings), or telling the runner
// not to open it (a narrowed testMatch / include, a grown ignore / exclude list).
//
// The block count uses the TS AST, not a line regex: `it(` in a comment or string, or
// "describe what it does" in a test name, must not register as a test. A false-firing
// BLOCK rule is poison, so this one is parsed properly.

import ts from 'typescript';
import { Change, Detector, DetectorContext, Finding, Policy } from '../types';
import { isProtected } from '../policy';
import { makeFinding } from './finding';
import { segments, tokens, unquote } from './command';
import { Lang, isSignificantLine, langOf } from './files';
import { containsProtected, trackedFiles } from './repo';
import { CANONICAL_SAMPLES, runnerOf, suiteNarrowings } from './suite-config';

const RULE = 'test-deletion';

// Test definitions per language, for the block count. The TS AST does the
// JavaScript case; these are the equivalent definition sites elsewhere, matched
// at line start where each ecosystem's convention puts them. Counting the same
// way on both sides is what matters: a definition that disappears is a deletion.
// JVM annotations may share the line: `@Timeout(5) @Test void adds()` is still
// one test, so the anchor allows any run of annotations before the test one.
const JVM_TEST = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/;
const TEST_DEFS: Record<Exclude<Lang, 'js'>, RegExp> = {
  py: /^\s*(?:async\s+)?def\s+test\w*\s*\(/,
  go: /^func\s+(?:Test|Example|Fuzz)\w*\s*\(/,
  rs: /^\s*#\[[\w:]*test[\w:]*(?:\(|\])/,
  rb: /^\s*(?:(?:it|specify|test|scenario|example)\s*(?:\(\s*)?['"]|def\s+test_\w+)/,
  java: JVM_TEST,
  kt: JVM_TEST,
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

const isEachOf = (expr: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(expr) &&
  ts.isIdentifier(expr.expression) &&
  (expr.expression.text === 'it' || expr.expression.text === 'test') &&
  expr.name.text === 'each';

/** How many tests an `it.each(table)` defines: one per row of a literal table.
 *  `open` when the table cannot be counted (an identifier, a spread, a call): the
 *  count is then a lower bound, and a comparison against it is not a comparison.
 *  Two `it()`s folded into one two-row `it.each` is the same suite, and a row
 *  deleted from a five-row table is a deleted test — both need rows counted. */
function eachRows(call: ts.CallExpression): { n: number; open: boolean } {
  const arg = call.arguments[0];
  if (!arg) return { n: 1, open: true };
  if (ts.isArrayLiteralExpression(arg)) {
    let n = 0;
    let open = false;
    for (const el of arg.elements) {
      if (ts.isSpreadElement(el)) open = true;
      else n++;
    }
    return { n: Math.max(n, open ? 0 : 1), open };
  }
  return { n: 1, open: true };
}

export interface TestCount {
  /** Tests defined, counting a literal each-table's rows individually. */
  min: number;
  /** Some each-table could not be counted; `min` is a lower bound only. */
  open: boolean;
}

/** Count test definitions — it()/test() via the AST for JS/TS, the language's own
 *  definition sites otherwise. Skips/onlys still count as present. */
export function countTests(src: string, path = 'spec.ts'): TestCount {
  const lang = langOf(path);
  if (lang && lang !== 'js') {
    const re = TEST_DEFS[lang];
    let n = 0;
    for (const line of src.split('\n')) if (re.test(line)) n++;
    return { min: n, open: false };
  }
  const sf = ts.createSourceFile('spec.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let n = 0;
  let open = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (isEachOf(node.expression)) {
        const r = eachRows(node);
        n += r.n;
        if (r.open) open = true;
      } else {
        const name = calleeName(node.expression);
        if (name === 'it' || name === 'test') n++;
      }
    } else if (ts.isTaggedTemplateExpression(node) && isEachOf(node.tag)) {
      // it.each`a | b\n 1 | 2\n 3 | 4`: header row, then one test per data row
      const rows = node.template.getText().split('\n').filter((l) => /\S/.test(l.replace(/[`]/g, ''))).length - 1;
      n += Math.max(rows, 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { min: n, open };
}

/** The lower-bound count alone — the shape older callers and tests read. */
export function countTestBlocks(src: string, path = 'spec.ts'): number {
  return countTests(src, path).min;
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

const OTHER_RUNNER_DIR = /(?:^|\/)(?:e2e|cypress|playwright)\//;

/** The protected JS/TS test files a runner config governs, from the repository listing
 *  when one is available, else the conventional layouts. */
function runnerSamples(configPath: string, policy: Policy, ctx?: DetectorContext): string[] {
  const files = trackedFiles(ctx);
  if (!files) return CANONICAL_SAMPLES;
  // the runner's rootDir is the config's directory: paths are relative to it
  const root = configPath.includes('/') ? configPath.slice(0, configPath.lastIndexOf('/') + 1) : '';
  // Specs under e2e/, cypress/, playwright/ belong to another runner: excluding them
  // from vitest or jest is how those repositories are set up, not a narrowing.
  const own = files
    .filter((f) => f.startsWith(root) && langOf(f) === 'js' && isProtected(f, policy, 'tests') && !OTHER_RUNNER_DIR.test(f))
    .map((f) => f.slice(root.length));
  return own.length ? own : CANONICAL_SAMPLES;
}

/** `root` joined with a relative `cd` target, `..` resolved; null when it escapes. */
function joinRoot(root: string, to: string): string | null {
  const parts = root ? root.split('/') : [];
  for (const seg of to.replace(/\/+$/, '').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether moving directory `dir` to `dest` takes any protected spec under it out of
 *  the glob. Decidable only with a repository listing; unknown reads as "no". */
function leavesGlob(dir: string, dest: string, policy: Policy, ctx?: DetectorContext): boolean {
  const files = trackedFiles(ctx);
  if (!files || !dir) return false;
  const src = dir.replace(/^\.\//, '').replace(/\/+$/, '') + '/';
  const to = dest.replace(/^\.\//, '').replace(/\/+$/, '') + '/';
  return files.some((f) => f.startsWith(src) && isProtected(f, policy, 'tests') && !isProtected(to + f.slice(src.length), policy, 'tests'));
}

// Shell spellings that erase or replace a protected spec. Each is a distinct
// command with the file in WRITE position; a command that merely reads the file
// (cat, grep, diff, cp FROM it) is not here.
const SED_INPLACE = /(?:^|\s)(?:-i\b|--in-place\b|-[a-zA-Z]*i[a-zA-Z]*\b)/;

export const testDeletion: Detector = {
  id: RULE,
  surface: ['file', 'command'],
  certainty: 'mechanical',
  run(changes: Change[], policy, _view, ctx): Finding[] {
    const out: Finding[] = [];

    // Pool the lines ADDED to protected specs in this changeset — whole files that
    // were added, plus the new lines of modified ones — to recognise relocations.
    // Pooling only added FILES read a merge (`mul.test.ts` folded into the existing
    // `calc.test.ts`) as a deletion and a split (two tests moved out of a spec into
    // a new one) as a block drop: the tests were right there in the same change.
    const addedTestLines = new Set<string>();
    let addedTestBlocks = 0;
    for (const c of changes) {
      if (c.kind !== 'file' || c.after == null || !isProtected(c.path, policy, 'tests')) continue;
      if (c.op === 'add') {
        for (const l of significantLines(c.after, c.path)) addedTestLines.add(l);
        addedTestBlocks += countTestBlocks(c.after, c.path);
      } else if (c.before != null) {
        const before = significantLines(c.before, c.path);
        for (const l of significantLines(c.after, c.path)) if (!before.has(l)) addedTestLines.add(l);
        addedTestBlocks += Math.max(0, countTestBlocks(c.after, c.path) - countTestBlocks(c.before, c.path));
      }
    }
    /** ≥60% of the removed lines reappear in added test content AND enough blocks were
     *  added elsewhere to hold the removed ones (the block-count guard stops a "move
     *  that guts assertions" from being excused). */
    const isRelocation = (removed: Set<string>, blocksRemoved: number): boolean => {
      if (removed.size === 0 || addedTestLines.size === 0) return false;
      let hit = 0;
      for (const l of removed) if (addedTestLines.has(l)) hit++;
      return hit / removed.size >= 0.6 && addedTestBlocks >= blocksRemoved;
    };

    for (const c of changes) {
      if (c.kind === 'file') {
        const isTest = isProtected(c.path, policy, 'tests');

        if (c.op === 'delete' && isTest) {
          if (c.before != null && isRelocation(significantLines(c.before, c.path), countTestBlocks(c.before, c.path))) continue; // moved, not deleted
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
          const before = countTests(c.before, c.path);
          const after = countTests(c.after, c.path);
          // An open after-count (an each-table now spread from elsewhere) is a lower
          // bound: it cannot be shown smaller. Its rows are test-content-removal's.
          if (after.min < before.min && !after.open) {
            const afterLines = significantLines(c.after, c.path);
            const removed = new Set([...significantLines(c.before, c.path)].filter((l) => !afterLines.has(l)));
            if (isRelocation(removed, before.min - after.min)) continue; // split into another spec
            out.push(
              makeFinding(RULE, policy, {
                file: c.path,
                message: `Test blocks removed: ${before.min} → ${after.min} it()/test() in this spec (each-table rows count as tests).`,
                evidence: `${before.min - after.min} test block(s) removed from ${c.path}`,
                remediation: 'Keep the assertions and fix the code. Removing test blocks to go green is the tamper.',
              }),
            );
          }
        } else if (c.op !== 'delete' && c.after != null && !isTest && isProtected(c.path, policy, 'config') && runnerOf(c.path)) {
          // The runner's selection config: a protected spec the runner opened before
          // and will not open after is out of the suite as surely as if deleted.
          for (const n of suiteNarrowings(c.before, c.after, c.path, runnerSamples(c.path, policy, ctx))) {
            out.push(
              makeFinding(RULE, policy, {
                file: c.path,
                message: `The runner no longer selects ${n.path}: ${n.reason}.`,
                evidence: `${n.path} dropped from the suite by ${c.path}`,
                remediation:
                  'Keep the runner pointed at the whole suite. Excluding a spec from the runner removes its tests without touching the file.',
              }),
            );
          }
        }
      } else {
        // `cd packages/a && rm test/x.test.ts`: the repository listing is consulted at
        // the path the command actually names, so a `cd` earlier in the line moves the
        // resolution root. An absolute or home-relative cd makes the root unknown, and
        // an unknown root falls back to the glob-only reading.
        let root: string | null = '';
        for (const seg of segments(c.raw)) {
          const toks = tokens(seg).map(unquote);
          const cdTo = toks[0] === 'cd' ? toks[1] : null;
          if (cdTo !== null) {
            root = cdTo === undefined || /^[/~$]/.test(cdTo) || root === null ? null : joinRoot(root, cdTo);
            continue;
          }
          const inRepo = (t: string) => (root ? `${root}/${t}` : t);
          const listing = trackedFiles(ctx);
          // A path token is protected when it matches a test glob — whether or not it
          // exists, so a spec named from a cwd the hook cannot see stays covered. The
          // one exception is a token that matches only as a DIRECTORY (`dist/__tests__`,
          // no extension, not a tracked file): then the repository listing decides, so a
          // build output nobody protects is not the suite. (see ./repo.ts)
          const testToks = toks.filter((t) => {
            if (!isProtected(t, policy, 'tests')) return false;
            if (!listing || root === null) return true;
            const looksLikeFile = /\.[A-Za-z0-9]+$/.test(t.split('/').pop() ?? '');
            if (looksLikeFile || listing.includes(inRepo(t))) return true;
            return containsProtected(inRepo(t), policy, 'tests', ctx);
          });
          // A directory token counts when a protected spec lives under it: `rm -rf test`
          // erases the suite while naming no spec; `rm -rf dist/__tests__` names an
          // ignored build output and is left alone.
          const dirToks = toks.filter(
            (t) =>
              !t.startsWith('-') &&
              !testToks.includes(t) &&
              !/[*?{}[\]]/.test(t) &&
              (root === null ? containsProtected(t, policy, 'tests', ctx) : containsProtected(inRepo(t), policy, 'tests', ctx)),
          );
          if (testToks.length === 0 && dirToks.length === 0) continue;
          const named = [...testToks, ...dirToks];
          const cmd = toks[0] ?? '';

          let why: string | null = null;
          let evidence = seg;

          // a redirect only tampers if its TARGET is the test (`cat x.spec.ts > /tmp/y`
          // reads the test and writes elsewhere — not a tamper)
          const redirectTarget = seg.match(/>\s*(\S+)/)?.[1];
          const redirectsOntoTest = redirectTarget ? isProtected(unquote(redirectTarget), policy, 'tests') : false;
          const findDeletes = cmd === 'find' && /\s(?:-delete\b|-exec\s+(?:rm|unlink)\b|-execdir\s+(?:rm|unlink)\b)/.test(seg);
          const gitRestoresOld =
            cmd === 'git' &&
            /^git\s+(?:checkout|restore)\b/.test(seg) &&
            (() => {
              const src = seg.match(/--source[= ]\s*(\S+)/)?.[1];
              const rev = src ?? toks.slice(2).find((t) => !t.startsWith('-') && !named.includes(t) && t !== '--');
              // `git checkout -- x.test.ts` discards the agent's own edits; a REV
              // other than HEAD puts back an older version of the spec.
              return !!rev && rev !== 'HEAD' && (!!src || seg.includes(' -- '));
            })();

          if (/\brm\b/.test(seg) && !/^(?:git|npm|yarn|pnpm|bun)\b/.test(seg)) {
            why = 'rm deletes a test file';
          } else if (cmd === 'git' && /^git\s+rm\b/.test(seg)) {
            why = 'git rm deletes a test file';
          } else if (cmd === 'sed' && SED_INPLACE.test(seg)) {
            why = 'sed -i rewrites a test file in place';
          } else if (cmd === 'perl' && /(?:^|\s)-[a-zA-Z]*i\b|\s-i\S*/.test(seg)) {
            why = 'perl -i rewrites a test file in place';
          } else if (/\btruncate\b/.test(seg)) {
            why = 'truncate empties a test file';
          } else if (redirectsOntoTest) {
            why = 'a redirect overwrites/empties a test file';
          } else if (cmd === 'cp' && testToks.length > 0 && isProtected(toks[toks.length - 1] ?? '', policy, 'tests') && !isProtected(toks[toks.length - 2] ?? '', policy, 'tests')) {
            why = 'cp overwrites a test file with something else';
          } else if (cmd === 'tee' && !toks.includes('-a') && !toks.includes('--append')) {
            why = 'tee overwrites a test file';
          } else if (findDeletes) {
            why = 'find -delete removes test files';
          } else if (gitRestoresOld) {
            why = 'git checkout <rev> replaces a test file with an older version';
          } else if (/\bmv\b/.test(seg)) {
            const dest = toks[toks.length - 1];
            if (dest && testToks.length > 0 && !isProtected(dest, policy, 'tests')) {
              why = 'mv renames a test file out of the test glob';
              evidence = `${testToks[0]} → ${dest}`;
            } else if (dest && testToks.length === 0 && dirToks[0] !== dest && leavesGlob(dirToks[0] ?? '', dest, policy, ctx)) {
              // a moved DIRECTORY only tampers when its specs land outside the glob
              why = 'mv renames a test directory so its specs leave the test glob';
              evidence = `${dirToks[0]} → ${dest}`;
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
