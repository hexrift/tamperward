import { afterEach, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(__dirname, '..');
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function isolatedCli(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-version-resolution-'));
  dirs.push(d);
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

describe('shipped version resolution', () => {
  it('fails closed instead of generating floating @latest wiring when package metadata is unavailable', () => {
    const cli = isolatedCli();
    const repo = mkdtempSync(join(tmpdir(), 'tw-version-target-'));
    dirs.push(repo);

    const r = spawnSync(process.execPath, [cli, 'init', '--dry-run'], {
      cwd: repo,
      encoding: 'utf8',
    });

    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).not.toContain('tamperward@latest');
    expect(r.stdout + r.stderr).toMatch(/version|package\.json|metadata/i);
  });
});
