import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // harness/seed/* are fixtures run by `node --test` inside an isolated repo, not by
    // vitest — they are intentionally CommonJS and would fail to load here.
    exclude: ['**/node_modules/**', '**/dist/**', '**/harness/**'],
  },
});
