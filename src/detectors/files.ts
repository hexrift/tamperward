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

// Comment/string masking for the diff-only fallback (JS/TS syntax). The line matchers
// (ts-any-cast's `NARROW_LINE`, test-skip's patterns) run on lines with no parser state, so
// a literal `as any` or a `.skip` inside a `//` comment, inside a `/* … */` block comment,
// inside a string, or on a continuation line of a multi-line template reads the same as
// real code. A masker is fed the after-view lines of one hunk in order (context lines
// advance the lexer; only additions are judged by the caller) and returns each line with
// comment bodies and masked string/template interiors replaced by spaces — length preserved,
// so match offsets and `insideStringLiteral` still line up. It is a small stateful lexer with
// a stack, so state (block comment, string, template, and the code inside a `${…}` template
// substitution) carries across the hunk's lines, and code inside `${…}` is kept VISIBLE so a
// cast or a skip there is still scanned. A JS regex literal is recognised through the shared
// token-aware `regexPosition`/`skipRegexLiteral` (#439), so its `/'/` does not open a string
// that swallows a following real cast.
//
// `maskStrings` (ts-any-cast, whose regex has no string awareness) blanks string/template
// interiors; test-skip leaves single-line strings intact so `insideStringLiteral` can still
// see a computed-property marker (`it['skip']`) as code and reject genuine in-string hits.
// Either way the CONTINUATION of a string/template opened on an earlier line is blanked,
// because `insideStringLiteral` is per-line and cannot see the opener. Delimiters are kept.
type MaskFrame =
  | { kind: 'block' }
  | { kind: 'string'; quote: string; carried: boolean }
  | { kind: 'template'; carried: boolean }
  | { kind: 'subst'; depth: number };

export class CommentStringMasker {
  private readonly stack: MaskFrame[] = [];

  constructor(private readonly maskStrings = true) {}

  mask(line: string): string {
    const out = line.split('');
    // A string/template still open from an earlier line is a continuation: its body is
    // blanked for every caller, since `insideStringLiteral` cannot see the opener.
    for (const f of this.stack) if (f.kind === 'string' || f.kind === 'template') f.carried = true;
    let i = 0;
    while (i < line.length) {
      const top = this.stack[this.stack.length - 1];
      const ch = line[i];
      const next = line[i + 1];
      if (top?.kind === 'block') {
        out[i] = ' ';
        if (ch === '*' && next === '/') {
          out[i + 1] = ' ';
          this.stack.pop();
          i += 2;
          continue;
        }
        i++;
        continue;
      }
      if (top?.kind === 'string' || top?.kind === 'template') {
        const blank = this.maskStrings || top.carried;
        if (ch === '\\') {
          if (blank) {
            out[i] = ' ';
            if (i + 1 < line.length) out[i + 1] = ' ';
          }
          i += 2;
          continue;
        }
        if (top.kind === 'string' ? ch === top.quote : ch === '`') {
          this.stack.pop(); // keep the closing delimiter
          i++;
          continue;
        }
        if (top.kind === 'template' && ch === '$' && next === '{') {
          this.stack.push({ kind: 'subst', depth: 1 }); // ${…} re-enters code, kept visible
          i += 2;
          continue;
        }
        if (blank) out[i] = ' ';
        i++;
        continue;
      }
      // Code context: the base, or inside a `${…}` substitution.
      if (ch === '/' && next === '/') {
        for (let j = i; j < line.length; j++) out[j] = ' ';
        i = line.length; // rest of the line is a comment; any open string/template resumes next line
        continue;
      }
      if (ch === '/' && next === '*') {
        out[i] = ' ';
        out[i + 1] = ' ';
        this.stack.push({ kind: 'block' });
        i += 2;
        continue;
      }
      if (ch === '`') {
        this.stack.push({ kind: 'template', carried: false }); // keep the opening delimiter
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        this.stack.push({ kind: 'string', quote: ch, carried: false });
        i++;
        continue;
      }
      if (ch === '/' && regexPosition(line.slice(0, i))) {
        i = skipRegexLiteral(line, i) + 1; // a regex literal is neither a comment nor a string
        continue;
      }
      if (top?.kind === 'subst') {
        if (ch === '{') top.depth++;
        else if (ch === '}' && --top.depth === 0) this.stack.pop();
      }
      i++;
    }
    return out.join('');
  }
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
