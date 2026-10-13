import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVerify, runVerify } from '../src/cli/verify';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'tw-cargo-'));
  dirs.push(dir);
  return dir;
}
function repo() {
  const cwd = temp();
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git('init'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.test');
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, 'source.cjs'), 'module.exports = 42;');
  writeFileSync(join(cwd, 'test/check.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const target = process.env.CARGO_TARGET_DIR;
if (!target) process.exit(9);
fs.mkdirSync(target, { recursive: true });
if (path.basename(target) === 'visible') fs.writeFileSync(path.join(target, 'visible-only'), 'candidate');
else if (fs.existsSync(path.join(target, 'visible-only'))) process.exit(8);
fs.writeFileSync(path.join(target, 'ran'), 'yes');
if (require('../source.cjs') !== 42) process.exit(1);
`);
  git('add', '.'); git('commit', '-qm', 'trusted suite');
  return { cwd, git };
}
function verify(cwd: string, root: string) {
  return runVerify({ ...parseVerify(['--base', 'HEAD', '--cmd', 'node test/check.cjs', '--cargo-target-root', root]), cwd, silent: true });
}

describe('operator-configured Cargo stage targets', () => {
  it('parses the explicit cache root and refuses missing flag values', () => {
    expect(parseVerify(['--cargo-target-root', '/tmp/cargo']).cargoTargetRoot).toBe('/tmp/cargo');
    expect(parseVerify(['--cargo-target-root', '--json']).invalid).toMatch(/needs a value/);
  });

  it('executes both stages with separate persistent targets, including a second run', () => {
    const { cwd } = repo();
    const root = temp();
    expect(verify(cwd, root)).toBe(0);
    expect(readFileSync(join(root, 'visible/ran'), 'utf8')).toBe('yes');
    expect(readFileSync(join(root, 'pristine/ran'), 'utf8')).toBe('yes');
    expect(existsSync(join(root, 'pristine/visible-only'))).toBe(false);
    expect(verify(cwd, root)).toBe(0);
  });

  it('still detects a masked failure with cached output present', () => {
    const { cwd } = repo();
    const root = temp();
    writeFileSync(join(cwd, 'source.cjs'), 'module.exports = 41;');
    writeFileSync(join(cwd, 'test/check.cjs'), 'process.exit(0);');
    expect(verify(cwd, root)).toBe(1);
    expect(readFileSync(join(root, 'pristine/ran'), 'utf8')).toBe('yes');
  });

  it('refuses cache roots inside the candidate and cache directories aliased between stages', () => {
    const { cwd } = repo();
    expect(verify(cwd, join(cwd, 'cache'))).toBe(2);
    const root = temp();
    mkdirSync(join(root, 'visible'));
    symlinkSync(join(root, 'visible'), join(root, 'pristine'), 'dir');
    expect(verify(cwd, root)).toBe(2);
    expect(existsSync(join(root, 'visible/ran'))).toBe(false);
  });
});
