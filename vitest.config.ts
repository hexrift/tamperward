import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Scrubs the GitHub Actions variables so fixture verdicts never reach a real job
    // summary (see test/setup.ts).
    setupFiles: ['test/setup.ts'],
    // harness/seed/* are fixtures run by `node --test` inside an isolated repo, not by
    // vitest — they are intentionally CommonJS and would fail to load here.
    exclude: ['**/node_modules/**', '**/dist/**', '**/harness/**'],
  },
});
