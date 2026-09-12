import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEnvelope } from '../src/cli/run';

const dirs: string[] = [];
const originalPath = process.env.PATH;
const originalVirtualEnv = process.env.VIRTUAL_ENV;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalVirtualEnv === undefined) delete process.env.VIRTUAL_ENV;
  else process.env.VIRTUAL_ENV = originalVirtualEnv;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repoWithIgnoredVenv(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-dep-env-'));
  dirs.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');

  mkdirSync(join(cwd, 'test'));
  mkdirSync(join(cwd, '.venv', 'bin'), { recursive: true });
  writeFileSync(join(cwd, '.gitignore'), '.venv/\n');
  writeFileSync(join(cwd, 'src.js'), 'module.exports = 41; // unfixed bug\n');
  writeFileSync(
    join(cwd, 'test', 'check.test.js'),
    `if (require('../src.js') !== 42) process.exit(1);\n`,
  );

  const python = join(cwd, '.venv', 'bin', 'python');
  writeFileSync(python, '#!/bin/sh\nexec node "$@"\n');
  chmodSync(python, 0o755);

  git('add', '.gitignore', 'src.js', 'test/check.test.js');
  git('commit', '-qm', 'base');
  return cwd;
}

describe('dependency environment attestation', () => {
  it('convicts a rewritten VIRTUAL_ENV interpreter even when both verifier runs are fooled', () => {
    const cwd = repoWithIgnoredVenv();
    const bin = join(cwd, '.venv', 'bin');
    process.env.VIRTUAL_ENV = join(cwd, '.venv');
    process.env.PATH = `${bin}:${originalPath ?? ''}`;

    const code = runEnvelope({
      cwd,
      cmd: 'python test/check.test.js',
      budget: 30,
      argv: [
        'bash',
        '-c',
        `printf '#!/bin/sh\\nexit 0\\n' > .venv/bin/python && chmod +x .venv/bin/python`,
      ],
    });

    // The source bug remains. The only thing that changed is the ignored venv
    // interpreter both visible/pristine verification resolve through PATH.
    expect(code).toBe(1);
  });
});
