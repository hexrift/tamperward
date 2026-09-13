// Runs in every vitest worker before its test file loads.
//
// `tamperward check` auto-detects GitHub Actions (`GITHUB_ACTIONS=true`) and, in that
// mode, appends its verdict to the job summary at `$GITHUB_STEP_SUMMARY`. The suite
// exercises that code path many times — in-process through `check`/`main`, and through
// child processes that inherit `process.env` — so on a runner every fixture verdict
// ("Tamperward: 3 blocking", ".tamperward.yml disabled hook-tampering", a deleted test
// file, ...) landed in the REAL summary of whichever job ran `npm test`. A green release
// run then read as a wall of blocking findings that were never about the release.
//
// Drop the two variables here rather than in each test: any test that wants Actions
// rendering passes an explicit `env` to `resolveFormat`/`writeSummary` (render.test.ts),
// and everything else should see the plain-text default regardless of where it runs.
// Vitest's own GitHub Actions reporter runs in the main process, not in a worker, so its
// "Vitest Test Report" section is unaffected.
delete process.env.GITHUB_ACTIONS;
delete process.env.GITHUB_STEP_SUMMARY;
