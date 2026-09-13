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

import ts from 'typescript';
import { Change, Detector, Finding } from '../types';
import { protectedCategory } from '../policy';
import { isCodeFile } from './files';
import { makeFinding } from './finding';

const RULE = 'ts-cast-growth';

const DECLARATION = /\.d\.(?:ts|mts|cts)$/;
const OUT_OF_BUDGET_PATH =
  /(?:^|\/)(?:node_modules|vendor|third_party|dist|build|generated|__generated__)\/|\.(?:generated|gen)\.[cm]?[jt]sx?$/;
// A generator's own header, anywhere in the first lines of the file.
const GENERATED_HEADER = /@generated\b|\bAUTO-?GENERATED\b|\bDO NOT EDIT\b/i;
const HEADER_LINES = 20;

function scriptKind(path: string): ts.ScriptKind {
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
function unparenthesized(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  return x;
}

/** Row 4's double cast: an assertion whose operand is itself an assertion to
 *  `unknown`, parentheses notwithstanding. */
export function isDoubleCast(node: ts.AsExpression | ts.TypeAssertion): boolean {
  const inner = unparenthesized(node.expression);
  return (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) && inner.type.kind === ts.SyntaxKind.UnknownKeyword;
}

interface Assertion {
  kind: 'type' | 'non-null';
  line: number;
  text: string;
}

interface Surface {
  type: number;
  nonNull: number;
  assertions: Assertion[];
}

/** The parse-clean assertion surface of one file, or null when the file does
 *  not parse: an unparseable side is a declined comparison, never a count. */
function surfaceOf(path: string, src: string): Surface | null {
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, scriptKind(path));
  } catch {
    return null;
  }
  // parseDiagnostics is not on the public SourceFile type; reading it through
  // the object shape is the one way to ask the parser whether it recovered.
  const diagnostics = 'parseDiagnostics' in sf && Array.isArray(sf.parseDiagnostics) ? sf.parseDiagnostics : [];
  if (diagnostics.length > 0) return null;

  const surface: Surface = { type: 0, nonNull: 0, assertions: [] };
  const record = (kind: Assertion['kind'], node: ts.Node): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    surface.assertions.push({ kind, line, text: node.getText(sf).replace(/\s+/g, ' ') });
    if (kind === 'type') surface.type++;
    else surface.nonNull++;
  };
  const isRow4OrHonest = (type: ts.TypeNode): boolean => {
    // `as const` is a literal-type request, `as unknown` the honest widening,
    // `as any` row 4's block; none of them is the ordinary assertion budgeted here.
    if (type.kind === ts.SyntaxKind.AnyKeyword || type.kind === ts.SyntaxKind.UnknownKeyword) return true;
    return ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === 'const';
  };
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      // `x as unknown as T` (parenthesised or not): the outer assertion is
      // row 4's double cast, not an ordinary narrowing — leave it to ts-any-cast.
      if (!isDoubleCast(node) && !isRow4OrHonest(node.type)) record('type', node);
    } else if (ts.isNonNullExpression(node)) {
      record('non-null', node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return surface;
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

      // Point at the first assertion that is a genuinely new OCCURRENCE: each
      // BEFORE spelling consumes one AFTER occurrence, so a second identical
      // assertion is reported at its own line, not at the unchanged first one.
      const budget = new Map<string, number>();
      for (const a of before.assertions) budget.set(a.text, (budget.get(a.text) ?? 0) + 1);
      const grownKinds = new Set<Assertion['kind']>([...(dType > 0 ? ['type' as const] : []), ...(dNonNull > 0 ? ['non-null' as const] : [])]);
      const first = after.assertions.find((a) => {
        const left = budget.get(a.text) ?? 0;
        if (left > 0) {
          budget.set(a.text, left - 1);
          return false;
        }
        return grownKinds.has(a.kind);
      }) ?? after.assertions.find((a) => grownKinds.has(a.kind));

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
