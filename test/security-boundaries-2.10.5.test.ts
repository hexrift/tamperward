import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileAt } from '../src/git/build';
import { loadPolicyAt } from '../src/policy-load';
import { treeFingerprint } from '../src/fingerprint';
import { defaultPolicy, isProtected } from '../src/policy';
import { HOOK_CMD, PRECOMMIT_CMD, SWEEP_CMD } from '../src/wiring';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function repo(): string {
  const cwd = tmp('tw-sec-');
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, 'test', 'a.test.js'), "it('a', () => {});\n");
  writeFileSync(join(cwd, '.tamperward.yml'), 'version: 1\nverify:\n  command: node trusted-runner.js\n');
  git('add', '-A');
  git('commit', '-qm', 'trusted base');
  return cwd;
}

describe('candidate npm configuration cannot start the authority under injected code', () => {
  it('pins every generated local npx call at command-line precedence', () => {
    for (const cmd of [HOOK_CMD, SWEEP_CMD, PRECOMMIT_CMD]) {
      expect(cmd).toContain('--registry=https://registry.npmjs.org/');
      expect(cmd).toContain("--node-options=' '");
      expect(cmd).toContain('--script-shell=');
      expect(cmd).toContain('--ignore-scripts');
      expect(cmd).toContain('--offline=false');
      expect(cmd).toContain('--prefer-online');
      expect(cmd.indexOf('--node-options')).toBeLessThan(cmd.indexOf('tamperward@'));
    }
  });

  it('the npx controls override a hostile project .npmrc before its child Node starts', () => {
    const cwd = tmp('tw-npmrc-');
    const preload = join(cwd, 'preload.cjs');
    const marker = join(cwd, 'loaded');
    writeFileSync(preload, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'loaded')\n`);
    writeFileSync(join(cwd, '.npmrc'), `node-options=--require=${preload}\n`);

    // Control: the project setting reaches the Node program npm launches.
    execFileSync('npx', ['--yes', '-c', 'node -e "process.exit(0)"'], { cwd, stdio: 'ignore' });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    execFileSync(
      'npx',
      [
        '--yes',
        '--registry=https://registry.npmjs.org/',
        '--node-options= ',
        '--script-shell=',
        '--ignore-scripts',
        '--offline=false',
        '--prefer-online',
        '-c',
        'node -e "process.exit(0)"',
      ],
      { cwd, stdio: 'ignore' },
    );
    expect(existsSync(marker)).toBe(false);
  });
});

describe('generic trusted git reads ignore replace objects', () => {
  it('fileAt and loadPolicyAt read the real base object under a pre-existing replace ref', () => {
    const cwd = repo();
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const base = git('rev-parse', 'HEAD');
    const trustedBranch = git('branch', '--show-current');

    git('switch', '--orphan', 'attacker');
    writeFileSync(join(cwd, '.tamperward.yml'), 'version: 1\nverify:\n  command: "true"\n');
    git('add', '-A');
    git('commit', '-qm', 'attacker replacement');
    const replacement = git('rev-parse', 'HEAD');
    git('switch', '-q', trustedBranch);
    git('replace', base, replacement);

    // Exploit control: ordinary git follows the replacement object.
    expect(git('show', `${base}:.tamperward.yml`)).toContain('command: "true"');
    expect(fileAt(base, '.tamperward.yml', { cwd })).toContain('node trusted-runner.js');
    expect(loadPolicyAt(base, cwd)?.verify?.command).toBe('node trusted-runner.js');
  });
});

describe('quiescence fingerprints filesystem identity and protected ignored state', () => {
  it('changes on a chmod-only transition with identical bytes', () => {
    const cwd = repo();
    const path = join(cwd, 'test', 'a.test.js');
    const beforeBytes = readFileSync(path);
    const before = treeFingerprint(cwd);
    chmodSync(path, 0o755);
    expect(readFileSync(path)).toEqual(beforeBytes);
    expect(treeFingerprint(cwd)).not.toBe(before);
  });

  it('includes ignored protected files but leaves unrelated ignored output out', () => {
    const cwd = repo();
    const policy = defaultPolicy();
    writeFileSync(join(cwd, '.gitignore'), 'test/local.test.js\nbuild.log\n');
    writeFileSync(join(cwd, 'test', 'local.test.js'), "it('local', () => {});\n");
    writeFileSync(join(cwd, 'build.log'), 'one\n');
    const keep = (rel: string) => isProtected(rel, policy);
    const before = treeFingerprint(cwd, keep);
    writeFileSync(join(cwd, 'build.log'), 'two\n');
    expect(treeFingerprint(cwd, keep)).toBe(before);
    writeFileSync(join(cwd, 'test', 'local.test.js'), "it.skip('local', () => {});\n");
    expect(treeFingerprint(cwd, keep)).not.toBe(before);
  });
});
