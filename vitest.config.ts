import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Scrubs the GitHub Actions variables so fixture verdicts never reach a real job
    // summary (see test/setup.ts).
    setupFiles: ['test/setup.ts'],
    // Runs once in the main process: when the suite runs as Linux root/euid 0 it prints
    // the one explanation for the envelope tests being skipped (see test/rootless.ts).
    // Unprivileged runs write nothing.
    globalSetup: ['test/global-setup.ts'],
    // harness/seed/* are fixtures run by `node --test` inside an isolated repo, not by
    // vitest — they are intentionally CommonJS and would fail to load here.
    // `.claude/` can hold nested checkouts (git worktrees an agent created there): those
    // are separate copies of THIS repository, so collecting their `test/*.test.ts` would
    // run stale duplicate suites against old code. A fresh CI clone never has them; the
    // exclude keeps a local run honest regardless of what a tool left under `.claude/`.
    exclude: ['**/node_modules/**', '**/dist/**', '**/harness/**', '**/.claude/**'],
  },
});
