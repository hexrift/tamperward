// #554: standalone `verify` loaded policy from the repository root but enumerated
// and materialized only the caller's directory. Invoked from a package
// subdirectory it therefore ran the root suite against an incomplete copy and
// reported a false SUITE_RED for a perfectly valid repository. Verify should
// normalize to the repository root, so a nested invocation matches a root one.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerify } from '../src/cli/verify';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const capture = (fn: () => number): { code: number; json: Record<string, unknown> } => {
  const orig = process.stdout.write;
  const lines: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = fn();
    const json = lines.map((l) => l.trim()).reverse().find((l) => l.startsWith('{'));
    if (!json) throw new Error('no JSON line written');
    return { code, json: JSON.parse(json) };
  } finally {
    process.stdout.write = orig;
  }
};

// A clean repo whose ROOT suite passes, with a tracked file in a package
// subdirectory. The verify command lives in the committed root policy and is
// root-relative, so a subtree-only copy cannot satisfy it.
function repoWithSubdir(pass: boolean): { root: string; sub: string } {
  const d = mkdtempSync(join(tmpdir(), 'tw-554-'));
  dirs.push(d);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: d });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src.js'), `module.exports = ${pass ? 42 : 41};\n`);
  writeFileSync(
    join(d, 'test', 'check.test.js'),
    `const v = require('../src.js');\nif (v !== 42) { console.error('expected 42, got ' + v); process.exit(1); }\n`,
  );
  writeFileSync(join(d, '.tamperward.yml'), 'verify:\n  command: node test/check.test.js\n');
  mkdirSync(join(d, 'packages', 'widget'), { recursive: true });
  writeFileSync(join(d, 'packages', 'widget', 'file.txt'), 'hello\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { root: d, sub: join(d, 'packages', 'widget') };
}

const verify = (cwd: string) => capture(() => runVerify({ cwd, base: 'HEAD', budget: 30, json: true }));

describe('#554 verify normalizes to the repository root', () => {
  it('a nested invocation produces the same VERIFIED verdict and restored count as root', () => {
    const { root, sub } = repoWithSubdir(true);
    const fromRoot = verify(root);
    const fromSub = verify(sub);
    expect(fromRoot.json.verdict).toBe('VERIFIED');
    expect(fromSub.json.verdict).toBe(fromRoot.json.verdict);
    expect(fromSub.json.protected_restored).toBe(fromRoot.json.protected_restored);
    expect(fromSub.code).toBe(fromRoot.code);
  });

  it('a genuine failing suite is still SUITE_RED from a subdirectory (no masking)', () => {
    const { root, sub } = repoWithSubdir(false);
    expect(verify(root).json.verdict).toBe('SUITE_RED');
    expect(verify(sub).json.verdict).toBe('SUITE_RED');
  });
});
