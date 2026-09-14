// #447: the protected runner config delegates its selection to a file nothing
// reviews, narrows by test NAME, or loads new setup/runner/environment/reporter
// modules from unprotected files; and the tsconfig / eslint / biome families —
// protected by glob, read by no rule — lower their strictness silently.
//
// Part 1 lands in test-deletion (block, the suite-config reading): the opacity
// itself is the weakening when the config now points at a file the same change
// adds or that no protected glob covers. `testNamePattern` is a whole-run
// narrowing like pytest's `-m`. New setup entries pointing at unprotected files
// are `config-weakening` warnings.
//
// Part 2 is the new warn rule `config-weakening`: tsconfig strictness lowered,
// `exclude` grown, `skipLibCheck` added, `checkJs` removed; eslint rules turned
// off, `ignores` / `ignorePatterns` / `.eslintignore` grown; biome's linter
// switched off or its rules turned off.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { yaml } from '../src/lazy-deps';
import { defaultPolicy, isProtected } from '../src/policy';
import { allDetectors } from '../src/detectors';
import { testDeletion } from '../src/detectors/test-deletion';
import { configWeakening } from '../src/detectors/config-weakening';
import type { Change, Detector, DetectorContext, FileChange } from '../src/types';

const P = defaultPolicy();

function file(path: string, before: string | null, after: string | null): FileChange {
  return {
    kind: 'file',
    path,
    oldPath: null,
    op: before === null ? 'add' : after === null ? 'delete' : 'modify',
    before,
    after,
    binary: false,
    hunks: [],
  };
}
const run = (d: Detector, c: Change[], ctx?: DetectorContext) => d.run(c, P, 'staged', ctx);
const msgs = (d: Detector, c: Change[], ctx?: DetectorContext) => run(d, c, ctx).map((f) => `${f.message} ${f.evidence}`);
const td = (c: Change[], ctx?: DetectorContext) => msgs(testDeletion, c, ctx);
const cw = (c: Change[], ctx?: DetectorContext) => msgs(configWeakening, c, ctx);

const repo: DetectorContext = { trackedFiles: ['src/calc.ts', 'src/hard.ts', 'test/calc.test.ts', 'test/hard.test.ts', 'vitest.config.ts', 'jest.config.js', 'tsconfig.json', 'eslint.config.js'] };
const vitest = (body: string) => `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {\n${body}\n} });\n`;
const jest = (body: string) => `module.exports = {\n${body}\n};\n`;

// ── part 1a: the selection delegated to a file nothing reviews (block) ────────
describe('test-deletion — the runner config delegates its selection to an unreviewed file (#447)', () => {
  const realVitest = "export default { test: { include: ['nothing/**'] } };\n";

  it("`export { default } from './vitest.real'` with vitest.real.ts added in the same change", () => {
    const m = td([file('vitest.config.ts', vitest("  include: ['test/**/*.test.ts'],"), "export { default } from './vitest.real';\n"), file('vitest.real.ts', null, realVitest)], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/delegat/i);
    expect(m[0]).toMatch(/vitest\.real/);
    expect(m[0]).toMatch(/adds/);
  });

  it("`export * from './vitest.real'` is the same delegation", () => {
    const m = td([file('vitest.config.ts', vitest(''), "export * from './vitest.real';\n"), file('vitest.real.ts', null, realVitest)], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/vitest\.real/);
  });

  it("`module.exports = require('./jest.real')` to a file no protected glob covers", () => {
    const m = td([file('jest.config.js', jest(''), "module.exports = require('./jest.real');\n")], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/jest\.real/);
    expect(m[0]).toMatch(/no protected glob/i);
  });

  it("a `...require('./jest.base')` spread into the config", () => {
    const m = td([file('jest.config.js', jest("  testMatch: ['**/*.test.ts'],"), "module.exports = { ...require('./jest.base'), verbose: true };\n")], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/jest\.base/);
  });

  it('`mergeConfig(base, …)` over a base imported from an unprotected file', () => {
    const after = "import { defineConfig, mergeConfig } from 'vitest/config';\nimport base from './vitest.shared';\nexport default mergeConfig(base, defineConfig({ test: { globals: true } }));\n";
    const m = td([file('vitest.config.ts', vitest("  include: ['test/**/*.test.ts'],"), after)], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/vitest\.shared/);
  });

  it('a `...base` spread whose binding is a relative import', () => {
    const after = "import base from './vitest.shared';\nexport default { ...base, test: { ...base.test, globals: true } };\n";
    const m = td([file('vitest.config.ts', vitest(''), after)], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/vitest\.shared/);
  });

  it('`export default base` where base is a relative import', () => {
    const after = "import base from './vitest.real';\nexport default base;\n";
    const m = td([file('vitest.config.ts', vitest(''), after), file('vitest.real.ts', null, realVitest)], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/vitest\.real/);
  });

  it('a project entry with `extends` pointing at an unprotected path', () => {
    const after = vitest("  projects: [{ extends: './vitest.other.ts', test: { name: 'unit' } }],");
    const m = td([file('vitest.config.ts', vitest(''), after)], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/vitest\.other\.ts/);
  });

  it('jest `preset` pointing at a local file', () => {
    const m = td([file('jest.config.js', jest(''), jest("  preset: './jest-preset.js',"))], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/jest-preset\.js/);
  });

  it('jest `projects` naming a config file by path', () => {
    const m = td([file('jest.config.js', jest("  testMatch: ['**/*.test.ts'],"), jest("  projects: ['<rootDir>/jest.unit.js'],"))], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/jest\.unit\.js/);
  });

  it('the test script `--config` pointing at an unprotected file (the script half of the same move)', () => {
    const before = JSON.stringify({ scripts: { test: 'vitest run' } });
    const after = JSON.stringify({ scripts: { test: 'vitest run --config vitest.real.ts' } });
    const m = td([file('package.json', before, after)], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/--config vitest\.real\.ts added/);
  });

  // controls
  it('delegating to a file that is itself protected and not added by the change is clean', () => {
    expect(td([file('vitest.config.ts', vitest(''), "export { default } from './vitest.config.base';\n")], repo)).toEqual([]);
    expect(td([file('jest.config.js', jest(''), "module.exports = require('./jest.config.base');\n")], repo)).toEqual([]);
  });

  it('delegating to a protected file the same change ADDS is still unreviewed', () => {
    const m = td([file('vitest.config.ts', vitest(''), "export { default } from './vitest.config.base';\n"), file('vitest.config.base.ts', null, realVitest)], repo);
    // the delegation, plus the added protected config's own narrowing against the default
    expect(m.filter((x) => /delegates/.test(x)), m.join('\n')).toHaveLength(1);
    expect(m.find((x) => /delegates/.test(x))).toMatch(/adds \(vitest\.config\.base\.ts\)/);
    expect(m.some((x) => /no longer selects/.test(x))).toBe(true);
  });

  it('a delegation that was already there is not this change\'s doing', () => {
    const before = "import base from './vitest.shared';\nexport default { ...base, test: { ...base.test, globals: false } };\n";
    const after = "import base from './vitest.shared';\nexport default { ...base, test: { ...base.test, globals: true } };\n";
    expect(td([file('vitest.config.ts', before, after)], repo)).toEqual([]);
  });

  it('a relative import that is not the selection (aliases, plugins) is clean', () => {
    const after = "import { defineConfig } from 'vitest/config';\nimport { aliases } from './scripts/aliases';\nexport default defineConfig({ resolve: { alias: aliases }, test: { include: ['test/**/*.test.ts'] } });\n";
    expect(td([file('vitest.config.ts', vitest("  include: ['test/**/*.test.ts'],"), after)], repo)).toEqual([]);
  });

  it('a package preset / an npm base is not a file delegation', () => {
    expect(td([file('jest.config.js', jest(''), jest("  preset: 'ts-jest',"))], repo)).toEqual([]);
    expect(td([file('vitest.config.ts', vitest(''), "import { defineConfig } from 'vitest/config';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()], test: {} });\n")], repo)).toEqual([]);
  });
});

// ── part 1b: testNamePattern ──────────────────────────────────────────────────
describe('test-deletion — testNamePattern narrows the whole run (#447)', () => {
  it('jest `testNamePattern` added', () => {
    const m = td([file('jest.config.js', jest(''), jest("  testNamePattern: 'zzz',"))], repo);
    expect(m.length, m.join('\n')).toBeGreaterThan(0);
    expect(m[0]).toMatch(/testNamePattern/);
  });

  it('vitest `test.testNamePattern` added', () => {
    const m = td([file('vitest.config.ts', vitest(''), vitest("  testNamePattern: 'zzz',"))], repo);
    expect(m.length, m.join('\n')).toBeGreaterThan(0);
    expect(m[0]).toMatch(/testNamePattern/);
  });

  it('an unchanged testNamePattern beside another edit is clean', () => {
    expect(td([file('jest.config.js', jest("  testNamePattern: 'unit',"), jest("  testNamePattern: 'unit',\n  verbose: true,"))], repo)).toEqual([]);
  });
});

// ── part 1c: new setup / runner / environment / reporter modules (warn) ──────
describe('config-weakening — new runner modules loaded from unprotected files (#447)', () => {
  it('vitest `setupFilesAfterEach` pointing at a file the change adds', () => {
    const setup = "globalThis.expect = new Proxy(globalThis.expect, { apply: () => ({ toBe() {} }) });\n";
    const m = cw([file('vitest.config.ts', vitest(''), vitest("  setupFilesAfterEach: ['./test-setup.js'],")), file('test-setup.js', null, setup)], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/setupFilesAfterEach/);
    expect(m[0]).toMatch(/test-setup\.js/);
  });

  it.each([
    ['setupFiles', "  setupFiles: ['<rootDir>/test-setup.js'],"],
    ['setupFilesAfterEnv', "  setupFilesAfterEnv: ['./test-setup.js'],"],
    ['globalSetup', "  globalSetup: '<rootDir>/global.js',"],
    ['runner', "  runner: './runner.js',"],
    ['testEnvironment', "  testEnvironment: './env.js',"],
    ['reporters', "  reporters: ['default', './reporter.js'],"],
    ['reporters (tuple)', "  reporters: ['default', ['./reporter.js', { out: 'x' }]],"],
  ])('jest %s pointing at an unprotected file', (_n, body) => {
    const m = cw([file('jest.config.js', jest(''), jest(body))], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/no protected glob/i);
  });

  it.each([
    ['setupFiles', "  setupFiles: ['test/setup.ts'],"],
    ['globalSetup', "  globalSetup: './global-setup.ts',"],
    ['environment', "  environment: './env.ts',"],
    ['runner', "  runner: './runner.ts',"],
    ['reporters', "  reporters: ['default', './reporter.ts'],"],
  ])('vitest test.%s pointing at an unprotected file', (_n, body) => {
    const m = cw([file('vitest.config.ts', vitest(''), vitest(body))], repo);
    expect(m, m.join('\n')).toHaveLength(1);
  });

  it('every such finding is a warning that needs no sign-off', () => {
    const f = run(configWeakening, [file('jest.config.js', jest(''), jest("  globalSetup: './global.js',"))], repo);
    expect(f).toHaveLength(1);
    expect(f[0].rule).toBe('config-weakening');
    expect(f[0].severity).toBe('warn');
    expect(f[0].signoff.required).toBe(false);
  });

  // controls
  it.each([
    ['a named environment', "  testEnvironment: 'jsdom',"],
    ['a package setup module', "  setupFiles: ['dotenv/config'],"],
    ['a package runner', "  runner: 'jest-circus/runner',"],
    ['named reporters', "  reporters: ['default', 'jest-junit'],"],
    ['a protected setup file', "  setupFiles: ['./jest.config.setup.js'],"],
  ])('%s is clean', (_n, body) => {
    expect(cw([file('jest.config.js', jest(''), jest(body))], repo)).toEqual([]);
  });

  it('an entry that was already there is clean', () => {
    expect(cw([file('jest.config.js', jest("  globalSetup: './global.js',"), jest("  globalSetup: './global.js',\n  verbose: true,"))], repo)).toEqual([]);
  });
});

// ── part 2: tsconfig ──────────────────────────────────────────────────────────
const tsconfig = (opts: Record<string, unknown>, rest: Record<string, unknown> = {}) => JSON.stringify({ compilerOptions: opts, ...rest }, null, 2);

describe('config-weakening — tsconfig strictness (#447)', () => {
  it('`strict: true → false` is one finding naming strict', () => {
    const m = cw([file('tsconfig.json', tsconfig({ strict: true }), tsconfig({ strict: false }))], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/\bstrict\b/);
  });

  it('`strict: true` removed', () => {
    const m = cw([file('tsconfig.json', tsconfig({ strict: true, target: 'es2022' }), tsconfig({ target: 'es2022' }))], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/\bstrict\b/);
  });

  it('`noImplicitAny: true → false`', () => {
    const m = cw([file('tsconfig.json', tsconfig({ noImplicitAny: true }), tsconfig({ noImplicitAny: false }))], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/noImplicitAny/);
  });

  it('`noImplicitAny: false` added under `strict: true` switches the implied flag off', () => {
    const m = cw([file('tsconfig.json', tsconfig({ strict: true }), tsconfig({ strict: true, noImplicitAny: false }))], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/noImplicitAny/);
  });

  it.each(['strictNullChecks', 'noUnusedLocals', 'noUnusedParameters', 'noImplicitReturns', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes', 'noImplicitOverride'])('%s true → removed', (flag) => {
    const m = cw([file('tsconfig.json', tsconfig({ [flag]: true }), tsconfig({}))], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toContain(flag);
  });

  it('`skipLibCheck: true` added', () => {
    const m = cw([file('tsconfig.json', tsconfig({ strict: true }), tsconfig({ strict: true, skipLibCheck: true }))], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/skipLibCheck/);
  });

  it('`checkJs: true` removed', () => {
    const m = cw([file('tsconfig.json', tsconfig({ allowJs: true, checkJs: true }), tsconfig({ allowJs: true }))], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/checkJs/);
  });

  it('`exclude` grown with a source path', () => {
    const m = cw([file('tsconfig.json', tsconfig({ strict: true }, { exclude: ['node_modules'] }), tsconfig({ strict: true }, { exclude: ['node_modules', 'src/hard.ts'] }))], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/exclude/);
    expect(m[0]).toMatch(/src\/hard\.ts/);
  });

  it('`extends` dropped: the strictness it carried is gone with it', () => {
    const m = cw([file('tsconfig.json', tsconfig({}, { extends: './tsconfig.base.json' }), tsconfig({}))], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/extends/);
  });

  it('a tsconfig with comments and trailing commas is still read', () => {
    const before = '{\n  // strict\n  "compilerOptions": { "strict": true, },\n}\n';
    const after = '{\n  // relaxed\n  "compilerOptions": { "strict": false, },\n}\n';
    expect(cw([file('tsconfig.json', before, after)], repo)).toHaveLength(1);
  });

  // controls
  it('`strict: false → true` is clean', () => {
    expect(cw([file('tsconfig.json', tsconfig({ strict: false }), tsconfig({ strict: true }))], repo)).toEqual([]);
  });

  it('`noImplicitAny: true` removed while `strict: true` still implies it is clean', () => {
    expect(cw([file('tsconfig.json', tsconfig({ strict: true, noImplicitAny: true }), tsconfig({ strict: true }))], repo)).toEqual([]);
  });

  it('`exclude` grown with build output is clean', () => {
    expect(cw([file('tsconfig.json', tsconfig({ strict: true }, { exclude: ['node_modules'] }), tsconfig({ strict: true }, { exclude: ['node_modules', 'dist', 'coverage/**'] }))], repo)).toEqual([]);
  });

  it('a new strictness flag added, a target bumped, paths added: clean', () => {
    expect(cw([file('tsconfig.json', tsconfig({ strict: true, target: 'es2020' }), tsconfig({ strict: true, target: 'es2022', noUncheckedIndexedAccess: true, paths: { '@/*': ['src/*'] } }))], repo)).toEqual([]);
  });

  it('a new tsconfig with strict on is clean; unparseable JSON is silent', () => {
    expect(cw([file('tsconfig.json', null, tsconfig({ strict: true }))], repo)).toEqual([]);
    expect(cw([file('tsconfig.json', tsconfig({ strict: true }), '{ not json')], repo)).toEqual([]);
  });
});

// ── part 2: eslint / biome ────────────────────────────────────────────────────
const flat = (body: string) => `export default [\n  {\n${body}\n  },\n];\n`;

describe('config-weakening — eslint and biome (#447)', () => {
  it("flat config: a rule set to 'off'", () => {
    const m = cw([file('eslint.config.js', flat("    rules: { 'no-unused-vars': 'error' },"), flat("    rules: { 'no-unused-vars': 'off' },"))], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/no-unused-vars/);
  });

  it('flat config: a rule set to 0, and an array form', () => {
    expect(cw([file('eslint.config.js', flat("    rules: { eqeqeq: 'error' },"), flat("    rules: { eqeqeq: 0 },"))], repo)).toHaveLength(1);
    expect(cw([file('eslint.config.js', flat("    rules: { eqeqeq: ['error', 'always'] },"), flat("    rules: { eqeqeq: ['off'] },"))], repo)).toHaveLength(1);
  });

  it('flat config: a rule turned off in a NEW override block', () => {
    const after = `export default [\n  { rules: { eqeqeq: 'error' } },\n  { files: ['src/hard.ts'], rules: { eqeqeq: 'off' } },\n];\n`;
    expect(cw([file('eslint.config.js', flat("    rules: { eqeqeq: 'error' },"), after)], repo)).toHaveLength(1);
  });

  it('flat config: `ignores` grown with a source path', () => {
    const m = cw([file('eslint.config.js', flat("    ignores: ['dist/**'],"), flat("    ignores: ['dist/**', 'src/hard.ts'],"))], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/ignores/);
    expect(m[0]).toMatch(/src\/hard\.ts/);
  });

  it('flat config: `globalIgnores([...])` grown', () => {
    const before = "import { defineConfig, globalIgnores } from 'eslint/config';\nexport default defineConfig([globalIgnores(['dist/**'])]);\n";
    const after = "import { defineConfig, globalIgnores } from 'eslint/config';\nexport default defineConfig([globalIgnores(['dist/**', 'src/**'])]);\n";
    expect(cw([file('eslint.config.js', before, after)], repo)).toHaveLength(1);
  });

  it('legacy .eslintrc.json: a rule turned off', () => {
    const m = cw([file('.eslintrc.json', '{ "rules": { "eqeqeq": "error" } }', '{ "rules": { "eqeqeq": "off" } }')], repo);
    expect(m, m.join('\n')).toHaveLength(1);
  });

  it('legacy .eslintrc.yml: ignorePatterns grown', () => {
    const m = cw([file('.eslintrc.yml', 'rules:\n  eqeqeq: error\n', 'rules:\n  eqeqeq: error\nignorePatterns:\n  - src/hard.ts\n')], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/ignorePatterns/);
  });

  it('.eslintignore grown with a source path (and the file is protected by default)', () => {
    expect(isProtected('.eslintignore', P, 'config')).toBe(true);
    expect(isProtected('biome.json', P, 'config')).toBe(true);
    const m = cw([file('.eslintignore', 'dist/\n', 'dist/\nsrc/hard.ts\n')], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/src\/hard\.ts/);
  });

  it('biome.json: the linter switched off, a rule turned off', () => {
    const on = JSON.stringify({ linter: { enabled: true, rules: { recommended: true, suspicious: { noExplicitAny: 'error' } } } });
    expect(cw([file('biome.json', on, JSON.stringify({ linter: { enabled: false } }))], repo)).toHaveLength(1);
    const off = JSON.stringify({ linter: { enabled: true, rules: { recommended: true, suspicious: { noExplicitAny: 'off' } } } });
    const m = cw([file('biome.json', on, off)], repo);
    expect(m, m.join('\n')).toHaveLength(1);
    expect(m[0]).toMatch(/noExplicitAny/);
  });

  // controls
  it("adding a rule at 'error' or 'warn' is clean; raising a rule is clean", () => {
    expect(cw([file('eslint.config.js', flat("    rules: {},"), flat("    rules: { eqeqeq: 'error', curly: 'warn' },"))], repo)).toEqual([]);
    expect(cw([file('eslint.config.js', flat("    rules: { eqeqeq: 'off' },"), flat("    rules: { eqeqeq: 'error' },"))], repo)).toEqual([]);
  });

  it('a base rule turned off in favour of its plugin variant is a replacement', () => {
    const after = flat("    rules: { 'no-unused-vars': 'off', '@typescript-eslint/no-unused-vars': 'error' },");
    expect(cw([file('eslint.config.js', flat("    rules: { 'no-unused-vars': 'error' },"), after)], repo)).toEqual([]);
  });

  it('a rule already off stays off: clean', () => {
    expect(cw([file('eslint.config.js', flat("    rules: { eqeqeq: 'off' },"), flat("    rules: { eqeqeq: 'off', curly: 'error' },"))], repo)).toEqual([]);
  });

  it('`ignores` grown with build output, or with a path no tracked source file matches, is clean', () => {
    expect(cw([file('eslint.config.js', flat("    ignores: [],"), flat("    ignores: ['dist/**', 'coverage', '**/*.min.js', 'node_modules'],"))], repo)).toEqual([]);
    expect(cw([file('eslint.config.js', flat("    ignores: [],"), flat("    ignores: ['docs/**'],"))], repo)).toEqual([]);
  });

  it('a migration from .eslintrc to flat config carries its off rules and ignores over: clean', () => {
    const legacy = '{ "rules": { "eqeqeq": "off" }, "ignorePatterns": ["src/legacy/**"] }';
    const m = cw([file('.eslintrc.json', legacy, null), file('eslint.config.js', null, flat("    ignores: ['src/legacy/**'],\n    rules: { eqeqeq: 'off' },"))], repo);
    expect(m, m.join('\n')).toEqual([]);
  });
});

// ── registration ──────────────────────────────────────────────────────────────
describe('config-weakening — registered as a warn rule (#447)', () => {
  it('ships in allDetectors, the baseline policy and the repository policy', () => {
    expect(allDetectors.some((d) => d.id === 'config-weakening')).toBe(true);
    expect(configWeakening.id).toBe('config-weakening');
    expect(configWeakening.certainty).toBe('mechanical');
    expect(P.rules['config-weakening']?.severity).toBe('warn');
    const own: unknown = yaml.parse(readFileSync(join(__dirname, '..', '.tamperward.yml'), 'utf8'));
    const rules = own !== null && typeof own === 'object' && 'rules' in own ? own.rules : undefined;
    expect(rules !== null && typeof rules === 'object' && 'config-weakening' in rules).toBe(true);
  });
});
