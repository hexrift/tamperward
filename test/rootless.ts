// Shared guard for the tests that need `tamperward run` to reach adjudication (#392).
//
// On Linux the envelope refuses root/euid 0 by design: same-UID lifecycle separation
// cannot trust any system interpreter path when the caller can write every one of them
// (src/cli/run.ts, `trustedLinuxPython`). Devcontainers, plain `docker run`, Codespaces
// and hosted agent sessions run as root by default, so without a guard a contributor
// there sees ~40 bare `expected 2 to be 0` failures on an untouched `main`. Every test
// that expects the envelope to adjudicate carries `it.skipIf(!rootless)`; the one test
// that mocks `geteuid` to 0 and asserts the refusal message stays unguarded so root still
// exercises the refusal path. `test/global-setup.ts` prints `rootRunNotice()` once at
// suite start so the skips are explained, not silent.
//
// The identity is a parameter everywhere so the contract is provable from an ordinary
// unprivileged run (test/rootless.test.ts) without needing root.

export interface ProcessIdentity {
  readonly platform: NodeJS.Platform;
  /** Effective uid, or null where the platform has none (Windows). */
  readonly euid: number | null;
}

export function currentIdentity(): ProcessIdentity {
  return {
    platform: process.platform,
    euid: typeof process.geteuid === 'function' ? process.geteuid() : null,
  };
}

/** Why the envelope refuses this identity, or null when it can reach adjudication. */
export function envelopeRefusal(id: ProcessIdentity = currentIdentity()): string | null {
  if (id.platform !== 'linux' || id.euid !== 0) return null;
  return (
    'Linux lifecycle supervision is unavailable when TamperWard runs as root/euid 0; ' +
    'same-UID separation cannot trust any system interpreter path'
  );
}

/** True when `tamperward run` can reach adjudication here; false only for Linux root. */
export const rootless: boolean = envelopeRefusal() === null;

export const UNPRIVILEGED_RUN_HINT =
  'sudo -u <unprivileged-user> -H npx vitest run   (CONTRIBUTING.md, "Running the suite unprivileged")';

/** The one message printed at suite start when the suite runs as Linux root. */
export function rootRunNotice(id: ProcessIdentity = currentIdentity()): string | null {
  const refusal = envelopeRefusal(id);
  if (refusal === null) return null;
  return [
    'tamperward suite: running as root (euid 0) on Linux.',
    `  \`tamperward run\` refuses Linux root by design (${refusal}),`,
    '  so every test that needs the envelope to reach adjudication is skipped, not failed;',
    '  the refusal path itself still runs. For full coverage run the suite as an unprivileged user:',
    `    ${UNPRIVILEGED_RUN_HINT}`,
  ].join('\n');
}

/** Global-setup hook body: writes the notice once and reports whether it did. */
export function announceRootRun(
  write: (s: string) => void = (s) => { process.stderr.write(s); },
  id: ProcessIdentity = currentIdentity(),
): boolean {
  const notice = rootRunNotice(id);
  if (notice === null) return false;
  write(`${notice}\n`);
  return true;
}
