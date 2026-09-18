// #545: the Linux capture supervisor tracked bare descendant PID numbers and
// SIGKILLed them at cleanup without checking process identity, so a PID that had
// exited and been reused could belong to an unrelated same-user process. The fix
// records each descendant's /proc start-time and re-verifies it before signalling.
//
// These tests exercise the shared identity helpers the supervisor embeds
// (`PROC_IDENTITY_SRC`) with a mocked /proc table — deterministic, no PID-wrap
// stress, exactly as the issue's acceptance criteria require.

import { describe, it, expect } from 'vitest';
import { PROC_IDENTITY_SRC } from '../src/suite-diagnostics';

// One /proc/<pid>/stat line: field 4 is ppid, field 22 is starttime. The parser
// splits after the `(comm)` field, so we only need those two placed correctly.
function statLine(pid: number, ppid: number, starttime: string, comm = 'proc'): string {
  const after = new Array(22).fill('0');
  after[0] = 'S'; // state (field 3)
  after[1] = String(ppid); // ppid (field 4)
  after[19] = starttime; // starttime (field 22)
  return `${pid} (${comm}) ${after.join(' ')}`;
}

type Stat = { ppid: number; starttime: string } | null;
interface Helpers {
  readStat(pid: number): Stat;
  linuxDescendants(rootPid: number): { pid: number; starttime: string }[];
  killableDescendants(tracked: Iterable<[number, string]>): number[];
}

// Load the embedded helpers exactly as the supervisor does — free variables `fs`
// and `process` resolved from the enclosing scope — but with a synthetic table.
function loadHelpers(table: Map<number, string | null>): Helpers {
  const fs = {
    readFileSync: (p: string): string => {
      const m = /^\/proc\/(\d+)\/stat$/.exec(p);
      if (!m) throw new Error(`unexpected read: ${p}`);
      const line = table.get(Number(m[1]));
      if (line == null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return line;
    },
    readdirSync: (): string[] => [...table.keys()].map(String),
  };
  const factory = new Function(
    'fs',
    'process',
    `${PROC_IDENTITY_SRC}\nreturn { readStat, linuxDescendants, killableDescendants };`,
  );
  return factory(fs, { platform: 'linux' }) as Helpers;
}

describe('#545 verifier descendant identity', () => {
  it('readStat extracts ppid and start-time from a /proc stat line', () => {
    const h = loadHelpers(new Map([[1234, statLine(1234, 1000, '987654')]]));
    expect(h.readStat(1234)).toEqual({ ppid: 1000, starttime: '987654' });
  });

  it('readStat returns null for a pid that has gone away', () => {
    const h = loadHelpers(new Map([[1234, null]]));
    expect(h.readStat(1234)).toBeNull();
  });

  it('linuxDescendants records each descendant with its start-time identity', () => {
    // 100 -> 200 -> 300; 400 is unrelated.
    const table = new Map<number, string | null>([
      [100, statLine(100, 1, 'a')],
      [200, statLine(200, 100, 'b')],
      [300, statLine(300, 200, 'c')],
      [400, statLine(400, 1, 'd')],
    ]);
    const h = loadHelpers(table);
    expect(h.linuxDescendants(100).sort((x, y) => x.pid - y.pid)).toEqual([
      { pid: 200, starttime: 'b' },
      { pid: 300, starttime: 'c' },
    ]);
  });

  it('a reused PID whose start-time changed is NOT selected for signalling', () => {
    // We observed pid 200 with start-time 'b'; by cleanup it exited and 200 was
    // reused by an unrelated process with a different start-time.
    const tracked: [number, string][] = [[200, 'b']];
    const h = loadHelpers(new Map([[200, statLine(200, 1, 'REUSED')]]));
    expect(h.killableDescendants(tracked)).toEqual([]);
  });

  it('a still-live descendant with unchanged identity IS selected for signalling', () => {
    const tracked: [number, string][] = [[200, 'b'], [300, 'c']];
    const h = loadHelpers(
      new Map([
        [200, statLine(200, 100, 'b')],
        [300, statLine(300, 200, 'c')],
      ]),
    );
    expect(h.killableDescendants(tracked).sort((a, b) => a - b)).toEqual([200, 300]);
  });

  it('an already-exited tracked pid is skipped, a live sibling is still killed', () => {
    const tracked: [number, string][] = [[200, 'b'], [300, 'c']];
    const h = loadHelpers(
      new Map<number, string | null>([
        [200, null], // exited, /proc entry gone
        [300, statLine(300, 200, 'c')],
      ]),
    );
    expect(h.killableDescendants(tracked)).toEqual([300]);
  });
});
