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
import { containsProtected, revIsHead, trackedFiles } from './repo';
import { CANONICAL_SAMPLES, PYTEST_CANONICAL_SAMPLES, effectivePytestConfig, runnerOf, suiteNarrowings } from './suite-config';
import type { Runner } from './suite-config';
import { SUITE_NARROWING_FLAGS } from './ci-tampering';

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

// `it.each(table)` and vitest 3's `it.for(table)` define one test per row alike —
// `for` differs only in how the row reaches the callback.
const TABLE_METHOD = /^(?:each|for)$/;

const isEachOf = (expr: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(expr) &&
  ts.isIdentifier(expr.expression) &&
  (expr.expression.text === 'it' || expr.expression.text === 'test') &&
  TABLE_METHOD.test(expr.name.text);

const isDescribeEach = (expr: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'describe' && TABLE_METHOD.test(expr.name.text);

/** The rows a loop runs its body over: a literal array is counted (`for (const n of
 *  [1, 2, 3])`, `[1, 2, 3].forEach(...)`), anything else is open. */
function loopRows(iterable: ts.Expression): { n: number; open: boolean } {
  if (ts.isArrayLiteralExpression(iterable)) {
    let n = 0;
    let open = false;
    for (const el of iterable.elements) {
      if (ts.isSpreadElement(el)) open = true;
      else n++;
    }
    return { n: Math.max(n, open ? 0 : 1), open };
  }
  return { n: 1, open: true };
}

/** Rows of an each-TEMPLATE table: the header row, then one test per data row. */
function templateRows(node: ts.TaggedTemplateExpression): number {
  const rows = node.template.getText().split('\n').filter((l) => /\S/.test(l.replace(/[`]/g, ''))).length - 1;
  return Math.max(rows, 1);
}

/** Whether a test call carries a body with at least one significant line. A stub —
 *  `it("noop", () => {})` — defines a test that tests nothing, and a relocation
 *  that "moves" three tests into three stubs moved no test. A test whose body is
 *  not a function literal (`it("x", fn)`) cannot be judged and counts as real. */
function hasSubstantiveBody(call: ts.CallExpression): boolean {
  const fn = call.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
  if (!fn) return true;
  const body = (fn as ts.ArrowFunction | ts.FunctionExpression).body;
  const text = ts.isBlock(body) ? body.getText().slice(1, -1) : body.getText();
  return text.split('\n').some((l) => isSignificantLine(l.trim(), 'js'));
}

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
 *  definition sites otherwise. Skips/onlys still count as present. A test inside
 *  `describe.each(table)` runs once per row, so it counts once per row: three rows
 *  cut to one is two tests gone with no `it()` touched. A test inside a loop over a
 *  literal array (`for (const n of [1, 2, 3])`, `[1, 2, 3].forEach`) is the same
 *  suite written by hand — `describe.each([[1], [2], [3]])` rewritten as that loop
 *  is three tests on both sides; a loop over anything else is open. With
 *  `substantiveOnly`, a JS test whose function body has no significant line (a
 *  stub) is not counted. */
export function countTests(src: string, path = 'spec.ts', substantiveOnly = false): TestCount {
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
  const visit = (node: ts.Node, mult: number): void => {
    if (ts.isForOfStatement(node)) {
      const r = loopRows(node.expression);
      if (r.open) open = true;
      visit(node.statement, mult * r.n);
      return;
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      open = true; // a body run an unknown number of times: counted once, as a floor
    }
    if (ts.isCallExpression(node)) {
      // [rows].forEach((row) => { it(...) }): the callback runs once per element
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'forEach') {
        const r = loopRows(callee.expression);
        if (r.open) open = true;
        for (const a of node.arguments) visit(a, mult * r.n);
        return;
      }
      // describe.each(table)(name, fn) / describe.each`…`(name, fn): the enclosed
      // tests are multiplied by the row count
      const head = node.expression;
      if (ts.isCallExpression(head) && isDescribeEach(head.expression)) {
        const r = eachRows(head);
        if (r.open) open = true;
        for (const a of node.arguments) visit(a, mult * r.n);
        return;
      }
      if (ts.isTaggedTemplateExpression(head) && isDescribeEach(head.tag)) {
        for (const a of node.arguments) visit(a, mult * templateRows(head));
        return;
      }
      if (isEachOf(node.expression)) {
        const r = eachRows(node);
        n += r.n * mult;
        if (r.open) open = true;
      } else {
        const name = calleeName(node.expression);
        if ((name === 'it' || name === 'test') && (!substantiveOnly || hasSubstantiveBody(node))) n += mult;
      }
    } else if (ts.isTaggedTemplateExpression(node) && isEachOf(node.tag)) {
      // it.each`a | b\n 1 | 2\n 3 | 4`: header row, then one test per data row
      n += templateRows(node) * mult;
    }
    ts.forEachChild(node, (c) => visit(c, mult));
  };
  visit(sf, 1);
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

// Specs under another runner's directory, or sample specs kept as fixtures / mocks
// for the tooling under test: the runner is SUPPOSED to skip them.
const OTHER_RUNNER_DIR = /(?:^|\/)(?:e2e|cypress|playwright|fixtures|__fixtures__|__mocks__)\//;

/** The protected JS/TS test files a runner config governs, from the repository listing
 *  when one is available, else the conventional layouts. */
function runnerSamples(configPath: string, policy: Policy, ctx?: DetectorContext, runner?: Runner | null): string[] {
  // The samples must be in the RUNNER's language: a pytest config judged against a
  // list of .ts specs selects nothing on either side, so every narrowing would be
  // invisible. (Found end-to-end: the unit model was right and the integration
  // still reported clean.)
  const lang = runner === 'pytest' ? 'py' : 'js';
  const fallback = runner === 'pytest' ? PYTEST_CANONICAL_SAMPLES : CANONICAL_SAMPLES;
  const files = trackedFiles(ctx);
  if (!files) return fallback;
  // the runner's rootDir is the config's directory: paths are relative to it
  const root = configPath.includes('/') ? configPath.slice(0, configPath.lastIndexOf('/') + 1) : '';
  // Specs under e2e/, cypress/, playwright/ belong to another runner: excluding them
  // from vitest or jest is how those repositories are set up, not a narrowing.
  const own = files
    .filter((f) => f.startsWith(root) && langOf(f) === lang && isProtected(f, policy, 'tests') && (lang !== 'js' || !OTHER_RUNNER_DIR.test(f)))
    .map((f) => f.slice(root.length));
  return own.length ? own : fallback;
}

interface ScriptNarrowing {
  script: string;
  flag: string;
  before: string;
  after: string;
}

/** The scripts that run THE suite: `npm test` and its CI twin. `test:unit` /
 *  `test:browser` with `--project`, `test:watch --changed`, `test:staged
 *  --findRelatedTests` are deliberately partial runs beside the whole one — their
 *  flags select a slice by design and narrow nothing anyone relies on. */
const WHOLE_SUITE_SCRIPT = /^test(?::ci)?$/;

/** `--exclude e2e/**` in the test script is the same set-up as `test.exclude:
 *  ['e2e/**']` in the config: another runner's directory, not a narrowing. */
function excludesOtherRunner(flag: string, cmd: string): boolean {
  if (flag !== '--exclude') return false;
  const values = [...cmd.matchAll(/--exclude(?:=|\s+)(['"]?)(\S+?)\1(?=\s|$)/g)].map((m) => m[2]);
  return values.length > 0 && values.every((v) => OTHER_RUNNER_DIR.test(v.replace(/^\.\//, '').replace(/(?:\/\*+)*\/?$/, '') + '/'));
}

/** A runner flag that selects fewer specs, newly present in the `scripts.test`
 *  entry of package.json that invokes jest or vitest. */
function scriptNarrowings(before: string | null, after: string, path: string): ScriptNarrowing[] {
  if ((path.split('/').pop() ?? path) !== 'package.json') return [];
  const scriptsOf = (src: string | null): Record<string, string> => {
    try {
      const s = (JSON.parse(src ?? '{}') as { scripts?: Record<string, unknown> }).scripts ?? {};
      return Object.fromEntries(Object.entries(s).filter((e): e is [string, string] => typeof e[1] === 'string'));
    } catch {
      return {};
    }
  };
  const was = scriptsOf(before);
  const now = scriptsOf(after);
  const out: ScriptNarrowing[] = [];
  for (const [name, cmd] of Object.entries(now)) {
    if (!WHOLE_SUITE_SCRIPT.test(name) || !/\b(?:jest|vitest)\b/.test(cmd)) continue;
    const prev = was[name] ?? '';
    const flags = new RegExp(SUITE_NARROWING_FLAGS.source, 'g');
    for (const m of cmd.matchAll(flags)) {
      const flag = m[0].trim();
      if (!flag) continue;
      const one = new RegExp(SUITE_NARROWING_FLAGS.source);
      // the flag was there already (a reformat, an unrelated edit): not an addition
      if (one.test(prev) && prev.includes(flag)) continue;
      if (excludesOtherRunner(flag, cmd)) continue;
      out.push({ script: name, flag, before: prev, after: cmd });
      break;
    }
  }
  return out;
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
    // A recorded expectation is not a spec, wherever it lives: jest's default layout
    // puts `__snapshots__/*.snap` INSIDE `__tests__/`, where the tests glob claims it,
    // and deleting an obsolete snapshot there is snapshot-rewrite's warn (its own
    // measured severity), not a deleted test file.
    const isSpec = (p: string) => isProtected(p, policy, 'tests') && !isProtected(p, policy, 'snapshots');

    // Pool the lines ADDED to protected specs in this changeset — whole files that
    // were added, plus the new lines of modified ones — to recognise relocations.
    // Pooling only added FILES read a merge (`mul.test.ts` folded into the existing
    // `calc.test.ts`) as a deletion and a split (two tests moved out of a spec into
    // a new one) as a block drop: the tests were right there in the same change.
    const addedTestLines = new Set<string>();
    let addedTestBlocks = 0;
    for (const c of changes) {
      if (c.kind !== 'file' || c.after == null || !isSpec(c.path)) continue;
      // Only a block with a body counts as somewhere a test could have moved TO:
      // three `it("noop", () => {})` stubs beside one real test satisfied the
      // guard for a three-test deletion.
      if (c.op === 'add') {
        for (const l of significantLines(c.after, c.path)) addedTestLines.add(l);
        addedTestBlocks += countTests(c.after, c.path, true).min;
      } else if (c.before != null) {
        const before = significantLines(c.before, c.path);
        for (const l of significantLines(c.after, c.path)) if (!before.has(l)) addedTestLines.add(l);
        addedTestBlocks += Math.max(0, countTests(c.after, c.path, true).min - countTests(c.before, c.path, true).min);
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
        const isTest = isSpec(c.path);

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
          isSpec(c.oldPath) &&
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
        } else if (c.op !== 'delete' && c.after != null && !isTest && isProtected(c.path, policy, 'config') && runnerOf(c.path, c.after)) {
          // The runner's selection config: a protected spec the runner opened before
          // and will not open after is out of the suite as surely as if deleted.
          const rn = runnerOf(c.path, c.after);
          // pytest opens ONE inifile: an inert config (nested, or shadowed by a
          // higher-precedence root file) changes nothing, so flagging it would be a
          // false positive in the gated arm only.
          const readable = rn !== 'pytest' || effectivePytestConfig(c.path, ctx);
          for (const n of readable ? suiteNarrowings(c.before, c.after, c.path, runnerSamples(c.path, policy, ctx, rn)) : []) {
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
          // The test SCRIPT told to run less: `jest --testPathPattern calc`, `-t`,
          // `vitest run --exclude …` added to `scripts.test*` narrows the suite for
          // everyone who runs `npm test` — the same class as the config keys above.
          for (const n of scriptNarrowings(c.before, c.after, c.path)) {
            out.push(
              makeFinding(RULE, policy, {
                file: c.path,
                message: `The test script now narrows the suite: ${n.flag} added to scripts.${n.script}.`,
                evidence: `"${n.script}": ${JSON.stringify(n.before)} → ${JSON.stringify(n.after)}`,
                remediation: 'Keep the test script running the whole suite; a runner flag that selects fewer specs removes the rest from every run.',
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
            // a `..`/`./` token is resolved against the cwd first: from packages/a,
            // `../../test/a.test.ts` is the root's spec
            const resolved = root !== null && /(?:^|\/)\.{1,2}(?:\/|$)/.test(t) ? joinRoot(root, t) : null;
            const probe = resolved ?? t;
            if (!isSpec(probe)) return false;
            if (!listing || root === null) return true;
            const looksLikeFile = /\.[A-Za-z0-9]+$/.test(probe.split('/').pop() ?? '');
            if (looksLikeFile || listing.includes(resolved ?? inRepo(t))) return true;
            return containsProtected(resolved ?? inRepo(t), policy, 'tests', ctx, 'snapshots');
          });
          // A directory token counts when a protected spec lives under it: `rm -rf test`
          // erases the suite while naming no spec; `rm -rf dist/__tests__` names an
          // ignored build output and is left alone. `.`, `./`, `*` name the whole
          // current directory, and a `..`-containing token is resolved against the
          // cwd first — `git checkout v1 -- .` from the root restores every spec.
          const rootHasProtected = () => (listing ? listing.some(isSpec) : true);
          const dirToks = toks.filter((t) => {
            if (t.startsWith('-') || testToks.includes(t)) return false;
            const whole = /^(?:\.|\.\/|\*|\.\/\*)$/.test(t);
            if (!whole && /[*?{}[\]]/.test(t)) return false;
            if (root === null) return whole ? false : containsProtected(t, policy, 'tests', ctx, 'snapshots');
            const dir = whole ? root : joinRoot(root, t);
            if (dir === null) return false; // escapes the repository: unknown
            if (dir === '') return rootHasProtected();
            return containsProtected(dir, policy, 'tests', ctx, 'snapshots');
          });
          if (testToks.length === 0 && dirToks.length === 0) continue;
          const named = [...testToks, ...dirToks];
          const cmd = toks[0] ?? '';

          let why: string | null = null;
          let evidence = seg;

          // a redirect only tampers if its TARGET is the test (`cat x.spec.ts > /tmp/y`
          // reads the test and writes elsewhere — not a tamper)
          const redirectTarget = seg.match(/>\s*(\S+)/)?.[1];
          const redirectsOntoTest = redirectTarget ? isSpec(unquote(redirectTarget)) : false;
          const findDeletes = cmd === 'find' && /\s(?:-delete\b|-exec\s+(?:rm|unlink)\b|-execdir\s+(?:rm|unlink)\b)/.test(seg);
          const gitRestoresOld =
            cmd === 'git' &&
            /^git\s+(?:checkout|restore)\b/.test(seg) &&
            (() => {
              const src = seg.match(/--source[= ]\s*(\S+)/)?.[1];
              const revIdx = toks.findIndex((t, i) => i >= 2 && !t.startsWith('-') && !named.includes(t) && t !== '--');
              const rev = src ?? (revIdx >= 0 ? toks[revIdx] : undefined);
              // `git checkout -- x.test.ts` discards the agent's own edits; a REV
              // other than HEAD puts back an older version of the spec — with or
              // without the `--`: `git checkout v1 test/a.test.ts` restores it too.
              // A rev that RESOLVES to HEAD (`main` while on main, `@`) restores
              // nothing older: it is the `--` form under another name.
              if (!rev || rev === 'HEAD' || rev === '@' || revIsHead(rev, ctx) === true) return false;
              if (src || seg.includes(' -- ')) return true;
              return revIdx >= 0 && toks.some((t, i) => i > revIdx && named.includes(t));
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
          } else if (cmd === 'cp' && testToks.length > 0 && isSpec(toks[toks.length - 1] ?? '') && !isSpec(toks[toks.length - 2] ?? '')) {
            why = 'cp overwrites a test file with something else';
          } else if (cmd === 'tee' && !toks.includes('-a') && !toks.includes('--append')) {
            why = 'tee overwrites a test file';
          } else if (findDeletes) {
            why = 'find -delete removes test files';
          } else if (gitRestoresOld) {
            why = 'git checkout <rev> replaces a test file with an older version';
          } else if (/\bmv\b/.test(seg)) {
            const dest = toks[toks.length - 1];
            if (dest && testToks.length > 0 && !isSpec(dest)) {
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
