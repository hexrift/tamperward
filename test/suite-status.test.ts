// The ONE interpretation of a suite process's termination (round 4). Table-driven
// and deterministic — no network, no subprocess — because it exists to stop a
// non-measurement (a 126, a 127, a signal death, a collection error) from ever
// being scored as a test failure, and a test of that property must not itself be
// able to flake.
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs, no types
import { classifySuite, codeOf, isAdmissible, STATUS } from '../harness/taskbench/runner/suite-status.mjs';

describe('classifySuite maps every exit code to exactly one meaning', () => {
  const cases: Array<[number, string, string]> = [
    [0,   STATUS.PASS,          'tests'],
    [1,   STATUS.FAIL,          'tests'],
    [2,   STATUS.EXEC_FAILED,   'exec'],        // INTERRUPTED, no collection marker
    [3,   STATUS.HARNESS_ERROR, 'exec'],        // pytest internal error
    [4,   STATUS.HARNESS_ERROR, 'setup'],       // usage / cmdline error
    [5,   STATUS.NO_TESTS,      'collection'],
    [124, STATUS.TIMEOUT,       'exec'],
    [126, STATUS.EXEC_FAILED,   'exec'],        // ENOEXEC — the venv could not run
    [127, STATUS.EXEC_FAILED,   'exec'],        // command not found
    [137, STATUS.EXEC_FAILED,   'exec'],        // 128+9, SIGKILL
    [139, STATUS.EXEC_FAILED,   'exec'],        // 128+11, SIGSEGV
    [42,  STATUS.HARNESS_ERROR, 'unknown'],     // an exit code no one models
  ];
  for (const [code, status, phase] of cases) {
    it(`exit ${code} -> ${status}/${phase}`, () => {
      const r = classifySuite({ code });
      expect(r.status).toBe(status);
      expect(r.phase).toBe(phase);
      expect(r.raw.code).toBe(code);
    });
  }
});

describe('the invariant: a non-measurement is never a test result', () => {
  it('only PASS and FAIL are admissible', () => {
    expect(isAdmissible(STATUS.PASS)).toBe(true);
    expect(isAdmissible(STATUS.FAIL)).toBe(true);
    for (const s of [STATUS.NO_TESTS, STATUS.TIMEOUT, STATUS.EXEC_FAILED, STATUS.HARNESS_ERROR]) {
      expect(isAdmissible(s)).toBe(false);
    }
  });
  it('exit 2 with a collection marker is attributed to the collection phase', () => {
    // The distinction verdict4 needs: a collection error (checkdocs .::project
    // pip-installing at collect time) is EXEC_FAILED, never FAIL.
    const r = classifySuite({ code: 2, stderr: 'ERROR collecting tests/foo.py\nModuleNotFoundError: no numpy' });
    expect(r.status).toBe(STATUS.EXEC_FAILED);
    expect(r.phase).toBe('collection');
  });
  it('the failing process cannot talk itself out of FAIL via its output', () => {
    // status is a pure function of the code; output only refines phase.
    const r = classifySuite({ code: 1, stdout: 'everything is fine, collection ok' });
    expect(r.status).toBe(STATUS.FAIL);
  });
});

describe('codeOf normalises a spawnSync result', () => {
  it('a clean exit passes its status through', () => {
    expect(codeOf({ status: 0, signal: null })).toBe(0);
    expect(codeOf({ status: 1, signal: null })).toBe(1);
  });
  it('a signal death becomes 128+n', () => {
    expect(codeOf({ status: null, signal: 'SIGKILL' }, { SIGKILL: 9 })).toBe(137);
    expect(codeOf({ status: null, signal: 'SIGSEGV' }, { SIGSEGV: 11 })).toBe(139);
  });
  it('a spawn error with no status is an execution failure, not a pass', () => {
    const r = classifySuite({ code: codeOf({ status: null, signal: null, error: new Error('ENOENT') }) });
    expect(isAdmissible(r.status)).toBe(false);
  });
});
