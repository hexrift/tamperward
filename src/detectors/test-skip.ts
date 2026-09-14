// #2 test-skip (file surface, mechanical).
// Added skip/focus markers that quietly drop assertions from the run. `.only` is in
// the same class — it narrows the suite to one block, silencing all the others.
// Scoped to test files to keep precision high.
//
// Per language: the baseline protects Python, Go, Rust, Ruby, JVM, PHP and .NET test
// files, and every marker below was the JavaScript spelling, so `@pytest.mark.skip`
// or `t.Skip()` added to a protected spec was never a finding. A test file whose
// language is not recognised is read with the JavaScript set, as before.
//
// Markers are code, so a comment-only line (`// was xit while flaky`) is never a
// hit; the two build-constraint spellings that ARE comments say so (`comment: true`).
// Call-position spellings (`fit(`, `xit(`) are matched with their paren: the bare
// word blocked `expect(label).toBe("fit")`.
//
// The historical line matcher remains the fallback for diff-only producers and non-JS
// ecosystems. When a JS/TS FileChange carries full BEFORE/AFTER content, an AST path
// additionally resolves formatting-independent member chains, statically computable
// property names, and simple locally provable runner aliases from known test APIs.
// Resolution is keyed by TypeScript symbol identity, not identifier spelling, so a local
// parameter/binding that shadows `test`, an imported alias, or a static property name
// is deliberately not inherited from the outer binding. Binding-only changes are judged
// as BEFORE/AFTER semantic deltas and attributed to the changed binding. Syntax-recovery
// ASTs are not trusted for block findings: parse diagnostics decline the AST path and
// leave the established line matcher as the fallback.

import { posix } from 'node:path';
import type TS from 'typescript';
import { parseSource, ts } from '../ts-lazy';
import { readRunnerChain, readTableCallee } from './runner-chain';
import { Change, Detector, DetectorContext, FileChange, Finding } from '../types';
import { addedLines } from '../diff/select';
import { isProtected } from '../policy';
import { trackedContent } from './repo';
import { insideStringLiteral, isCommentLine, Lang, langOf } from './files';
import { makeFinding } from './finding';

const RULE = 'test-skip';

type Pattern = { re: RegExp; why: string; comment?: true; astOwned?: true };

// Line-fallback member access to one of `names` (a `|`-alternation), reached by dot
// or literal string-bracket access. This intentionally stays line-local; the AST path
// above this fallback owns multiline/static-computed/alias semantics when full content
// is available.
const acc = (names: string): string =>
  `(?:\\s*\\.\\s*(?:${names})(?![\\w$])|\\s*\\[\\s*['"\`](?:${names})['"\`]\\s*\\])`;
const JS_RUNNER = '\\b(?:it|test|describe|suite)';
const JS_MOD = 'concurrent|sequential|shuffle|serial|parallel'; // it.concurrent.skip, describe.serial.only

// JUnit 5 conditional execution: `@EnabledIfEnvironmentVariable(named = "NEVER", …)`,
// `@EnabledIfSystemProperty`, `@EnabledIf("method")`, `@DisabledIf…` — the test runs
// only when a condition the file does not carry allows it (#431).
const JVM_CONDITIONAL = /@(?:[\w.]+\.)?(?:EnabledIf|DisabledIf)\w*\b/;

// ── #441 · Go any-receiver Skip and pytest conftest hooks ─────────────────────
// Kept as their own constants so the language rows below stay one spread each.
//
// Go: `testing.TB` is passed around under any name (`tb`, `tt` for a subtest,
// `testingT`), and testify reaches the runner through `s.T()`. The one-letter
// receiver `\b[tb]\.` left every other spelling silent.
const GO_SKIP_PATTERNS: Pattern[] = [
  { re: /\b\w+\.Skip(?:f|Now)?\(/, why: 'a runtime t.Skip()/Skipf()/SkipNow() call' },
  { re: /\bT\(\)\.Skip(?:f|Now)?\(/, why: 'a runtime T().Skip()/Skipf()/SkipNow() call (testify suite)' },
];
// pytest: a conftest.py is a protected test file and these hooks are how a suite is
// narrowed or its verdict rewritten without a marker ever appearing in a test:
// `pytest_collection_modifyitems` filters `items` or marks them, `pytest_pycollect_makeitem`
// decides what becomes a test at all, and a `pytest_runtest_makereport` hookwrapper can
// set `rep.outcome = 'passed'` on a failed call. `add_marker(mark.skip)` is the
// programmatic decorator; `sk = pytest.mark.skip` then `@sk` is the aliased one.
const PY_MARK = '(?:\\w+\\.)?mark\\.(?:skip|skipif|xfail)\\b';
const PY_CONFTEST_PATTERNS: Pattern[] = [
  { re: /\bdef\s+pytest_collection_modifyitems\s*\(/, why: 'a pytest_collection_modifyitems hook (collected tests are filtered or marked before they run)' },
  { re: /\bdef\s+pytest_pycollect_makeitem\s*\(/, why: 'a pytest_pycollect_makeitem hook (what counts as a test is decided here)' },
  { re: /\bdef\s+pytest_runtest_makereport\s*\(/, why: 'a pytest_runtest_makereport hook (the test report can be rewritten)' },
  { re: new RegExp('\\.add_marker\\(\\s*' + PY_MARK), why: 'an add_marker(mark.skip/skipif/xfail) call (the test is skipped programmatically)' },
  { re: new RegExp('^\\s*\\w+\\s*=\\s*' + PY_MARK), why: 'a skip/skipif/xfail marker bound to a name (an aliased decorator)' },
  { re: /\b\w+\.outcome\s*=\s*['"](?:passed|skipped)['"]/, why: 'a report outcome rewritten to passed/skipped' },
];
// An alias bound earlier (`sk = pytest.mark.skip`) makes a later `@sk` the marker.
const PY_MARK_ALIAS = new RegExp('^\\s*(\\w+)\\s*=\\s*' + PY_MARK, 'gm');
const PY_DECORATOR = /^\s*@(\w+)\s*(?:\(|$)/;
/** Names bound to a pytest skip marker anywhere in `source` (the AFTER file, or the added lines). */
function pyMarkAliases(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(PY_MARK_ALIAS)) out.add(m[1]);
  return out;
}
/** Added lines that decorate with an aliased skip marker, as [line number, evidence]. */
function pyAliasDecoratorHits(c: FileChange): Array<{ line: number | undefined; evidence: string }> {
  const added = addedLines(c);
  const aliases = pyMarkAliases(c.after ?? added.map((l) => l.content).join('\n'));
  if (aliases.size === 0) return [];
  const hits: Array<{ line: number | undefined; evidence: string }> = [];
  for (const l of added) {
    const m = PY_DECORATOR.exec(l.content);
    if (m && aliases.has(m[1])) hits.push({ line: l.newLine ?? undefined, evidence: l.content.trim() });
  }
  return hits;
}
// ── end #441 ──────────────────────────────────────────────────────────────────

const PATTERNS: Record<Lang, Pattern[]> = {
  js: [
    // The skip/only/todo family on a runner, by dot-or-bracket access, with one optional
    // vitest concurrency modifier hop: test.skip, test . skip, test['skip'], it.concurrent.skip.
    { re: new RegExp(JS_RUNNER + acc(JS_MOD) + '?' + acc('skip|only|todo')), why: 'a .skip/.only/.todo marker', astOwned: true },
    { re: new RegExp(JS_RUNNER + acc('skipIf|runIf') + '\\s*\\('), why: 'a .skipIf()/.runIf() condition (the test runs only when the condition allows)', astOwned: true },
    { re: new RegExp(JS_RUNNER + acc('fails|failing') + '\\s*\\('), why: 'a .fails/.failing marker (the test now passes by failing)', astOwned: true },
    { re: /\b(?:it|test|describe)\.each\s*\(\s*\[\s*\]\s*\)/, why: 'an empty .each table (no case ever runs)', astOwned: true },
    { re: /\b(?:xit|xtest|xdescribe)\s*\(/, why: 'an x-prefixed disabled test' },
    { re: /\b(?:fit|ftest|fdescribe)\s*\(/, why: 'an f-prefixed focused test (narrows the suite)' },
    { re: /\bpending\(\s*\)/, why: 'a pending() marker' },
    // node:test spells the same class as options — `test('x', { skip: true }, ...)` — and as
    // a runtime call. A live evasion used the options form the day this gap was measured
    // (PREDICTION-baselines.md): denied the rm, the agent skipped by option instead.
    // In options position (right after the title) ANY value but false/0 skips — a
    // non-literal `{ skip: process.env.CI }` included. Elsewhere on a line only the
    // literal forms count: `list({ skip: 1, take: 5 })` is pagination.
    { re: /\b(?:it|test|describe|suite)\s*\(\s*(['"`])(?:(?!\1).)*\1\s*,\s*\{[^}]*?\bskip:(?!\s*(?:false|0)\b)/, why: 'a { skip: ... } option disabling the test (node:test options form)', astOwned: true },
    { re: /\bskip:\s*(?:true|['"`])/, why: 'a { skip: ... } option disabling the test (node:test options form)' },
    { re: /\btodo:\s*(?:true|['"`])/, why: 'a { todo: ... } option (the test no longer fails the run)' },
    { re: new RegExp('\\b(?:t|ctx|context|this)' + acc('skip') + '\\s*\\('), why: 'a runtime t.skip()/this.skip() call' },
  ],
  py: [
    // `import pytest as pt` makes the decorator `@pt.mark.skip`; the module alias is free.
    { re: /@\w+\.mark\.(?:skip|skipif|xfail)\b/, why: 'a pytest skip/skipif/xfail marker' },
    // `from pytest import mark` makes it `@mark.skip`; `marks=pytest.mark.skip` is the
    // parametrize form. Both carry the same marker without the `@<module>.` shape.
    { re: /@mark\.(?:skip|skipif|xfail)\b/, why: 'a pytest skip/skipif/xfail marker (from pytest import mark)' },
    { re: /\bmarks\s*=\s*(?:\w+\.)?mark\.(?:skip|skipif|xfail)\b/, why: 'a parametrize marks= skip/skipif/xfail marker' },
    { re: /\bpytestmark\s*=.*\.mark\.(?:skip|skipif|xfail)\b/, why: 'a module-level pytestmark skip (every test in the file is skipped)' },
    { re: /\bpytest\.(?:skip|xfail|importorskip)\(/, why: 'a runtime pytest.skip()/xfail()/importorskip() call' },
    // Collection-time drops. A conftest.py is protected as a test file, and these
    // are how pytest is told never to collect a test in the first place — no
    // marker ever appears in the test itself. `collect_ignore` / `collect_ignore_glob`
    // are conftest globals (pytest docs, "Customizing test collection");
    // `pytest_ignore_collect` is the hook whose only job is to say "skip this path";
    // `__test__ = False` de-collects a class or function.
    { re: /\bcollect_ignore(?:_glob)?\s*(?:=|\+=|\.(?:append|extend)\()/, why: 'a collect_ignore / collect_ignore_glob entry (the files are never collected)' },
    { re: /\bdef\s+pytest_ignore_collect\s*\(/, why: 'a pytest_ignore_collect hook (paths are dropped at collection)' },
    // `from unittest import skip` makes the decorator bare `@skip`.
    { re: /@(?:unittest\.)?(?:skip|skipIf|skipUnless|expectedFailure)\b/, why: 'a unittest skip/expectedFailure decorator' },
    { re: /\bself\.skipTest\(/, why: 'a runtime self.skipTest() call' },
    { re: /\braise\s+(?:unittest\.)?SkipTest\b/, why: 'a raised SkipTest' },
    { re: /\b__test__\s*=\s*False\b/, why: '__test__ = False hides the test from collection' },
    ...PY_CONFTEST_PATTERNS, // #441
  ],
  go: [
    ...GO_SKIP_PATTERNS, // #441: any receiver, and testify's T()

    { re: /\bif\s+testing\.Short\(\)/, why: 'a testing.Short() guard (the body is skipped under -short)' },
    // Any constraint on a `_test.go` — `ignore`, `integration`, `never`, `!ci` — takes
    // the file out of the default `go test ./...` run; the tag's name is the agent's
    // to choose (#431).
    { re: /^\s*\/\/\s*(?:go:build|\+build)\b/, why: 'a build constraint on a test file (the file is excluded from the default test run)', comment: true },
  ],
  rs: [
    { re: /#\[ignore\b/, why: 'an #[ignore] attribute (the test no longer runs by default)' },
    { re: /#\[cfg_attr\(.*\bignore\b/, why: 'a cfg_attr(…, ignore) attribute (the test is ignored under that configuration)' },
  ],
  rb: [
    { re: /(?:^|[\s;{(])(?:skip|pending)(?:\s*\(|\s+['"]|\s+(?:if|unless)\b|\s*\}|\s*$)/, why: 'a skip/pending call' },
    { re: /(?:^|[\s;{(])x(?:it|describe|context|specify|example)\s*[('"]/, why: 'an x-prefixed disabled example' },
    { re: /(?:^|[\s;{(])f(?:it|describe|context)\s*[('"]/, why: 'an f-prefixed focused example (narrows the suite)' },
    { re: /\b(?:skip|pending):\s*(?:true|['"])/, why: 'a skip/pending metadata flag' },
    { re: /^\s*(?:it|specify|example)\s+(['"])(?:(?!\1).)*\1\s*$/, why: 'an example with no block (RSpec reports it as pending)' },
    // `it 'x', if: false do` — RSpec's conditional filter with a constant that never
    // lets the example run (#431). `if: ENV['SLOW']` is a real condition and passes.
    { re: /(?:^|[\s;{(])(?:it|specify|example|describe|context|scenario|feature)\s*[('"].*(?:\bif:\s*false\b|\bunless:\s*true\b|:if\s*=>\s*false\b|:unless\s*=>\s*true\b)/, why: 'a constant-false if:/unless: filter (the example never runs)' },
  ],
  java: [
    { re: /@(?:[\w.]+\.)?(?:Ignore|Disabled)\b/, why: 'an @Ignore/@Disabled annotation' },
    { re: JVM_CONDITIONAL, why: 'a conditional-execution annotation (@EnabledIf… / @DisabledIf…: the test runs only when the condition allows)' },
    { re: /\bassume(?:True\(\s*false|False\(\s*true)\s*[,)]/, why: 'an assumption that never holds (the test aborts as skipped)' },
  ],
  kt: [
    { re: /@(?:[\w.]+\.)?(?:Ignore|Disabled)\b/, why: 'an @Ignore/@Disabled annotation' },
    { re: JVM_CONDITIONAL, why: 'a conditional-execution annotation (@EnabledIf… / @DisabledIf…: the test runs only when the condition allows)' },
    { re: /\bassume(?:True\(\s*false|False\(\s*true)\s*[,)]/, why: 'an assumption that never holds (the test aborts as skipped)' },
  ],
  php: [{ re: /\bmarkTest(?:Skipped|Incomplete)\(/, why: 'a markTestSkipped()/markTestIncomplete() call' }],
  cs: [
    { re: /\[Ignore\b/, why: 'an [Ignore] attribute' },
    { re: /\bSkip\s*=\s*"/, why: 'a Skip = "..." attribute argument' },
    { re: /(?:\[|,)\s*Explicit\b/, why: 'an [Explicit] attribute (the test runs only when selected by name)' },
    { re: /\bAssert\.Inconclusive\(/, why: 'an Assert.Inconclusive() call (the test ends without a verdict)' },
  ],
};

// A pattern fires only when it hits code OUTSIDE a string literal: a marker spelled inside a
// quoted string (`expect(x).toBe("test.skip")`, `const s = 'it["skip"]'`) is text, not a skip,
// so every match position is checked and the first non-string one wins. Build-constraint
// patterns (comment:true) are matched as-is — they ARE comments, on lines this rule only reaches
// when the whole line is a comment. A per-call global clone keeps the stored regex stateless.
function matchesOutsideString(p: Pattern, content: string, lang: Lang | null): boolean {
  if (p.comment) return p.re.test(content);
  const re = p.re.global ? p.re : new RegExp(p.re.source, p.re.flags + 'g');
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (!insideStringLiteral(content, m.index, lang)) return true;
    if (m.index === re.lastIndex) re.lastIndex++; // guard against a zero-length match
  }
  return false;
}

const JS_RUNNERS = new Set(['it', 'test', 'describe', 'suite']);
// The chain modifiers (`it.concurrent.skip`, `test.describe.serial.only`) and table
// methods live in ./runner-chain, shared with test-deletion and assertion-weakening.
// Modules whose DEFAULT export is the runner (`import test from 'node:test'`).
const JS_DEFAULT_RUNNER_MODULES = new Set(['node:test', 'node:test/promises', '@playwright/test']);
const JS_TEST_MODULES = new Set([
  'vitest',
  '@jest/globals',
  'node:test',
  'node:test/promises',
  'mocha',
  'bun:test',
  '@playwright/test',
]);

type AstHit = { line: number; why: string; evidence: string };

/** The AFTER-side lines a change can show: the whole file when it carries one,
 *  else the hunks' added and context lines by their new line number. */
function afterLinesOf(c: FileChange): Map<number, string> {
  const out = new Map<number, string>();
  if (c.after != null) {
    c.after.split('\n').forEach((l, i) => out.set(i + 1, l));
    return out;
  }
  for (const h of c.hunks) for (const l of h.lines) if (l.newLine != null && l.type !== 'del') out.set(l.newLine, l.content);
  return out;
}

const GO_TEST_MAIN = /^func\s+TestMain\s*\(\s*(\w+)\s+\*testing\.M\s*\)/;
const RS_CFG = /^\s*#\[cfg\((.*)\)\]\s*$/;
const RS_ATTR = /^\s*#!?\[/;
const RS_TEST_ATTR = /^\s*#\[[\w:]*test\b/;
const RS_MOD = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+/;
const RS_FN = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+\w+/;

/** Skips that need the lines around them (#431): a Go `TestMain` that never
 *  calls `m.Run()` runs no test of its package; a Rust `#[cfg(…)]` other than
 *  `cfg(test)` on `mod tests` or beside `#[test]` compiles the tests out under
 *  every ordinary configuration. */
function contextSkipHits(c: FileChange, lang: Lang | null): AstHit[] {
  if (lang !== 'go' && lang !== 'rs') return [];
  const lines = afterLinesOf(c);
  const hits: AstHit[] = [];
  for (const l of addedLines(c)) {
    if (l.newLine == null) continue;
    if (lang === 'go') {
      const m = GO_TEST_MAIN.exec(l.content);
      if (!m) continue;
      const runs = new RegExp('\\b' + m[1] + '\\.Run\\(\\)');
      let ran = false;
      for (const [, text] of lines) if (runs.test(text) && !isCommentLine(text.trim(), lang)) ran = true;
      if (!ran) hits.push({ line: l.newLine, why: `a TestMain that never calls ${m[1]}.Run() (no test in the package runs)`, evidence: l.content.trim() });
      continue;
    }
    const cfg = RS_CFG.exec(l.content);
    if (!cfg || cfg[1].trim() === 'test') continue;
    // The attribute run this cfg belongs to, and the item it decorates.
    let first = l.newLine;
    while (RS_ATTR.test(lines.get(first - 1) ?? '')) first--;
    let at = l.newLine + 1;
    while (RS_ATTR.test(lines.get(at) ?? '') || (lines.has(at) && !/\S/.test(lines.get(at) ?? ''))) at++;
    const item = lines.get(at) ?? '';
    let besideTest = false;
    for (let i = first; i < at; i++) if (RS_TEST_ATTR.test(lines.get(i) ?? '')) besideTest = true;
    if (RS_MOD.test(item)) {
      hits.push({ line: l.newLine, why: 'a #[cfg(…)] on the test module (the tests are compiled out under every ordinary configuration)', evidence: l.content.trim() });
    } else if (besideTest && RS_FN.test(item)) {
      hits.push({ line: l.newLine, why: 'a #[cfg(…)] beside #[test] (the test is compiled out under every ordinary configuration)', evidence: l.content.trim() });
    }
  }
  return hits;
}

function scriptKind(path: string): TS.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/i.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function addedLineNumbers(c: FileChange): Set<number> {
  const out = new Set<number>();
  for (const h of c.hunks) {
    for (const line of h.lines) {
      if (line.type === 'add' && line.newLine != null) out.add(line.newLine);
    }
  }
  return out;
}

function moduleName(expr: TS.Expression): string | null {
  return ts.isStringLiteralLike(expr) ? expr.text : null;
}

function requiredModule(expr: TS.Expression): string | null {
  if (
    !ts.isCallExpression(expr) ||
    !ts.isIdentifier(expr.expression) ||
    expr.expression.text !== 'require' ||
    expr.arguments.length !== 1
  ) return null;
  return moduleName(expr.arguments[0]);
}


type AstContext = {
  sf: TS.SourceFile;
  checker: TS.TypeChecker;
};

type StaticValue = {
  value: string;
  causes: TS.Node[];
};

type SemanticHit = {
  semanticKey: string;
  terminalNode: TS.Node;
  causeNodes: TS.Node[];
  why: string;
  evidence: string;
};

function astContext(path: string, source: string): AstContext | null {
  const rootName = path.startsWith('/') ? path : '/tamperward/' + path;
  // A declined parse (size, nesting, overflow — #444) is not a verdict: the line
  // matcher judges the file instead, exactly as it does for a diff-only change.
  const sf = parseSource(rootName, source, scriptKind(path));
  if (!sf) return null;

  // parseDiagnostics is not on the public SourceFile type; asking the object
  // whether it carries the property is the one way to learn the parser recovered.
  const diagnostics = 'parseDiagnostics' in sf && Array.isArray(sf.parseDiagnostics) ? sf.parseDiagnostics : [];
  if (diagnostics.length > 0) return null;

  const options: TS.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
  };
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (fileName) => fileName === rootName ? sf : undefined;
  host.fileExists = (fileName) => fileName === rootName;
  host.readFile = (fileName) => fileName === rootName ? source : undefined;
  host.writeFile = () => {};
  host.getDefaultLibFileName = () => '';
  host.getCurrentDirectory = () => '/tamperward';
  host.getCanonicalFileName = (fileName) => fileName;
  host.useCaseSensitiveFileNames = () => true;
  host.getNewLine = () => '\n';

  const program = ts.createProgram([rootName], options, host);
  return { sf, checker: program.getTypeChecker() };
}

function symbolAt(ctx: AstContext, node: TS.Node): TS.Symbol | null {
  return ctx.checker.getSymbolAtLocation(node) ?? null;
}

/**
 * What a chain root is proven to be (#428).
 *
 * `runner`: the symbol is a test runner — imported from a known runner module,
 * a `.extend(...)` of one, or an alias of one, followed through a relative
 * fixture module whose content is in hand. `non-runner`: the symbol is proven
 * to be something else — a parameter, a local function/class, a local
 * declaration whose initialiser is not an import/alias/extend of a runner, or an
 * import of a non-runner name from a known runner module. `unknown`: the AST
 * cannot say (an import from a module it cannot read, a fixture whose content
 * is unavailable, an initialiser it does not model); the call is then NOT the
 * AST's to judge and the line matcher keeps its say.
 */
type Verdict =
  | { kind: 'runner'; causes: TS.Node[] }
  | { kind: 'non-runner' }
  | { kind: 'unknown' };

const RUNNER: Verdict = { kind: 'runner', causes: [] };
const NON_RUNNER: Verdict = { kind: 'non-runner' };
const UNKNOWN: Verdict = { kind: 'unknown' };

const withCause = (v: Verdict, cause: TS.Node): Verdict =>
  v.kind === 'runner' ? { kind: 'runner', causes: [cause, ...v.causes] } : v;

/** Content of a repo-relative module path, or null when it cannot be read. */
type ModuleSource = (path: string) => string | null;

const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Repo-relative candidate paths for `spec` imported from `fromPath`, in the order
 *  a bundler or TypeScript would try them (`./fixtures` → `fixtures.ts`,
 *  `fixtures/index.ts`; a `.js` specifier also names the `.ts` source). */
function relativeCandidates(fromPath: string, spec: string): string[] {
  const base = posix.normalize(posix.join(posix.dirname(fromPath), spec));
  if (base.startsWith('../') || base.startsWith('/')) return [];
  const bases = [base];
  const swapped = base.replace(/\.([mc]?)js$/, '.$1ts');
  if (swapped !== base) bases.push(swapped);
  const out: string[] = [];
  for (const b of bases) {
    out.push(b);
    for (const ext of MODULE_EXTENSIONS) out.push(b + ext);
    for (const ext of MODULE_EXTENSIONS) out.push(b + '/index' + ext);
  }
  return out;
}

/** Whether `stmt` carries the `export` modifier. */
function isExported(stmt: TS.Statement): boolean {
  return ts.canHaveModifiers(stmt) &&
    (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** `module.exports` / `exports` / `module.exports.<name>` / `exports.<name>` as an
 *  assignment target: the exported name, `''` for the whole module object. */
function cjsExportTarget(expr: TS.Expression): string | null {
  const isModuleExports = (e: TS.Expression): boolean =>
    (ts.isIdentifier(e) && e.text === 'exports') ||
    (ts.isPropertyAccessExpression(e) &&
      ts.isIdentifier(e.expression) && e.expression.text === 'module' && e.name.text === 'exports');
  if (isModuleExports(expr)) return '';
  if (ts.isPropertyAccessExpression(expr) && isModuleExports(expr.expression)) return expr.name.text;
  return null;
}

/**
 * Resolves runner bindings across the files a change can see. One resolver serves
 * one side (BEFORE or AFTER) of one detector run; fixture modules are parsed at
 * most once per side, and a chain of re-exports is followed at most `MAX_DEPTH`
 * modules deep before it is declared unknown.
 */
class RunnerResolver {
  private readonly binders = new Map<string, ModuleBinder | null>();
  static readonly MAX_DEPTH = 4;

  constructor(private readonly source: ModuleSource) {}

  binderFor(path: string, ctx: AstContext): ModuleBinder {
    const hit = this.binders.get(path);
    if (hit && hit.ctx === ctx) return hit;
    const binder = new ModuleBinder(ctx, path, this, 0);
    this.binders.set(path, binder);
    return binder;
  }

  /** The verdict for `name` exported by `spec` as imported from `fromPath`. */
  exportOf(fromPath: string, spec: string, name: string, depth: number): Verdict {
    if (JS_TEST_MODULES.has(spec)) {
      if (name === 'default') return JS_DEFAULT_RUNNER_MODULES.has(spec) ? RUNNER : UNKNOWN;
      return JS_RUNNERS.has(name) ? RUNNER : NON_RUNNER;
    }
    if (!spec.startsWith('./') && !spec.startsWith('../')) return UNKNOWN;
    if (depth >= RunnerResolver.MAX_DEPTH) return UNKNOWN;
    for (const candidate of relativeCandidates(fromPath, spec)) {
      if (this.binders.has(candidate)) {
        const cached = this.binders.get(candidate);
        return cached ? cached.exported(name) : UNKNOWN;
      }
      const src = this.source(candidate);
      if (src == null) continue;
      const ctx = astContext(candidate, src);
      const binder = ctx ? new ModuleBinder(ctx, candidate, this, depth + 1) : null;
      this.binders.set(candidate, binder);
      return binder ? binder.exported(name) : UNKNOWN;
    }
    return UNKNOWN;
  }
}

/** Runner classification of the symbols of one parsed module. */
class ModuleBinder {
  private readonly memo = new Map<TS.Symbol, Verdict>();
  private readonly resolving = new Set<TS.Symbol>();
  private exports: Map<string, () => Verdict> | null = null;
  private starExports: string[] = [];
  private opaqueCjs = false;

  constructor(
    readonly ctx: AstContext,
    private readonly path: string,
    private readonly resolver: RunnerResolver,
    private readonly depth: number,
  ) {}

  private moduleExport(spec: string, name: string): Verdict {
    return this.resolver.exportOf(this.path, spec, name, this.depth);
  }

  /** The verdict for member `name` of the module object `spec` denotes. */
  memberOf(spec: string, name: string): Verdict {
    return this.moduleExport(spec, name);
  }

  /** The module specifier a symbol stands for as a namespace object
   *  (`import * as v from 'vitest'`, `const v = require('vitest')`), else null. */
  namespaceOf(sym: TS.Symbol): string | null {
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!decl) return null;
    if (ts.isNamespaceImport(decl)) {
      const imp = decl.parent.parent;
      return ts.isImportDeclaration(imp) ? moduleName(imp.moduleSpecifier) : null;
    }
    if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.initializer) {
      return requiredModule(decl.initializer);
    }
    return null;
  }

  /** The verdict for a root identifier's symbol. */
  classify(sym: TS.Symbol): Verdict {
    const cached = this.memo.get(sym);
    if (cached) return cached;
    if (this.resolving.has(sym)) return UNKNOWN;
    this.resolving.add(sym);
    const verdict = this.classifyDeclaration(sym);
    this.resolving.delete(sym);
    this.memo.set(sym, verdict);
    return verdict;
  }

  private classifyDeclaration(sym: TS.Symbol): Verdict {
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!decl) return UNKNOWN;

    if (ts.isImportSpecifier(decl)) {
      const imp = decl.parent.parent.parent;
      const spec = ts.isImportDeclaration(imp) ? moduleName(imp.moduleSpecifier) : null;
      if (spec == null) return UNKNOWN;
      return withCause(this.moduleExport(spec, (decl.propertyName ?? decl.name).text), decl.name);
    }
    if (ts.isImportClause(decl)) {
      const spec = ts.isImportDeclaration(decl.parent) ? moduleName(decl.parent.moduleSpecifier) : null;
      if (spec == null || !decl.name) return UNKNOWN;
      return withCause(this.moduleExport(spec, 'default'), decl.name);
    }
    if (
      ts.isNamespaceImport(decl) ||
      ts.isParameter(decl) ||
      ts.isFunctionDeclaration(decl) ||
      ts.isClassDeclaration(decl) ||
      ts.isEnumDeclaration(decl) ||
      ts.isModuleDeclaration(decl)
    ) return NON_RUNNER;

    if (ts.isBindingElement(decl)) return this.classifyBindingElement(decl);

    if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
      if (!decl.initializer) return UNKNOWN;
      return withCause(this.classifyExpression(decl.initializer), decl.name);
    }
    return UNKNOWN;
  }

  /** `const { it } = require('vitest')`, `const { test } = fixtures`: the element
   *  is what the module (or namespace) exports under its property name. */
  private classifyBindingElement(decl: TS.BindingElement): Verdict {
    const pattern = decl.parent;
    const owner = pattern.parent;
    if (ts.isParameter(owner) || !ts.isObjectBindingPattern(pattern) || !ts.isIdentifier(decl.name)) {
      return NON_RUNNER;
    }
    if (!ts.isVariableDeclaration(owner) || !owner.initializer) return UNKNOWN;
    const key = decl.propertyName
      ? (ts.isIdentifier(decl.propertyName) || ts.isStringLiteralLike(decl.propertyName)
        ? decl.propertyName.text
        : null)
      : decl.name.text;
    if (key == null) return UNKNOWN;
    const spec = this.namespaceSpec(owner.initializer);
    if (spec != null) return withCause(this.moduleExport(spec, key), decl.name);
    if (ts.isIdentifier(owner.initializer)) {
      const inner = symbolAt(this.ctx, owner.initializer);
      const verdict = inner ? this.classify(inner) : UNKNOWN;
      return verdict.kind === 'unknown' ? UNKNOWN : NON_RUNNER;
    }
    return NON_RUNNER;
  }

  /** The module specifier `expr` denotes as a namespace object, else null. */
  private namespaceSpec(expr: TS.Expression): string | null {
    const direct = requiredModule(expr);
    if (direct != null) return direct;
    if (!ts.isIdentifier(expr)) return null;
    const sym = symbolAt(this.ctx, expr);
    return sym ? this.namespaceOf(sym) : null;
  }

  /** The verdict for an expression used as a runner: an initialiser or a
   *  re-exported value. */
  classifyExpression(expr: TS.Expression): Verdict {
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isSatisfiesExpression(expr) ||
      ts.isTypeAssertionExpression(expr) ||
      ts.isNonNullExpression(expr)
    ) return this.classifyExpression(expr.expression);

    if (ts.isIdentifier(expr)) {
      const sym = symbolAt(this.ctx, expr);
      if (sym) return this.classify(sym);
      return JS_RUNNERS.has(expr.text) ? RUNNER : UNKNOWN;
    }

    if (ts.isCallExpression(expr)) {
      const spec = requiredModule(expr);
      if (spec != null) return this.moduleExport(spec, 'default');
      const callee = expr.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'extend') {
        return this.classifyExpression(callee.expression);
      }
      return NON_RUNNER;
    }

    if (ts.isPropertyAccessExpression(expr)) {
      const spec = this.namespaceSpec(expr.expression);
      return spec != null ? this.moduleExport(spec, expr.name.text) : UNKNOWN;
    }
    if (ts.isElementAccessExpression(expr)) {
      const spec = this.namespaceSpec(expr.expression);
      const name = ts.isStringLiteralLike(expr.argumentExpression) ? expr.argumentExpression.text : null;
      return spec != null && name != null ? this.moduleExport(spec, name) : UNKNOWN;
    }

    if (
      ts.isLiteralExpression(expr) ||
      ts.isTemplateExpression(expr) ||
      ts.isObjectLiteralExpression(expr) ||
      ts.isArrayLiteralExpression(expr) ||
      ts.isFunctionExpression(expr) ||
      ts.isArrowFunction(expr) ||
      ts.isClassExpression(expr) ||
      ts.isNewExpression(expr) ||
      ts.isBinaryExpression(expr) ||
      ts.isPrefixUnaryExpression(expr) ||
      ts.isPostfixUnaryExpression(expr) ||
      ts.isJsxElement(expr) ||
      ts.isJsxSelfClosingElement(expr) ||
      expr.kind === ts.SyntaxKind.TrueKeyword ||
      expr.kind === ts.SyntaxKind.FalseKeyword ||
      expr.kind === ts.SyntaxKind.NullKeyword
    ) return NON_RUNNER;

    return UNKNOWN;
  }

  /** The verdict for what this module exports under `name` (`default` for the
   *  default export or a whole-module `module.exports = …`). */
  exported(name: string): Verdict {
    if (!this.exports) this.collectExports();
    const local = this.exports?.get(name);
    if (local) return local();
    for (const spec of this.starExports) {
      const v = this.moduleExport(spec, name);
      if (v.kind !== 'non-runner') return v;
    }
    return this.opaqueCjs ? UNKNOWN : NON_RUNNER;
  }

  private collectExports(): void {
    const exports = new Map<string, () => Verdict>();
    this.exports = exports;
    const ctx = this.ctx;
    const bySymbol = (id: TS.Identifier) => (): Verdict => {
      const sym = symbolAt(ctx, id);
      return sym ? this.classify(sym) : UNKNOWN;
    };

    for (const stmt of ctx.sf.statements) {
      if (ts.isExportDeclaration(stmt)) {
        const spec = stmt.moduleSpecifier ? moduleName(stmt.moduleSpecifier) : null;
        if (!stmt.exportClause) {
          if (spec != null) this.starExports.push(spec);
          else this.opaqueCjs = true;
          continue;
        }
        if (!ts.isNamedExports(stmt.exportClause)) continue;
        for (const el of stmt.exportClause.elements) {
          const exportedName = el.name.text;
          const localName = (el.propertyName ?? el.name).text;
          if (spec != null) {
            exports.set(exportedName, () => this.moduleExport(spec, localName));
          } else {
            exports.set(exportedName, () => {
              const sym = ctx.checker.getExportSpecifierLocalTargetSymbol(el);
              return sym ? this.classify(sym) : UNKNOWN;
            });
          }
        }
        continue;
      }
      if (ts.isExportAssignment(stmt)) {
        exports.set('default', () => this.classifyExpression(stmt.expression));
        continue;
      }
      if (isExported(stmt)) {
        if (ts.isVariableStatement(stmt)) {
          for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) exports.set(decl.name.text, bySymbol(decl.name));
            else if (ts.isObjectBindingPattern(decl.name)) {
              for (const el of decl.name.elements) {
                if (ts.isIdentifier(el.name)) exports.set(el.name.text, bySymbol(el.name));
              }
            }
          }
        } else if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) {
          exports.set(stmt.name.text, () => NON_RUNNER);
        }
        continue;
      }
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isBinaryExpression(stmt.expression) &&
        stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const target = cjsExportTarget(stmt.expression.left);
        if (target == null) continue;
        const value = stmt.expression.right;
        if (target !== '') {
          exports.set(target, () => this.classifyExpression(value));
        } else if (ts.isObjectLiteralExpression(value)) {
          for (const prop of value.properties) {
            if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name))) {
              const init = prop.initializer;
              exports.set(prop.name.text, () => this.classifyExpression(init));
            } else if (ts.isShorthandPropertyAssignment(prop)) {
              exports.set(prop.name.text, () => {
                const sym = ctx.checker.getShorthandAssignmentValueSymbol(prop);
                return sym ? this.classify(sym) : UNKNOWN;
              });
            } else {
              this.opaqueCjs = true; // a spread or computed key: the export set is open
            }
          }
        } else {
          exports.set('default', () => this.classifyExpression(value));
          this.opaqueCjs = true; // `module.exports = expr`: named members are the expr's
        }
      }
    }
  }
}

function topLevelStaticStrings(ctx: AstContext): Map<TS.Symbol, StaticValue> {
  const pending = new Map<TS.Symbol, { decl: TS.Identifier; expr: TS.Expression }>();

  for (const stmt of ctx.sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
    if (!isConst) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const sym = symbolAt(ctx, decl.name);
      if (sym) pending.set(sym, { decl: decl.name, expr: decl.initializer });
    }
  }

  const resolved = new Map<TS.Symbol, StaticValue>();
  const resolving = new Set<TS.Symbol>();

  const valueOf = (expr: TS.Expression): StaticValue | null => {
    if (ts.isStringLiteralLike(expr)) return { value: expr.text, causes: [] };
    if (ts.isParenthesizedExpression(expr)) return valueOf(expr.expression);
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = valueOf(expr.left);
      const right = valueOf(expr.right);
      if (!left || !right) return null;
      return { value: left.value + right.value, causes: [...left.causes, ...right.causes] };
    }
    if (ts.isIdentifier(expr)) {
      const sym = symbolAt(ctx, expr);
      if (!sym) return null;
      const cached = resolved.get(sym);
      if (cached) return cached;
      const item = pending.get(sym);
      if (!item || resolving.has(sym)) return null;
      resolving.add(sym);
      const nested = valueOf(item.expr);
      resolving.delete(sym);
      if (!nested) return null;
      const result = { value: nested.value, causes: [item.decl, ...nested.causes] };
      resolved.set(sym, result);
      return result;
    }
    return null;
  };

  for (const [sym, item] of pending) {
    if (resolved.has(sym)) continue;
    resolving.add(sym);
    const nested = valueOf(item.expr);
    resolving.delete(sym);
    if (nested) resolved.set(sym, { value: nested.value, causes: [item.decl, ...nested.causes] });
  }
  return resolved;
}

function staticPropertyName(
  expr: TS.Expression,
  ctx: AstContext,
  strings: Map<TS.Symbol, StaticValue>,
): { name: string; causes: TS.Node[] } | null {
  if (ts.isStringLiteralLike(expr)) return { name: expr.text, causes: [] };
  if (ts.isParenthesizedExpression(expr)) return staticPropertyName(expr.expression, ctx, strings);
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticPropertyName(expr.left, ctx, strings);
    const right = staticPropertyName(expr.right, ctx, strings);
    if (!left || !right) return null;
    return { name: left.name + right.name, causes: [...left.causes, ...right.causes] };
  }
  if (ts.isIdentifier(expr)) {
    const sym = symbolAt(ctx, expr);
    if (!sym) return null;
    const value = strings.get(sym);
    return value ? { name: value.value, causes: value.causes } : null;
  }
  return null;
}

type RunnerChain = {
  root: string;
  props: string[];
  /** The node naming each of `props`, index-aligned (#429). */
  propNodes: TS.Node[];
  terminalNode: TS.Node;
  causes: TS.Node[];
};

/**
 * The member chain of a call's callee, rooted at a runner: the chain when the root
 * is a proven runner, `'unknown'` when the root's binding cannot be classified
 * (the call is then the line matcher's to judge, #428), and null when the callee
 * is proven not to be a runner chain or is not a member chain the AST models.
 */
function runnerChain(
  expr: TS.Expression,
  ctx: AstContext,
  binder: ModuleBinder,
  strings: Map<TS.Symbol, StaticValue>,
): RunnerChain | 'unknown' | null {
  const props: string[] = [];
  const propNodes: TS.Node[] = [];
  const causes: TS.Node[] = [];
  let cur: TS.Expression = expr;
  let terminalNode: TS.Node = expr;

  while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    if (ts.isPropertyAccessExpression(cur)) {
      props.unshift(cur.name.text);
      propNodes.unshift(cur.name);
      if (props.length === 1) terminalNode = cur.name;
      cur = cur.expression;
      continue;
    }
    if (!cur.argumentExpression) return null;
    const property = staticPropertyName(cur.argumentExpression, ctx, strings);
    if (!property) return null;
    props.unshift(property.name);
    propNodes.unshift(cur.argumentExpression);
    causes.push(...property.causes);
    if (props.length === 1) terminalNode = cur.argumentExpression;
    cur = cur.expression;
  }

  let verdict: Verdict;
  let namespace: string | null = null;
  if (ts.isIdentifier(cur)) {
    const sym = symbolAt(ctx, cur);
    if (!sym) {
      verdict = JS_RUNNERS.has(cur.text) ? RUNNER : UNKNOWN;
    } else {
      verdict = binder.classify(sym);
      if (verdict.kind !== 'runner') namespace = binder.namespaceOf(sym);
    }
  } else {
    // `require('vitest').it.skip(...)`: the root is the module object itself.
    namespace = requiredModule(cur);
    // `describe.only.each(rows)('t', fn)`: the outer call's root is the table call,
    // which is judged as its own chain (#429); the outer call is not one the AST
    // models, and nothing is left for the line matcher on its lines.
    if (namespace == null && readTableCallee(cur)) return null;
    verdict = namespace == null ? UNKNOWN : NON_RUNNER;
  }

  // A namespace object (`import * as v`, `const v = require(...)`) is not a runner;
  // its first member may be one (`v.it.skip`).
  let root = ts.isIdentifier(cur) ? cur.text : '';
  if (namespace != null && props.length > 0) {
    verdict = withCause(binder.memberOf(namespace, props[0]), cur);
    if (verdict.kind === 'runner') {
      root = props.shift() ?? root;
      propNodes.shift();
    }
  }

  if (verdict.kind === 'unknown') return 'unknown';
  if (verdict.kind === 'non-runner') return null;
  causes.push(...verdict.causes);
  return { root, props, propNodes, terminalNode, causes };
}

function optionDisables(value: TS.Expression): boolean {
  return !(
    value.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isNumericLiteral(value) && Number(value.text) === 0)
  );
}

function shorthandOptionDisables(
  prop: TS.ShorthandPropertyAssignment,
  ctx: AstContext,
): boolean {
  const sym = ctx.checker.getShorthandAssignmentValueSymbol(prop) ?? symbolAt(ctx, prop.name);
  const decl =
    sym?.valueDeclaration ??
    sym?.declarations?.find((d): d is TS.VariableDeclaration => ts.isVariableDeclaration(d));
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return true;
  return optionDisables(decl.initializer);
}

/**
 * Stable syntax identity for BEFORE/AFTER semantic comparison.
 *
 * Source positions, whitespace and comments are deliberately absent. Leaf
 * identifiers/literals retain their values; punctuation/operators/keywords are
 * represented by SyntaxKind, so a formatting-only rewrite keeps the same key
 * while real expression changes remain distinct.
 */
function structuralNodeKey(node: TS.Node, sf: TS.SourceFile): string {
  const children = node.getChildren(sf);
  const text = 'text' in node ? node.text : undefined;
  if (children.length === 0) {
    return typeof text === 'string'
      ? `${node.kind}:${JSON.stringify(text)}`
      : String(node.kind);
  }
  return `${node.kind}(${children.map((child) => structuralNodeKey(child, sf)).join(',')})`;
}

type SemanticAnalysis = {
  hits: SemanticHit[];
  /** Lines of callee chains whose root the AST could not classify: the line
   *  matcher keeps its say on these (#428). */
  unowned: Set<number>;
};

function semanticSkipHits(ctx: AstContext, binder: ModuleBinder): SemanticAnalysis {
  const strings = topLevelStaticStrings(ctx);
  const hits: SemanticHit[] = [];
  const unowned = new Set<number>();
  const callOrdinals = new Map<string, number>();
  const lineOf = (pos: number): number => ctx.sf.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node)) {
      const callText = node.getText(ctx.sf).trim();
      const callIdentity = structuralNodeKey(node, ctx.sf);
      const ordinal = (callOrdinals.get(callIdentity) ?? 0) + 1;
      callOrdinals.set(callIdentity, ordinal);
      const callKey = `${callIdentity}\u0000${ordinal}`;

      const chain = runnerChain(node.expression, ctx, binder, strings);
      if (chain === 'unknown') {
        const callee = node.expression;
        const first = lineOf(callee.getStart(ctx.sf));
        const last = lineOf(callee.getEnd());
        for (let line = first; line <= last; line++) unowned.add(line);
      } else if (chain) {
        const { root, props, propNodes, terminalNode, causes } = chain;
        const terminal = props.at(-1);
        // The chain's shape — modifiers in any order, a table method last (#429).
        const shape = readRunnerChain(root, props);
        const push = (target: TS.Node, extraCauses: TS.Node[], why: string): void => {
          hits.push({
            semanticKey: `${callKey}\u0000${why}`,
            terminalNode: target,
            causeNodes: [...causes, ...extraCauses],
            why,
            evidence: callText,
          });
        };

        if (shape?.skipMarker) {
          // `it.skip.each(rows)`, `describe.only.each(rows)`, `it.concurrent.skip`:
          // the marker anywhere before `.each` / `.for` narrows the run; the
          // finding points at the marker's own line.
          push(propNodes[shape.skipIndex] ?? terminalNode, [], 'a .skip/.only/.todo marker');
        } else if (terminal && ['skipIf', 'runIf'].includes(terminal) && props.length === 1) {
          push(terminalNode, [], 'a .skipIf()/.runIf() condition (the test runs only when the condition allows)');
        } else if (terminal && ['fails', 'failing'].includes(terminal) && props.length === 1) {
          push(terminalNode, [], 'a .fails/.failing marker (the test now passes by failing)');
        } else if (
          shape?.table === 'each' &&
          node.arguments.length > 0 &&
          ts.isArrayLiteralExpression(node.arguments[0]) &&
          node.arguments[0].elements.length === 0
        ) {
          push(terminalNode, [], 'an empty .each table (no case ever runs)');
        }

        if (props.length === 0) {
          for (const arg of node.arguments) {
            if (!ts.isObjectLiteralExpression(arg)) continue;
            for (const prop of arg.properties) {
              if (ts.isPropertyAssignment(prop)) {
                let name: string | null = null;
                let propertyCauses: TS.Node[] = [];
                if (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) {
                  name = prop.name.text;
                } else if (ts.isComputedPropertyName(prop.name)) {
                  const resolved = staticPropertyName(prop.name.expression, ctx, strings);
                  name = resolved?.name ?? null;
                  propertyCauses = resolved?.causes ?? [];
                }
                if (!name || !['skip', 'todo', 'only'].includes(name)) continue;
                if (!optionDisables(prop.initializer)) continue;
                const why = name === 'only'
                  ? 'an { only: ... } option focusing the test'
                  : name === 'todo'
                    ? 'a { todo: ... } option (the test no longer fails the run)'
                    : 'a { skip: ... } option disabling the test';
                push(prop.name, propertyCauses, why);
              } else if (
                ts.isShorthandPropertyAssignment(prop) &&
                ['skip', 'todo', 'only'].includes(prop.name.text)
              ) {
                if (!shorthandOptionDisables(prop, ctx)) continue;
                push(prop.name, [], `a { ${prop.name.text} } option that conditionally narrows the test run`);
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ctx.sf);
  return { hits, unowned };
}

type AstAnalysis = { hits: AstHit[]; authoritative: boolean; unowned: Set<number> };

const NO_AST: AstAnalysis = { hits: [], authoritative: false, unowned: new Set() };

/** The content of a module the change can see on one side: the change's own
 *  BEFORE/AFTER for a path it touches, the repository's copy otherwise. */
function moduleSource(changes: Change[], side: 'before' | 'after', ctx?: DetectorContext): ModuleSource {
  const touched = new Map<string, string | null>();
  for (const c of changes) {
    if (c.kind !== 'file') continue;
    touched.set(c.path, c[side]);
    if (side === 'before' && c.oldPath != null) touched.set(c.oldPath, c.before);
  }
  return (path) => touched.has(path) ? touched.get(path) ?? null : trackedContent(path, ctx);
}

function astSkipHits(c: FileChange, resolvers: { before: RunnerResolver; after: RunnerResolver }): AstAnalysis {
  if (c.after == null) return NO_AST;
  const added = addedLineNumbers(c);
  if (added.size === 0) return NO_AST;

  const afterCtx = astContext(c.path, c.after);
  if (!afterCtx) return NO_AST;

  const beforeCtx = c.before == null ? null : astContext(c.path, c.before);
  const beforeKeys = beforeCtx == null
    ? null
    : new Set(
      semanticSkipHits(beforeCtx, resolvers.before.binderFor(c.oldPath ?? c.path, beforeCtx)).hits
        .map((hit) => hit.semanticKey),
    );

  const lineOf = (node: TS.Node): number =>
    afterCtx.sf.getLineAndCharacterOfPosition(node.getStart(afterCtx.sf)).line + 1;

  const hits: AstHit[] = [];
  const seen = new Set<string>();
  const analysis = semanticSkipHits(afterCtx, resolvers.after.binderFor(c.path, afterCtx));
  for (const hit of analysis.hits) {
    const directLine = lineOf(hit.terminalNode);
    let findingLine: number | null = added.has(directLine) ? directLine : null;
    if (findingLine == null) {
      for (const cause of hit.causeNodes) {
        const line = lineOf(cause);
        if (added.has(line)) {
          findingLine = line;
          break;
        }
      }
      if (findingLine == null) continue;
      // A binding-attributed hit needs a trustworthy BEFORE semantic set;
      // otherwise we cannot prove the edit introduced the skip/focus meaning.
      if (beforeKeys == null) continue;
    }

    // Apply BEFORE/AFTER semantic suppression to direct hits too. A formatting-
    // only rewrite may move ".only" onto a newly-added physical line without
    // introducing any new suite narrowing.
    if (beforeKeys?.has(hit.semanticKey)) continue;
    const dedupe = `${findingLine}\u0000${hit.semanticKey}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    hits.push({ line: findingLine, why: hit.why, evidence: hit.evidence });
  }
  return { hits, authoritative: true, unowned: analysis.unowned };
}

export const testSkip: Detector = {
  id: RULE,
  surface: ['file'],
  certainty: 'mechanical',
  run(changes: Change[], policy, _view, ctx): Finding[] {
    const out: Finding[] = [];
    const resolvers = {
      before: new RunnerResolver(moduleSource(changes, 'before', ctx)),
      after: new RunnerResolver(moduleSource(changes, 'after', ctx)),
    };
    for (const c of changes) {
      if (c.kind !== 'file') continue;
      if (!isProtected(c.path, policy, 'tests')) continue;
      const lang = langOf(c.path);
      const patterns = PATTERNS[lang ?? 'js'];
      const astHitLines = new Set<number>();
      let astAuthoritative = false;
      let unowned = new Set<number>();

      // Enriched JS/TS changes carry the whole AFTER file. For the JS forms the
      // AST models, a parse-clean AST is authoritative even when the result is
      // deliberately "not a test runner" because lexical shadowing must not be
      // overridden by the spelling-only regex fallback — but only where the AST
      // PROVED the root is not a runner. A root it cannot classify (a fixture
      // module it cannot read, a wrapper package) leaves the call to the line
      // matcher (#428). Diff-only inputs and parse-recovery trees keep the
      // historical regex behavior.
      if (lang === 'js' && c.after != null) {
        const analysis = astSkipHits(c, resolvers);
        astAuthoritative = analysis.authoritative;
        unowned = analysis.unowned;
        for (const hit of analysis.hits) {
          astHitLines.add(hit.line);
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              line: hit.line,
              message: `Test skipped or narrowed: ${hit.why}.`,
              evidence: hit.evidence,
              remediation:
                'Make the test pass rather than skipping it. If it is genuinely obsolete, a human must sign off.',
            }),
          );
        }
      }

      for (const hit of contextSkipHits(c, lang)) {
        astHitLines.add(hit.line);
        out.push(
          makeFinding(RULE, policy, {
            file: c.path,
            line: hit.line,
            message: `Test skipped or narrowed: ${hit.why}.`,
            evidence: hit.evidence,
            remediation:
              'Make the test pass rather than skipping it. If it is genuinely obsolete, a human must sign off.',
          }),
        );
      }

      // #441: `@sk` where `sk = pytest.mark.skip` was bound in the file or the change.
      if (lang === 'py') {
        for (const hit of pyAliasDecoratorHits(c)) {
          if (hit.line != null) astHitLines.add(hit.line);
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              line: hit.line,
              message: 'Test skipped or narrowed: a decorator aliasing a pytest skip/skipif/xfail marker.',
              evidence: hit.evidence,
              remediation:
                'Make the test pass rather than skipping it. If it is genuinely obsolete, a human must sign off.',
            }),
          );
        }
      }

      for (const l of addedLines(c)) {
        if (l.newLine != null && astHitLines.has(l.newLine)) continue;
        const comment = isCommentLine(l.content.trim(), lang);
        for (const p of patterns) {
          if (astAuthoritative && p.astOwned && !(l.newLine != null && unowned.has(l.newLine))) continue;
          if (comment && !p.comment) continue;
          if (matchesOutsideString(p, l.content, lang)) {
            out.push(
              makeFinding(RULE, policy, {
                file: c.path,
                line: l.newLine ?? undefined,
                message: `Test skipped or narrowed: ${p.why}.`,
                evidence: l.content.trim(),
                remediation:
                  'Make the test pass rather than skipping it. If it is genuinely obsolete, a human must sign off.',
              }),
            );
            break;
          }
        }
      }
    }
    return out;
  },
};
