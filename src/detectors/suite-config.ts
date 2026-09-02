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
// The predicate has more dials than the two lists, and every one of them was found
// turned on its own: jest `roots` (the directories walked at all), `rootDir` (what
// `<rootDir>` and the walk are relative to), `modulePathIgnorePatterns` (a module the
// resolver cannot see is a spec the runner cannot run); vitest `test.dir` (the scan
// base) and a `!` entry inside `include` (tinyglobby honours the negation). A
// multi-project config — jest `projects`, vitest `test.projects`, a
// `vitest.workspace.*` file — runs the UNION of its projects' selections, so that is
// what is compared; a project given as a string (a path to its own config) is
// unreadable here and makes the whole config opaque. Vitest's `typecheck.include`
// and `benchmark.include` are other suites: only a key DIRECTLY under `test` is read.
//
// Only string literals are read. A computed list (`include: pick()`, a spread of
// `configDefaults.exclude`) is opaque, and an opaque side is never claimed as a
// narrowing — silence rather than a guess.

import picomatch from 'picomatch';
import ts from 'typescript';

interface IgnoreEntry {
  pattern: string;
  /** The config key it came from, for the evidence line. */
  key: string;
}

interface Selection {
  /** Jest globs (testMatch) or vitest globs (test.include), `!` entries included; null = runner default. */
  include: string[] | null;
  /** Jest testRegex entries; null = unset. */
  regex: string[] | null;
  /** Jest testPathIgnorePatterns / modulePathIgnorePatterns (regexes) or vitest test.exclude (globs); null = default. */
  ignore: IgnoreEntry[] | null;
  /** Jest `roots`: directories the runner walks (relative to rootDir); null = rootDir itself. */
  roots: string[] | null;
  /** Jest `rootDir` / vitest `test.dir`: paths outside it are never seen; null = the config's directory. */
  base: string | null;
  /** Per-project selections of a multi-project config; the suite is their union. */
  projects: Selection[] | null;
  /** A selection list was present but not fully literal — never claim on it. */
  opaque: boolean;
  present: boolean;
}

export type Runner = 'jest' | 'vitest';

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

const isStr = (e: ts.Node): e is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e);

/** String literals of an array (or a lone string); `opaque` when anything else sits in it. */
function literals(e: ts.Expression): { items: string[]; opaque: boolean } {
  if (isStr(e)) return { items: [e.text], opaque: false };
  if (!ts.isArrayLiteralExpression(e)) return { items: [], opaque: true };
  const items: string[] = [];
  let opaque = false;
  for (const el of e.elements) {
    if (isStr(el)) items.push(el.text);
    else if (ts.isSpreadElement(el) && /^(?:configDefaults\.|default)(?:exclude|include)$/i.test(el.expression.getText())) {
      // the idiomatic vitest form, `[...configDefaults.exclude, 'more']`, spreads a
      // list this module knows — keep it literal rather than going blind on it
      items.push(...(/exclude$/i.test(el.expression.getText()) ? VITEST_DEFAULT_EXCLUDE : VITEST_DEFAULT_INCLUDE));
    } else opaque = true;
  }
  return { items, opaque };
}

/** The key of the property whose object literal holds `node` — `include` inside
 *  `test: { include }` answers `test`; inside `test: { typecheck: { include } }` it
 *  answers `typecheck`, which is the point: only the nearest owner scopes a key. */
function ownerKey(node: ts.PropertyAssignment): string | null {
  const obj = node.parent;
  if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
  let q: ts.Node | undefined = obj.parent;
  while (q && (ts.isParenthesizedExpression(q) || ts.isAsExpression(q) || q.kind === ts.SyntaxKind.SatisfiesExpression)) q = q.parent;
  return q && ts.isPropertyAssignment(q) ? keyName(q.name) : null;
}

function asExpression(src: string): string {
  const t = src.trim();
  return t.startsWith('{') ? `(${t})` : src;
}

/** The runner a protected config file configures, or null when it is neither. A
 *  `vite.config.*` is a vitest config exactly when it carries a `test:` key —
 *  vitest reads it in preference to nothing — so the content decides. */
export function runnerOf(path: string, content?: string | null): Runner | null {
  const base = path.split('/').pop() ?? path;
  if (/^jest\.config\./.test(base) || base === 'package.json') return 'jest';
  if (/^vitest\.(?:config|workspace)\./.test(base)) return 'vitest';
  if (/^vite\.config\./.test(base) && content != null && /(?:^|[\s,{])["']?test["']?\s*:/m.test(content)) return 'vitest';
  return null;
}

const isWorkspaceFile = (path: string) => /^vitest\.workspace\./.test(path.split('/').pop() ?? path);

const empty = (): Selection => ({ include: null, regex: null, ignore: null, roots: null, base: null, projects: null, opaque: false, present: false });

/** jest globs and roots are written against `<rootDir>/`, which is what the samples
 *  are relative to once rebased. */
const stripRootDir = (g: string) => g.replace(/^<rootDir>\/?/, '');

/** A directory value read literally: `.`/`./` is the config's own directory. */
function dirValue(e: ts.Expression): { dir: string | null; opaque: boolean } {
  if (!isStr(e)) return { dir: null, opaque: true };
  const d = stripRootDir(e.text).replace(/^\.\//, '').replace(/\/+$/, '');
  // a base outside the config's directory widens the walk — nothing to rebase onto
  if (d === '.' || d === '' || d.split('/').includes('..')) return { dir: null, opaque: false };
  return { dir: d, opaque: false };
}

/** Read one config object (the root, or one project of a multi-project config). */
function collect(root: ts.Node, runner: Runner): Selection {
  const sel = empty();
  const seen = new Set<string>();
  const take = (key: string, e: ts.Expression): string[] => {
    const { items, opaque } = literals(e);
    // the same key set twice at one level is not a config this reader models — opaque
    if (opaque || seen.has(key)) sel.opaque = true;
    seen.add(key);
    sel.present = true;
    return items.map(stripRootDir);
  };
  const ignores = (key: string, e: ts.Expression) => {
    const entries = take(key, e).map((pattern) => ({ pattern, key }));
    sel.ignore = [...(sel.ignore ?? []), ...entries];
  };
  const projects = (e: ts.Expression) => {
    sel.present = true;
    if (!ts.isArrayLiteralExpression(e)) {
      sel.opaque = true;
      return;
    }
    const list: Selection[] = [];
    for (const el of e.elements) {
      // a project named by path or glob has its own config file — unreadable here
      if (ts.isObjectLiteralExpression(el)) list.push(collect(el, runner));
      else sel.opaque = true;
    }
    sel.projects = list;
    if (list.some((p) => p.opaque)) sel.opaque = true;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const k = keyName(node.name);
      if (runner === 'jest') {
        if (k === 'testMatch') sel.include = take(k, node.initializer);
        else if (k === 'testRegex') sel.regex = take(k, node.initializer);
        else if (k === 'testPathIgnorePatterns' || k === 'modulePathIgnorePatterns') ignores(k, node.initializer);
        else if (k === 'roots') sel.roots = take(k, node.initializer);
        else if (k === 'rootDir') {
          const { dir, opaque } = dirValue(node.initializer);
          sel.present = true;
          if (opaque) sel.opaque = true;
          else sel.base = dir;
        } else if (k === 'projects') {
          projects(node.initializer);
          return; // a project's keys are its own, not the root's
        }
      } else if (ownerKey(node) === 'test') {
        if (k === 'include') sel.include = take(k, node.initializer);
        else if (k === 'exclude') ignores(k, node.initializer);
        else if (k === 'dir') {
          const { dir, opaque } = dirValue(node.initializer);
          sel.present = true;
          if (opaque) sel.opaque = true;
          else sel.base = dir;
        } else if (k === 'projects') {
          projects(node.initializer);
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return sel;
}

/** The array a `vitest.workspace.*` file exports — `export default [...]` or
 *  `defineWorkspace([...])`; null when it exports anything else. */
function workspaceArray(sf: ts.SourceFile): ts.ArrayLiteralExpression | null {
  for (const st of sf.statements) {
    let e: ts.Expression | undefined;
    if (ts.isExportAssignment(st)) e = st.expression;
    else if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && /module\.exports/.test(st.expression.left.getText())) e = st.expression.right;
    if (!e) continue;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || e.kind === ts.SyntaxKind.SatisfiesExpression) {
      e = (e as ts.ParenthesizedExpression | ts.AsExpression | ts.SatisfiesExpression).expression;
    }
    if (ts.isCallExpression(e) && e.arguments.length > 0) e = e.arguments[0];
    return ts.isArrayLiteralExpression(e) ? e : null;
  }
  return null;
}

export function parseSelection(src: string, runner: Runner, path = ''): Selection {
  let sel = empty();
  try {
    const sf = ts.createSourceFile('cfg.ts', asExpression(src), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (runner === 'vitest' && isWorkspaceFile(path)) {
      const arr = workspaceArray(sf);
      if (arr) {
        const list: Selection[] = [];
        for (const el of arr.elements) {
          if (ts.isObjectLiteralExpression(el)) list.push(collect(el, runner));
          else sel.opaque = true;
        }
        sel.projects = list;
        sel.present = true;
        if (list.some((p) => p.opaque)) sel.opaque = true;
      } else if (src.trim()) sel.opaque = true;
    } else sel = collect(sf, runner);
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
/** micromatch semantics for a list with `!` entries: matched by a positive glob and
 *  by no negated one. */
const globList = (patterns: string[]) => {
  const pos = globs(patterns.filter((g) => !g.startsWith('!')));
  const neg = globs(patterns.filter((g) => g.startsWith('!')).map((g) => g.slice(1)));
  return (path: string) => pos(path) && !neg(path);
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

const underDir = (path: string, dir: string) => dir === '' || path.startsWith(dir + '/');

function predicate(sel: Selection, runner: Runner): Predicate {
  if (sel.projects) {
    const ps = sel.projects.map((p) => predicate(p, runner));
    return {
      selects: (p) => ps.some((x) => x.selects(p)),
      why: (p) => (ps.length ? `no project selects it (${ps[0].why(p)})` : 'the projects list is empty'),
    };
  }
  const includeList = sel.include ?? (runner === 'jest' ? (sel.regex ? null : JEST_DEFAULT_MATCH) : VITEST_DEFAULT_INCLUDE);
  const ignoreList: IgnoreEntry[] =
    sel.ignore ?? (runner === 'jest' ? JEST_DEFAULT_IGNORE : VITEST_DEFAULT_EXCLUDE).map((pattern) => ({ pattern, key: runner === 'jest' ? 'testPathIgnorePatterns' : 'test.exclude' }));
  const included = includeList ? globList(includeList) : sel.regex ? regexes(sel.regex) : () => true;
  const ignoredBy = (p: string): IgnoreEntry | undefined =>
    ignoreList.find((e) => (runner === 'jest' ? regexes([e.pattern]) : globs([e.pattern]))(p));
  const roots = sel.roots?.map((r) => r.replace(/^\.\//, '').replace(/\/+$/, '')).map((r) => (r === '.' ? '' : r)) ?? null;
  // rootDir / dir: a path outside it is never walked; inside it, everything the
  // config says is relative to it
  const rebase = (p: string): string | null => (sel.base === null ? p : underDir(p, sel.base) ? p.slice(sel.base.length + 1) : null);
  const inRoots = (p: string) => roots === null || roots.some((r) => underDir(p, r));
  return {
    selects: (p) => {
      const r = rebase(p);
      return r !== null && inRoots(r) && included(r) && !ignoredBy(r);
    },
    why: (p) => {
      const r = rebase(p);
      const baseKey = runner === 'jest' ? 'rootDir' : 'test.dir';
      if (r === null) return `${baseKey} no longer covers it (${JSON.stringify(sel.base)})`;
      if (!inRoots(r)) return `roots no longer covers it (${JSON.stringify(sel.roots)})`;
      const hit = ignoredBy(r);
      if (hit) return `${hit.key === 'exclude' ? 'test.exclude' : hit.key} now matches it (${JSON.stringify(hit.pattern)})`;
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
  const runner = runnerOf(path, after) ?? runnerOf(path, before);
  if (!runner) return [];
  const b = parseSelection(before ?? '', runner, path);
  const a = parseSelection(after, runner, path);
  if (!a.present || a.opaque) return [];
  const pb = predicate(b, runner);
  const pa = predicate(a, runner);
  const out: Narrowing[] = [];
  for (const s of samples) {
    if (pb.selects(s) && !pa.selects(s)) out.push({ path: s, reason: pa.why(s) });
  }
  return out;
}
