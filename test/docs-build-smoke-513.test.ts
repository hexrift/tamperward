import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const script = join(__dirname, '..', '.github/docs/docs-smoke.mjs');

const run = (root: string) =>
  spawnSync(process.execPath, [script, root], { encoding: 'utf8' });

describe('VitePress artifact smoke test (#513)', () => {
  it('accepts a real VitePress rules page (anchor heading, home page without main)', () => {
    const root = mkdtempSync(join(tmpdir(), 'tamperward-docs-'));
    try {
      mkdirSync(join(root, 'guide'), { recursive: true });
      // The home layout renders no <main>; 404 is a bare shell — both legitimate.
      writeFileSync(join(root, 'index.html'), '<div class="VPHome"><h1>Home</h1></div>');
      writeFileSync(join(root, '404.html'), '<div class="NotFound">404</div>');
      // Default-theme headings carry a trailing header-anchor <a> inside the <h1>.
      writeFileSync(
        join(root, 'guide/rules.html'),
        '<main><div class="vp-doc"><h1 id="the-rules" tabindex="-1">The rules <a class="header-anchor" href="#the-rules">​</a></h1><p><code>ci-tampering</code></p></div></main>',
      );
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
      writeFileSync(join(root, 'index.html'), '<div class="VPHome"><h1>Home</h1></div>');
      writeFileSync(join(root, 'guide/rules.html'), '');
      const result = run(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('docs smoke test failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a content page left with an empty <main> shell (the #513 symptom)', () => {
    const root = mkdtempSync(join(tmpdir(), 'tamperward-docs-'));
    try {
      mkdirSync(join(root, 'guide'), { recursive: true });
      writeFileSync(join(root, 'index.html'), '<div class="VPHome"><h1>Home</h1></div>');
      // SSR crashed: the layout shell is present but <main> never filled.
      writeFileSync(
        join(root, 'guide/rules.html'),
        '<main><div class="vp-doc"><h1 id="the-rules" tabindex="-1">The rules</h1><p><code>ci-tampering</code></p></div></main>',
      );
      writeFileSync(join(root, 'guide/config.html'), '<main>   </main>');
      const result = run(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('empty <main>');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
