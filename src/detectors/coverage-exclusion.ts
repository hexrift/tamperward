// #438 coverage-exclusion (file surface, mechanical, warn by default).
//
// The per-function form of the coverage-lowering class. Row 6 reads the CONFIG: a
// threshold lowered, a denominator narrowed, a switch turned off. But every coverage
// tool also takes the exclusion inline — `/* istanbul ignore next */`, `/* c8 ignore
// start */`, `/* v8 ignore next */`, `/* node:coverage ignore next */`, `# pragma: no
// cover`, `#[coverage(off)]` — and an agent denied the config dial can take the hard
// branch out of the measurement one comment at a time, with no config touched and no
// rule reading it. A `//go:build` constraint added to an existing Go file is the same
// move for `go test -cover`: the file leaves the build, and the measurement, on the
// default platform.
//
// Scope: an ADDED marker line in a non-test source file — a language the pattern
// rules know, outside the protected `tests` category, not on a generated, vendored,
// declaration or output path. A marker inside a string literal (a codemod's HEADER
// constant) or quoted in a line comment ("never add /* istanbul ignore next */") is
// text, not a directive; a marker line removed and re-added verbatim in the same
// change moved, it was not added; a `//go:build` on a NEW file is a platform split,
// and one edited on a file that already carried a constraint is not an exclusion.
//
// Severity is WARN, per the SPEC §7 discipline: an inline exclusion is also the
// ordinary way to mark a genuinely unreachable branch, so the rule is measured
// against a labeled corpus (harness/fp-study/coverage-exclusion-corpus.json) and any
// block graduation is a separate decision on that evidence.

import { Change, Detector, Finding } from '../types';
import { addedLines, removedLines } from '../diff/select';
import { Lang, langOf } from './files';
import { protectedCategory } from '../policy';
import { makeFinding } from './finding';

const RULE = 'coverage-exclusion';

interface Pattern {
  re: RegExp;
  why: string;
  /** Only an addition to a file that carried no such line before counts. */
  existingOnly?: true;
}

const PATTERNS: Partial<Record<Lang, Pattern[]>> = {
  js: [
    { re: /\/\*\s*istanbul\s+ignore\b/, why: '`istanbul ignore` takes the next statement, branch or the whole file out of the coverage measurement' },
    { re: /\/\*\s*c8\s+ignore\b(?!\s*stop\b)/, why: '`c8 ignore` takes the next statement or the marked range out of the coverage measurement' },
    { re: /\/\*\s*v8\s+ignore\b(?!\s*stop\b)/, why: '`v8 ignore` takes the next statement or the marked range out of the coverage measurement' },
    { re: /\/\*\s*node:coverage\s+(?:ignore|disable)\b/, why: '`node:coverage ignore/disable` takes the following code out of the coverage measurement' },
  ],
  py: [{ re: /#\s*pragma[:\s]\s*no\s*cover\b/i, why: '`# pragma: no cover` takes the line or block out of the coverage measurement' }],
  rs: [{ re: /#\s*!?\[[^\]]*\bcoverage\s*\(\s*off\s*\)/, why: '`#[coverage(off)]` takes the item out of the coverage measurement' }],
  go: [
    {
      re: /^\s*\/\/\s*(?:go:build\b|\+build\b)/,
      why: 'a build constraint added to an existing file takes it out of the default build, and out of `go test -cover`',
      existingOnly: true,
    },
  ],
};

// Paths whose coverage nobody gates: dependencies, vendored code, build output,
// generated code, declarations, examples and docs, tooling scripts, fixtures — and
// a runner config (`jest.config.js`), which is protected config, not measured source.
const OUT_OF_SCOPE_PATH =
  /(?:^|\/)(?:node_modules|vendor|third_party|dist|build|out|coverage|generated|__generated__|codegen|examples?|docs?|scripts?|fixtures?|__fixtures__|__mocks__)\/|\.d\.[cm]?ts$|\.(?:generated|gen|pb)\.[^/]*$/;

const LINE_COMMENT: Partial<Record<Lang, RegExp>> = { js: /^\/\//, go: /^\/\//, rs: /^\/\//, py: /^#/ };

/** Whether `line[idx]` sits inside a string literal or behind a line-comment opener
 *  — text, not a directive. Quotes toggle a string state (escapes honoured); a
 *  comment opener outside a string, strictly before `idx`, makes the rest prose. */
function isText(line: string, idx: number, lang: Lang): boolean {
  const opener = LINE_COMMENT[lang];
  let quote: string | null = null;
  for (let j = 0; j < idx; j++) {
    const ch = line[j];
    if (quote) {
      if (ch === '\\') j++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (opener && opener.test(line.slice(j, j + 2))) return true;
  }
  return quote !== null;
}

export const coverageExclusion: Detector = {
  id: RULE,
  surface: ['file'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];
    for (const c of changes) {
      if (c.kind !== 'file' || c.op === 'delete') continue;
      const lang = langOf(c.path);
      if (!lang) continue;
      const patterns = PATTERNS[lang];
      if (!patterns) continue;
      const category = protectedCategory(c.path, policy);
      if (OUT_OF_SCOPE_PATH.test(c.path) || category === 'tests' || category === 'config') continue;

      const removed = new Set(removedLines(c).map((l) => l.content.trim()));
      const before = c.before ?? '';
      for (const l of addedLines(c)) {
        const trimmed = l.content.trim();
        if (removed.has(trimmed)) continue; // moved, not added
        for (const p of patterns) {
          const m = p.re.exec(l.content);
          if (!m || isText(l.content, m.index, lang)) continue;
          // A constraint on a new file is a platform split; on a file that already
          // carried one it is an edit. Without the before content there is no way to
          // tell, so decline.
          if (p.existingOnly && (c.op === 'add' || c.before == null || before.split('\n').some((b) => p.re.test(b)))) continue;
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              line: l.newLine ?? undefined,
              message: `Coverage exclusion added: ${p.why}.`,
              evidence: trimmed,
              remediation: 'Cover the code with a test instead of excluding it from the measurement; if it is genuinely unreachable, say so in review.',
              defaultSeverity: 'warn',
            }),
          );
          break;
        }
      }
    }
    return out;
  },
};
