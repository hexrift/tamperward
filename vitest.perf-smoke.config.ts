// The performance smoke, run ALONE. `npm test` (vitest.config.ts) excludes
// `**/harness/**`, so harness/perf/smoke.test.ts never shares a runner with the
// parallel suite: its verdict is a CPU ratio between processes measured in the
// same run, and sibling test files were spending its headroom (#421). This
// config is what `npm run test:perf-smoke` and the `perf-smoke` CI job load.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['harness/perf/smoke.test.ts'],
    setupFiles: ['test/setup.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
  },
});
