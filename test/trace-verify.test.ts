import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseStraceFileAccess,
  summarizeTraceRuns,
  runTraceVerify,
  type TraceFileAccess,
} from '../src/cli/trace-verify';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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


describe('trace-verify real advisory run (#324)', () => {
  it.skipIf(process.platform !== 'linux')('traces a trusted base, suggests an uncovered config input, and never edits policy', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tw-trace-e2e-'));
    dirs.push(cwd);
    const git = (...args: string[]) => execFileSync('git', args, { cwd });
    git('init', '-q');
    git('config', 'user.email', 't@b');
    git('config', 'user.name', 'tb');
    mkdirSync(join(cwd, 'config'));
    writeFileSync(join(cwd, 'config', 'custom.json'), '{"ok":true}\n');
    writeFileSync(
      join(cwd, 'runner.js'),
      "const fs=require('node:fs'); JSON.parse(fs.readFileSync('config/custom.json','utf8'));\n",
    );
    writeFileSync(
      join(cwd, '.tamperward.yml'),
      ['version: 1', 'verify:', '  command: node runner.js', '  budget: 10', ''].join('\n'),
    );
    git('add', '-A');
    git('commit', '-qm', 'trusted trace fixture');

    const before = readFileSync(join(cwd, '.tamperward.yml'), 'utf8');
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const code = runTraceVerify({ cwd, base: 'HEAD', runs: 2, json: true });
    expect(code).toBe(0);
    const report = JSON.parse(chunks.join('').trim());
    expect(report.advisory).toBe(true);
    expect(report.trace_complete).toBe(true);
    expect(report.suggested_verify_inputs).toContain('config/custom.json');
    expect(report.repository_inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'runner.js', covered: true }),
        expect.objectContaining({ path: 'config/custom.json', covered: false, config: true }),
      ]),
    );
    expect(report.external_inputs.some((x: { path: string }) => /(?:^|\/)node$/.test(x.path))).toBe(true);
    expect(readFileSync(join(cwd, '.tamperward.yml'), 'utf8')).toBe(before);
  }, 30_000);
});
