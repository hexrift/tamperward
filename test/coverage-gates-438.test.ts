// #438: the rest of the coverage denominator-narrowing surface. jest `collectCoverage`,
// vitest `coverage.all`, nyc `--check-coverage` dropped from a script, `--cov-fail-under`
// lowered in a script / `pytest.ini` `addopts` / `pyproject.toml` / a workflow line,
// `setup.cfg` and `tox.ini` `[coverage:report] fail_under`, and an unanchored
// `.md` written as a jest REGEX (which exempts `src/cmd.ts` and `src/readme-loader.ts`)
// were each zero findings. Every positive here was silent before the fix; every
// negative is the honest spelling of the same edit and must stay clean.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coverageLowering } from '../src/detectors/coverage-lowering';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy } from '../src/policy';
import type { FileChange, FileOp, Finding } from '../src/types';

const P = defaultPolicy();

/** A file change with REAL hunks (git diff --no-index), so the line-scanning checks see it. */
function diffed(path: string, before: string | null, after: string | null, op?: FileOp): FileChange {
  const dir = mkdtempSync(join(tmpdir(), 'tw-cov438-'));
  writeFileSync(join(dir, 'a'), before ?? '');
  writeFileSync(join(dir, 'b'), after ?? '');
  let raw = '';
  try {
    raw = execFileSync('git', ['diff', '--no-index', '--no-color', join(dir, 'a'), join(dir, 'b')], { encoding: 'utf8' });
  } catch (e) {
    raw = String((e as { stdout?: Buffer }).stdout ?? '');
  }
  rmSync(dir, { recursive: true, force: true });
  const parsed = parseDiff(raw)[0];
  return {
    kind: 'file',
    path,
    oldPath: null,
    op: op ?? (before == null ? 'add' : after == null ? 'delete' : 'modify'),
    before,
    after,
    binary: false,
    hunks: parsed?.kind === 'file' ? parsed.hunks : [],
  };
}

const run = (path: string, before: string, after: string): Finding[] => coverageLowering.run([diffed(path, before, after)], P);
const evidence = (fs: Finding[]) => fs.map((f) => `${f.message} :: ${f.evidence}`).join('\n');

const jest = (body: string) => `module.exports = {\n${body}\n};\n`;
const vitest = (body: string) => `import { defineConfig } from 'vitest/config';\nexport default defineConfig({\n  test: {\n    coverage: {\n${body}\n    },\n  },\n});\n`;
const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts }, null, 2) + '\n';

describe('coverage-lowering — the run switches (#438)', () => {
  it('fires on jest collectCoverage: true → false', () => {
    const f = run('jest.config.js', jest('  collectCoverage: true,\n  coverageThreshold: { global: { lines: 80 } },'), jest('  collectCoverage: false,\n  coverageThreshold: { global: { lines: 80 } },'));
    expect(evidence(f)).toMatch(/collectCoverage/);
    expect(f.every((x) => x.severity === 'block')).toBe(true);
  });

  it('fires on jest collectCoverage: true → false under package.json "jest"', () => {
    const before = JSON.stringify({ name: 'x', jest: { collectCoverage: true, coverageThreshold: { global: { lines: 80 } } } }, null, 2);
    const after = JSON.stringify({ name: 'x', jest: { collectCoverage: false, coverageThreshold: { global: { lines: 80 } } } }, null, 2);
    expect(evidence(run('package.json', before, after))).toMatch(/collectCoverage/);
  });

  it('fires on vitest coverage.all: true → false', () => {
    const f = run('vitest.config.ts', vitest('      all: true,\n      thresholds: { lines: 80 },'), vitest('      all: false,\n      thresholds: { lines: 80 },'));
    expect(evidence(f)).toMatch(/coverage\.all/);
  });

  it('stays clean when the switches go the other way, or are unchanged', () => {
    expect(run('jest.config.js', jest('  collectCoverage: false,'), jest('  collectCoverage: true,'))).toEqual([]);
    expect(run('vitest.config.ts', vitest('      all: false,'), vitest('      all: true,'))).toEqual([]);
    expect(run('jest.config.js', jest('  collectCoverage: true,\n  verbose: false,'), jest('  collectCoverage: true,\n  verbose: true,'))).toEqual([]);
  });

  it('does not read an `all` key outside the coverage block as the switch', () => {
    const before = vitest('      thresholds: { lines: 80 },') + 'export const all = true;\n';
    const after = vitest('      thresholds: { lines: 80 },') + 'export const all = false;\n';
    expect(run('vitest.config.ts', before, after)).toEqual([]);
  });
});

describe('coverage-lowering — script flags (#438)', () => {
  it('fires when nyc --check-coverage is removed from a script', () => {
    const f = run('package.json', pkg({ test: 'nyc --check-coverage --lines 90 mocha' }), pkg({ test: 'nyc --lines 90 mocha' }));
    expect(evidence(f)).toMatch(/--check-coverage/);
    expect(f.every((x) => x.rule === 'coverage-lowering' && x.severity === 'block')).toBe(true);
  });

  it('stays clean when --check-coverage moves to another script in the same edit', () => {
    const before = pkg({ test: 'nyc --check-coverage mocha' });
    const after = pkg({ test: 'npm run test:cov', 'test:cov': 'nyc --check-coverage mocha' });
    expect(run('package.json', before, after).filter((f) => /check-coverage/.test(f.evidence))).toEqual([]);
  });

  it('fires when --cov-fail-under is lowered in a script', () => {
    const f = run('package.json', pkg({ test: 'pytest --cov=src --cov-fail-under=90' }), pkg({ test: 'pytest --cov=src --cov-fail-under=50' }));
    expect(evidence(f)).toMatch(/--cov-fail-under.*90.*50/);
  });

  it('fires when --cov-fail-under is removed from a script', () => {
    const f = run('package.json', pkg({ test: 'pytest --cov=src --cov-fail-under=90' }), pkg({ test: 'pytest --cov=src' }));
    expect(evidence(f)).toMatch(/--cov-fail-under.*removed/);
  });

  it('stays clean when --cov-fail-under is raised, or reformatted at the same number', () => {
    expect(run('package.json', pkg({ test: 'pytest --cov-fail-under=80' }), pkg({ test: 'pytest --cov-fail-under=95' }))).toEqual([]);
    expect(run('package.json', pkg({ test: 'pytest --cov-fail-under=80' }), pkg({ test: 'pytest --cov=src --cov-fail-under 80' }))).toEqual([]);
  });
});

describe('coverage-lowering — the pytest / coverage.py ini files (#438)', () => {
  it('fires when pytest.ini addopts lowers --cov-fail-under', () => {
    const f = run('pytest.ini', '[pytest]\naddopts = --cov=src --cov-fail-under=90\n', '[pytest]\naddopts = --cov=src --cov-fail-under=40\n');
    expect(evidence(f)).toMatch(/--cov-fail-under.*90.*40/);
  });

  it('fires when pytest.ini addopts drops --cov-fail-under', () => {
    const f = run('pytest.ini', '[pytest]\naddopts = --cov=src --cov-fail-under=90\n', '[pytest]\naddopts = --cov=src\n');
    expect(evidence(f)).toMatch(/--cov-fail-under.*removed/);
  });

  it('fires when pyproject.toml [tool.pytest.ini_options] addopts lowers --cov-fail-under', () => {
    const f = run('pyproject.toml', '[tool.pytest.ini_options]\naddopts = "--cov=src --cov-fail-under=90"\n', '[tool.pytest.ini_options]\naddopts = "--cov=src --cov-fail-under=10"\n');
    expect(evidence(f)).toMatch(/--cov-fail-under.*90.*10/);
  });

  it('fires when setup.cfg [coverage:report] fail_under is lowered', () => {
    const f = run('setup.cfg', '[metadata]\nname = x\n\n[coverage:report]\nfail_under = 90\n', '[metadata]\nname = x\n\n[coverage:report]\nfail_under = 60\n');
    expect(evidence(f)).toMatch(/fail_under lowered 90 → 60/);
  });

  it('fires when tox.ini [coverage:report] fail_under is lowered or removed', () => {
    const before = '[tox]\nenvlist = py3\n\n[coverage:report]\nfail_under = 85\n';
    expect(evidence(run('tox.ini', before, before.replace('85', '20')))).toMatch(/fail_under lowered 85 → 20/);
    expect(evidence(run('tox.ini', before, '[tox]\nenvlist = py3\n'))).toMatch(/fail_under removed/);
  });

  it('fires when a tox.ini command lowers --cov-fail-under', () => {
    const before = '[testenv]\ncommands = pytest --cov --cov-fail-under=90\n';
    expect(evidence(run('tox.ini', before, before.replace('=90', '=30')))).toMatch(/--cov-fail-under.*90.*30/);
  });

  it('stays clean on an unrelated setup.cfg / tox.ini edit, and on a raised floor', () => {
    expect(run('setup.cfg', '[metadata]\nname = x\nversion = 1.0\n\n[coverage:report]\nfail_under = 90\n', '[metadata]\nname = x\nversion = 1.1\n\n[coverage:report]\nfail_under = 90\n')).toEqual([]);
    expect(run('tox.ini', '[coverage:report]\nfail_under = 80\n', '[coverage:report]\nfail_under = 95\n')).toEqual([]);
    expect(run('pytest.ini', '[pytest]\naddopts = --cov-fail-under=80\n', '[pytest]\naddopts = -q --cov-fail-under=90\n')).toEqual([]);
  });

  it('reads a fail_under gate moved from .coveragerc to setup.cfg as a move, not a deletion', () => {
    const gone = diffed('.coveragerc', '[report]\nfail_under = 90\n', null, 'delete');
    const here = diffed('setup.cfg', '[metadata]\nname = x\n', '[metadata]\nname = x\n\n[coverage:report]\nfail_under = 90\n');
    expect(coverageLowering.run([gone, here], P)).toEqual([]);
  });
});

describe('coverage-lowering — workflow lines (#438)', () => {
  it('fires when a workflow step lowers --cov-fail-under', () => {
    const before = 'jobs:\n  test:\n    steps:\n      - run: pytest --cov=src --cov-fail-under=90\n';
    const f = run('.github/workflows/ci.yml', before, before.replace('=90', '=10'));
    expect(f.some((x) => x.rule === 'coverage-lowering' && /--cov-fail-under lowered 90 → 10/.test(x.message))).toBe(true);
  });

  it('fires when a workflow step drops nyc --check-coverage', () => {
    const before = 'jobs:\n  test:\n    steps:\n      - run: npx nyc --check-coverage npm test\n';
    const f = run('.github/workflows/ci.yml', before, before.replace('--check-coverage ', ''));
    expect(f.some((x) => x.rule === 'coverage-lowering' && /--check-coverage/.test(x.evidence))).toBe(true);
  });

  it('stays clean on a workflow edit that keeps the floor', () => {
    const before = 'jobs:\n  test:\n    steps:\n      - run: pytest --cov=src --cov-fail-under=90\n';
    expect(run('.github/workflows/ci.yml', before, before.replace('pytest', 'python -m pytest'))).toEqual([]);
    expect(run('.github/workflows/ci.yml', before, before.replace('=90', '=95'))).toEqual([]);
  });
});

describe('coverage-lowering — the benign exemption literals are anchored (#438)', () => {
  const ignore = (list: string) => jest(`  coveragePathIgnorePatterns: [${list}],`);

  it("fires on '.md' as a jest regex: it matches src/cmd.ts and src/readme-loader.ts", () => {
    const f = run('jest.config.js', ignore("'/node_modules/'"), ignore("'/node_modules/', '.md'"));
    expect(evidence(f)).toMatch(/now exempts ".md"/);
  });

  it("fires on '.d.ts' as a jest regex: it matches src/add.ts", () => {
    const f = run('jest.config.js', ignore("'/node_modules/'"), ignore("'/node_modules/', '.d.ts'"));
    expect(evidence(f)).toMatch(/now exempts ".d.ts"/);
  });

  it('stays clean on the anchored regex spellings \\.md$ and \\.d\\.ts$', () => {
    expect(run('jest.config.js', ignore("'/node_modules/'"), ignore("'/node_modules/', '\\\\.md$'"))).toEqual([]);
    expect(run('jest.config.js', ignore("'/node_modules/'"), ignore("'/node_modules/', '\\\\.d\\\\.ts$'"))).toEqual([]);
    expect(run('jest.config.js', ignore("'/node_modules/'"), ignore("'/node_modules/', '\\\\.json$', '\\\\.css$'"))).toEqual([]);
  });

  it('stays clean on the glob spellings, where a dot is literal', () => {
    expect(run('vitest.config.ts', vitest("      exclude: ['**/*.test.ts'],"), vitest("      exclude: ['**/*.test.ts', '**/*.md', '**/*.d.ts'],"))).toEqual([]);
    expect(run('.coveragerc', '[run]\nomit = tests/*\n', '[run]\nomit = tests/*, *.md\n')).toEqual([]);
    expect(run('jest.config.js', jest("  collectCoverageFrom: ['src/**'],"), jest("  collectCoverageFrom: ['src/**', '!**/*.md', '!**/*.d.ts'],"))).toEqual([]);
  });

  it('still reads the directory exemptions as benign in either spelling', () => {
    expect(run('jest.config.js', ignore("'/node_modules/'"), ignore("'/node_modules/', '/dist/', '<rootDir>/test/'"))).toEqual([]);
  });
});
