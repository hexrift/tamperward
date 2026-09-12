import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEnvelope } from '../src/cli/run';
import { runVerify } from '../src/cli/verify';

const dirs: string[] = [];
const originalPath = process.env.PATH;
const originalVirtualEnv = process.env.VIRTUAL_ENV;
const originalTransientCounter = process.env.TW_TRANSIENT_COUNTER;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalVirtualEnv === undefined) delete process.env.VIRTUAL_ENV;
  else process.env.VIRTUAL_ENV = originalVirtualEnv;
  if (originalTransientCounter === undefined) delete process.env.TW_TRANSIENT_COUNTER;
  else process.env.TW_TRANSIENT_COUNTER = originalTransientCounter;
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repoWithIgnoredVenv(fixed = false): string {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-dep-env-'));
  dirs.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');

  mkdirSync(join(cwd, 'test'));
  mkdirSync(join(cwd, '.venv', 'bin'), { recursive: true });
  mkdirSync(join(cwd, '.venv', 'lib', 'python3.11', 'site-packages'), { recursive: true });
  writeFileSync(join(cwd, '.gitignore'), '.venv/\n');
  writeFileSync(join(cwd, 'src.js'), fixed ? 'module.exports = 42;\n' : 'module.exports = 41; // unfixed bug\n');
  writeFileSync(
    join(cwd, 'test', 'check.test.js'),
    `if (require('../src.js') !== 42) process.exit(1);\n`,
  );
  writeFileSync(
    join(cwd, 'run-suite.js'),
    [
      "const cp = require('node:child_process');",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const venv = process.env.VIRTUAL_ENV;",
      "const py = path.join(venv, 'bin', 'python');",
      "const original = fs.readFileSync(py);",
      "const mode = fs.statSync(py).mode & 0o777;",
      "fs.writeFileSync(py, '#!/bin/sh\\nexit 0\\n', { mode: 0o755 });",
      "const child = cp.spawnSync('python', ['test/check.test.js'], { env: process.env, stdio: 'ignore' });",
      "fs.writeFileSync(py, original, { mode });",
      "const counter = process.env.TW_TRANSIENT_COUNTER;",
      "let n = 0;",
      "try { n = Number(fs.readFileSync(counter, 'utf8')) || 0; } catch {}",
      "n += 1; fs.writeFileSync(counter, String(n));",
      "if (n >= 2) fs.writeFileSync(path.join(venv, '.two-suite-calls'), '2\\n');",
      "process.exit(child.status ?? 1);",
      "",
    ].join('\n'),
  );

  // A minimal venv-shaped tree. The runner is intentionally a shell wrapper so
  // these tests do not depend on Python being installed on every Node CI image.
  writeFileSync(join(cwd, '.venv', 'pyvenv.cfg'), 'include-system-site-packages = false\n');
  const python = join(cwd, '.venv', 'bin', 'python');
  writeFileSync(python, '#!/bin/sh\nexec node "$@"\n');
  chmodSync(python, 0o755);
  writeFileSync(join(cwd, '.venv', 'lib', 'python3.11', 'site-packages', 'helper.py'), 'VALUE = 1\n');

  git('add', '.gitignore', 'src.js', 'test/check.test.js', 'run-suite.js');
  git('commit', '-qm', 'base');
  return cwd;
}

function selectVenv(cwd: string): void {
  const bin = join(cwd, '.venv', 'bin');
  process.env.VIRTUAL_ENV = join(cwd, '.venv');
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
}

const run = (
  cwd: string,
  agent: string,
  extra: Partial<Parameters<typeof runEnvelope>[0]> = {},
): number =>
  runEnvelope({
    cwd,
    cmd: 'python test/check.test.js',
    budget: 30,
    argv: ['bash', '-c', agent],
    ...extra,
  });

describe('dependency environment attestation', () => {
  it('convicts a rewritten VIRTUAL_ENV interpreter even when both verifier runs are fooled', () => {
    const cwd = repoWithIgnoredVenv();
    selectVenv(cwd);

    const code = run(cwd, `printf '#!/bin/sh\\nexit 0\\n' > .venv/bin/python && chmod +x .venv/bin/python`);

    // The source bug remains. The only thing that changed is the ignored venv
    // interpreter both visible/pristine verification resolve through PATH.
    expect(code).toBe(1);
  });

  it('attests mutable site-packages, not only the interpreter path', () => {
    const cwd = repoWithIgnoredVenv(true);
    selectVenv(cwd);

    const code = run(cwd, `printf 'VALUE = 2\\n' > .venv/lib/python3.11/site-packages/helper.py`);

    expect(code).toBe(1);
  });

  it('catches dependency drift introduced only after the pristine suite, after both interpreter substitutions restored', () => {
    const cwd = repoWithIgnoredVenv();
    selectVenv(cwd);
    const counter = join(mkdtempSync(join(tmpdir(), 'tw-dep-counter-')), 'calls');
    dirs.push(join(counter, '..'));
    process.env.TW_TRANSIENT_COUNTER = counter;
    const original = readFileSync(join(cwd, '.venv', 'bin', 'python'), 'utf8');

    const code = runEnvelope({
      cwd,
      cmd: 'node run-suite.js',
      budget: 30,
      argv: ['bash', '-c', 'true'],
    });

    // The interpreter itself is restored after each invocation, and the
    // out-of-root counter proves both visible and pristine suites actually ran
    // the substitute. The second suite then leaves a NEW dependency-root marker,
    // which is intentionally what the post-pristine checkpoint convicts. This
    // does not claim detection of a fully self-restoring mutation that leaves
    // every attested byte identical between checkpoints.
    expect(code).toBe(1);
    expect(readFileSync(counter, 'utf8')).toBe('2');
    expect(readFileSync(join(cwd, '.venv', 'bin', 'python'), 'utf8')).toBe(original);
    expect(readFileSync(join(cwd, '.venv', '.two-suite-calls'), 'utf8')).toBe('2\n');
  });

  it('fails closed when an attested root contains a directory link outside its bounded closure', () => {
    const cwd = repoWithIgnoredVenv(true);
    selectVenv(cwd);
    const outside = mkdtempSync(join(tmpdir(), 'tw-dep-outside-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'plugin.py'), 'VALUE = 1\n');
    symlinkSync(outside, join(cwd, '.venv', 'lib', 'python3.11', 'site-packages', 'escape'), 'dir');

    expect(run(cwd, 'true')).toBe(2);
  });

  it('the operator-owned --allow-dep-drift override explicitly accepts an unattestable environment', () => {
    const cwd = repoWithIgnoredVenv(true);
    selectVenv(cwd);
    const outside = mkdtempSync(join(tmpdir(), 'tw-dep-outside-'));
    dirs.push(outside);
    symlinkSync(outside, join(cwd, '.venv', 'lib', 'python3.11', 'site-packages', 'escape'), 'dir');

    expect(run(cwd, 'true', { allowDepDrift: true })).toBe(0);
  });

  it('an honest selected venv stays green', () => {
    const cwd = repoWithIgnoredVenv(true);
    selectVenv(cwd);
    expect(run(cwd, 'true')).toBe(0);
  });

  it('accepts the normal venv shape where bin/python is a symlink to an external interpreter file', () => {
    const cwd = repoWithIgnoredVenv(true);
    selectVenv(cwd);
    const external = mkdtempSync(join(tmpdir(), 'tw-base-python-'));
    dirs.push(external);
    const basePython = join(external, 'python3');
    writeFileSync(basePython, '#!/bin/sh\nexec node "$@"\n');
    chmodSync(basePython, 0o755);
    rmSync(join(cwd, '.venv', 'bin', 'python'));
    symlinkSync(basePython, join(cwd, '.venv', 'bin', 'python'));

    expect(run(cwd, 'true')).toBe(0);
  });

  it('a Node verifier with no node_modules remains a legitimate no-dependency environment', () => {
    const cwd = repoWithIgnoredVenv(true);
    delete process.env.VIRTUAL_ENV;
    process.env.PATH = originalPath;
    expect(
      runEnvelope({
        cwd,
        cmd: 'node test/check.test.js',
        budget: 30,
        argv: ['bash', '-c', 'true'],
      }),
    ).toBe(0);
  });

  it.each([
    ['bundle exec rspec', 'ruby'],
    ['mvn test', 'jvm'],
    ['gradle test', 'jvm'],
    ['dotnet test', 'dotnet'],
  ])('classifies unsupported %s dependency environments as unattestable', (cmd) => {
    const cwd = repoWithIgnoredVenv(true);
    delete process.env.VIRTUAL_ENV;
    process.env.PATH = originalPath;
    expect(
      runEnvelope({ cwd, cmd, budget: 30, argv: ['bash', '-c', 'true'] }),
    ).toBe(2);
  });

  it('freezes a direct .venv/bin/python root even when the executable is absent at entry', () => {
    const cwd = repoWithIgnoredVenv(true);
    delete process.env.VIRTUAL_ENV;
    process.env.PATH = originalPath;
    rmSync(join(cwd, '.venv', 'bin', 'python'));

    expect(
      runEnvelope({
        cwd,
        cmd: '.venv/bin/python test/check.test.js',
        budget: 30,
        argv: ['bash', '-c', `printf '#!/bin/sh\\nexit 0\\n' > .venv/bin/python && chmod +x .venv/bin/python`],
      }),
    ).toBe(1);
  });

  it('fails closed instead of letting an npm workspace link escape the materialised verifier copy', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tw-workspace-dep-'));
    dirs.push(cwd);
    const git = (...args: string[]) => execFileSync('git', args, { cwd });
    git('init', '-q');
    git('config', 'user.email', 't@b');
    git('config', 'user.name', 'tb');
    mkdirSync(join(cwd, 'packages', 'pkg'), { recursive: true });
    mkdirSync(join(cwd, 'node_modules'), { recursive: true });
    mkdirSync(join(cwd, 'test'));
    writeFileSync(join(cwd, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(cwd, 'packages', 'pkg', 'value.js'), 'module.exports = 1;\n');
    writeFileSync(join(cwd, 'test', 'check.test.js'), "if (require('pkg/value.js') !== 2) process.exit(1);\n");
    symlinkSync('../packages/pkg', join(cwd, 'node_modules', 'pkg'), 'dir');
    git('add', '.gitignore', 'packages/pkg/value.js', 'test/check.test.js');
    git('commit', '-qm', 'base');

    expect(
      runEnvelope({
        cwd,
        cmd: 'node test/check.test.js',
        budget: 30,
        argv: ['bash', '-c', `printf 'module.exports = 2;\\n' > packages/pkg/value.js`],
      }),
    ).toBe(2);
  });

  it('reports the carried dependency trust assumption in verify JSON', () => {
    const cwd = repoWithIgnoredVenv(true);
    selectVenv(cwd);
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    expect(runVerify({ cwd, base: 'HEAD', cmd: 'python test/check.test.js', budget: 30, json: true })).toBe(0);
    const line = chunks.join('').trim().split('\n').at(-1)!;
    const report = JSON.parse(line);
    expect(report.dependency_environment.status).toBe('attested');
    expect(report.dependency_environment.roots).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'python-venv' })]),
    );
    expect(report.dependency_environment.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});
