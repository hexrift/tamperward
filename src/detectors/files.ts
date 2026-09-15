// File-kind helpers. A TS/JS-specific rule (casts, lint directives) must only look at
// TS/JS files — `as any` inside a YAML comment or a Markdown doc is not a cast.
//
// The baseline protects test files in eight ecosystems (src/policy.ts, P2-13), but
// every pattern rule was written for JavaScript: `it.skip` never appears in a Python
// spec, so test-skip could not fire there, and the AST block count read `def test_x`
// as zero tests on both sides. Protection that is silently absent — the very thing
// P2-13 widened the globs to avoid, one layer down. The language of a file decides
// which spellings the pattern rules look for; `isCodeFile` keeps its JS/TS meaning
// for the rules that genuinely are TypeScript-only (ts-any-cast).

const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export function isCodeFile(path: string): boolean {
  return CODE.test(path);
}

export type Lang = 'js' | 'py' | 'go' | 'rs' | 'rb' | 'java' | 'kt' | 'php' | 'cs';

const EXT: Array<[RegExp, Lang]> = [
  [CODE, 'js'],
  [/\.pyw?$/, 'py'],
  [/\.go$/, 'go'],
  [/\.rs$/, 'rs'],
  [/\.rb$/, 'rb'],
  [/\.java$/, 'java'],
  [/\.kts?$/, 'kt'],
  [/\.php$/, 'php'],
  [/\.cs$/, 'cs'],
];

/** The language a pattern rule should read `path` as, or null when unknown. */
export function langOf(path: string): Lang | null {
  for (const [re, lang] of EXT) if (re.test(path)) return lang;
  return null;
}

// Lines that carry no test content: imports, comments, bare closers. One filter,
// shared by test-deletion (relocation) and test-content-removal (gutting), so the
// two can never drift apart again. Comment syntax is per language — a removed
// `#` comment in a Python spec is not removed content.
const COMMON = /^(export\s|\/\/|\*|\/\*|}\)?;?$)/;
const IMPORTS: Record<Lang, RegExp> = {
  js: /^import\b/,
  py: /^(?:import\b|from\s+\S+\s+import\b)/,
  go: /^(?:import\b|package\b)/,
  rs: /^(?:use\b|extern\s+crate\b|mod\b)/,
  rb: /^(?:require(?:_relative)?\b|include\b)/,
  java: /^(?:import\b|package\b)/,
  kt: /^(?:import\b|package\b)/,
  php: /^(?:use\b|namespace\b|require(?:_once)?\b|include(?:_once)?\b)/,
  cs: /^(?:using\b|namespace\b)/,
};
const HASH_COMMENT: ReadonlySet<Lang> = new Set(['py', 'rb']);
// Debug chatter is not test content: removing three `console.log` lines from a spec
// blocked as "content gutted" — a line that only prints, or a `debugger` statement,
// asserts nothing and its removal weakens nothing. Only the PURE call counts: a
// `console.log` inside an expect() is still an assertion line.
const DEBUG_ONLY = /^(?:console\.\w+\(.*\)\s*;?|debugger\s*;?)$/;

/** Whether a trimmed line is significant test content for the language. */
export function isSignificantLine(trimmed: string, lang: Lang | null): boolean {
  if (trimmed.length < 10) return false;
  if (COMMON.test(trimmed)) return false;
  if (DEBUG_ONLY.test(trimmed)) return false;
  const l = lang ?? 'js';
  if (IMPORTS[l].test(trimmed)) return false;
  if (HASH_COMMENT.has(l) && trimmed.startsWith('#')) return false;
  return true;
}

// Comment-only lines, for rules whose spellings are CODE. A `// was xit while flaky`
// line adds no marker, and a maintainer writing that comment must not be blocked.
// lint-suppression must NOT use this: its spellings are comments by construction.
// PHP `#[...]` is an attribute, not a comment; Rust `#[...]` never reaches the hash
// branch because Rust is not a hash-comment language.
const SLASH_COMMENT = /^(?:\/\/|\/\*|\*(?:\s|\/|$))/;
const HASH_COMMENT_LANGS: ReadonlySet<Lang> = new Set(['py', 'rb', 'php']);

/** Whether a trimmed line is only a comment in the language (php: `#`, `//`, `/*`). */
export function isCommentLine(trimmed: string, lang: Lang | null): boolean {
  const l = lang ?? 'js';
  if (HASH_COMMENT_LANGS.has(l) && trimmed.startsWith('#') && !trimmed.startsWith('#[')) return true;
  if (l === 'py' || l === 'rb') return false;
  return SLASH_COMMENT.test(trimmed);
}

// Whether `line[idx]` sits inside a string literal: a codemod's HEADER constant holding
// an eslint-disable comment, or a Python docstring saying "never add # noqa", is text,
// not a directive. A single-line scan: quotes toggle a string state (backslash escapes
// honoured), and a comment opener outside a string ends the scan because everything
// after it is comment. Multi-line strings are not tracked — deliberately per line.
//
// Two per-language shapes the plain scan mistook for open strings: a Python triple quote
// (`'''` / `"""`) is one delimiter, so `'''it's'''` closes on the line rather than leaving
// the apostrophe hanging; and a JS regex literal (`/'/ `) is not a string, so its quote
// must not swallow the rest of the line and hide the trailing `// eslint-disable`.
export function insideStringLiteral(line: string, idx: number, lang: Lang | null): boolean {
  const l = lang ?? 'js';
  const hash = HASH_COMMENT_LANGS.has(l);
  let quote: string | null = null; // a 1- or 3-char delimiter, or null when not in a string
  for (let j = 0; j < idx; j++) {
    const ch = line[j];
    if (quote) {
      if (ch === '\\') j++;
      else if (quote.length === 3) {
        if (ch === quote[0] && line[j + 1] === quote[0] && line[j + 2] === quote[0]) {
          quote = null;
          j += 2;
        }
      } else if (ch === quote) quote = null;
      continue;
    }
    if (l === 'py' && (ch === '"' || ch === "'") && line[j + 1] === ch && line[j + 2] === ch) {
      quote = ch.repeat(3);
      j += 2;
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '/' && (line[j + 1] === '/' || line[j + 1] === '*')) return false;
    else if (l === 'js' && ch === '/' && regexPosition(line.slice(0, j))) j = skipRegexLiteral(line, j);
    else if (hash && ch === '#') return false;
  }
  return quote !== null;
}

// Keywords after which a `/` introduces an expression, so it starts a regex literal
// rather than dividing the keyword.
const REGEX_KEYWORDS: ReadonlySet<string> = new Set([
  'return', 'throw', 'case', 'yield', 'do', 'else', 'in', 'of', 'typeof', 'void', 'delete',
  'instanceof', 'new',
]);

// A `/` begins a JS regex literal (not division) when the preceding token cannot end an
// expression: at line start, after an operator / `(` `[` `{` `,` `;` `:`, or after an
// expression-introducing keyword. It is division after an identifier, a number, `)`, `]`,
// or a closing quote — so `a /b/ c` and `"x" / 2` are read as division, not a regex. The
// decision is token-aware (the trailing keyword, not just the last character) so a valid
// literal after `return`, `yield`, `case`, … is not misread.
function regexPosition(before: string): boolean {
  const s = before.replace(/\s+$/, '');
  if (s === '') return true;
  const last = s[s.length - 1];
  if (/[\w$]/.test(last)) {
    const kw = /[A-Za-z_$][\w$]*$/.exec(s); // null when the token ends in a digit (a number)
    return kw !== null && REGEX_KEYWORDS.has(kw[0]);
  }
  return last !== ')' && last !== ']' && last !== '"' && last !== "'" && last !== '`';
}

// Consume a regex literal starting at `line[start]` (`/`), honouring `\` escapes and
// `[...]` character classes, and return the index of its closing `/` (or the last index
// when unterminated) so the caller's loop resumes just past it.
function skipRegexLiteral(line: string, start: number): number {
  let inClass = false;
  for (let k = start + 1; k < line.length; k++) {
    const c = line[k];
    if (c === '\\') k++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return k;
  }
  return line.length - 1;
}
