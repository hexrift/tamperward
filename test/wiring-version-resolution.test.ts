import { afterEach, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

function dryRun(cli: string) {
  const repo = mkdtempSync(join(tmpdir(), 'tw-version-target-'));
  dirs.push(repo);
  return spawnSync(process.execPath, [cli, 'init', '--dry-run'], {
    cwd: repo,
    encoding: 'utf8',
  });
}

describe('shipped version resolution', () => {
  it.each([
    ['package metadata is unavailable', undefined],
    ['package metadata is not a plain release semver', 'latest'],
  ])('fails closed instead of generating floating wiring when %s', (_name, version) => {
    const r = dryRun(isolatedCli(version));

    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).not.toContain('tamperward@latest');
    expect(r.stdout + r.stderr).toMatch(/version|package\.json|metadata/i);
  });
});
