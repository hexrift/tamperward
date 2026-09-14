// #383 ts-cast-growth (file surface, mechanical count, warn by default).
//
// A cast is a promise to the compiler, not a runtime proof. In code that
// consumes untrusted or candidate-influenced data, an unnecessary assertion can
// hide exactly the mismatch a fail-closed gate exists to catch: malformed JSON,
// an unexpected process result, a filesystem state the type never modelled.
//
// Row 4 (`ts-any-cast`, block) takes the unambiguous escapes: `as any`,
// `as unknown as T`, the `@ts-*` directives. This rule takes what row 4
// deliberately leaves alone — ORDINARY `x as T` / `<T>x` assertions and
// non-null `x!` assertions — and reports NET GROWTH of that surface in a
// non-test source file. It is a budget, not a ban:
//
//   - a cast removed in the same change offsets a cast added elsewhere;
//   - a net reduction (the hardening direction) is silent;
//   - `as const`, `as unknown`, `satisfies`, generic call/JSX arguments and
//     cast-like text in comments or strings are not casts;
//   - declaration, generated and vendored files, and protected test files, are
//     outside the budget: they do not decide whether production typechecks.
//
// Severity is WARN. The rule fires on a large share of legitimate TypeScript
// mainline diffs — real libraries add assertions as routine work — so no block
// threshold survives (harness/fp-study/CAST-GROWTH-CORPUS.md). The finding is
// the review prompt the issue asked for: "this change grew the unsafe
// assertion surface; say why."
//
// The counts come from the TypeScript AST on full BEFORE/AFTER content. A side
// that does not parse cleanly declines (no guess); a diff-only change has no
// before/after and is silent, because growth is only meaningful net of what
// the same change removed.

import type TS from 'typescript';
import { parseSource, ts } from '../ts-lazy';
import { Change, Detector, Finding } from '../types';
import { protectedCategory } from '../policy';
import { addedLines } from '../diff/select';
import { isCodeFile } from './files';
import { makeFinding } from './finding';

const RULE = 'ts-cast-growth';

const DECLARATION = /\.d\.(?:ts|mts|cts)$/;
const OUT_OF_BUDGET_PATH =
  /(?:^|\/)(?:node_modules|vendor|third_party|dist|build|generated|__generated__)\/|\.(?:generated|gen)\.[cm]?[jt]sx?$/;
// A generator's own header, anywhere in the first lines of the file.
const GENERATED_HEADER = /@generated\b|\bAUTO-?GENERATED\b|\bDO NOT EDIT\b/i;
const HEADER_LINES = 20;

function scriptKind(path: string): TS.ScriptKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return ts.ScriptKind.TS;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/** Whether the file is outside the budget. Path rules apply to every file. The
 *  generated-header rule reads only the TRUSTED side: a header the candidate
 *  adds in the same change is candidate-controlled and must not exempt the
 *  assertions it adds beside it, and a newly added file's own header is not
 *  evidence of anything — only its path can exempt it. */
function outOfBudget(path: string, before: string | null): boolean {
  if (DECLARATION.test(path) || OUT_OF_BUDGET_PATH.test(path)) return true;
  return before != null && GENERATED_HEADER.test(before.split('\n', HEADER_LINES).join('\n'));
}

/** `x` with any `(…)` wrappers removed, so `(raw as unknown) as T` reads as
 *  the same double cast as `raw as unknown as T`. */
function unparenthesized(e: TS.Expression): TS.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  return x;
}

/** The asserted type with any `(…)` wrappers removed: `as (unknown)` is
 *  `as unknown`, `as ((any))` is `as any`. Both rules classify the target
 *  through this one helper so they cannot drift apart. */
export function assertedType(node: TS.AsExpression | TS.TypeAssertion): TS.TypeNode {
  let t: TS.TypeNode = node.type;
  while (ts.isParenthesizedTypeNode(t)) t = t.type;
  return t;
}

// Row 4's laundering surface, classified by the target type an assertion widens
// THROUGH. `any` / `never` are assignable in the dangerous direction on their own;
// `unknown` / `{}` / `object` / `Object` only launder as the INNER step of a double
// cast (`(x as {}) as T`) — alone they are an honest widening (`unknown`) or an
// ordinary assertion the growth budget keeps (`{}` / `object`). Local `type` aliases
// of these keywords resolve to the same kind, so `type A = any; x as A` is `as any`.
export type LaunderKind = 'any' | 'never' | 'unknown' | 'empty' | 'objectish' | 'const';
// The inner-step kinds a double cast may widen through to launder to an arbitrary type.
const DOUBLE_CAST_INNER: ReadonlySet<LaunderKind> = new Set<LaunderKind>(['any', 'never', 'unknown', 'empty', 'objectish']);

/** The launder kind a type node names WITHOUT resolving alias identifiers, or null for
 *  an honest/ordinary type. `Object` and the `const` of `as const` are recognised here;
 *  a plain alias identifier is left to the caller's resolver. */
function bareKind(type: TS.TypeNode): LaunderKind | null {
  let x: TS.TypeNode = type;
  while (ts.isParenthesizedTypeNode(x)) x = x.type;
  switch (x.kind) {
    case ts.SyntaxKind.AnyKeyword:
      return 'any';
    case ts.SyntaxKind.NeverKeyword:
      return 'never';
    case ts.SyntaxKind.UnknownKeyword:
      return 'unknown';
    case ts.SyntaxKind.ObjectKeyword:
      return 'objectish';
  }
  if (ts.isTypeLiteralNode(x) && x.members.length === 0) return 'empty'; // `{}`
  if (ts.isTypeReferenceNode(x) && ts.isIdentifier(x.typeName) && !x.typeArguments) {
    if (x.typeName.text === 'Object') return 'objectish';
    if (x.typeName.text === 'const') return 'const';
  }
  return null;
}

/** The launder kind a type node names, resolving a local alias identifier through
 *  `resolveName`. */
function kindOfType(type: TS.TypeNode, resolveName: (name: string) => LaunderKind | null): LaunderKind | null {
  const bare = bareKind(type);
  if (bare) return bare;
  let x: TS.TypeNode = type;
  while (ts.isParenthesizedTypeNode(x)) x = x.type;
  if (ts.isTypeReferenceNode(x) && ts.isIdentifier(x.typeName) && !x.typeArguments) return resolveName(x.typeName.text);
  return null;
}

/** The file's resolvable non-generic `type X = <launder keyword>` aliases, collapsed to
 *  the kind they ultimately name (through parens and other local aliases). Generic
 *  aliases, cycles, and aliases of honest types are left out — they resolve to nothing. */
export function buildAliasMap(sf: TS.SourceFile): Map<string, LaunderKind> {
  const decls = new Map<string, TS.TypeNode>();
  const collect = (node: TS.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && (!node.typeParameters || node.typeParameters.length === 0)) decls.set(node.name.text, node.type);
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const resolve = (name: string, seen: Set<string>): LaunderKind | null => {
    if (seen.has(name)) return null; // a cycle resolves to nothing
    seen.add(name);
    const t = decls.get(name);
    return t ? kindOfType(t, (n) => resolve(n, seen)) : null;
  };
  const resolved = new Map<string, LaunderKind>();
  for (const name of decls.keys()) {
    const k = resolve(name, new Set());
    if (k) resolved.set(name, k);
  }
  return resolved;
}

/** The launder kind an assertion widens TO, resolving local aliases. */
export function assertedLaunderKind(node: TS.AsExpression | TS.TypeAssertion, aliasMap: Map<string, LaunderKind>): LaunderKind | null {
  return kindOfType(assertedType(node), (n) => aliasMap.get(n) ?? null);
}

/** Row 4's double cast: an assertion whose operand is itself an assertion whose target
 *  widens (to `unknown` / `never` / `any` / `{}` / `object` / `Object`, alias-resolved),
 *  expression and type parentheses notwithstanding. `(x as {}) as T` launders exactly as
 *  `x as unknown as T` does. */
export function isDoubleCast(node: TS.AsExpression | TS.TypeAssertion, aliasMap?: Map<string, LaunderKind>): boolean {
  const inner = unparenthesized(node.expression);
  if (!(ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner))) return false;
  const k = assertedLaunderKind(inner, aliasMap ?? EMPTY_ALIASES);
  return k != null && DOUBLE_CAST_INNER.has(k);
}

const EMPTY_ALIASES: Map<string, LaunderKind> = new Map();

interface Assertion {
  kind: 'type' | 'non-null';
  line: number;
  text: string;
  /** The whole source line, trimmed: the alignment key. Two identical
   *  assertions on different lines are told apart by what surrounds them. */
  lineText: string;
}

interface Surface {
  type: number;
  nonNull: number;
  assertions: Assertion[];
}

/** The parse-clean assertion surface of one file, or null when the file does
 *  not parse: an unparseable side is a declined comparison, never a count. */
function surfaceOf(path: string, src: string): Surface | null {
  const sf = parseSource(path, src, scriptKind(path));
  if (!sf) return null;
  // parseDiagnostics is not on the public SourceFile type; reading it through
  // the object shape is the one way to ask the parser whether it recovered.
  const diagnostics = 'parseDiagnostics' in sf && Array.isArray(sf.parseDiagnostics) ? sf.parseDiagnostics : [];
  if (diagnostics.length > 0) return null;

  const surface: Surface = { type: 0, nonNull: 0, assertions: [] };
  const lines = src.split('\n');
  const aliasMap = buildAliasMap(sf);
  const record = (kind: Assertion['kind'], node: TS.Node): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    surface.assertions.push({ kind, line, text: node.getText(sf).replace(/\s+/g, ' '), lineText: (lines[line - 1] ?? '').trim() });
    if (kind === 'type') surface.type++;
    else surface.nonNull++;
  };
  // The inner step of a laundering double cast is part of row 4, not the ordinary
  // budget — even when its own target (`{}` / `object`) would be budgeted alone.
  const launderInner = new Set<TS.Node>();
  const collectInners = (node: TS.Node): void => {
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && isDoubleCast(node, aliasMap)) launderInner.add(unparenthesized(node.expression));
    ts.forEachChild(node, collectInners);
  };
  collectInners(sf);
  const isRow4OrHonest = (node: TS.AsExpression | TS.TypeAssertion): boolean => {
    // `as const` is a literal-type request, `as unknown` the honest widening,
    // `as any` / `as never` row 4's block; none of them is the ordinary assertion
    // budgeted here — parentheses and local aliases (`type A = any`) notwithstanding.
    // `{}` / `object` stay in the budget unless they are the inner step of a launder.
    const k = assertedLaunderKind(node, aliasMap);
    return k === 'any' || k === 'never' || k === 'unknown' || k === 'const';
  };
  const visit = (node: TS.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      // `x as unknown as T` (parenthesised or not), and every widening spelling of
      // it, is row 4's double cast — the outer assertion and its inner step both
      // belong to ts-any-cast, not the ordinary narrowing budget.
      if (!isDoubleCast(node, aliasMap) && !isRow4OrHonest(node) && !launderInner.has(node)) record('type', node);
    } else if (ts.isNonNullExpression(node)) {
      record('non-null', node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return surface;
}

/** The AFTER assertions that no BEFORE assertion aligns with, under a
 *  longest-common-subsequence alignment on the whole source line. */
function unmatchedAfter(before: Assertion[], after: Assertion[]): Assertion[] {
  const n = before.length;
  const m = after.length;
  const same = (i: number, j: number): boolean => before[i].lineText === after[j].lineText && before[i].text === after[j].text;
  // lcs[i][j]: LCS length of before[i..] and after[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = same(i, j) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: Assertion[] = [];
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && same(i, j)) {
      i++;
      j++;
    } else if (i < n && lcs[i + 1][j] >= lcs[i][j + 1]) {
      i++; // a BEFORE occurrence that was removed
    } else {
      out.push(after[j]); // an AFTER occurrence nothing aligns with: new
      j++;
    }
  }
  return out;
}

export const tsCastGrowth: Detector = {
  id: RULE,
  surface: ['file'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];
    for (const c of changes) {
      if (c.kind !== 'file' || c.op === 'delete' || c.after == null) continue;
      if (!isCodeFile(c.path) || outOfBudget(c.path, c.before)) continue;
      if (protectedCategory(c.path, policy) === 'tests') continue;

      const after = surfaceOf(c.path, c.after);
      const before = c.before == null ? { type: 0, nonNull: 0, assertions: [] } : surfaceOf(c.path, c.before);
      if (!after || !before) continue; // one side did not parse: decline, do not guess

      const dType = after.type - before.type;
      const dNonNull = after.nonNull - before.nonNull;
      if (dType <= 0 && dNonNull <= 0) continue;

      // Point at the first assertion that is a genuinely new OCCURRENCE. When
      // the producer supplied hunks, an occurrence on a line the diff added is
      // new by definition. Otherwise the BEFORE and AFTER sequences are aligned
      // by longest common subsequence on the whole source line, so an identical
      // assertion inserted before an existing one is the unmatched (new)
      // occurrence and the shifted-down original is not.
      const grownKinds = new Set<Assertion['kind']>([...(dType > 0 ? ['type' as const] : []), ...(dNonNull > 0 ? ['non-null' as const] : [])]);
      const addedLineNumbers = new Set(addedLines(c).flatMap((l) => (l.newLine == null ? [] : [l.newLine])));
      const onAddedLine = after.assertions.find((a) => grownKinds.has(a.kind) && addedLineNumbers.has(a.line));
      const first =
        onAddedLine ??
        unmatchedAfter(before.assertions, after.assertions).find((a) => grownKinds.has(a.kind)) ??
        after.assertions.find((a) => grownKinds.has(a.kind));

      const parts: string[] = [];
      if (dType > 0) parts.push(`+${dType} type assertion${dType === 1 ? '' : 's'} (\`as T\` / \`<T>x\`)`);
      if (dNonNull > 0) parts.push(`+${dNonNull} non-null assertion${dNonNull === 1 ? '' : 's'} (\`x!\`)`);
      out.push(
        makeFinding(RULE, policy, {
          file: c.path,
          ...(first ? { line: first.line } : {}),
          message:
            `The unsafe assertion surface grew: ${parts.join(', ')} net of any removed in this change` +
            ` (now ${after.type} type / ${after.nonNull} non-null in this file).`,
          evidence: first?.text ?? parts.join(', '),
          remediation:
            'Prove the value instead of asserting it: parse or validate at the boundary, use a type guard or ' +
            'discriminated union, or handle the nullable case. If the assertion is genuinely unavoidable, keep it ' +
            'at the narrowest boundary and say why in a comment.',
          defaultSeverity: 'warn',
        }),
      );
    }
    return out;
  },
};
