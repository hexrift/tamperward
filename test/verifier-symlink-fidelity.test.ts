import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerify } from '../src/cli/verify';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-link-'));
  dirs.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  mkdirSync(join(cwd, 'test'));
  mkdirSync(join(cwd, 'fixtures', 'dir'), { recursive: true });
  writeFileSync(join(cwd, 'fixtures', 'value.js'), 'module.exports = 42;\n');
  writeFileSync(join(cwd, 'fixtures', 'dir', 'value.js'), 'module.exports = 42;\n');
  writeFileSync(join(cwd, '.gitignore'), 'node_modules/\nsecret.txt\n');
  return cwd;
}

function commit(cwd: string): void {
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['-c', 'user.name=tb', '-c', 'user.email=t@b', 'commit', '-qm', 'base'], { cwd });
}

function capture(fn: () => number): { code: number; out: string } {
  let out = '';
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
  try {
    return { code: fn(), out };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = original;
  }
}

describe('#315 verifier symlink fidelity', () => {
  it('preserves a tracked link to a file in both materialised runs', () => {
    const cwd = repo();
    symlinkSync('../fixtures/value.js', join(cwd, 'test', 'linked.test.js'));
    commit(cwd);
    const cmd = `node -e "const f=require('fs');if(!f.lstatSync('test/linked.test.js').isSymbolicLink()||require('./test/linked.test.js')!==42)process.exit(1)"`;
    expect(runVerify({ cwd, base: 'HEAD', cmd, budget: 30, json: true })).toBe(0);
    expect(lstatSync(join(cwd, 'test', 'linked.test.js')).isSymbolicLink()).toBe(true);
  });

  it('preserves tracked directory-link semantics', () => {
    const cwd = repo();
    symlinkSync('../fixtures/dir', join(cwd, 'test', 'linked-dir'));
    commit(cwd);
    const cmd = `node -e "const f=require('fs');if(!f.lstatSync('test/linked-dir').isSymbolicLink()||require('./test/linked-dir/value.js')!==42)process.exit(1)"`;
    expect(runVerify({ cwd, base: 'HEAD', cmd, budget: 30, json: true })).toBe(0);
  });

  it('preserves a safe broken tracked link instead of dropping it', () => {
    const cwd = repo();
    symlinkSync('../fixtures/missing.js', join(cwd, 'test', 'broken.test.js'));
    commit(cwd);
    const cmd = `node -e "const f=require('fs');if(!f.lstatSync('test/broken.test.js').isSymbolicLink()||f.existsSync('test/broken.test.js'))process.exit(1)"`;
    expect(runVerify({ cwd, base: 'HEAD', cmd, budget: 30, json: true })).toBe(0);
  });

  it.each([
    ['an absolute link', (outside: string) => outside],
    ['a relative escape', () => '../../../outside'],
  ])('fails closed on %s', (_name, target) => {
    const cwd = repo();
    const outside = join(tmpdir(), `tw-outside-${Date.now()}`);
    symlinkSync(target(outside), join(cwd, 'test', 'escape.test.js'));
    commit(cwd);
    const result = capture(() => runVerify({ cwd, base: 'HEAD', cmd: 'true', budget: 30 }));
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/symlink that escapes the materialised tree/);
  });

  it('allows a link genuinely contained below the external node_modules root', () => {
    const cwd = repo();
    mkdirSync(join(cwd, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules', 'pkg', 'value.js'), 'module.exports = 73;\n');
    symlinkSync('../node_modules/pkg/value.js', join(cwd, 'test', 'dependency.test.js'));
    commit(cwd);
    const cmd = `node -e "const f=require('fs');if(!f.lstatSync('test/dependency.test.js').isSymbolicLink()||require('./test/dependency.test.js')!==73)process.exit(1)"`;
    expect(runVerify({ cwd, base: 'HEAD', cmd, budget: 30, json: true })).toBe(0);
  });

  it('fails closed when a link enters node_modules and then climbs back into the original worktree', () => {
    const cwd = repo();
    mkdirSync(join(cwd, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(cwd, 'secret.txt'), 'original-worktree-only\n');
    symlinkSync('../node_modules/../secret.txt', join(cwd, 'test', 'escape.test.js'));
    commit(cwd);
    const result = capture(() => runVerify({ cwd, base: 'HEAD', cmd: 'true', budget: 30 }));
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/symlink that escapes the materialised tree/);
  });

  it('fails closed on a chained in-copy link that reaches node_modules before climbing out', () => {
    const cwd = repo();
    mkdirSync(join(cwd, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(cwd, 'secret.txt'), 'original-worktree-only\n');
    symlinkSync('../node_modules/pkg', join(cwd, 'test', 'deps'));
    symlinkSync('deps/../../secret.txt', join(cwd, 'test', 'escape.test.js'));
    commit(cwd);
    const result = capture(() => runVerify({ cwd, base: 'HEAD', cmd: 'true', budget: 30 }));
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/symlink that escapes the materialised tree/);
  });

  it('fails closed when a dependency symlink leaves the real node_modules root', () => {
    const cwd = repo();
    mkdirSync(join(cwd, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(cwd, 'secret.txt'), 'original-worktree-only\n');
    symlinkSync('../../secret.txt', join(cwd, 'node_modules', 'pkg', 'leak'));
    symlinkSync('../node_modules/pkg/leak', join(cwd, 'test', 'escape.test.js'));
    commit(cwd);
    const result = capture(() => runVerify({ cwd, base: 'HEAD', cmd: 'true', budget: 30 }));
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/symlink that escapes the materialised tree/);
  });

  it('never writes trusted overlay bytes through a candidate escape link', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'test', 'guard.test.js'), 'trusted test\n');
    commit(cwd);
    const outsideDir = mkdtempSync(join(tmpdir(), 'tw-link-target-'));
    dirs.push(outsideDir);
    const outside = join(outsideDir, 'target');
    writeFileSync(outside, 'outside stays unchanged\n');
    rmSync(join(cwd, 'test', 'guard.test.js'));
    symlinkSync(outside, join(cwd, 'test', 'guard.test.js'));

    expect(runVerify({ cwd, base: 'HEAD', cmd: 'true', budget: 30 })).toBe(2);
    expect(existsSync(outside)).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('outside stays unchanged\n');
  });
});
