import { describe, expect, it } from 'vitest';
import {
  parseStraceFileAccess,
  summarizeTraceRuns,
  type TraceFileAccess,
} from '../src/cli/trace-verify';

describe('trace-verify strace parsing (#324)', () => {
  it('extracts repository reads/execs and external runtime paths without treating failed probes as reads', () => {
    const raw = [
      '100 execve("/usr/bin/node", ["node", "scripts/test.js"], 0x0) = 0',
      '100 openat(AT_FDCWD, "/trace/base/package.json", O_RDONLY|O_CLOEXEC) = 3',
      '100 openat(AT_FDCWD, "/trace/base/scripts/test.js", O_RDONLY|O_CLOEXEC) = 3',
      '100 newfstatat(AT_FDCWD, "/trace/base/config/custom.json", {st_mode=S_IFREG|0644}, 0) = 0',
      '100 access("/trace/base/missing.json", R_OK) = -1 ENOENT (No such file or directory)',
      '100 openat(AT_FDCWD, "/usr/lib/libc.so.6", O_RDONLY|O_CLOEXEC) = 3',
    ].join('\n');

    expect(parseStraceFileAccess(raw)).toEqual([
      { path: '/usr/bin/node', access: 'exec' },
      { path: '/trace/base/package.json', access: 'read' },
      { path: '/trace/base/scripts/test.js', access: 'read' },
      { path: '/trace/base/config/custom.json', access: 'read' },
      { path: '/usr/lib/libc.so.6', access: 'read' },
    ]);
  });

  it('unions repeated traces, marks varying reads dynamic, classifies config, and suggests only uncovered repo inputs', () => {
    const run1: TraceFileAccess[] = [
      { path: '/trace/base/package.json', access: 'read' },
      { path: '/trace/base/scripts/test.js', access: 'exec' },
      { path: '/trace/base/config/custom.json', access: 'read' },
      { path: '/usr/bin/node', access: 'exec' },
    ];
    const run2: TraceFileAccess[] = [
      { path: '/trace/base/package.json', access: 'read' },
      { path: '/trace/base/scripts/test.js', access: 'exec' },
      { path: '/trace/base/fixtures/optional.json', access: 'read' },
      { path: '/usr/bin/node', access: 'exec' },
    ];

    const report = summarizeTraceRuns({
      root: '/trace/base',
      runs: [run1, run2],
      tracked: new Set([
        'package.json',
        'scripts/test.js',
        'config/custom.json',
        'fixtures/optional.json',
      ]),
      covered: new Set(['package.json', 'scripts/test.js']),
    });

    expect(report.repository_inputs).toEqual([
      {
        path: 'config/custom.json',
        accesses: ['read'],
        config: true,
        covered: false,
        observed_runs: 1,
        dynamic: true,
      },
      {
        path: 'fixtures/optional.json',
        accesses: ['read'],
        config: false,
        covered: false,
        observed_runs: 1,
        dynamic: true,
      },
      {
        path: 'package.json',
        accesses: ['read'],
        config: true,
        covered: true,
        observed_runs: 2,
        dynamic: false,
      },
      {
        path: 'scripts/test.js',
        accesses: ['exec'],
        config: false,
        covered: true,
        observed_runs: 2,
        dynamic: false,
      },
    ]);
    expect(report.external_inputs).toEqual([
      {
        path: '/usr/bin/node',
        accesses: ['exec'],
        observed_runs: 2,
        dynamic: false,
      },
    ]);
    expect(report.uncovered_repository_inputs).toEqual([
      'config/custom.json',
      'fixtures/optional.json',
    ]);
    expect(report.suggested_verify_inputs).toEqual([
      'config/custom.json',
      'fixtures/optional.json',
    ]);
  });

  it('does not suggest untracked/generated paths inside the traced base', () => {
    const report = summarizeTraceRuns({
      root: '/trace/base',
      runs: [[
        { path: '/trace/base/.cache/runtime.json', access: 'read' },
        { path: '/trace/base/src/app.js', access: 'read' },
      ]],
      tracked: new Set(['src/app.js']),
      covered: new Set<string>(),
    });

    expect(report.repository_inputs.map((x) => x.path)).toEqual(['src/app.js']);
    expect(report.suggested_verify_inputs).toEqual(['src/app.js']);
  });
});
