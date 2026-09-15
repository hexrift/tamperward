import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const script = join(__dirname, '..', '.github/docs/docs-smoke.mjs');

const run = (root: string) =>
  spawnSync(process.execPath, [script, root], { encoding: 'utf8' });

describe('VitePress artifact smoke test (#513)', () => {
  it('accepts a rendered rules page with a non-empty main', () => {
    const root = mkdtempSync(join(tmpdir(), 'tamperward-docs-'));
    try {
      mkdirSync(join(root, 'guide'), { recursive: true });
      writeFileSync(join(root, 'index.html'), '<main><h1>Home</h1></main>');
      writeFileSync(join(root, 'guide/rules.html'), '<main><h1>The rules</h1><p>ci-tampering</p></main>');
      const result = run(root);
      expect(result.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an empty or missing rules page', () => {
    const root = mkdtempSync(join(tmpdir(), 'tamperward-docs-'));
    try {
      mkdirSync(join(root, 'guide'), { recursive: true });
      writeFileSync(join(root, 'index.html'), '<main></main>');
      writeFileSync(join(root, 'guide/rules.html'), '');
      const result = run(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('docs smoke test failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
