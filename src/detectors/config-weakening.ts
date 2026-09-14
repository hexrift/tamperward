// config-weakening (file surface, mechanical, semantic config-diff; warn).
//
// Three protected config families were protected in name only (#447): the globs
// covered `tsconfig*.json`, `.eslintrc*` and `eslint.config.*`, and no rule read
// them. `strict: true → false` in tsconfig.json is the broadest `any` launder
// there is, and it fired nothing; `'no-unused-vars': 'off'` and `ignores:
// ['src/hard.ts']` in eslint.config.js fired nothing; `.eslintignore` was not even
// protected. This rule reads each family the way its tool does and reports the
// EFFECTIVE weakening:
//
//   - tsconfig: a strictness flag that was on (explicitly, or implied by `strict`)
//     and is off after — `strict`, the `strict` family, `noUnusedLocals`,
//     `noImplicitReturns`, `noUncheckedIndexedAccess`, `checkJs`, …; a flag whose
//     `true` LOOSENS the check gained (`skipLibCheck`, `allowUnreachableCode`);
//     `exclude` grown with a path that hides source; `extends` dropped or pointed
//     at a file nothing reviews. A flag that is lowered here and raised in another
//     tsconfig of the same change moved, and is not reported.
//   - eslint (flat and legacy, JS/JSON/YAML) and `.eslintignore`: a rule turned
//     `off` / `0` that was not off before — across every eslint config in the
//     change, so a migration from `.eslintrc` to `eslint.config.js` carries its off
//     rules over silently; a base rule turned off while its plugin variant
//     (`@typescript-eslint/<rule>`) is on is a replacement, not a removal;
//     `ignores` / `ignorePatterns` / `globalIgnores([...])` / `.eslintignore` grown
//     with a path that hides source.
//   - biome: `linter.enabled: false`, `rules.recommended: false`, a rule set to
//     `off`, `files.ignore` / `linter.ignore` grown, a `!` entry added to
//     `files.includes`.
//   - jest / vitest: a NEW `setupFiles` / `setupFilesAfterEnv` / `globalSetup` /
//     `runner` / `testEnvironment` / `reporters` entry pointing at a file the same
//     change adds or that no protected glob covers — a module the runner executes
//     with the suite's globals in reach (the `expect` proxy of #447).
//
// "Hides source" is judged over the repository listing when the gate has one:
// a pattern under which no tracked code file sits, or only build output,
// dependencies and generated files, is housekeeping. Without a listing the
// conventional output directories and file classes are housekeeping by name.
//
// Warn, not block: every one of these has an honest spelling (a build-only
// tsconfig excludes the tests; a rule is retired for its typed twin), and the
// severity is decided by corpus (harness/fp-study/CONFIG-WEAKENING-CORPUS.md).
// Raising the bar is `strict: false → true`, a rule added at `error`, an ignore
// removed — none of which is read as anything.

import { picomatch, yaml } from '../lazy-deps';
import type TS from 'typescript';
import { parseSource, ts } from '../ts-lazy';
import { Change, Detector, DetectorContext, FileChange, Finding, Policy } from '../types';
import { isProtected } from '../policy';
import { isRecord } from '../narrow';
import { makeFinding } from './finding';
import { trackedFiles } from './repo';
import { newSetupEntries, runnerOf, targetCandidates } from './suite-config';

const RULE = 'config-weakening';

const basename = (path: string) => path.split('/').pop() ?? path;
const isTsconfig = (path: string) => /^tsconfig.*\.json$/.test(basename(path));
const isEslintConfig = (path: string) => /^(?:\.eslintrc(?:\..*)?|eslint\.config\..*)$/.test(basename(path));
const isEslintIgnore = (path: string) => basename(path) === '.eslintignore';
const isBiome = (path: string) => /^biome\.jsonc?$/.test(basename(path));

// ── JSON with comments (tsconfig, .eslintrc, biome.jsonc) and YAML ───────────

function parseJsonc(path: string, text: string): unknown {
  try {
    const r = ts.parseConfigFileTextToJson(path, text);
    if (r.error) return null;
    const cfg: unknown = r.config;
    return cfg;
  } catch {
    return null;
  }
}

function parseYaml(text: string): unknown {
  try {
    const v: unknown = yaml.parse(text);
    return v;
  } catch {
    return null;
  }
}

// ── "hides source": a new ignore / exclude entry judged over the repository ──

const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
/** Output, dependency, cache and generated trees by their conventional names. */
const HOUSEKEEPING_DIR = /^(?:node_modules|dist|build|out|output|coverage|lib|esm|cjs|umd|target|tmp|temp|vendor|generated|__generated__|public|static|storybook-static|\..+)$/;
const HOUSEKEEPING_FILE = /(?:\.(?:min\.[cm]?js|d\.[cm]?ts|snap|map|json|jsonc|md|mdx|lock|ya?ml|toml|html?|css|scss|svg|png|jpe?g|gif|txt)|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|CHANGELOG\.md))$/i;

/** The pattern with its leading `./`, `/`, `**/` and trailing `/**`, `/*`, `/` removed. */
function corePattern(p: string): string {
  return p
    .trim()
    .replace(/^!/, '')
    .replace(/^(?:\.\/|\/)+/, '')
    .replace(/^(?:\*\*\/)+/, '')
    .replace(/(?:\/\*\*?)+\/?$/, '')
    .replace(/\/+$/, '');
}

function housekeepingByName(p: string): boolean {
  const core = corePattern(p);
  if (core === '' || core === '**' || core === '*') return false;
  const first = core.split('/')[0];
  return HOUSEKEEPING_DIR.test(first) || HOUSEKEEPING_FILE.test(core);
}

/** gitignore/eslint semantics for a listing: an entry names a path at any depth,
 *  and a directory entry covers everything under it. */
function ignoreGlobs(p: string): string[] {
  const core = corePattern(p);
  if (!core) return [];
  const anchored = p.trim().replace(/^!/, '').startsWith('/') || core.includes('/');
  const heads = anchored ? [core] : [core, `**/${core}`];
  return heads.flatMap((h) => [h, `${h}/**`]);
}

const matcher = (patterns: string[]) => {
  const ms = patterns.map((g) => {
    try {
      return picomatch(g, { dot: true });
    } catch {
      return () => false;
    }
  });
  return (path: string) => ms.some((m) => m(path));
};

/**
 * Whether a new ignore/exclude entry hides a code file the repository tracks.
 * With a listing the answer is exact over the listing (housekeeping paths in it
 * do not count); without one the conventional names decide.
 */
function hidesSource(pattern: string, dir: string, ctx?: DetectorContext): string | null {
  const files = trackedFiles(ctx);
  if (!files) return housekeepingByName(pattern) ? null : pattern;
  const m = matcher(ignoreGlobs(pattern));
  const hit = files.find((f) => {
    if (dir && !f.startsWith(dir)) return false;
    const rel = f.slice(dir.length);
    if (!CODE_FILE.test(rel) || HOUSEKEEPING_FILE.test(rel)) return false;
    if (rel.split('/').slice(0, -1).some((seg) => HOUSEKEEPING_DIR.test(seg))) return false;
    return m(rel);
  });
  return hit === undefined ? null : hit;
}

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');

/** Entries `after` carries that `before` did not, as normalised strings. */
function grown(before: string[], after: string[]): string[] {
  const was = new Set(before.map(corePattern));
  return after.filter((e) => !was.has(corePattern(e)));
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);

// ── tsconfig ──────────────────────────────────────────────────────────────────

/** Flags `strict: true` switches on. */
const STRICT_FAMILY = new Set([
  'noImplicitAny',
  'strictNullChecks',
  'strictFunctionTypes',
  'strictBindCallApply',
  'strictPropertyInitialization',
  'noImplicitThis',
  'alwaysStrict',
  'useUnknownInCatchVariables',
  'strictBuiltinIteratorReturn',
]);
/** Flags whose `true` is the stricter setting. */
const TRUE_IS_STRICT = [
  'strict',
  ...STRICT_FAMILY,
  'noUnusedLocals',
  'noUnusedParameters',
  'noImplicitReturns',
  'noFallthroughCasesInSwitch',
  'noUncheckedIndexedAccess',
  'noImplicitOverride',
  'noPropertyAccessFromIndexSignature',
  'exactOptionalPropertyTypes',
  'checkJs',
  'forceConsistentCasingInFileNames',
];
/** Flags whose `true` LOOSENS a check the compiler otherwise applies. */
const TRUE_IS_WEAK = ['skipLibCheck', 'allowUnreachableCode', 'allowUnusedLabels', 'suppressImplicitAnyIndexErrors', 'suppressExcessPropertyErrors', 'noStrictGenericChecks'];

interface TsconfigFacts {
  options: Record<string, unknown>;
  exclude: string[];
  extends: string[];
}

function tsconfigFacts(path: string, text: string | null): TsconfigFacts | null {
  if (text === null) return null;
  const cfg = parseJsonc(path, text);
  if (!isRecord(cfg)) return null;
  return {
    options: isRecord(cfg.compilerOptions) ? cfg.compilerOptions : {},
    exclude: strings(cfg.exclude),
    extends: strings(cfg.extends),
  };
}

/** The flag as the compiler applies it: explicit, else implied by `strict`. */
function effective(f: TsconfigFacts | null, flag: string): boolean {
  if (!f) return false;
  const v = f.options[flag];
  if (typeof v === 'boolean') return v;
  return STRICT_FAMILY.has(flag) && f.options.strict === true;
}

const isLocalTarget = (s: string) => /^(?:\.\.?\/|\/)/.test(s);

function tsconfigWeakenings(c: FileChange, all: FileChange[], policy: Policy, addedPaths: Set<string>, ctx: DetectorContext | undefined, out: Finding[]): void {
  if (c.before === null || c.after === null) return; // an added or deleted file lowers nothing that was there
  const b = tsconfigFacts(c.path, c.before);
  const a = tsconfigFacts(c.path, c.after);
  if (!b || !a) return;
  // a flag lowered here and raised in another tsconfig of the same change moved
  const others = all.filter((o) => o !== c && o.after !== null && isTsconfig(o.path)).map((o) => ({ b: tsconfigFacts(o.path, o.before), a: tsconfigFacts(o.path, o.after) }));
  const movedTo = (flag: string) => others.find((o) => effective(o.a, flag) && !effective(o.b, flag));
  const push = (message: string, evidence: string, remediation: string) => out.push(makeFinding(RULE, policy, { file: c.path, message, evidence, remediation, defaultSeverity: 'warn' }));
  const strictLowered = effective(b, 'strict') && !effective(a, 'strict');
  for (const flag of TRUE_IS_STRICT) {
    if (!effective(b, flag) || effective(a, flag)) continue;
    // the family follows `strict`: one finding for the umbrella, not ten
    if (flag !== 'strict' && STRICT_FAMILY.has(flag) && strictLowered && a.options[flag] === undefined) continue;
    if (movedTo(flag)) continue;
    const was = typeof b.options[flag] === 'boolean' ? String(b.options[flag]) : 'implied by strict';
    const now = a.options[flag] === undefined ? 'removed' : String(a.options[flag]);
    push(
      `tsconfig strictness lowered: compilerOptions.${flag} ${was} → ${now}.`,
      `${c.path}: ${flag} ${was} → ${now}`,
      `Keep ${flag} on and fix the code it reports. Lowering the compiler's strictness hides the errors it was finding, in every file at once.`,
    );
  }
  for (const flag of TRUE_IS_WEAK) {
    if (b.options[flag] === true || a.options[flag] !== true) continue;
    push(
      `tsconfig check loosened: compilerOptions.${flag}: true added${flag === 'skipLibCheck' ? ' (declaration files are no longer type-checked)' : ''}.`,
      `${c.path}: ${flag}: true`,
      `Leave ${flag} off and fix what the compiler reports; a check switched off here is off for every build.`,
    );
  }
  const dir = dirOf(c.path);
  for (const e of grown(b.exclude, a.exclude)) {
    const hit = hidesSource(e, dir, ctx);
    if (hit === null) continue;
    push(
      `tsconfig exclude grown: ${JSON.stringify(e)} now hides ${hit === e ? 'source' : hit} from the compiler.`,
      `${c.path}: exclude += ${JSON.stringify(e)}`,
      'Keep the compiler pointed at the whole source. A file excluded from tsconfig is not type-checked anywhere.',
    );
  }
  // `extends` carries the base's strictness with it
  if (b.extends.length && a.extends.length === 0) {
    push(
      `tsconfig no longer extends ${b.extends.map((x) => JSON.stringify(x)).join(', ')}: the strictness the base carried is gone with it.`,
      `${c.path}: extends removed`,
      'Keep the base config, or carry its compiler options over explicitly so the check stays as strict as it was.',
    );
  }
  for (const target of a.extends.filter((t) => !b.extends.includes(t) && isLocalTarget(t))) {
    const cands = targetCandidates(c.path, target);
    const added = cands.find((f) => addedPaths.has(f));
    if (added === undefined && cands.some((f) => isProtected(f, policy, 'config'))) continue;
    push(
      `tsconfig now extends ${JSON.stringify(target)}, ${added !== undefined ? `a file this change adds (${added})` : 'a file no protected glob covers'}.`,
      `${c.path}: extends ${JSON.stringify(target)}`,
      'Extend a protected config, or protect the base (protected.config in .tamperward.yml); the strictness now lives where the gate cannot read it.',
    );
  }
}

// ── eslint / biome ────────────────────────────────────────────────────────────

interface LintFacts {
  /** rule → how it is off, for the evidence line */
  off: Map<string, string>;
  on: Set<string>;
  ignores: string[];
  /** biome: `linter.enabled: false` */
  linterOff: boolean;
}

const emptyFacts = (): LintFacts => ({ off: new Map(), on: new Set(), ignores: [], linterOff: false });

/** An eslint rule level: `'off'` / `0` / `['off', …]` is off, `warn`/`error`/1/2 is on. */
function levelOf(v: unknown): 'off' | 'on' | null {
  const head = Array.isArray(v) ? v[0] : v;
  if (head === 'off' || head === 0) return 'off';
  if (head === 'warn' || head === 'error' || head === 1 || head === 2) return 'on';
  return null;
}

/** eslint facts from a parsed object (JSON / YAML / package.json `eslintConfig`). */
function eslintObjectFacts(v: unknown, f: LintFacts, key: string | null = null): void {
  if (Array.isArray(v)) {
    for (const el of v) eslintObjectFacts(el, f, null);
    return;
  }
  if (!isRecord(v)) return;
  if (key === 'rules') {
    for (const [rule, level] of Object.entries(v)) {
      const l = levelOf(level);
      if (l === 'off') f.off.set(rule, `${rule}: ${JSON.stringify(level)}`);
      else if (l === 'on') f.on.add(rule);
    }
    return;
  }
  for (const [k, val] of Object.entries(v)) {
    if (k === 'ignores' || k === 'ignorePatterns') f.ignores.push(...strings(val));
    else eslintObjectFacts(val, f, k);
  }
}

/** eslint facts from a JS/TS config on the AST: every `rules: {…}` object, every
 *  `ignores` / `ignorePatterns` array, every `globalIgnores([...])` call. */
function eslintAstFacts(text: string, f: LintFacts): void {
  let sf: TS.SourceFile | null = null;
  try {
    sf = parseSource('eslint.config.ts', text);
  } catch {
    return;
  }
  if (!sf) return;
  const isStr = (e: TS.Node): e is TS.StringLiteral | TS.NoSubstitutionTemplateLiteral => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e);
  const keyText = (n: TS.PropertyName): string | null => (ts.isIdentifier(n) || isStr(n) || ts.isNumericLiteral(n) ? n.text : null);
  const literal = (e: TS.Expression): unknown => {
    if (isStr(e)) return e.text;
    if (ts.isNumericLiteral(e)) return Number(e.text);
    if (ts.isArrayLiteralExpression(e)) return e.elements.map(literal);
    return undefined;
  };
  const arrayStrings = (e: TS.Expression): string[] => (ts.isArrayLiteralExpression(e) ? e.elements.filter(isStr).map((s) => s.text) : isStr(e) ? [e.text] : []);
  const visit = (node: TS.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const k = keyText(node.name);
      if (k === 'rules' && ts.isObjectLiteralExpression(node.initializer)) {
        for (const p of node.initializer.properties) {
          if (!ts.isPropertyAssignment(p)) continue;
          const rule = keyText(p.name);
          if (rule === null) continue;
          const l = levelOf(literal(p.initializer));
          if (l === 'off') f.off.set(rule, `${rule}: ${p.initializer.getText().replace(/\s+/g, ' ').slice(0, 60)}`);
          else if (l === 'on') f.on.add(rule);
        }
      } else if (k === 'ignores' || k === 'ignorePatterns') f.ignores.push(...arrayStrings(node.initializer));
    } else if (ts.isCallExpression(node) && /^(?:\w+\.)?globalIgnores$/.test(node.expression.getText()) && node.arguments[0]) {
      f.ignores.push(...arrayStrings(node.arguments[0]));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function eslintFacts(path: string, text: string | null): LintFacts {
  const f = emptyFacts();
  if (text === null) return f;
  const base = basename(path);
  if (isEslintIgnore(path)) {
    f.ignores.push(...text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!')));
    return f;
  }
  if (/\.(?:[cm]?[jt]s)$/.test(base)) eslintAstFacts(text, f);
  else if (/\.ya?ml$/.test(base)) eslintObjectFacts(parseYaml(text), f);
  else if (base === 'package.json') {
    const pkg = parseJsonc(path, text);
    if (isRecord(pkg)) eslintObjectFacts(pkg.eslintConfig, f);
  } else {
    // `.eslintrc` and `.eslintrc.json`: JSON (with comments), or YAML for the bare file
    const j = parseJsonc(path, text);
    eslintObjectFacts(j !== null ? j : base === '.eslintrc' ? parseYaml(text) : null, f);
  }
  return f;
}

/** biome facts: `linter.enabled`, `rules.<group>.<rule>` (`off` or `{ level: 'off' }`),
 *  `rules.recommended`, `files.ignore` / `linter.ignore`, `!` entries in `files.includes`. */
function biomeFacts(path: string, text: string | null): LintFacts {
  const f = emptyFacts();
  if (text === null) return f;
  const cfg = parseJsonc(path, text);
  if (!isRecord(cfg)) return f;
  const readLinter = (linter: unknown) => {
    if (!isRecord(linter)) return;
    if (linter.enabled === false) f.linterOff = true;
    f.ignores.push(...strings(linter.ignore));
    const rules = linter.rules;
    if (!isRecord(rules)) return;
    if (rules.recommended === false) f.off.set('recommended', 'rules.recommended: false');
    for (const [group, body] of Object.entries(rules)) {
      if (!isRecord(body)) continue;
      if (body.recommended === false) f.off.set(`${group}/recommended`, `${group}.recommended: false`);
      for (const [rule, level] of Object.entries(body)) {
        const l = level === 'off' || (isRecord(level) && level.level === 'off') ? 'off' : typeof level === 'string' || isRecord(level) ? 'on' : null;
        if (l === 'off') f.off.set(`${group}/${rule}`, `${group}.${rule}: off`);
        else if (l === 'on') f.on.add(`${group}/${rule}`);
      }
    }
  };
  readLinter(cfg.linter);
  if (Array.isArray(cfg.overrides)) for (const o of cfg.overrides) if (isRecord(o)) readLinter(o.linter);
  if (isRecord(cfg.files)) {
    f.ignores.push(...strings(cfg.files.ignore));
    f.ignores.push(...strings(cfg.files.includes).filter((p) => p.startsWith('!')));
  }
  return f;
}

/** A base rule turned off beside its plugin-prefixed twin switched on is a
 *  replacement (`no-unused-vars: off`, `@typescript-eslint/no-unused-vars: error`). */
function replacedByVariant(rule: string, on: Set<string>): boolean {
  if (rule.includes('/')) return false;
  for (const r of on) if (r.endsWith(`/${rule}`)) return true;
  return false;
}

function lintWeakenings(c: FileChange, facts: (p: string, t: string | null) => LintFacts, priorAll: LintFacts, policy: Policy, ctx: DetectorContext | undefined, out: Finding[]): void {
  if (c.after === null) return;
  const a = facts(c.path, c.after);
  const tool = isBiome(c.path) ? 'biome' : 'eslint';
  const push = (message: string, evidence: string, remediation: string) => out.push(makeFinding(RULE, policy, { file: c.path, message, evidence, remediation, defaultSeverity: 'warn' }));
  if (a.linterOff && !priorAll.linterOff) {
    push(`${tool} linter switched off: linter.enabled: false.`, `${c.path}: linter.enabled: false`, 'Keep the linter on and fix what it reports.');
  }
  for (const [rule, how] of a.off) {
    if (priorAll.off.has(rule) || replacedByVariant(rule, a.on)) continue;
    push(
      `${tool} rule turned off: ${rule}.`,
      `${c.path}: ${how}`,
      `Keep ${rule} on and fix what it reports, or scope a justified exception with a reason. A rule turned off in the config is off for every file at once.`,
    );
  }
  const dir = dirOf(c.path);
  for (const e of grown(priorAll.ignores, a.ignores)) {
    const hit = hidesSource(e, dir, ctx);
    if (hit === null) continue;
    const key = isEslintIgnore(c.path) ? '.eslintignore' : tool === 'biome' ? 'files.ignore' : /\.eslintrc/.test(basename(c.path)) ? 'ignorePatterns' : 'ignores';
    push(
      `${tool} ${key} grown: ${JSON.stringify(e)} now hides ${hit === e ? 'source' : hit} from the lint.`,
      `${c.path}: ${key} += ${JSON.stringify(e)}`,
      'Keep the lint pointed at the whole source. A path ignored here is never linted, whatever the rules say.',
    );
  }
}

// ── the detector ──────────────────────────────────────────────────────────────

export const configWeakening: Detector = {
  id: RULE,
  surface: ['file'],
  certainty: 'mechanical',
  run(changes: Change[], policy: Policy, _view, ctx?: DetectorContext): Finding[] {
    const out: Finding[] = [];
    const files = changes.filter((c): c is FileChange => c.kind === 'file');
    const addedPaths = new Set(files.filter((c) => c.op === 'add').map((c) => c.path));
    const tsconfigs = files.filter((c) => isTsconfig(c.path) && isProtected(c.path, policy, 'config'));
    const eslints = files.filter((c) => (isEslintConfig(c.path) || isEslintIgnore(c.path)) && isProtected(c.path, policy, 'config'));
    const biomes = files.filter((c) => isBiome(c.path) && isProtected(c.path, policy, 'config'));
    // what the lint had switched off or ignored BEFORE this change, across every
    // config of the family — a rule off in the deleted `.eslintrc.json` and off in
    // the new `eslint.config.js` moved, and a migration is not a weakening
    const priorOf = (list: FileChange[], facts: (p: string, t: string | null) => LintFacts): LintFacts => {
      const all = emptyFacts();
      for (const c of list) {
        const f = facts(c.path, c.before);
        for (const [k, v] of f.off) all.off.set(k, v);
        for (const k of f.on) all.on.add(k);
        all.ignores.push(...f.ignores);
        if (f.linterOff) all.linterOff = true;
      }
      return all;
    };
    const eslintPrior = priorOf(eslints, eslintFacts);
    const biomePrior = priorOf(biomes, biomeFacts);
    for (const c of tsconfigs) tsconfigWeakenings(c, tsconfigs, policy, addedPaths, ctx, out);
    for (const c of eslints) lintWeakenings(c, eslintFacts, eslintPrior, policy, ctx, out);
    for (const c of biomes) lintWeakenings(c, biomeFacts, biomePrior, policy, ctx, out);
    // the runner's setup modules (#447): a NEW entry pointing at an unreviewed file
    for (const c of files) {
      if (c.after === null || !isProtected(c.path, policy, 'config')) continue;
      const rn = runnerOf(c.path, c.after) ?? runnerOf(c.path, c.before);
      if (rn !== 'jest' && rn !== 'vitest') continue;
      for (const e of newSetupEntries(c.before, c.after, c.path)) {
        const cands = targetCandidates(c.path, e.target);
        const added = cands.find((f) => addedPaths.has(f));
        if (added === undefined && cands.some((f) => isProtected(f, policy))) continue;
        out.push(
          makeFinding(RULE, policy, {
            file: c.path,
            message: `The runner now loads ${e.target} through ${e.key}, ${added !== undefined ? `a file this change adds (${added})` : 'a file no protected glob covers'}: it runs with the suite's globals in reach.`,
            evidence: `${c.path}: ${e.key} += ${JSON.stringify(e.target)}`,
            remediation: 'Review the module the runner will execute around every test, and protect it (protected.config in .tamperward.yml) so later edits to it are gated too.',
            defaultSeverity: 'warn',
          }),
        );
      }
    }
    return out;
  },
};
