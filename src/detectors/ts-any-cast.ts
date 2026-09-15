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
//                  bare `as any` / old-style `<any>` casts, `as never` (assignable in the
//                  dangerous direction), the double cast through `unknown` / `never` / `{}` /
//                  `object` / `Object`, a local `type` alias of any of those, the
//                  @ts-ignore / @ts-expect-error / @ts-nocheck directives (counted live, on the
//                  AST's comment ranges — not by whole-file text, so a comment that merely
//                  mentions one is not one), and the JSDoc `@type {any}` / `{*}` / `{?}` cast.
//   ts-any-launder (WARN) — `any` introduced in an annotation/generic position (`: any`,
//                  `Record<string, any>`, `Array<any>`, …). Common in legit code, so it surfaces
//                  for human review rather than hard-blocking, until a semantic (does-this-`any`-
//                  silence-an-error) signal earns block. NOTE: this is the construct the agent
//                  launders with, so the laundering is WARNed, not silently allowed.
//
// `unknown` (the honest narrowing target) is UnknownKeyword, never counted on its own. Diff-only
// changes (no before/after) fall back to additive-line analysis, also split, so nothing throws.

import type TS from 'typescript';
import { parseSource, ts } from '../ts-lazy';
import { Change, Detector, Finding } from '../types';
import { addedLines } from '../diff/select';
import { protectedCategory } from '../policy';
import { CommentStringMasker, isCodeFile } from './files';
import { makeFinding } from './finding';
import { assertedLaunderKind, buildAliasMap, isDoubleCast, LaunderKind } from './ts-cast-growth';

const BLOCK_RULE = 'ts-any-cast';
const WARN_RULE = 'ts-any-launder';

// The JavaScript spelling of `as any`: a JSDoc cast, `/** @type {any} */ (x)`. `{*}` and `{?}`
// are the same `any` in JSDoc. Only the parenthesised form is a cast (an annotation before a
// declaration is the launder class), and only in a JS file — TypeScript ignores JSDoc types.
const JSDOC_ANY_CAST = /\/\*\*\s*@type\s*\{\s*(?:any|\*|\?)\s*\}\s*\*\/\s*\(/g;
const JS_FILE = /\.(?:js|jsx|mjs|cjs)$/;
const countMatches = (s: string, re: RegExp): number => (s.match(re) || []).length;

// A live `@ts-*` directive: the directive at the START of a comment's content (after the `//`,
// `/*`, or a JSDoc `*` continuation), which is the position TypeScript honours it in. `// never
// use @ts-ignore here` mentions it but does not start with it, so it suppresses nothing.
const DIRECTIVE_START = /^@ts-(?:ignore|expect-error|nocheck)\b/;

/** Whether one comment token (markers included) is a live `@ts-*` directive. */
function commentIsLiveDirective(text: string): boolean {
  let inner = text;
  if (inner.startsWith('//')) inner = inner.replace(/^\/+/, ''); // `//` or `///`
  else inner = inner.replace(/^\/\*+/, '').replace(/\*+\/$/, ''); // `/* … */` or `/** … */`
  for (const raw of inner.split('\n')) {
    if (DIRECTIVE_START.test(raw.replace(/^\s*\*+/, '').trim())) return true;
  }
  return false;
}

/** Count live `@ts-*` directives by tokenising the source: the scanner yields comment trivia and
 *  reads strings, templates and regex literals as their own tokens, so `@ts-ignore` inside a
 *  string, a template, or a `/…/` regex is text and is not counted. */
function countLiveDirectives(src: string): number {
  let n = 0;
  try {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ false, ts.LanguageVariant.Standard, src);
    let tok = scanner.scan();
    while (tok !== ts.SyntaxKind.EndOfFileToken) {
      if (tok === ts.SyntaxKind.SingleLineCommentTrivia || tok === ts.SyntaxKind.MultiLineCommentTrivia) {
        if (commentIsLiveDirective(scanner.getTokenText())) n++;
      }
      tok = scanner.scan();
    }
  } catch {
    /* fail-safe: a scan that throws yields no directives rather than a crash */
  }
  return n;
}

interface AnyCounts {
  cast: number; // `as any` / `<any>` / `as A` where `A = any` — an explicit cast TO any
  never: number; // `as never` / `<never>` / `as N` where `N = never` — assignable to anything
  broad: number; // any in any other position (`: any`, generic <…any…>) — common in legit code
  double: number; // `x as unknown as T` and its `never` / `{}` / `object` / `Object` widenings
  suppress: number; // live `@ts-*` directives on the comment ranges
  jsdoc: number; // JSDoc `@type {any|*|?}` casts (JS files only)
}

/** Count the `any`-typed escapes in a full source, classified. Cast targets are read through the
 *  file's local `type` aliases, so `type A = any; x as A` counts as `as any`. */
function countAny(src: string, path: string): AnyCounts {
  const r: AnyCounts = { cast: 0, never: 0, broad: 0, double: 0, suppress: 0, jsdoc: 0 };
  r.suppress = countLiveDirectives(src);
  r.jsdoc = JS_FILE.test(path) ? countMatches(src, JSDOC_ANY_CAST) : 0;
  try {
    const sf = parseSource('f.ts', src);
    if (!sf) return r; // declined parse (#444): the line fallback carries the rule
    const aliasMap = buildAliasMap(sf);
    const visit = (node: TS.Node): void => {
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const k = assertedLaunderKind(node, aliasMap);
        if (k === 'any') r.cast++;
        else if (k === 'never') r.never++;
        if (isDoubleCast(node, aliasMap)) r.double++;
      }
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        // `x as (any)` parents the keyword under a ParenthesizedType; the cast is the
        // same, so unwrap the parens before asking what the target type is. An `any` in a
        // direct cast target is already counted above; here we only add the broad-position any.
        let target: TS.Node = node;
        let p = target.parent;
        while (p && ts.isParenthesizedTypeNode(p)) {
          target = p;
          p = p.parent;
        }
        const isCast =
          (p && ts.isAsExpression(p) && p.type === target) || (p && ts.isTypeAssertionExpression(p) && p.type === target);
        if (!isCast) r.broad++;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  } catch {
    /* fail-safe */
  }
  return r;
}

// Additive-line fallback for diff-only changes (no before/after content). The `any` / `never`
// casts and the laundering double cast are read structurally (`lineHasRow4Cast`), resolving
// aliases declared on the change's own added lines; the `@ts-*` directives and the JSDoc cast
// are token patterns. The literal `as any` / `<any>` regex is kept as a floor for a line the
// snippet parser cannot recover.
const NARROW_LINE = /\bas\s+\(*\s*any\b|<\s*any\s*>/;
const BROAD_LINE = /:\s*any\b|<[^<>]*\bany\b[^<>]*>/;
// A directive on its own added line, including a bare JSDoc continuation fragment (`* @ts-…`).
const FRAGMENT_DIRECTIVE = /^\s*\*?\s*@ts-(?:ignore|expect-error|nocheck)\b/;

/** Whether an added line carries a live `@ts-*` directive: a real comment the scanner sees, or a
 *  JSDoc continuation fragment fed as its own diff line (`* @ts-expect-error`). A directive
 *  inside a string or regex on the line is text and does not count. */
function lineHasLiveDirective(line: string): boolean {
  return countLiveDirectives(line) > 0 || FRAGMENT_DIRECTIVE.test(line);
}

/** Best-effort structural read of one added line against the change's alias map: does it contain
 *  a row-4 cast — `as any` / `as never` (alias-resolved) or the laundering double cast? The line
 *  is parsed as a snippet; a partial line (an argument in a multi-line call, a trailing comma)
 *  recovers with diagnostics but still yields the assertion node, and comment or string text
 *  yields none. The fallback may see less than full-source analysis; it must never call one
 *  spelling block and a structurally identical one clean. */
function lineHasRow4Cast(line: string, aliasMap: Map<string, LaunderKind>): boolean {
  const sf = parseSource('line.ts', line);
  if (!sf) return false;
  let found = false;
  const visit = (n: TS.Node): void => {
    if (found) return;
    if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) {
      const k = assertedLaunderKind(n, aliasMap);
      if (k === 'any' || k === 'never' || isDoubleCast(n, aliasMap)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** The alias map for a diff-only change: the aliases declared across ALL of the change's added
 *  lines, so an alias declared on one added line resolves a cast on another. */
function aliasMapForAddedLines(c: Change): Map<string, LaunderKind> {
  const snippet = addedLines(c)
    .map((l) => l.content)
    .join('\n');
  const sf = parseSource('lines.ts', snippet);
  return sf ? buildAliasMap(sf) : new Map();
}

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
        const a = countAny(c.after, c.path);
        const b = countAny(before, c.path);
        const dCast = a.cast - b.cast;
        const dNever = a.never - b.never;
        const dBroad = a.broad - b.broad;
        const dDouble = a.double - b.double;
        const dSuppr = a.suppress - b.suppress;
        const dJsdoc = a.jsdoc - b.jsdoc;

        // BLOCK: unambiguous escape hatches
        const blockReasons: string[] = [];
        if (dCast > 0) blockReasons.push('`as any` cast');
        if (dNever > 0) blockReasons.push('`as never` cast');
        if (dDouble > 0) blockReasons.push('`as unknown as` double cast');
        if (dSuppr > 0) blockReasons.push('@ts-ignore/@ts-expect-error/@ts-nocheck suppression');
        if (dJsdoc > 0) blockReasons.push('JSDoc `@type {any}` cast');
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

      // Fallback: diff-only change → additive-line analysis, split narrow(block)/broad(warn).
      // The structural/literal cast reads run on a comment/string-masked copy of the line so a
      // cast spelled inside a `//`, a `/* … */`, a string, or a multi-line template is text
      // (#446). Each hunk's after-view (context lines + additions, deletions excluded) advances
      // one masker so that state carries across the hunk's lines and code inside a `${…}`
      // substitution stays scanned; state is NOT carried across hunks (the unseen gap between
      // them may open or close a construct), so an addition whose enclosing opener lies outside
      // the hunk's context is read as code, exactly as the per-line matcher always was. Only
      // additions produce findings. The `@ts-*` directive and JSDoc-cast reads keep the raw
      // line — those spellings ARE comments and are counted on the comment ranges themselves.
      const jsdocCast = JS_FILE.test(c.path) ? new RegExp(JSDOC_ANY_CAST.source) : null;
      const aliasMap = aliasMapForAddedLines(c);
      for (const h of c.hunks) {
        const masker = new CommentStringMasker();
        for (const l of h.lines) {
          if (l.type === 'del') continue;
          const code = masker.mask(l.content);
          if (l.type !== 'add') continue;
          if (NARROW_LINE.test(code) || lineHasRow4Cast(code, aliasMap) || lineHasLiveDirective(l.content) || (jsdocCast && jsdocCast.test(l.content))) {
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
          } else if (BROAD_LINE.test(code)) {
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
    }
    return out;
  },
};
