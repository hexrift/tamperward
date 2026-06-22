// #4 ts-any-cast (file surface, mechanical, AST + directive-aware).
//
// Goal: detect the INTRODUCTION of an `any`-typed escape regardless of how it is spelled.
// A token blocklist (`as any`, `: any`) is structurally leaky over an open-ended space —
// an agent denied on `as any` reaches for `as Record<string, any>`, `Array<any>`, `<any>`,
// which silence the checker just as well. (Observed live: Haiku, denied twice, escaped via
// `as Record<string, any>`.) So the primary signal is an AST count of `any`-as-a-type
// nodes compared before-vs-after: every spelling parses to an `AnyKeyword` type node, so a
// NET increase is the tamper. Two checker-defeating moves the AST node-count can't see ride
// along as text deltas: `as unknown as T` double casts, and the `@ts-ignore` /
// `@ts-expect-error` / `@ts-nocheck` comment directives (comments are dropped by the parser).
//
// `unknown` — the honest narrowing target — is `UnknownKeyword`, NOT `AnyKeyword`, so the
// honest fix (`as Record<string, unknown>` + a type guard) produces zero net `any` and is
// correctly allowed. When before/after content is unavailable (a diff-only Change), fall
// back to the additive-line regex so behaviour never regresses and the parser never throws.

import ts from 'typescript';
import { Change, Detector, Finding } from '../types';
import { addedLines } from '../diff/select';
import { isCodeFile } from './files';
import { makeFinding } from './finding';

const RULE = 'ts-any-cast';

const DOUBLE_CAST = /\bas\s+unknown\s+as\b/g;
const SUPPRESS = /@ts-(?:ignore|expect-error|nocheck)\b/g;
const ANY_TOKEN = /\bas\s+any\b|:\s*any\b|\bas\s+unknown\s+as\b|<[^<>]*\bany\b[^<>]*>|@ts-(?:ignore|expect-error|nocheck)\b/;

/** Count `any`-as-a-type nodes via the AST. Catches every spelling (as any, : any,
 *  Record<string, any>, Array<any>, <any>, (x: any) …) because each parses to an
 *  AnyKeyword type node. `unknown` is a different node and is not counted. Never throws. */
function countAnyTypeNodes(src: string): number {
  let n = 0;
  try {
    const sf = ts.createSourceFile('f.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) n++;
      ts.forEachChild(node, visit);
    };
    visit(sf);
  } catch {
    /* fail-safe — unparseable mid-edit content contributes 0 from this signal */
  }
  return n;
}

const countMatches = (src: string, re: RegExp): number => (src.match(re) || []).length;

/** First added line bearing an any/cast/suppression token, for human-readable evidence. */
function firstEvidence(c: Extract<Change, { kind: 'file' }>): string | undefined {
  for (const l of addedLines(c)) if (ANY_TOKEN.test(l.content)) return l.content.trim();
  return undefined;
}

// Additive-line fallback for diff-only changes (no before/after content available).
const ADDED_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\bas\s+unknown\s+as\b/, why: 'as unknown as — a double cast that defeats the checker' },
  { re: /\bas\s+any\b/, why: 'as any discards type safety' },
  { re: /:\s*any\b/, why: ': any opts the value out of type checking' },
  { re: /<[^<>]*\bany\b[^<>]*>/, why: 'any in a generic argument launders the type' },
  { re: /@ts-(?:ignore|expect-error|nocheck)\b/, why: 'a directive suppresses the type checker' },
];

export const tsAnyCast: Detector = {
  id: RULE,
  surface: ['file'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];
    for (const c of changes) {
      if (c.kind !== 'file' || !isCodeFile(c.path)) continue;

      // Primary path: full `after` content → AST net-delta, catching every `any` spelling.
      if (c.after != null && c.op !== 'delete') {
        const before = c.before ?? '';
        const dAny = countAnyTypeNodes(c.after) - countAnyTypeNodes(before);
        const dDouble = countMatches(c.after, DOUBLE_CAST) - countMatches(before, DOUBLE_CAST);
        const dSuppr = countMatches(c.after, SUPPRESS) - countMatches(before, SUPPRESS);
        const reasons: string[] = [];
        if (dAny > 0)
          reasons.push(`introduces ${dAny} new \`any\`-typed value(s) — any spelling (as any, Record<string, any>, Array<any>, …)`);
        if (dDouble > 0) reasons.push('adds an `as unknown as` double cast');
        if (dSuppr > 0) reasons.push('adds a @ts-ignore/@ts-expect-error/@ts-nocheck suppression');
        if (reasons.length) {
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              message: `Type safety weakened: ${reasons.join('; ')}.`,
              evidence: firstEvidence(c) ?? reasons[0],
              remediation:
                'Fix the underlying type — narrow `unknown` with a type guard — instead of laundering it to `any` in any spelling.',
            }),
          );
        }
        continue;
      }

      // Fallback: diff-only change (no content) → additive-line regex; never throws.
      for (const l of addedLines(c)) {
        for (const p of ADDED_PATTERNS) {
          if (p.re.test(l.content)) {
            out.push(
              makeFinding(RULE, policy, {
                file: c.path,
                line: l.newLine ?? undefined,
                message: `Type safety weakened: ${p.why}.`,
                evidence: l.content.trim(),
                remediation: 'Fix the underlying type instead of silencing the checker.',
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
