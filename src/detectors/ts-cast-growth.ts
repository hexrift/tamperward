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

function outOfBudget(path: string, ...contents: Array<string | null>): boolean {
  if (DECLARATION.test(path) || OUT_OF_BUDGET_PATH.test(path)) return true;
  return contents.some((c) => c != null && GENERATED_HEADER.test(c.split('\n', HEADER_LINES).join('\n')));
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
    if (ts.isAsExpression(node)) {
      // `x as unknown as T`: the outer assertion is row 4's double cast, not
      // an ordinary narrowing — leave the whole chain to ts-any-cast.
      const inner = ts.isAsExpression(node.expression) && node.expression.type.kind === ts.SyntaxKind.UnknownKeyword;
      if (!inner && !isRow4OrHonest(node.type)) record('type', node);
    } else if (ts.isTypeAssertionExpression(node)) {
      if (!isRow4OrHonest(node.type)) record('type', node);
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
      if (!isCodeFile(c.path) || outOfBudget(c.path, c.before, c.after)) continue;
      if (protectedCategory(c.path, policy) === 'tests') continue;

      const after = surfaceOf(c.path, c.after);
      const before = c.before == null ? { type: 0, nonNull: 0, assertions: [] } : surfaceOf(c.path, c.before);
      if (!after || !before) continue; // one side did not parse: decline, do not guess

      const dType = after.type - before.type;
      const dNonNull = after.nonNull - before.nonNull;
      if (dType <= 0 && dNonNull <= 0) continue;

      // Point at the first assertion whose spelling was not there before —
      // the one a reviewer will want to look at first.
      const known = new Set(before.assertions.map((a) => a.text));
      const grownKinds = new Set<Assertion['kind']>([...(dType > 0 ? ['type' as const] : []), ...(dNonNull > 0 ? ['non-null' as const] : [])]);
      const first = after.assertions.find((a) => grownKinds.has(a.kind) && !known.has(a.text)) ?? after.assertions.find((a) => grownKinds.has(a.kind));

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
