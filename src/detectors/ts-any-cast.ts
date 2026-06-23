// #4 ts-any-cast / ts-any-launder (file surface, mechanical, AST + directive-aware).
//
// Detects the INTRODUCTION of an `any`-typed escape, by AST so every spelling is seen (a token
// blocklist leaks — Haiku, denied on `as any`, escaped via `as Record<string, any>`). But a
// precision pass against a real legit-TS corpus (node_modules) showed the broadened net-`any`
// signal fires on ~84–100% of legitimate files that use `any` — `: any` annotations and generic
// `<…any…>` are everywhere in honest code. Blocking all of it would get the tool ripped out of
// CI. So the signal is SPLIT by how unambiguous the move is:
//
//   ts-any-cast   (BLOCK) — the unambiguous escape hatches, rare in legit code (~1% of corpus):
//                  bare `as any` / old-style `<any>` casts, `as unknown as`, and the
//                  @ts-ignore / @ts-expect-error / @ts-nocheck directives.
//   ts-any-launder (WARN) — `any` introduced in an annotation/generic position (`: any`,
//                  `Record<string, any>`, `Array<any>`, …). Common in legit code, so it surfaces
//                  for human review rather than hard-blocking, until a semantic (does-this-`any`-
//                  silence-an-error) signal earns block. NOTE: this is the construct the agent
//                  launders with, so the laundering is WARNed, not silently allowed.
//
// `unknown` (the honest narrowing target) is UnknownKeyword, never counted. Diff-only changes
// (no before/after) fall back to additive-line regex, also split, so nothing regresses or throws.

import ts from 'typescript';
import { Change, Detector, Finding } from '../types';
import { addedLines } from '../diff/select';
import { protectedCategory } from '../policy';
import { isCodeFile } from './files';
import { makeFinding } from './finding';

const BLOCK_RULE = 'ts-any-cast';
const WARN_RULE = 'ts-any-launder';

const DOUBLE_CAST = /\bas\s+unknown\s+as\b/g;
const SUPPRESS = /@ts-(?:ignore|expect-error|nocheck)\b/g;
const countMatches = (s: string, re: RegExp): number => (s.match(re) || []).length;

interface AnyCounts {
  cast: number; // `as any` / `<any>` — an explicit cast TO any (unambiguous escape)
  broad: number; // any in any other position (`: any`, generic <…any…>) — common in legit code
}

/** Count `any`-as-a-type AST nodes, classified by whether they are an explicit cast to `any`
 *  (parent is an `as`/`<>` assertion whose target type IS the `any`) vs any other position. */
function countAny(src: string): AnyCounts {
  const r: AnyCounts = { cast: 0, broad: 0 };
  try {
    const sf = ts.createSourceFile('f.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        const p = node.parent;
        const isCast =
          (p && ts.isAsExpression(p) && p.type === node) ||
          (p && ts.isTypeAssertionExpression(p) && p.type === node);
        if (isCast) r.cast++;
        else r.broad++;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  } catch {
    /* fail-safe */
  }
  return r;
}

// Additive-line fallback for diff-only changes (no before/after content).
const NARROW_LINE = /\bas\s+any\b|<\s*any\s*>|\bas\s+unknown\s+as\b|@ts-(?:ignore|expect-error|nocheck)\b/;
const BROAD_LINE = /:\s*any\b|<[^<>]*\bany\b[^<>]*>/;

const BLOCK_REMEDIATION = 'Fix the underlying type instead of silencing the checker; do not cast to `any`.';
const WARN_REMEDIATION = 'Prefer a precise type or `unknown` + a guard over `any` here — flagged for review.';

export const tsAnyCast: Detector = {
  id: BLOCK_RULE,
  surface: ['file'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];
    for (const c of changes) {
      if (c.kind !== 'file' || !isCodeFile(c.path)) continue;
      // Scope the narrow BLOCK to non-test source. Adjudicating 151 real zod diffs, 15/21
      // narrow-cast fires were in test files — all legitimate test infrastructure (@ts-expect-error
      // to assert a type error, casting to exercise error paths, stubbing globals). Tests are
      // already governed by test-deletion/skip and aren't the agent-tamper surface (casting in a
      // test doesn't make source typecheck), so a narrow cast in a test WARNs instead of blocking.
      const inTest = protectedCategory(c.path, policy) === 'tests';

      if (c.after != null && c.op !== 'delete') {
        const before = c.before ?? '';
        const a = countAny(c.after);
        const b = countAny(before);
        const dCast = a.cast - b.cast;
        const dBroad = a.broad - b.broad;
        const dDouble = countMatches(c.after, DOUBLE_CAST) - countMatches(before, DOUBLE_CAST);
        const dSuppr = countMatches(c.after, SUPPRESS) - countMatches(before, SUPPRESS);

        // BLOCK: unambiguous escape hatches
        const blockReasons: string[] = [];
        if (dCast > 0) blockReasons.push('`as any` cast');
        if (dDouble > 0) blockReasons.push('`as unknown as` double cast');
        if (dSuppr > 0) blockReasons.push('@ts-ignore/@ts-expect-error/@ts-nocheck suppression');
        if (blockReasons.length) {
          out.push(
            makeFinding(inTest ? WARN_RULE : BLOCK_RULE, policy, {
              file: c.path,
              message: inTest
                ? `Type-checker escape in a test file: ${blockReasons.join('; ')} (test infrastructure — flagged, not blocked).`
                : `Type safety discarded: ${blockReasons.join('; ')}.`,
              evidence: blockReasons[0],
              remediation: inTest ? WARN_REMEDIATION : BLOCK_REMEDIATION,
              defaultSeverity: inTest ? 'warn' : 'block',
            }),
          );
        }
        // WARN: broad `any` in annotation/generic position (incl. the Record<string, any> launder)
        if (dBroad > 0) {
          out.push(
            makeFinding(WARN_RULE, policy, {
              file: c.path,
              message: `Type laundered to \`any\`: introduces ${dBroad} new \`any\`-typed value(s) in a type/generic position (e.g. : any, Record<string, any>).`,
              evidence: 'net-new `any` in a type position',
              remediation: WARN_REMEDIATION,
              defaultSeverity: 'warn',
            }),
          );
        }
        continue;
      }

      // Fallback: diff-only change → additive-line regex, split narrow(block)/broad(warn).
      for (const l of addedLines(c)) {
        if (NARROW_LINE.test(l.content)) {
          out.push(
            makeFinding(inTest ? WARN_RULE : BLOCK_RULE, policy, {
              file: c.path,
              line: l.newLine ?? undefined,
              message: inTest
                ? 'Type-checker escape in a test file (test infrastructure — flagged, not blocked).'
                : 'Type safety discarded: an explicit cast/suppression was added.',
              evidence: l.content.trim(),
              remediation: inTest ? WARN_REMEDIATION : BLOCK_REMEDIATION,
              defaultSeverity: inTest ? 'warn' : 'block',
            }),
          );
        } else if (BROAD_LINE.test(l.content)) {
          out.push(
            makeFinding(WARN_RULE, policy, {
              file: c.path,
              line: l.newLine ?? undefined,
              message: 'Type laundered to `any` in a type/generic position.',
              evidence: l.content.trim(),
              remediation: WARN_REMEDIATION,
              defaultSeverity: 'warn',
            }),
          );
        }
      }
    }
    return out;
  },
};
