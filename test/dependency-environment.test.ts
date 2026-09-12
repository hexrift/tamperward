import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEnvelope } from '../src/cli/run';
import { runVerify } from '../src/cli/verify';

const dirs: string[] = [];
const originalPath = process.env.PATH;
const originalVirtualEnv = process.env.VIRTUAL_ENV;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalVirtualEnv === undefined) delete process.env.VIRTUAL_ENV;
  else process.env.VIRTUAL_ENV = originalVirtualEnv;
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

  // A minimal venv-shaped tree. The runner is intentionally a shell wrapper so
  // these tests do not depend on Python being installed on every Node CI image.
  writeFileSync(join(cwd, '.venv', 'pyvenv.cfg'), 'include-system-site-packages = false\n');
  const python = join(cwd, '.venv', 'bin', 'python');
  writeFileSync(python, '#!/bin/sh\nexec node "$@"\n');
  chmodSync(python, 0o755);
  writeFileSync(join(cwd, '.venv', 'lib', 'python3.11', 'site-packages', 'helper.py'), 'VALUE = 1\n');

  git('add', '.gitignore', 'src.js', 'test/check.test.js');
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

  it('convicts a self-restoring interpreter that would fool both suites then put its bytes back', () => {
    const cwd = repoWithIgnoredVenv();
    selectVenv(cwd);

    const fake = [
      'cp .venv/bin/python .venv/bin/python.real',
      `cat > .venv/bin/python <<'EOF'`,
      '#!/bin/sh',
      'n=$(cat "$VIRTUAL_ENV/.calls" 2>/dev/null || echo 0)',
      'n=$((n+1))',
      'echo "$n" > "$VIRTUAL_ENV/.calls"',
      'if [ "$n" -ge 2 ]; then cp "$0.real" "$0"; chmod +x "$0"; fi',
      'exit 0',
      'EOF',
      'chmod +x .venv/bin/python',
    ].join('\n');

    expect(run(cwd, fake)).toBe(1);
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
