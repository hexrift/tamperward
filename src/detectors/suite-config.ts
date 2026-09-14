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
// narrowing — silence rather than a guess. So is a selection this file does not
// hold on its own: `mergeConfig(shared, {…})` over an imported base (vite
// CONCATENATES the arrays, so the effective include is a union nobody here can
// see), a `...base` spread into the config or its `test` object, and a project or
// workspace entry with `extends: '<path>'`. `extends: true` is readable — the
// project inherits the root's selection — and is seeded from it; a project's
// `test.root` rebases its globs exactly like `test.dir`.

import { picomatch } from '../lazy-deps';
import type TS from 'typescript';
import { parseSource, ts } from '../ts-lazy';

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
  /** Whole-run narrowings that match no path — `testNamePattern` selects by test
   *  NAME inside every file the runner opens, so it shrinks the run everywhere
   *  (#447), exactly like pytest's `-m`. */
  wide: IgnoreEntry[];
  /** A selection list was present but not fully literal — never claim on it. */
  opaque: boolean;
  present: boolean;
}

export type Runner = 'jest' | 'vitest' | 'pytest';

const JEST_DEFAULT_MATCH = ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)'];
const JEST_DEFAULT_IGNORE = ['/node_modules/'];
const VITEST_DEFAULT_INCLUDE = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];
// pytest's own defaults: `python_files` is `test_*.py *_test.py`, and
// `norecursedirs` keeps the walk out of build/venv trees.
const PYTEST_DEFAULT_INCLUDE = ['**/test_*.py', '**/*_test.py'];
export const PYTEST_DEFAULT_IGNORE = ['**/build/**', '**/dist/**', '**/node_modules/**', '**/venv/**', '**/.*/**'];
export const VITEST_DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/cypress/**',
  '**/.{idea,git,cache,output,temp}/**',
  '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
];
// A JS/TS spec under any dot-directory (`.archive/`, `.trash/`) is outside what a
// runner walks by default, not only the five vitest names.
const JS_UNWALKED = [...VITEST_DEFAULT_EXCLUDE, '**/.*/**'];

/**
 * Why a runner would never OPEN `path` although it sits inside the protected tests
 * glob, or null when the path is a test target. The glob says what a spec looks
 * like; each runner also has a walk it never leaves, and a spec renamed into the gap
 * between the two disappears from the suite as surely as a deleted one (#430):
 *
 *   - vitest / jest: the default `test.exclude` (`node_modules/`, `dist/`, `cypress/`,
 *     `.idea/`…), and any dot-directory;
 *   - pytest: the default `norecursedirs` (`build/`, `dist/`, `venv/`, `.*`…);
 *   - cargo: an integration test target is `tests/<name>.rs` or `tests/<name>/main.rs`;
 *     any deeper file is at most a module of one, never a target (a `tests/`
 *     under `src/` is inline unit-test layout, which cargo does not walk this way);
 *   - go test: a directory or file component named `testdata`, or beginning with
 *     `_` or `.`, is ignored by the go tool.
 */
export function runnerSkips(path: string): string | null {
  const parts = path.split('/');
  if (/\.rs$/.test(path)) {
    const i = parts.indexOf('tests');
    if (i < 0 || parts.slice(0, i).includes('src')) return null;
    const rest = parts.slice(i + 1);
    if (rest.length === 1 || (rest.length === 2 && rest[1] === 'main.rs')) return null;
    return 'cargo builds only tests/*.rs and tests/*/main.rs as test targets';
  }
  if (/\.go$/.test(path)) {
    const hit = parts.find((p) => p === 'testdata' || p.startsWith('_') || p.startsWith('.'));
    if (hit === undefined) return null;
    return `go test skips ${hit === 'testdata' ? 'testdata/' : hit.startsWith('_') ? '_*' : '.*'} paths (${JSON.stringify(hit)})`;
  }
  if (/\.py$/.test(path)) {
    const hit = PYTEST_DEFAULT_IGNORE.find((g) => globs([g])(path));
    return hit === undefined ? null : `pytest's default norecursedirs matches it (${JSON.stringify(hit)})`;
  }
  if (/\.[cm]?[jt]sx?$/.test(path)) {
    const hit = JS_UNWALKED.find((g) => globs([g])(path));
    return hit === undefined ? null : `the runner's default exclude matches it (${JSON.stringify(hit)})`;
  }
  return null;
}

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

/** The pytest equivalent of CANONICAL_SAMPLES, for a repository listing we do not
 *  have. pytest collects by BASENAME (`test_*.py`, `*_test.py`) at any depth. */
export const PYTEST_CANONICAL_SAMPLES = [
  'tests/test_a.py',
  'tests/a_test.py',
  'test_a.py',
  'src/tests/test_a.py',
  'tests/conftest.py',
];

function keyName(name: TS.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

const isStr = (e: TS.Node): e is TS.StringLiteral | TS.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e);

/** String literals of an array (or a lone string); `opaque` when anything else sits in it. */
function literals(e: TS.Expression): { items: string[]; opaque: boolean } {
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
function ownerKey(node: TS.PropertyAssignment): string | null {
  const obj = node.parent;
  if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
  let q: TS.Node | undefined = obj.parent;
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
  // pytest. `pytest.ini`/`.pytest.ini` are pytest's by name; the shared files are
  // pytest's only when they carry the section pytest reads, so an ordinary
  // `[tox]` or `[metadata]` edit is not treated as a suite config at all.
  if (base === 'pytest.ini' || base === '.pytest.ini') return 'pytest';
  if (content == null) return null;
  if (base === 'tox.ini' && /^\s*\[pytest\]/m.test(content)) return 'pytest';
  if (base === 'setup.cfg' && /^\s*\[tool:pytest\]/m.test(content)) return 'pytest';
  if (base === 'pyproject.toml' && /^\s*\[tool\.pytest\.ini_options\]/m.test(content)) return 'pytest';
  return null;
}

/**
 * Whether pytest would actually READ this config, under the registered cwd (the
 * repository root). pytest resolves exactly ONE inifile from the rootdir, by a
 * fixed precedence: pytest.ini > .pytest.ini > pyproject.toml > tox.ini >
 * setup.cfg. Two consequences, both verified against real pytest:
 *
 *   - a NESTED config is never opened when the suite runs from the root, so a
 *     narrowing in it changes nothing;
 *   - a lower-precedence root file is shadowed by a higher-precedence one, so a
 *     narrowing in `pyproject.toml` beneath a `pytest.ini` changes nothing either.
 *
 * Flagging an inert config is a FALSE POSITIVE, and a false positive appears in the
 * gated arm alone — it is not experimentally neutral. Where the repository listing
 * cannot settle whether a higher-precedence file claims pytest (its content is not
 * in hand), this stays SILENT rather than guessing, in the same spirit as the rest
 * of this module. Silence costs a late finding; a guess costs a wrong one, and the
 * pristine boundary still refuses to inherit the file either way.
 */
export const PYTEST_INI_ORDER = ['pytest.ini', '.pytest.ini', 'pyproject.toml', 'tox.ini', 'setup.cfg'] as const;

/**
 * Whether this file CLAIMS the inifile slot. `pytest.ini` and `.pytest.ini` claim it
 * unconditionally — pytest opens them even when empty, which is exactly why an added
 * empty one shadows a broader `setup.cfg`. The shared files claim it only when they
 * carry THEIR OWN pytest section: `[tool.pytest.ini_options]` in pyproject.toml,
 * `[pytest]` in tox.ini, `[tool:pytest]` in setup.cfg. Accepting any of the three
 * spellings in any of the three files would hand precedence to a `pyproject.toml`
 * that merely mentions pytest as a dependency.
 */
export function claimsPytest(name: string, src: string): boolean {
  if (name === 'pytest.ini' || name === '.pytest.ini') return true;
  const section =
    name === 'pyproject.toml' ? /^\s*\[tool\.pytest\.ini_options\]\s*$/m
    : name === 'tox.ini' ? /^\s*\[pytest\]\s*$/m
    : name === 'setup.cfg' ? /^\s*\[tool:pytest\]\s*$/m
    : null;
  return section !== null && section.test(src);
}

/**
 * The ONE file pytest would open, given every root config and its content. `null`
 * when nothing claims the slot (pytest then applies its defaults, which are broader
 * than any narrowing — so losing the inifile is never a narrowing).
 */
export function effectivePytestFile(files: Map<string, string | null>): { path: string; content: string } | null {
  for (const name of PYTEST_INI_ORDER) {
    const content = files.get(name);
    if (content == null) continue;
    if (claimsPytest(name, content)) return { path: name, content };
  }
  return null;
}

export function effectivePytestConfig(path: string, ctx?: { trackedFiles?: string[] }): boolean {
  if (path.includes('/')) return false; // nested: not the rootdir config
  const base = path;
  const rank = PYTEST_INI_ORDER.findIndex((name) => name === base);
  if (rank < 0) return false;
  const files = ctx?.trackedFiles;
  if (!files) return true; // no listing: cannot establish a shadow, so do not invent one
  const rootNames = new Set(files.filter((f) => !f.includes('/')));
  // any higher-precedence root config present may be the one pytest opens
  return !PYTEST_INI_ORDER.slice(0, rank).some((n) => rootNames.has(n));
}

/**
 * The pytest configuration block, as key -> raw value, from whichever spelling the
 * file uses: an INI section (`[pytest]`, `[tool:pytest]`) or a TOML table
 * (`[tool.pytest.ini_options]`). INI CONTINUATION LINES are folded into their key,
 * which is how `addopts` is most often written across several lines.
 */
function pytestBlock(src: string): Record<string, string> | null {
  const lines = src.split(/\r?\n/);
  const head = /^\s*\[(pytest|tool:pytest|tool\.pytest\.ini_options)\]\s*$/;
  let i = lines.findIndex((l) => head.test(l));
  if (i < 0) return null;
  const out: Record<string, string> = {};
  let key: string | null = null;
  for (i += 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\[/.test(line)) break;                       // next section ends the block
    if (/^\s*[#;]/.test(line) || !line.trim()) { continue; }
    const m = line.match(/^(\w[\w.-]*)\s*[=:]\s*(.*)$/);
    if (m) { key = m[1]; out[key] = m[2].trim(); continue; }
    if (key && /^\s+\S/.test(line)) out[key] += ' ' + line.trim();  // continuation
  }
  return out;
}

/** A config value as a token list: a TOML array, a quoted string, or bare INI text. */
function pytestTokens(raw: string): string[] {
  const v = raw.trim();
  if (v.startsWith('[')) {
    return [...v.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');
  }
  const unq = v.replace(/^"([\s\S]*)"$/, '$1').replace(/^'([\s\S]*)'$/, '$1');
  // keep quoted groups together so `-k "not test_bug"` is two tokens, not three
  return [...unq.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '').filter(Boolean);
}

/** A `--ignore=<p>` path, or a `--deselect <nodeid>`, as the glob it hides. */
const pathGlobs = (p: string): string[] => {
  const clean = p.replace(/^\.\//, '').replace(/::.*$/, '').replace(/\/+$/, '');
  return clean ? [clean, clean + '/**'] : [];
};

/**
 * pytest's selection, as the same predicate shape the JS runners use. Only the keys
 * that change WHICH FILES RUN are read; `-v`, `--tb`, `-r`, `--color`, `--durations`
 * and a `markers` registry move nothing and are therefore silent BY CONSTRUCTION —
 * there is no benign-flag denylist to keep in step with pytest's option grammar.
 */
function pytestSelection(src: string): Selection {
  const sel = empty();
  const blk = pytestBlock(src);
  if (!blk) return sel;
  sel.present = true;
  // pytest's ignore set is NOT one list. `norecursedirs` REPLACES the built-in dir
  // skips; `--ignore`, `--ignore-glob`, `--deselect`, `-k` and `-m` are ADDITIVE on
  // top of whatever norecursedirs is in force. Seeding the additive entries into an
  // empty list dropped the built-in skips, so a config carrying only
  // `addopts = -k "not slow"` was modelled as collecting `build/**` — which made a
  // later config that merely restores the defaults look like a NARROWING. That is a
  // false positive, and a false positive lands in the gated arm alone.
  const ignore: IgnoreEntry[] =
    blk.norecursedirs !== undefined
      ? pytestTokens(blk.norecursedirs).flatMap((d) => pathGlobs(d).map((pattern) => ({ pattern, key: 'norecursedirs' })))
      : PYTEST_DEFAULT_IGNORE.map((pattern) => ({ pattern, key: 'norecursedirs' }));
  if (blk.testpaths !== undefined) sel.roots = pytestTokens(blk.testpaths).map((t) => t.replace(/^\.\//, ''));
  if (blk.python_files !== undefined) sel.include = pytestTokens(blk.python_files).map((g) => (g.includes('/') ? g : '**/' + g));
  for (const key of ['python_classes', 'python_functions'] as const) {
    // these narrow WITHIN a file; a file whose stem no longer matches any pattern
    // is still collected, so they are recorded as a selection change on the block
    if (blk[key] !== undefined) ignore.push({ pattern: '\u0000' + key, key });
  }
  const opts = blk.addopts !== undefined ? pytestTokens(blk.addopts) : [];
  for (let j = 0; j < opts.length; j++) {
    const o = opts[j];
    const val = (inline: string) => (o.includes('=') ? o.slice(o.indexOf('=') + 1) : (opts[++j] ?? inline));
    if (o === '--ignore' || o.startsWith('--ignore=')) for (const g of pathGlobs(val(''))) ignore.push({ pattern: g, key: '--ignore' });
    else if (o === '--ignore-glob' || o.startsWith('--ignore-glob=')) {
      // pytest fnmatches --ignore-glob against the WHOLE path, where `*` crosses
      // `/`; picomatch's `*` stops at a separator, so a pattern without an explicit
      // directory part also gets a `**/`-anchored form.
      const g = val('');
      ignore.push({ pattern: g, key: '--ignore-glob' });
      if (!g.startsWith('**/') && !g.startsWith('/')) ignore.push({ pattern: '**/' + g, key: '--ignore-glob' });
    }
    else if (o === '--deselect' || o.startsWith('--deselect=')) for (const g of pathGlobs(val(''))) ignore.push({ pattern: g, key: '--deselect' });
    else if (o === '-k' || o.startsWith('-k=')) {
      // `-k` selects by test NAME. A `not <word>` term hides every file whose stem
      // carries that word; anything more involved is left alone rather than guessed.
      for (const w of (val('').match(/\bnot\s+([A-Za-z_][\w]*)/g) ?? []).map((t) => t.replace(/^not\s+/, '')))
        ignore.push({ pattern: `**/*${w}*`, key: '-k' });
    } else if (o === '-m' || o.startsWith('-m=')) {
      // `-m` selects by MARKER, which no config can map to files. It can only ever
      // reduce the run, so it is reported against the config itself rather than
      // guessing a file.
      ignore.push({ pattern: '\u0000-m ' + val(''), key: '-m' });
    } else if (o === '-p' || o.startsWith('-p=') || (o.length > 2 && o.startsWith('-p'))) {
      // `-p no:<plugin>` turns a plugin OFF, and a plugin that is off contributes
      // no items: pytest-checkdocs' `.::project`, pytest-ruff's lint items,
      // whatever an enabler toggles. That is the same harm as `--ignore` or `-k`
      // written in a key the collection options never covered — round 4's pilot
      // (seq 18) found it used to make a failing item disappear while every
      // narrowing key stayed untouched, allowed at the tool call and persisted.
      //
      // Which plugin it is cannot be resolved from the config, so this is a
      // WHOLE-BLOCK narrowing like `-m` rather than a guess at the files. There is
      // no allowlist of harmless plugins: the gate cannot know what any plugin
      // contributes, and a genuine environment reason to disable one is exactly
      // what the sign-off path is for.
      //
      // The value may be detached (`-p no:x`), attached (`-pno:x`) or after `=`
      // (`-p=no:x`); pytest accepts all three, so all three are read. `-p <plugin>`
      // without `no:` LOADS one, which can only widen the run and is never a
      // finding — flagging it would be a false positive, and a false positive lands
      // in the gated arm alone.
      const v = o === '-p' ? (opts[++j] ?? '') : o.startsWith('-p=') ? o.slice(3) : o.slice(2);
      if (v.startsWith('no:')) ignore.push({ pattern: '\u0000-p ' + v, key: '-p' });
    } else if (o === '--collect-only' || o === '--co') ignore.push({ pattern: '**', key: o });
  }
  // Always recorded now: the list already carries the built-in skips (or the
  // replacement for them), so "unset" and "set to the defaults" are the same thing.
  sel.ignore = ignore;
  return sel;
}

const isWorkspaceFile = (path: string) => /^vitest\.workspace\./.test(path.split('/').pop() ?? path);

const empty = (): Selection => ({ include: null, regex: null, ignore: null, roots: null, base: null, projects: null, wide: [], opaque: false, present: false });

/** jest globs and roots are written against `<rootDir>/`, which is what the samples
 *  are relative to once rebased. */
const stripRootDir = (g: string) => g.replace(/^<rootDir>\/?/, '');

/** A directory value read literally: `.`/`./` is the config's own directory. */
function dirValue(e: TS.Expression): { dir: string | null; opaque: boolean } {
  if (!isStr(e)) return { dir: null, opaque: true };
  const d = stripRootDir(e.text).replace(/^\.\//, '').replace(/\/+$/, '');
  // a base outside the config's directory widens the walk — nothing to rebase onto
  if (d === '.' || d === '' || d.split('/').includes('..')) return { dir: null, opaque: false };
  return { dir: d, opaque: false };
}

/** Read one config object (the root, or one project of a multi-project config). */
function collect(root: TS.Node, runner: Runner): Selection {
  const sel = empty();
  const seen = new Set<string>();
  const take = (key: string, e: TS.Expression): string[] => {
    const { items, opaque } = literals(e);
    // the same key set twice at one level is not a config this reader models — opaque
    if (opaque || seen.has(key)) sel.opaque = true;
    seen.add(key);
    sel.present = true;
    return items.map(stripRootDir);
  };
  const ignores = (key: string, e: TS.Expression) => {
    const entries = take(key, e).map((pattern) => ({ pattern, key }));
    sel.ignore = [...(sel.ignore ?? []), ...entries];
  };
  // `testNamePattern` (jest root, vitest `test`) runs only the tests whose NAME
  // matches: every file is still opened and the run still shrinks, so it is a
  // whole-run narrowing recorded against the config rather than a path (#447).
  const namePattern = (e: TS.Expression) => {
    sel.present = true;
    sel.wide.push({ pattern: '\u0000testNamePattern ' + (isStr(e) ? e.text : e.getText()), key: 'testNamePattern' });
  };
  let projectList: TS.Expression | null = null;
  const projects = (e: TS.Expression) => {
    sel.present = true;
    // read AFTER the root's own keys, whatever order the file wrote them in: an
    // `extends: true` project inherits the root's include/exclude/dir
    projectList = e;
  };
  const visit = (node: TS.Node): void => {
    if (ts.isSpreadAssignment(node) && spreadsIntoConfig(node, runner)) {
      sel.present = true;
      sel.opaque = true; // `{ ...base, test: {…} }`: the base's selection is not here to read
    }
    if (ts.isCallExpression(node) && /^(?:\w+\.)?mergeConfig$/.test(node.expression.getText()) && node.arguments[0] && !ts.isObjectLiteralExpression(unwrapConfigCall(node.arguments[0]))) {
      sel.present = true;
      sel.opaque = true; // `mergeConfig(shared, …)`: arrays concatenate with a base this file does not hold
    }
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
        } else if (k === 'testNamePattern') namePattern(node.initializer);
      } else if (ownerKey(node) === 'test') {
        if (k === 'include') sel.include = take(k, node.initializer);
        else if (k === 'exclude') ignores(k, node.initializer);
        else if (k === 'dir' || k === 'root') {
          const { dir, opaque } = dirValue(node.initializer);
          sel.present = true;
          if (opaque) sel.opaque = true;
          else sel.base = dir;
        } else if (k === 'projects') {
          projects(node.initializer);
          return;
        } else if (k === 'testNamePattern') namePattern(node.initializer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (projectList) sel.projects = readProjects(projectList, sel, runner);
  if (sel.projects?.some((p) => p.opaque)) sel.opaque = true;
  return sel;
}

/** `defineConfig({...})` / `defineProject({...})` around a literal is the literal. */
function unwrapConfigCall(e: TS.Expression): TS.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x)) {
    x = x.expression;
  }
  if (ts.isCallExpression(x) && /^(?:\w+\.)?define(?:Config|Project)$/.test(x.expression.getText()) && x.arguments[0]) return unwrapConfigCall(x.arguments[0]);
  return x;
}

const JEST_SELECTION_KEYS = /^(?:testMatch|testRegex|testPathIgnorePatterns|modulePathIgnorePatterns|roots|rootDir|projects)$/;

/** A `...base` spread that lands where a selection key would: in vitest's `test`
 *  object or the object holding it, in jest's config object. */
function spreadsIntoConfig(node: TS.SpreadAssignment, runner: Runner): boolean {
  const obj = node.parent;
  if (!ts.isObjectLiteralExpression(obj)) return false;
  const keys = obj.properties.map((p) => (ts.isPropertyAssignment(p) ? keyName(p.name) : null));
  if (runner === 'vitest') {
    if (keys.includes('test')) return true;
    let q: TS.Node | undefined = obj.parent;
    while (q && (ts.isParenthesizedExpression(q) || ts.isAsExpression(q) || q.kind === ts.SyntaxKind.SatisfiesExpression)) q = q.parent;
    return !!q && ts.isPropertyAssignment(q) && keyName(q.name) === 'test';
  }
  return keys.some((k) => k !== null && JEST_SELECTION_KEYS.test(k));
}

/** The `extends` a project or workspace entry declares: `true` inherits the root
 *  config, a string names another config file, absent means the runner default. */
function extendsOf(el: TS.ObjectLiteralExpression): true | 'path' | null {
  for (const p of el.properties) {
    if (!ts.isPropertyAssignment(p) || keyName(p.name) !== 'extends') continue;
    if (p.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (p.initializer.kind === ts.SyntaxKind.FalseKeyword) return null;
    return 'path';
  }
  return null;
}

/** One project of a multi-project config: its own keys over what it extends. */
function readProject(el: TS.ObjectLiteralExpression, root: Selection | null, runner: Runner): Selection {
  const p = collect(el, runner);
  const ext = extendsOf(el);
  if (ext === 'path') p.opaque = true; // another config file's selection — unreadable here
  else if (ext === true && root) {
    p.include ??= root.include;
    p.regex ??= root.regex;
    p.ignore ??= root.ignore;
    p.roots ??= root.roots;
    p.base ??= root.base;
    if (root.opaque) p.opaque = true;
  }
  p.present = true;
  return p;
}

/** The projects list of a config (`projects: [...]`), each read over the root. */
function readProjects(e: TS.Expression, root: Selection, runner: Runner): Selection[] {
  if (!ts.isArrayLiteralExpression(e)) {
    root.opaque = true;
    return [];
  }
  const list: Selection[] = [];
  for (const el of e.elements) {
    // a project named by path or glob has its own config file — unreadable here
    const lit = unwrapConfigCall(el);
    if (ts.isObjectLiteralExpression(lit)) list.push(readProject(lit, root, runner));
    else root.opaque = true;
  }
  return list;
}

/** The array a `vitest.workspace.*` file exports — `export default [...]` or
 *  `defineWorkspace([...])`; null when it exports anything else. */
function workspaceArray(sf: TS.SourceFile): TS.ArrayLiteralExpression | null {
  for (const st of sf.statements) {
    let e: TS.Expression | undefined;
    if (ts.isExportAssignment(st)) e = st.expression;
    else if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && /module\.exports/.test(st.expression.left.getText())) e = st.expression.right;
    if (!e) continue;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) {
      e = e.expression;
    }
    if (ts.isCallExpression(e) && e.arguments.length > 0) e = e.arguments[0];
    return ts.isArrayLiteralExpression(e) ? e : null;
  }
  return null;
}

export function parseSelection(src: string, runner: Runner, path = ''): Selection {
  let sel = empty();
  if (runner === 'pytest') return pytestSelection(src);
  try {
    const sf = parseSource('cfg.ts', asExpression(src));
    if (!sf) return sel; // declined parse (#444): selects like the default, as the catch below does
    if (runner === 'vitest' && isWorkspaceFile(path)) {
      const arr = workspaceArray(sf);
      if (arr) {
        // a workspace entry with `extends: true` inherits nothing this file holds
        sel.projects = readProjects(arr, sel, runner);
        sel.present = true;
        if (sel.projects.some((p) => p.opaque)) sel.opaque = true;
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

/** The evidence for a whole-run narrowing: the key and what it was given. */
const wideWhy = (hit: IgnoreEntry) => `${hit.key} narrows the whole run (${JSON.stringify(hit.pattern.slice(1).replace(/^testNamePattern /, ''))})`;

interface Predicate {
  selects(path: string): boolean;
  /** Which entry dropped `path`, for the evidence line. */
  why(path: string): string;
}

const underDir = (path: string, dir: string) => dir === '' || path.startsWith(dir + '/');

function predicate(sel: Selection, runner: Runner): Predicate {
  if (sel.projects) {
    const ps = sel.projects.map((p) => predicate(p, runner));
    const wide = sel.wide[0];
    return {
      selects: (p) => wide === undefined && ps.some((x) => x.selects(p)),
      why: (p) =>
        wide !== undefined ? wideWhy(wide)
        : ps.length ? `no project selects it (${ps[0].why(p)})`
        : 'the projects list is empty',
    };
  }
  const includeList =
    sel.include ?? (runner === 'jest' ? (sel.regex ? null : JEST_DEFAULT_MATCH) : runner === 'pytest' ? PYTEST_DEFAULT_INCLUDE : VITEST_DEFAULT_INCLUDE);
  const ignoreList: IgnoreEntry[] =
    sel.ignore ??
    (runner === 'jest' ? JEST_DEFAULT_IGNORE : runner === 'pytest' ? PYTEST_DEFAULT_IGNORE : VITEST_DEFAULT_EXCLUDE).map((pattern) => ({
      pattern,
      key: runner === 'jest' ? 'testPathIgnorePatterns' : runner === 'pytest' ? 'norecursedirs' : 'test.exclude',
    }));
  // A `\u0000`-prefixed entry is a WHOLE-BLOCK narrowing (`-m`, python_classes,
  // python_functions): real, but not attributable to one path, so it applies to
  // every sample rather than being matched as a glob.
  const blockWide = [...ignoreList.filter((e) => e.pattern.startsWith('\u0000')), ...sel.wide];
  const included = includeList ? globList(includeList) : sel.regex ? regexes(sel.regex) : () => true;
  const ignoredBy = (p: string): IgnoreEntry | undefined =>
    blockWide[0] ?? ignoreList.filter((e) => !e.pattern.startsWith('\u0000')).find((e) => (runner === 'jest' ? regexes([e.pattern]) : globs([e.pattern]))(p));
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
      if (hit) {
        // A whole-block narrowing (`-m`, `python_classes`, `python_functions`,
        // `-p no:<plugin>`) does not MATCH a path — it shrinks what the runner
        // collects everywhere. Saying "now matches it" of a marker expression or a
        // disabled plugin would name a mechanism that did not happen.
        if (hit.pattern.startsWith('\u0000')) return wideWhy(hit);
        return `${hit.key === 'exclude' ? 'test.exclude' : hit.key} now matches it (${JSON.stringify(hit.pattern)})`;
      }
      const key = runner === 'jest' ? (sel.include ? 'testMatch' : sel.regex ? 'testRegex' : 'testMatch (default)') : sel.include ? 'test.include' : 'test.include (default)';
      return `${key} no longer matches it (${JSON.stringify(sel.include ?? sel.regex ?? includeList ?? [])})`;
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

// ── delegation: the selection handed to a file this config does not hold ──────
//
// A protected config can stop holding its own selection without narrowing a line
// of it (#447): `export { default } from './vitest.real'`, `module.exports =
// require('./jest.real')`, a `...base` spread from a relative import,
// `mergeConfig(base, …)`, a project `extends: './x'`, a jest `preset: './x'`, a
// `projects` entry naming a config by path. The reader above goes OPAQUE on every
// one of these, and opacity was silence — so the runner's whole selection moved to
// a file no glob protects and the gate said nothing. The opacity IS the weakening
// when the target is a file the same change adds or that nothing protects; a
// delegation that was already there, or to a protected file the change did not
// write, is the repository's own layout.

export interface Delegation {
  /** The module specifier / path as written (`./vitest.real`, `<rootDir>/jest.unit.js`). */
  target: string;
  /** The construct, for the evidence line. */
  how: string;
}

/** A path this config resolves against its own directory, as opposed to a package. */
const isLocalPath = (s: string) => /^(?:\.\.?\/|\/|<rootDir>)/.test(s);
const hasGlob = (s: string) => /[*?[\]{}]/.test(s);

const oneLine = (node: TS.Node) => node.getText().replace(/\s+/g, ' ').slice(0, 120);

/** `require('./x')` / `import('./x')`: the relative specifier, or null. */
function requiredPath(e: TS.Expression): string | null {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isAwaitExpression(x)) x = x.expression;
  if (ts.isCallExpression(x) && x.arguments.length > 0 && isStr(x.arguments[0])) {
    const callee = x.expression;
    if ((ts.isIdentifier(callee) && callee.text === 'require') || callee.kind === ts.SyntaxKind.ImportKeyword) return x.arguments[0].text;
  }
  return null;
}

function delegationsIn(src: string, runner: Runner): Delegation[] {
  const out: Delegation[] = [];
  const seen = new Set<string>();
  const add = (target: string, how: string, local = true) => {
    if ((local && !isLocalPath(target)) || hasGlob(target) || seen.has(target)) return;
    seen.add(target);
    out.push({ target, how });
  };
  let sf: TS.SourceFile | null = null;
  try {
    sf = parseSource('cfg.ts', asExpression(src));
  } catch {
    return out;
  }
  if (!sf) return out;
  // identifiers bound to a relative module: `import base from './x'`,
  // `import * as b from './x'`, `import { a } from './x'`, `const b = require('./x')`
  const bound = new Map<string, string>();
  const bindNames = (name: TS.BindingName, spec: string) => {
    if (ts.isIdentifier(name)) bound.set(name.text, spec);
    else for (const el of name.elements) if (ts.isBindingElement(el)) bindNames(el.name, spec);
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && isStr(st.moduleSpecifier) && isLocalPath(st.moduleSpecifier.text) && st.importClause) {
      const spec = st.moduleSpecifier.text;
      if (st.importClause.name) bound.set(st.importClause.name.text, spec);
      const nb = st.importClause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) bound.set(nb.name.text, spec);
      else if (nb) for (const el of nb.elements) bound.set(el.name.text, spec);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const spec = d.initializer ? requiredPath(d.initializer) : null;
        if (spec !== null && isLocalPath(spec)) bindNames(d.name, spec);
      }
    }
  }
  /** The relative module an expression stands for: a bound identifier (or a
   *  member of one), or an inline `require('./x')`. */
  const moduleOf = (e: TS.Expression): string | null => {
    let x = e;
    while (
      ts.isParenthesizedExpression(x) ||
      ts.isAsExpression(x) ||
      ts.isSatisfiesExpression(x) ||
      ts.isAwaitExpression(x) ||
      ts.isPropertyAccessExpression(x) ||
      ts.isNonNullExpression(x)
    )
      x = x.expression;
    if (ts.isIdentifier(x)) return bound.get(x.text) ?? null;
    return requiredPath(x);
  };
  /** The exported value, if the whole export is another module's. */
  const exported = (e: TS.Expression, how: string) => {
    const m = moduleOf(unwrapConfigCall(e));
    if (m !== null) add(m, how);
  };
  const visit = (node: TS.Node): void => {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && isStr(node.moduleSpecifier)) {
      // `export * from './x'`, `export { default } from './x'`, `export { x as default } from './x'`
      const clause = node.exportClause;
      const whole = !clause || (ts.isNamedExports(clause) && clause.elements.some((el) => el.name.text === 'default'));
      if (whole) add(node.moduleSpecifier.text, oneLine(node));
    } else if (ts.isExportAssignment(node)) {
      exported(node.expression, oneLine(node));
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      /^(?:module\.)?exports(?:\.default)?$/.test(node.left.getText())
    ) {
      exported(node.right, oneLine(node));
    } else if (ts.isSpreadAssignment(node)) {
      const m = moduleOf(node.expression);
      if (m !== null) add(m, `...${oneLine(node.expression)}`);
    } else if (ts.isCallExpression(node) && /^(?:\w+\.)?mergeConfig$/.test(node.expression.getText()) && node.arguments[0]) {
      const m = moduleOf(node.arguments[0]);
      if (m !== null) add(m, `${oneLine(node.expression)}(${oneLine(node.arguments[0])}, …)`);
    } else if (ts.isPropertyAssignment(node)) {
      const k = keyName(node.name);
      const v = node.initializer;
      if (runner === 'vitest' && k === 'extends' && isStr(v)) add(v.text, `extends: ${JSON.stringify(v.text)}`);
      else if (runner === 'jest' && k === 'preset' && isStr(v)) add(v.text, `preset: ${JSON.stringify(v.text)}`);
      else if (k === 'projects' && ts.isArrayLiteralExpression(v) && (runner === 'jest' || ownerKey(node) === 'test')) {
        // a project named by PATH has its own config file; a glob is a set of them
        // this reader cannot enumerate (opaque, as before)
        for (const el of v.elements) if (isStr(el)) add(el.text, `projects: [${JSON.stringify(el.text)}]`, false);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Delegations `after` carries that `before` did not: the runner's selection is now
 * read from another file. The caller judges each target — a file this change adds,
 * or one no protected glob covers, is unreviewed and the delegation is the finding.
 */
export function suiteDelegations(before: string | null, after: string, path: string): Delegation[] {
  const runner = runnerOf(path, after) ?? runnerOf(path, before);
  if (!runner || runner === 'pytest') return [];
  const was = new Set(delegationsIn(before ?? '', runner).map((d) => d.target));
  return delegationsIn(after, runner).filter((d) => !was.has(d.target));
}

/**
 * The repository paths a config-relative target may name, for a protection or
 * added-file check: the path as written, with each module extension, and as a
 * directory index. `<rootDir>/` and `./` are the config's own directory.
 */
export function targetCandidates(configPath: string, target: string): string[] {
  const dir = configPath.includes('/') ? configPath.slice(0, configPath.lastIndexOf('/')) : '';
  const rel = target.replace(/^<rootDir>\/?/, './');
  const parts = rel.startsWith('/') || !dir ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const base = parts.join('/');
  if (!base) return [];
  const exts = ['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.json'];
  return [base, ...exts.map((e) => base + e), ...exts.map((e) => `${base}/index${e}`)];
}

// ── setup: the modules a runner loads around the suite ────────────────────────
//
// `setupFiles`, `setupFilesAfterEnv`, `globalSetup`, a custom `runner`, a custom
// `testEnvironment`, a `reporters` entry: each names a module the runner executes
// with the suite's globals in reach (#447 found a global `expect` proxy in a new
// `setupFilesAfterEach` file). A NEW entry pointing at a file nothing protects is
// reported as a warning by `config-weakening`; the reader lives here beside the
// selection reader because the config shapes are the same.

export interface SetupEntry {
  key: string;
  target: string;
}

const JEST_SETUP_KEYS =
  /^(?:setupFiles|setupFilesAfterEnv|setupFilesAfterEach|globalSetup|globalTeardown|runner|testRunner|testEnvironment|reporters|testResultsProcessor|testSequencer|snapshotResolver|resolver)$/;
const VITEST_SETUP_KEYS = /^(?:setupFiles|setupFilesAfterEach|globalSetup|environment|runner|reporters)$/;

/** A value that names a file rather than a package: relative, rooted, or carrying
 *  a module extension (`test/setup.ts`; `dotenv/config` and `jsdom` are packages). */
const namesFile = (s: string) => isLocalPath(s) || (/\.[cm]?[jt]sx?$/.test(s) && !s.startsWith('@'));

function setupEntriesIn(src: string, runner: Runner, path: string): SetupEntry[] {
  const out: SetupEntry[] = [];
  let sf: TS.SourceFile | null = null;
  try {
    sf = parseSource('cfg.ts', asExpression(src));
  } catch {
    return out;
  }
  if (!sf) return out;
  const inPackageJson = (path.split('/').pop() ?? path) === 'package.json';
  const underJestKey = (node: TS.Node): boolean => {
    for (let q: TS.Node | undefined = node.parent; q; q = q.parent) {
      if (ts.isPropertyAssignment(q) && keyName(q.name) === 'jest') return true;
    }
    return false;
  };
  const values = (e: TS.Expression): string[] => {
    if (isStr(e)) return [e.text];
    if (!ts.isArrayLiteralExpression(e)) return [];
    const vs: string[] = [];
    for (const el of e.elements) {
      if (isStr(el)) vs.push(el.text);
      else if (ts.isArrayLiteralExpression(el) && el.elements[0] && isStr(el.elements[0])) vs.push(el.elements[0].text); // `['./reporter.js', { … }]`
    }
    return vs;
  };
  const visit = (node: TS.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const k = keyName(node.name);
      const applies =
        k !== null &&
        (runner === 'jest' ? JEST_SETUP_KEYS.test(k) && (!inPackageJson || underJestKey(node)) : VITEST_SETUP_KEYS.test(k) && ownerKey(node) === 'test');
      if (applies && k !== null) for (const v of values(node.initializer)) if (namesFile(v)) out.push({ key: k, target: v });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Setup entries `after` carries that `before` did not (by key and target). */
export function newSetupEntries(before: string | null, after: string, path: string): SetupEntry[] {
  const runner = runnerOf(path, after) ?? runnerOf(path, before);
  if (!runner || runner === 'pytest') return [];
  const was = new Set(setupEntriesIn(before ?? '', runner, path).map((e) => `${e.key} ${e.target}`));
  return setupEntriesIn(after, runner, path).filter((e) => !was.has(`${e.key} ${e.target}`));
}
