// Runs once in the vitest main process before any worker starts (#392).
//
// When the suite runs as Linux root/euid 0, the `tamperward run` envelope refuses to
// start the agent and every test that needs it to reach adjudication is skipped via
// `it.skipIf(!rootless)` (test/rootless.ts). This prints the one explanation for those
// skips — why the envelope refuses root and how to run the suite unprivileged — so a
// contributor in a devcontainer sees a reason, not a wall of `expected 2 to be 0`.
// Unprivileged runs (CI included) write nothing.

import { announceRootRun } from './rootless';

export function setup(): void {
  announceRootRun();
}
