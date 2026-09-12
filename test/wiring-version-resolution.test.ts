import { afterEach, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(__dirname, '..');
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function isolatedCli(packageVersion?: string): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-version-resolution-'));
  dirs.push(d);
  symlinkSync(join(ROOT, 'node_modules'), join(d, 'node_modules'), 'dir');
  if (packageVersion !== undefined) {
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'tamperward', version: packageVersion }));
  }
  mkdirSync(join(d, 'cli'));
  const out = join(d, 'cli', 'index.js');
  buildSync({
    entryPoints: [join(ROOT, 'src/cli/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: out,
    logLevel: 'silent',
  });
  return out;
}

function targetRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'tw-version-target-'));
  dirs.push(repo);
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
  return repo;
}

function run(cli: string, args: string[], cwd = targetRepo()) {
  return {
    cwd,
    result: spawnSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: 'utf8',
    }),
  };
}

describe('shipped version resolution', () => {
  it.each([
    ['package metadata is unavailable', undefined],
    ['package metadata is a registry tag', 'latest'],
    ['package metadata is a semver range', '^2.10.7'],
    ['package metadata is a prerelease', '2.10.7-beta.1'],
  ])('fails closed instead of generating floating wiring when %s', (_name, version) => {
    const { result: r } = run(isolatedCli(version), ['init', '--dry-run']);

    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).not.toContain('tamperward@latest');
    expect(r.stdout + r.stderr).not.toContain('tamperward@0.0.0-unresolved');
    expect(r.stdout + r.stderr).toMatch(/version|package\.json|metadata/i);
  });

  it('refuses before a non-dry-run init can write any managed artifact', () => {
    const { cwd, result: r } = run(isolatedCli(), ['init']);

    expect(r.status).toBe(2);
    for (const path of [
      '.tamperward.yml',
      '.claude/settings.json',
      '.git/hooks/pre-commit',
      '.github/workflows/tamperward.yml',
      '.github/CODEOWNERS',
    ]) {
      expect(existsSync(join(cwd, path)), path).toBe(false);
    }
  });

  it('does not make unresolved package metadata an eager import failure for unrelated commands', () => {
    const { result: r } = run(isolatedCli(), ['--help']);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('tamperward — the deterministic agent-integrity gate');
    expect(r.stderr).toBe('');
  });

  it('pins generated wiring to the exact plain semver from the packaged layout', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    const { cwd, result: r } = run(isolatedCli(pkg.version), ['init']);

    expect(r.status).toBe(0);
    const settings = readFileSync(join(cwd, '.claude/settings.json'), 'utf8');
    const precommit = readFileSync(join(cwd, '.git/hooks/pre-commit'), 'utf8');
    const workflow = readFileSync(join(cwd, '.github/workflows/tamperward.yml'), 'utf8');
    for (const generated of [settings, precommit, workflow]) {
      expect(generated).toContain(`tamperward@${pkg.version}`);
      expect(generated).not.toContain('tamperward@latest');
      expect(generated).not.toContain('tamperward@0.0.0-unresolved');
    }
  });
});
