// The runner's SELECTION config, read as a suite membership function.
//
// A spec can leave the suite without a line of it changing: jest's
// `testPathIgnorePatterns` gains an entry, `testMatch`/`testRegex` shrinks, vitest's
// `test.exclude` grows or `test.include` narrows. The file is still there, still
// protected, and the runner never opens it. Comparing the lists entry by entry is the
// wrong question (two spellings of the same glob are not a narrowing; a new
// `/node_modules/` entry hides nothing), so both configs are turned into the
// predicate the runner applies — included(path) && !ignored(path) — and evaluated
// over the repository's own protected test files (the canonical layouts when no
// listing is available). A narrowing is a file the runner selected before and does
// not select after; the evidence names it and the entry that dropped it.
//
// Only string literals are read. A computed list (`include: pick()`, a spread of
// `configDefaults.exclude`) is opaque, and an opaque side is never claimed as a
// narrowing — silence rather than a guess.

import picomatch from 'picomatch';
import ts from 'typescript';

interface Selection {
  /** Jest globs (testMatch) or vitest globs (test.include); null = runner default. */
  include: string[] | null;
  /** Jest testRegex entries; null = unset. */
  regex: string[] | null;
  /** Jest testPathIgnorePatterns (regexes) or vitest test.exclude (globs); null = default. */
  ignore: string[] | null;
  /** A selection list was present but not fully literal — never claim on it. */
  opaque: boolean;
  present: boolean;
}

type Runner = 'jest' | 'vitest';

const JEST_DEFAULT_MATCH = ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)'];
const JEST_DEFAULT_IGNORE = ['/node_modules/'];
const VITEST_DEFAULT_INCLUDE = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];
const VITEST_DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/cypress/**',
  '**/.{idea,git,cache,output,temp}/**',
  '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
];

/** Conventional JS/TS spec layouts, for when no repository listing is available. */
export const CANONICAL_SAMPLES = [
  'src/a.test.ts',
  'src/a.spec.ts',
  'test/a.test.ts',
  'tests/a.test.js',
  'src/__tests__/a.ts',
  'a.test.tsx',
  'a.spec.js',
  'test/a.test.mjs',
];

function keyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/** String literals of an array (or a lone string); `opaque` when anything else sits in it. */
function literals(e: ts.Expression): { items: string[]; opaque: boolean } {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { items: [e.text], opaque: false };
  if (!ts.isArrayLiteralExpression(e)) return { items: [], opaque: true };
  const items: string[] = [];
  let opaque = false;
  for (const el of e.elements) {
    if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) items.push(el.text);
    else if (ts.isSpreadElement(el) && /^(?:configDefaults\.|default)(?:exclude|include)$/i.test(el.expression.getText())) {
      // the idiomatic vitest form, `[...configDefaults.exclude, 'more']`, spreads a
      // list this module knows — keep it literal rather than going blind on it
      items.push(...(/exclude$/i.test(el.expression.getText()) ? VITEST_DEFAULT_EXCLUDE : VITEST_DEFAULT_INCLUDE));
    } else opaque = true;
  }
  return { items, opaque };
}

function underKey(node: ts.Node, key: string): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isPropertyAssignment(p) && keyName(p.name) === key) return true;
  }
  return false;
}

function asExpression(src: string): string {
  const t = src.trim();
  return t.startsWith('{') ? `(${t})` : src;
}

/** The runner a protected config file configures, or null when it is neither. */
export function runnerOf(path: string): Runner | null {
  const base = path.split('/').pop() ?? path;
  if (/^jest\.config\./.test(base) || base === 'package.json') return 'jest';
  if (/^vitest\.config\./.test(base)) return 'vitest';
  return null;
}

export function parseSelection(src: string, runner: Runner): Selection {
  const sel: Selection = { include: null, regex: null, ignore: null, opaque: false, present: false };
  try {
    const sf = ts.createSourceFile('cfg.ts', asExpression(src), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const seen = new Set<string>();
    const take = (key: string, e: ts.Expression): string[] => {
      const { items, opaque } = literals(e);
      // a key set more than once is a multi-project config, whose selection is the
      // union of per-project predicates this reader does not model — opaque
      if (opaque || seen.has(key)) sel.opaque = true;
      seen.add(key);
      sel.present = true;
      // jest globs are matched against absolute paths; `<rootDir>/` is the config's
      // directory, which is what the samples are relative to
      return items.map((g) => g.replace(/^<rootDir>\//, ''));
    };
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node)) {
        const k = keyName(node.name);
        if (runner === 'jest') {
          if (k === 'testMatch') sel.include = take(k, node.initializer);
          else if (k === 'testRegex') sel.regex = take(k, node.initializer);
          else if (k === 'testPathIgnorePatterns') sel.ignore = take(k, node.initializer);
        } else if (underKey(node, 'test') && !underKey(node, 'coverage')) {
          if (k === 'include') sel.include = take(k, node.initializer);
          else if (k === 'exclude') sel.ignore = take(k, node.initializer);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  } catch {
    /* fail-safe: an unparseable config selects like the default */
  }
  return sel;
}

const globs = (patterns: string[]) => {
  const ms = patterns.map((g) => {
    try {
      return picomatch(g, { dot: true });
    } catch {
      return () => false;
    }
  });
  return (path: string) => ms.some((m) => m(path));
};
const regexes = (patterns: string[]) => {
  const rs = patterns.flatMap((p) => {
    try {
      return [new RegExp(p.replace(/<rootDir>/g, ''))];
    } catch {
      return [];
    }
  });
  // jest matches its regexes against the ABSOLUTE path; a leading slash stands in
  // for the repository root so `<rootDir>/test/` and `/test/` both apply.
  return (path: string) => rs.some((r) => r.test('/' + path));
};

interface Predicate {
  selects(path: string): boolean;
  /** Which entry dropped `path`, for the evidence line. */
  why(path: string): string;
}

function predicate(sel: Selection, runner: Runner): Predicate {
  const includeList = sel.include ?? (runner === 'jest' ? (sel.regex ? null : JEST_DEFAULT_MATCH) : VITEST_DEFAULT_INCLUDE);
  const ignoreList = sel.ignore ?? (runner === 'jest' ? JEST_DEFAULT_IGNORE : VITEST_DEFAULT_EXCLUDE);
  const included = includeList ? globs(includeList) : sel.regex ? regexes(sel.regex) : () => true;
  const ignored = runner === 'jest' ? regexes(ignoreList) : globs(ignoreList);
  return {
    selects: (p) => included(p) && !ignored(p),
    why: (p) => {
      if (ignored(p)) {
        const key = runner === 'jest' ? 'testPathIgnorePatterns' : 'test.exclude';
        const hit = ignoreList.find((g) => (runner === 'jest' ? regexes([g]) : globs([g]))(p));
        return `${key} now matches it (${JSON.stringify(hit ?? '')})`;
      }
      const key = sel.include ? (runner === 'jest' ? 'testMatch' : 'test.include') : 'testRegex';
      return `${key} no longer matches it (${JSON.stringify(sel.include ?? sel.regex ?? [])})`;
    },
  };
}

export interface Narrowing {
  path: string;
  reason: string;
}

/**
 * Protected test files the runner selected under `before` and does not select under
 * `after`. `samples` is the repository's JS/TS protected test list (or the canonical
 * layouts). Returns nothing when the after-config is opaque, or when neither side
 * carries a selection key (an unrelated config edit).
 */
export function suiteNarrowings(before: string | null, after: string, path: string, samples: string[]): Narrowing[] {
  const runner = runnerOf(path);
  if (!runner) return [];
  const b = parseSelection(before ?? '', runner);
  const a = parseSelection(after, runner);
  if (!a.present || a.opaque) return [];
  const pb = predicate(b, runner);
  const pa = predicate(a, runner);
  const out: Narrowing[] = [];
  for (const s of samples) {
    if (pb.selects(s) && !pa.selects(s)) out.push({ path: s, reason: pa.why(s) });
  }
  return out;
}
