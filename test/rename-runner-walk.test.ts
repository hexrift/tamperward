// #430: a spec renamed INTO a directory the runner never walks is still a
// deletion. The rename-out branch fires only when the new path leaves the tests
// glob; `cypress/a.test.ts`, `tests/integration/mod.rs`, `pkg/testdata/a_test.go`
// and `tests/.archive/test_a.py` all stay inside it while vitest / cargo / go test /
// pytest never open them. And `policy.ignore` tested only the NEW path of a
// rename, so `ignore: ['docs/**']` hid `test/a.test.ts → docs/a.md`.

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { evaluate, hasBlocking, isSuppressed } from '../src/engine';
import { testDeletion } from '../src/detectors/test-deletion';
import { defaultPolicy } from '../src/policy';
import { parsePolicy } from '../src/policy-load';
import { Change } from '../src/types';
import { guardedMain } from '../src/cli/main';

const rename = (oldPath: string, path: string, body: string): Change => ({
  kind: 'file', path, oldPath, op: 'rename', before: body, after: body, binary: false, hunks: [],
});
const cmd = (raw: string): Change => ({ kind: 'command', raw, argv: raw.split(/\s+/) });

const findings = (changes: Change[]) => testDeletion.run(changes, defaultPolicy(), 'staged', undefined);
const messages = (changes: Change[]) => findings(changes).map((f) => f.message);

const JS = "import { it, expect } from 'vitest';\nit('adds', () => { expect(1 + 1).toBe(2); });\n";
const RS = '#[test]\nfn adds() { assert_eq!(1 + 1, 2); }\n';
const GO = 'package pkg\n\nimport "testing"\n\nfunc TestAdds(t *testing.T) { if 1+1 != 2 { t.Fail() } }\n';
const PY = 'def test_adds():\n    assert 1 + 1 == 2\n';

describe('#430: a spec renamed into a path the runner does not walk', () => {
  it.each([
    ['vitest default exclude', 'src/a.test.ts', 'cypress/a.test.ts', JS],
    ['vitest default exclude (node_modules)', 'src/a.test.ts', 'node_modules/a/a.test.ts', JS],
    ['vitest default exclude (dist)', 'src/a.test.ts', 'dist/a.test.ts', JS],
    ['a dot-directory', 'src/a.test.ts', '.archive/a.test.ts', JS],
    ['cargo builds only tests/*.rs and tests/*/main.rs', 'tests/integration.rs', 'tests/integration/mod.rs', RS],
    ['cargo, nested deeper', 'crates/x/tests/a.rs', 'crates/x/tests/a/b/main.rs', RS],
    ['go test skips testdata', 'pkg/a_test.go', 'pkg/testdata/a_test.go', GO],
    ['go test skips _* components', 'pkg/a_test.go', 'pkg/_old/a_test.go', GO],
    ['go test skips .* components', 'pkg/a_test.go', 'pkg/.hidden/a_test.go', GO],
    ['pytest norecursedirs .*', 'tests/test_a.py', 'tests/.archive/test_a.py', PY],
    ['pytest norecursedirs venv', 'tests/test_a.py', 'venv/test_a.py', PY],
  ])('%s: %s → %s blocks as test-deletion', (_why, from, to, body) => {
    const m = messages([rename(from, to, body)]);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/renamed into a path the runner does not walk/);
    expect(m[0]).toContain(`${from} → ${to}`);
    expect(hasBlocking(evaluate([rename(from, to, body)], defaultPolicy(), undefined, 'staged'))).toBe(true);
  });

  it.each([
    ['src/a.test.ts', 'src/b.test.ts', JS],
    ['src/a.test.ts', 'src/nested/a.test.ts', JS],
    ['src/a.test.ts', 'src/__tests__/a.test.ts', JS],
    ['tests/integration.rs', 'tests/other.rs', RS],
    ['tests/integration.rs', 'tests/integration/main.rs', RS],
    ['pkg/a_test.go', 'pkg/sub/a_test.go', GO],
    ['tests/test_a.py', 'tests/unit/test_a.py', PY],
    ['tests/test_a.py', 'tests/test_b.py', PY],
  ])('control: %s → %s (still walked) stays clean', (from, to, body) => {
    expect(messages([rename(from, to, body)])).toEqual([]);
  });

  it('the shell spelling is the same deletion: mv into a cypress/ path', () => {
    const m = messages([cmd('mv src/a.test.ts cypress/a.test.ts')]);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/does not walk/);
    expect(messages([cmd('mv src/a.test.ts src/b.test.ts')])).toEqual([]);
  });
});

describe('#430: policy.ignore cannot hide the old path of a rename', () => {
  const policy = parsePolicy({ ignore: ['docs/**'] });

  it('a spec renamed into an ignored directory is not suppressed', () => {
    const c = rename('test/a.test.ts', 'docs/a.md', JS);
    expect(isSuppressed(c, policy)).toBe(false);
    const f = evaluate([c], policy, undefined, 'staged');
    expect(hasBlocking(f)).toBe(true);
    expect(f.map((x) => x.rule)).toContain('test-deletion');
  });

  it('a rename is suppressed only when both ends are ignored', () => {
    expect(isSuppressed(rename('docs/a.md', 'docs/b.md', '# a\n'), policy)).toBe(true);
    expect(isSuppressed(rename('README.md', 'docs/README.md', '# a\n'), policy)).toBe(false);
    expect(isSuppressed({ kind: 'file', path: 'docs/a.md', oldPath: null, op: 'add', before: null, after: '# a\n', binary: false, hunks: [] }, policy)).toBe(true);
  });

  it('an old path in a protected category is never suppressed, even when both ends are ignored', () => {
    const both = parsePolicy({ ignore: ['docs/**', 'test/**'] });
    expect(isSuppressed(rename('test/a.test.ts', 'docs/a.md', JS), both)).toBe(false);
  });
});

// The issue's reproduction: `git mv` then `check --staged`.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
}

function repoWith(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-430-'));
  dirs.push(d);
  git(d, 'init', '-q');
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), body);
  }
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'init');
  return d;
}

function check(cwd: string): { code: number; out: string } {
  let out = '';
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
  try {
    const code = guardedMain(['check', '--staged', '--json', '--cwd', cwd]);
    if (typeof code !== 'number') throw new Error('check returned a promise');
    return { code, out };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = so;
    (process.stderr as unknown as { write: unknown }).write = se;
  }
}

describe('#430: git mv + check --staged', () => {
  it.each([
    ['src/a.test.ts', 'cypress/a.test.ts', JS],
    ['tests/integration.rs', 'tests/integration/mod.rs', RS],
    ['pkg/a_test.go', 'pkg/testdata/a_test.go', GO],
    ['tests/test_a.py', 'tests/.archive/test_a.py', PY],
  ])('%s → %s exits 1 with a test-deletion finding', (from, to, body) => {
    const d = repoWith({ [from]: body, 'src/lib.txt': 'x\n' });
    mkdirSync(dirname(join(d, to)), { recursive: true });
    git(d, 'mv', from, to);
    const r = check(d);
    expect(r.code).toBe(1);
    expect(r.out).toContain('test-deletion');
    expect(r.out).toContain('does not walk');
  });

  it('a rename into an ignored path exits 1 with a test-deletion finding', () => {
    const d = repoWith({ 'test/a.test.ts': JS, '.tamperward.yml': "version: 1\nignore: ['docs/**']\n" });
    mkdirSync(join(d, 'docs'), { recursive: true });
    git(d, 'mv', 'test/a.test.ts', 'docs/a.md');
    const r = check(d);
    expect(r.code).toBe(1);
    expect(r.out).toContain('test-deletion');
  });

  it('control: a rename within the walked tree stays clean', () => {
    const d = repoWith({ 'src/a.test.ts': JS });
    mkdirSync(join(d, 'src/unit'), { recursive: true });
    git(d, 'mv', 'src/a.test.ts', 'src/unit/a.test.ts');
    const r = check(d);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('test-deletion');
  });
});
