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

import ts from 'typescript';
import { Change, Detector, FileChange, Finding } from '../types';
import { addedLines } from '../diff/select';
import { isProtected } from '../policy';
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
const JS_MOD = 'concurrent|sequential|shuffle'; // vitest concurrency modifier: it.concurrent.skip

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
  ],
  go: [
    { re: /\b[tb]\.Skip(?:f|Now)?\(/, why: 'a runtime t.Skip()/Skipf()/SkipNow() call' },
    { re: /\bif\s+testing\.Short\(\)/, why: 'a testing.Short() guard (the body is skipped under -short)' },
    { re: /^\s*\/\/\s*(?:go:build|\+build)\s+ignore\b/, why: 'a build-ignore constraint (the file is excluded from the test run)', comment: true },
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
  ],
  java: [
    { re: /@(?:[\w.]+\.)?(?:Ignore|Disabled)\b/, why: 'an @Ignore/@Disabled annotation' },
    { re: /\bassume(?:True\(\s*false|False\(\s*true)\s*[,)]/, why: 'an assumption that never holds (the test aborts as skipped)' },
  ],
  kt: [
    { re: /@(?:[\w.]+\.)?(?:Ignore|Disabled)\b/, why: 'an @Ignore/@Disabled annotation' },
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
const JS_CHAIN_MODIFIERS = new Set(['concurrent', 'sequential', 'shuffle']);
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

function scriptKind(path: string): ts.ScriptKind {
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

function moduleName(expr: ts.Expression): string | null {
  return ts.isStringLiteralLike(expr) ? expr.text : null;
}

function requiredModule(expr: ts.Expression): string | null {
  if (
    !ts.isCallExpression(expr) ||
    !ts.isIdentifier(expr.expression) ||
    expr.expression.text !== 'require' ||
    expr.arguments.length !== 1
  ) return null;
  return moduleName(expr.arguments[0]);
}


type AstContext = {
  sf: ts.SourceFile;
  checker: ts.TypeChecker;
};

type StaticValue = {
  value: string;
  causes: ts.Node[];
};

type RunnerBinding = {
  causes: ts.Node[];
};

type SemanticHit = {
  semanticKey: string;
  terminalNode: ts.Node;
  causeNodes: ts.Node[];
  why: string;
  evidence: string;
};

function astContext(path: string, source: string): AstContext | null {
  const rootName = path.startsWith('/') ? path : '/tamperward/' + path;
  const sf = ts.createSourceFile(
    rootName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );

  const diagnostics = (
    sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return null;

  const options: ts.CompilerOptions = {
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

function symbolAt(ctx: AstContext, node: ts.Node): ts.Symbol | null {
  return ctx.checker.getSymbolAtLocation(node) ?? null;
}

function importAliases(ctx: AstContext): Map<ts.Symbol, RunnerBinding> {
  const out = new Map<ts.Symbol, RunnerBinding>();
  const simpleAliases: Array<{ local: ts.Identifier; source: ts.Identifier }> = [];

  const add = (id: ts.Identifier, causes: ts.Node[] = [id]): void => {
    const sym = symbolAt(ctx, id);
    if (sym) out.set(sym, { causes });
  };

  for (const stmt of ctx.sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
      if (!JS_TEST_MODULES.has(stmt.moduleSpecifier.text)) continue;
      const clause = stmt.importClause;
      if (!clause) continue;
      if (clause.name && stmt.moduleSpecifier.text.startsWith('node:test')) add(clause.name);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          const imported = el.propertyName?.text ?? el.name.text;
          if (JS_RUNNERS.has(imported)) add(el.name);
        }
      }
      continue;
    }

    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isObjectBindingPattern(decl.name) && decl.initializer) {
        const mod = requiredModule(decl.initializer);
        if (!mod || !JS_TEST_MODULES.has(mod)) continue;
        for (const el of decl.name.elements) {
          if (!ts.isIdentifier(el.name)) continue;
          const imported = el.propertyName && ts.isIdentifier(el.propertyName)
            ? el.propertyName.text
            : el.name.text;
          if (JS_RUNNERS.has(imported)) add(el.name);
        }
      } else if (ts.isIdentifier(decl.name) && decl.initializer && ts.isIdentifier(decl.initializer)) {
        simpleAliases.push({ local: decl.name, source: decl.initializer });
      }
    }
  }

  for (let pass = 0; pass < simpleAliases.length + 1; pass++) {
    let changed = false;
    for (const alias of simpleAliases) {
      const localSym = symbolAt(ctx, alias.local);
      if (!localSym || out.has(localSym)) continue;

      const sourceSym = symbolAt(ctx, alias.source);
      const sourceBinding = sourceSym ? out.get(sourceSym) : undefined;
      const implicitGlobal = sourceSym == null && JS_RUNNERS.has(alias.source.text);

      if (!sourceBinding && !implicitGlobal) continue;
      out.set(localSym, {
        causes: [alias.local, ...(sourceBinding?.causes ?? [])],
      });
      changed = true;
    }
    if (!changed) break;
  }
  return out;
}

function topLevelStaticStrings(ctx: AstContext): Map<ts.Symbol, StaticValue> {
  const pending = new Map<ts.Symbol, { decl: ts.Identifier; expr: ts.Expression }>();

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

  const resolved = new Map<ts.Symbol, StaticValue>();
  const resolving = new Set<ts.Symbol>();

  const valueOf = (expr: ts.Expression): StaticValue | null => {
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
  expr: ts.Expression,
  ctx: AstContext,
  strings: Map<ts.Symbol, StaticValue>,
): { name: string; causes: ts.Node[] } | null {
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

function runnerChain(
  expr: ts.Expression,
  ctx: AstContext,
  runners: Map<ts.Symbol, RunnerBinding>,
  strings: Map<ts.Symbol, StaticValue>,
): { root: string; props: string[]; terminalNode: ts.Node; causes: ts.Node[] } | null {
  const props: string[] = [];
  const causes: ts.Node[] = [];
  let cur: ts.Expression = expr;
  let terminalNode: ts.Node = expr;

  while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    if (ts.isPropertyAccessExpression(cur)) {
      props.unshift(cur.name.text);
      if (props.length === 1) terminalNode = cur.name;
      cur = cur.expression;
      continue;
    }
    if (!cur.argumentExpression) return null;
    const property = staticPropertyName(cur.argumentExpression, ctx, strings);
    if (!property) return null;
    props.unshift(property.name);
    causes.push(...property.causes);
    if (props.length === 1) terminalNode = cur.argumentExpression;
    cur = cur.expression;
  }

  if (!ts.isIdentifier(cur)) return null;
  const sym = symbolAt(ctx, cur);
  if (sym) {
    const binding = runners.get(sym);
    if (!binding) return null;
    causes.push(...binding.causes);
  } else if (!JS_RUNNERS.has(cur.text)) {
    return null;
  }

  return { root: cur.text, props, terminalNode, causes };
}

function optionDisables(value: ts.Expression): boolean {
  return !(
    value.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isNumericLiteral(value) && Number(value.text) === 0)
  );
}

function shorthandOptionDisables(
  prop: ts.ShorthandPropertyAssignment,
  ctx: AstContext,
): boolean {
  const sym = ctx.checker.getShorthandAssignmentValueSymbol(prop) ?? symbolAt(ctx, prop.name);
  const decl =
    sym?.valueDeclaration ??
    sym?.declarations?.find((d): d is ts.VariableDeclaration => ts.isVariableDeclaration(d));
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
function structuralNodeKey(node: ts.Node, sf: ts.SourceFile): string {
  const children = node.getChildren(sf);
  const text = (node as ts.Node & { text?: unknown }).text;
  if (children.length === 0) {
    return typeof text === 'string'
      ? `${node.kind}:${JSON.stringify(text)}`
      : String(node.kind);
  }
  return `${node.kind}(${children.map((child) => structuralNodeKey(child, sf)).join(',')})`;
}

function semanticSkipHits(ctx: AstContext): SemanticHit[] {
  const runners = importAliases(ctx);
  const strings = topLevelStaticStrings(ctx);
  const hits: SemanticHit[] = [];
  const callOrdinals = new Map<string, number>();

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callText = node.getText(ctx.sf).trim();
      const callIdentity = structuralNodeKey(node, ctx.sf);
      const ordinal = (callOrdinals.get(callIdentity) ?? 0) + 1;
      callOrdinals.set(callIdentity, ordinal);
      const callKey = `${callIdentity}\u0000${ordinal}`;

      const chain = runnerChain(node.expression, ctx, runners, strings);
      if (chain) {
        const { props, terminalNode, causes } = chain;
        const terminal = props.at(-1);
        const push = (target: ts.Node, extraCauses: ts.Node[], why: string): void => {
          hits.push({
            semanticKey: `${callKey}\u0000${why}`,
            terminalNode: target,
            causeNodes: [...causes, ...extraCauses],
            why,
            evidence: callText,
          });
        };

        if (
          terminal &&
          (terminal === 'skip' || terminal === 'only' || terminal === 'todo') &&
          props.slice(0, -1).every((p) => JS_CHAIN_MODIFIERS.has(p))
        ) {
          push(terminalNode, [], 'a .skip/.only/.todo marker');
        } else if (terminal && ['skipIf', 'runIf'].includes(terminal) && props.length === 1) {
          push(terminalNode, [], 'a .skipIf()/.runIf() condition (the test runs only when the condition allows)');
        } else if (terminal && ['fails', 'failing'].includes(terminal) && props.length === 1) {
          push(terminalNode, [], 'a .fails/.failing marker (the test now passes by failing)');
        } else if (
          terminal === 'each' &&
          props.length === 1 &&
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
                let propertyCauses: ts.Node[] = [];
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
  return hits;
}

function astSkipHits(c: FileChange): { hits: AstHit[]; authoritative: boolean } {
  if (c.after == null) return { hits: [], authoritative: false };
  const added = addedLineNumbers(c);
  if (added.size === 0) return { hits: [], authoritative: false };

  const afterCtx = astContext(c.path, c.after);
  if (!afterCtx) return { hits: [], authoritative: false };

  const beforeCtx = c.before == null ? null : astContext(c.path, c.before);
  const beforeKeys = beforeCtx == null
    ? null
    : new Set(semanticSkipHits(beforeCtx).map((hit) => hit.semanticKey));

  const lineOf = (node: ts.Node): number =>
    afterCtx.sf.getLineAndCharacterOfPosition(node.getStart(afterCtx.sf)).line + 1;

  const hits: AstHit[] = [];
  const seen = new Set<string>();
  for (const hit of semanticSkipHits(afterCtx)) {
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
  return { hits, authoritative: true };
}

export const testSkip: Detector = {
  id: RULE,
  surface: ['file'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];
    for (const c of changes) {
      if (c.kind !== 'file') continue;
      if (!isProtected(c.path, policy, 'tests')) continue;
      const lang = langOf(c.path);
      const patterns = PATTERNS[lang ?? 'js'];
      const astHitLines = new Set<number>();
      let astAuthoritative = false;

      // Enriched JS/TS changes carry the whole AFTER file. For the JS forms the
      // AST models, a parse-clean AST is authoritative even when the result is
      // deliberately "not a test runner" because lexical shadowing must not be
      // overridden by the spelling-only regex fallback. Diff-only inputs and
      // parse-recovery trees keep the historical regex behavior.
      if (lang === 'js' && c.after != null) {
        const analysis = astSkipHits(c);
        astAuthoritative = analysis.authoritative;
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

      for (const l of addedLines(c)) {
        if (l.newLine != null && astHitLines.has(l.newLine)) continue;
        const comment = isCommentLine(l.content.trim(), lang);
        for (const p of patterns) {
          if (astAuthoritative && p.astOwned) continue;
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
