// #438 coverage-exclusion — the per-function form of the coverage-lowering class.
//
// `/* istanbul ignore next */`, `/* c8 ignore start */`, `/* v8 ignore next */`,
// `/* node:coverage ignore next */`, `# pragma: no cover`, `#[coverage(off)]` and a
// `//go:build` constraint added to an existing Go source file each take code out of
// the coverage denominator without touching a config, and no rule read them. The rule
// ships WARN (SPEC §7 graduation discipline): it is measured against a labeled corpus
// (harness/fp-study/coverage-exclusion-corpus.json) before any block decision.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { coverageExclusion } from '../src/detectors/coverage-exclusion';
import { allDetectors } from '../src/detectors';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy } from '../src/policy';
import type { FileChange, FileOp, Finding } from '../src/types';

const P = defaultPolicy();
const RULE = 'coverage-exclusion';

function diffed(path: string, before: string | null, after: string | null, op?: FileOp): FileChange {
  const dir = mkdtempSync(join(tmpdir(), 'tw-covx-'));
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

const run = (path: string, before: string | null, after: string): Finding[] => coverageExclusion.run([diffed(path, before, after)], P);

const TS = 'export function parse(raw: string): number {\n  const n = Number(raw);\n  if (Number.isNaN(n)) throw new Error(raw);\n  return n;\n}\n';
const PY = 'def parse(raw):\n    n = int(raw)\n    if n < 0:\n        raise ValueError(raw)\n    return n\n';
const RS = 'pub fn parse(raw: &str) -> i64 {\n    raw.parse().unwrap()\n}\n';
const GO = 'package parse\n\nimport "strconv"\n\nfunc Parse(raw string) (int, error) {\n\treturn strconv.Atoi(raw)\n}\n';

describe('coverage-exclusion — registration and identity (#438)', () => {
  it('is registered, is a file-surface rule, and ships warn by default', () => {
    expect(allDetectors.some((d) => d.id === RULE)).toBe(true);
    expect(coverageExclusion.surface).toEqual(['file']);
    expect(P.rules[RULE]?.severity).toBe('warn');
  });

  it('is declared warn in the repository policy file', () => {
    const yml = readFileSync(join(__dirname, '..', '.tamperward.yml'), 'utf8');
    expect(yml).toMatch(/^\s*coverage-exclusion:\s*\{\s*severity:\s*warn\s*\}/m);
  });

  it('every fire is a warn carrying the file, the line, the evidence and a remediation', () => {
    const [f] = run('src/parse.ts', TS, TS.replace('  if (Number', '  /* istanbul ignore next */\n  if (Number'));
    expect(f).toBeDefined();
    expect(f.rule).toBe(RULE);
    expect(f.severity).toBe('warn');
    expect(f.file).toBe('src/parse.ts');
    expect(f.line).toBe(3);
    expect(f.evidence).toBe('/* istanbul ignore next */');
    expect(f.message).toMatch(/istanbul ignore/);
    expect(f.remediation).toMatch(/test/i);
    expect(f.signoff.required).toBe(false);
  });
});

describe('coverage-exclusion — the fixtures in the issue', () => {
  it.each([
    ['/* istanbul ignore next */', /istanbul/],
    ['/* istanbul ignore if */', /istanbul/],
    ['/* istanbul ignore file */', /istanbul/],
    ['/* c8 ignore next */', /c8/],
    ['/* c8 ignore start */', /c8/],
    ['/* v8 ignore next */', /v8/],
    ['/* v8 ignore next 3 */', /v8/],
    ['/* node:coverage ignore next */', /node:coverage/],
    ['/* node:coverage disable */', /node:coverage/],
  ])('fires on %s added to a JS/TS source file', (marker, why) => {
    const f = run('src/parse.ts', TS, TS.replace('  if (Number', `  ${marker}\n  if (Number`));
    expect(f).toHaveLength(1);
    expect(f[0].message).toMatch(why);
    expect(run('lib/parse.js', TS, TS.replace('  if (Number', `  ${marker}\n  if (Number`))).toHaveLength(1);
  });

  it('fires on an exclusion comment trailing a statement', () => {
    expect(run('src/parse.ts', TS, TS.replace('throw new Error(raw);', 'throw new Error(raw); /* istanbul ignore next */'))).toHaveLength(1);
  });

  it('fires on # pragma: no cover added to a Python module, in its spellings', () => {
    expect(run('pkg/parse.py', PY, PY.replace('    if n < 0:', '    if n < 0:  # pragma: no cover'))).toHaveLength(1);
    expect(run('pkg/parse.py', PY, PY.replace('    if n < 0:', '    if n < 0:  #pragma:no cover'))).toHaveLength(1);
    expect(run('pkg/parse.py', PY, PY.replace('    if n < 0:', '    if n < 0:  # PRAGMA: NO COVER'))).toHaveLength(1);
  });

  it('fires on #[coverage(off)] and its cfg_attr spelling added to a Rust source file', () => {
    expect(run('src/parse.rs', RS, RS.replace('pub fn', '#[coverage(off)]\npub fn'))).toHaveLength(1);
    expect(run('src/parse.rs', RS, RS.replace('pub fn', '#[cfg_attr(coverage_nightly, coverage(off))]\npub fn'))).toHaveLength(1);
  });

  it('fires on a //go:build constraint added to an existing Go source file', () => {
    expect(run('internal/parse/parse.go', GO, '//go:build ignore\n\n' + GO)).toHaveLength(1);
    expect(run('internal/parse/parse.go', GO, '//go:build !ci\n\n' + GO)).toHaveLength(1);
    expect(run('internal/parse/parse.go', GO, '// +build ignore\n\n' + GO)).toHaveLength(1);
  });

  it('fires on a whole new source file that opens with a file-wide exclusion', () => {
    expect(run('src/parse.ts', null, '/* istanbul ignore file */\n' + TS)).toHaveLength(1);
    expect(run('src/parse.ts', null, '/* c8 ignore start */\n' + TS + '/* c8 ignore stop */\n')).toHaveLength(1);
  });

  it('reports once per added marker line', () => {
    const after = TS.replace('  const n', '  /* istanbul ignore next */\n  const n').replace('  if (Number', '  /* istanbul ignore next */\n  if (Number');
    expect(run('src/parse.ts', TS, after)).toHaveLength(2);
  });
});

describe('coverage-exclusion — controls', () => {
  it('a marker inside a string literal is text, not a directive', () => {
    expect(run('src/codemod.ts', TS, TS + "export const HEADER = '/* istanbul ignore next */';\n")).toEqual([]);
    expect(run('src/codemod.ts', TS, TS + 'export const HEADER = "/* c8 ignore start */";\n')).toEqual([]);
    expect(run('src/codemod.ts', TS, TS + 'export const HEADER = `/* v8 ignore next */`;\n')).toEqual([]);
    expect(run('pkg/lint.py', PY, PY + 'BANNED = "# pragma: no cover"\n')).toEqual([]);
    expect(run('pkg/lint.py', PY, PY + '"""Never write # pragma: no cover in this package."""\n')).toEqual([]);
  });

  it('a marker quoted in a line comment is prose, not a directive', () => {
    expect(run('src/parse.ts', TS, TS + '// never add /* istanbul ignore next */ here\n')).toEqual([]);
    expect(run('pkg/parse.py', PY, PY + '# do not sprinkle # pragma: no cover on this\n')).toEqual([]);
    expect(run('src/parse.rs', RS, RS + '// nightly-only: #[coverage(off)]\n')).toEqual([]);
  });

  it('a marker added to a protected test file is not a finding', () => {
    expect(run('src/parse.test.ts', TS, '/* istanbul ignore file */\n' + TS)).toEqual([]);
    expect(run('src/__tests__/parse.ts', TS, '/* c8 ignore start */\n' + TS)).toEqual([]);
    expect(run('tests/test_parse.py', PY, PY.replace('    if n < 0:', '    if n < 0:  # pragma: no cover'))).toEqual([]);
    expect(run('internal/parse/parse_test.go', GO, '//go:build integration\n\n' + GO)).toEqual([]);
  });

  it('a marker in a file of unknown language, or on a generated / vendored / declaration path, is not a finding', () => {
    expect(run('docs/coverage.md', '', '/* istanbul ignore next */\n')).toEqual([]);
    expect(run('jest.config.js', 'module.exports = {};\n', '/* istanbul ignore file */\nmodule.exports = {};\n')).toEqual([]);
    expect(run('dist/parse.js', TS, '/* istanbul ignore file */\n' + TS)).toEqual([]);
    expect(run('vendor/parse.js', TS, '/* istanbul ignore file */\n' + TS)).toEqual([]);
    expect(run('src/types.d.ts', 'export {};\n', '/* istanbul ignore file */\nexport {};\n')).toEqual([]);
    expect(run('src/schema.generated.ts', TS, '/* istanbul ignore file */\n' + TS)).toEqual([]);
    expect(run('examples/demo.ts', TS, '/* istanbul ignore file */\n' + TS)).toEqual([]);
  });

  it('a marker that moved within the file (removed and re-added verbatim) is not an addition', () => {
    const before = TS.replace('  if (Number', '  /* istanbul ignore next */\n  if (Number');
    const after = TS.replace('  const n', '  /* istanbul ignore next */\n  const n');
    expect(run('src/parse.ts', before, after)).toEqual([]);
  });

  it('a //go:build constraint on a NEW Go file is a platform split, not an exclusion', () => {
    expect(run('internal/parse/parse_linux.go', null, '//go:build linux\n\n' + GO)).toEqual([]);
  });

  it('a //go:build line edited on a file that already carried one is not an addition', () => {
    const before = '//go:build linux\n\n' + GO;
    expect(run('internal/parse/parse_linux.go', before, before.replace('linux', 'linux || darwin'))).toEqual([]);
  });

  it('a JS marker in a Python file, or a Python pragma in a JS file, is not a directive there', () => {
    expect(run('pkg/parse.py', PY, PY + '# /* istanbul ignore next */\n')).toEqual([]);
    expect(run('src/parse.ts', TS, TS + '// # pragma: no cover\n')).toEqual([]);
  });

  it('the diff-only fallback (no before/after content) still reads an added marker line', () => {
    const d = parseDiff(
      'diff --git a/src/parse.ts b/src/parse.ts\nindex 1..2 100644\n--- a/src/parse.ts\n+++ b/src/parse.ts\n@@ -2,1 +2,2 @@\n+  /* istanbul ignore next */\n   if (Number.isNaN(n)) throw new Error(raw);\n',
    );
    expect(coverageExclusion.run(d, P)).toHaveLength(1);
  });
});
