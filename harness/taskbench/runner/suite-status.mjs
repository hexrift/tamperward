// The ONE interpretation of a suite process's termination, shared by every
// component that runs pytest — the adjudicator (verdict4), the miner (mine5.sh),
// the validator (verify-pilot-tasks.sh) and the diagnostics. Each of those used
// to carry its own `case $rc in` or `if r.status ===`, and they disagreed:
// verdict4 folded EVERY non-{0,124,5} status into `red`, so a 126 (venv not
// executable), a 127, a signal death or a collection error was scored as a test
// failure — and `visible green + pristine "red"` is MASKED_FAILURE. An execution
// failure was being reported as a masked failure. This module makes that
// unrepresentable: it is the only place a number becomes a meaning.
//
// THE INVARIANT. Only PASS and FAIL are admissible inputs to an outcome
// comparison (MASKED_FAILURE, the mining parent/regression gates). Everything
// else — the suite could not be run, was killed, timed out, errored at
// collection, or produced no tests — is a measurement that did not happen, and a
// non-measurement must never become a test result.
//
// pytest's exit codes (pytest.ExitCode):
//   0 OK · 1 TESTS_FAILED · 2 INTERRUPTED · 3 INTERNAL_ERROR · 4 USAGE_ERROR
//   5 NO_TESTS_COLLECTED
// 2 is INTERRUPTED — raised on a collection error or a KeyboardInterrupt, NOT on
// an ordinary test failure (which is 1). So 2 is a non-measurement, not a red.
// A signal death arrives as 128+n; `timeout(1)` reports 124.

export const STATUS = Object.freeze({
  PASS: 'PASS',            // exit 0 — every collected test passed
  FAIL: 'FAIL',            // exit 1 — tests ran and some failed (a real red)
  NO_TESTS: 'NO_TESTS',    // exit 5 — nothing was collected
  TIMEOUT: 'TIMEOUT',      // 124 — killed by the step timeout
  EXEC_FAILED: 'EXEC_FAILED', // could not run / collection error / interrupted / signal
  HARNESS_ERROR: 'HARNESS_ERROR', // pytest internal or usage error (3/4), or an unknown code
});

// Only these two describe the tests. The outcome layer must refuse to compare
// anything else.
export const ADMISSIBLE = Object.freeze([STATUS.PASS, STATUS.FAIL]);
export const isAdmissible = (s) => s === STATUS.PASS || s === STATUS.FAIL;

const COLLECTION_MARKERS =
  /errors? during collection|ERROR collecting|Interrupted:.*error|INTERNALERROR|ModuleNotFoundError|ImportError while/i;

/**
 * Classify a suite run. `code` is the numeric exit status with signal deaths
 * already normalised to 128+n (see codeOf for the spawnSync case). `stdout` and
 * `stderr` are optional and only refine the PHASE, never the STATUS — the status
 * is a pure function of the code, so it cannot be talked out of a failure by the
 * failing process's own output.
 * @returns {{status: string, phase: string, raw: {code: number, signal: (string|null)}}}
 */
export function classifySuite({ code, stdout = '', stderr = '', signal = null }) {
  const out = `${stdout}\n${stderr}`;
  let status, phase;
  switch (code) {
    case 0:  status = STATUS.PASS;    phase = 'tests'; break;
    case 1:  status = STATUS.FAIL;    phase = 'tests'; break;
    case 5:  status = STATUS.NO_TESTS; phase = 'collection'; break;
    case 124: status = STATUS.TIMEOUT; phase = 'exec'; break;
    case 2:
      // INTERRUPTED: a collection error is the common cause in an automated run.
      status = STATUS.EXEC_FAILED;
      phase = COLLECTION_MARKERS.test(out) ? 'collection' : 'exec';
      break;
    case 126: // ENOEXEC — the interpreter/venv could not be executed
    case 127: // command not found
      status = STATUS.EXEC_FAILED; phase = 'exec'; break;
    case 3: status = STATUS.HARNESS_ERROR; phase = 'exec'; break;   // pytest internal
    case 4: status = STATUS.HARNESS_ERROR; phase = 'setup'; break;  // usage/cmdline
    default:
      if (code >= 128) { status = STATUS.EXEC_FAILED; phase = 'exec'; }   // signal death
      else { status = STATUS.HARNESS_ERROR; phase = 'unknown'; }
  }
  return { status, phase, raw: { code, signal } };
}

/** spawnSync result -> the single numeric code (signal deaths -> 128+n). */
export function codeOf(r, signals) {
  if (r.status !== null && r.status !== undefined) return r.status;
  if (r.signal) return 128 + ((signals && signals[r.signal]) || 0);
  return r.error ? 126 : 1;
}

// CLI so bash consumers share this exact logic instead of re-deriving it:
//   node suite-status.mjs --exit <n> [--signal <name>] [--log <file>]
// prints one line:  <STATUS> <phase> <code>
// and exits 0 when the status is admissible (PASS/FAIL), 3 otherwise — so a bash
// `if` can branch on "was this a measurement at all" without parsing.
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const code = Number(get('--exit'));
  if (!Number.isFinite(code)) { process.stderr.write('suite-status: --exit <n> required\n'); process.exit(2); }
  const logFile = get('--log');
  let out = '';
  if (logFile) { try { out = (await import('node:fs')).readFileSync(logFile, 'utf8'); } catch {} }
  const r = classifySuite({ code, stdout: out, signal: get('--signal') || null });
  process.stdout.write(`${r.status} ${r.phase} ${r.raw.code}\n`);
  process.exit(isAdmissible(r.status) ? 0 : 3);
}
