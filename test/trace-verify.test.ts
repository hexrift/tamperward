import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyTraceRun,
  parseStraceFileAccess,
  summarizeTraceRuns,
  runTraceVerify,
  tracerDenialDiagnostic,
  tracerPreflight,
  type RawTraceRun,
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


describe('trace-verify tracer classification (#516)', () => {
  const rawRun = (over: Partial<RawTraceRun> = {}): RawTraceRun => ({
    spawnError: null,
    status: 0,
    signal: null,
    stderr: '',
    traceFileCount: 2,
    accessCount: 10,
    ...over,
  });

  it('classifies a missing strace executable (spawn error) as a tracer failure', () => {
    const out = classifyTraceRun(rawRun({ spawnError: 'spawn strace ENOENT', status: null, traceFileCount: 0, accessCount: 0 }));
    expect(out.kind).toBe('tracer-error');
    expect(out).toMatchObject({ diagnostic: expect.stringContaining('ENOENT') });
  });

  it('classifies a ptrace denial with an empty log as a tracer failure, quoting strace', () => {
    const stderr = 'strace: test_ptrace_get_syscall_info: PTRACE_TRACEME: Operation not permitted\n';
    const out = classifyTraceRun(rawRun({ status: 1, stderr, traceFileCount: 1, accessCount: 0 }));
    expect(out.kind).toBe('tracer-error');
    expect(out).toMatchObject({ diagnostic: expect.stringContaining('PTRACE_TRACEME') });
  });

  it('a tracer-denial diagnostic wins even if a stray access slipped through', () => {
    const stderr = 'strace: PTRACE_TRACEME: Operation not permitted\n';
    expect(classifyTraceRun(rawRun({ status: 1, stderr, accessCount: 3 })).kind).toBe('tracer-error');
  });

  it('classifies a killed tracer as a tracer failure', () => {
    const out = classifyTraceRun(rawRun({ status: null, signal: 'SIGKILL', traceFileCount: 0, accessCount: 0 }));
    expect(out).toEqual({ kind: 'tracer-error', diagnostic: expect.stringContaining('SIGKILL') });
  });

  it('classifies an empty trace with no diagnostic as a tracer failure (attached to nothing)', () => {
    expect(classifyTraceRun(rawRun({ status: 0, stderr: '', traceFileCount: 1, accessCount: 0 })).kind).toBe('tracer-error');
  });

  it('treats a valid trace whose command exits 1 as a genuine run (incomplete evidence, not exit 2)', () => {
    expect(classifyTraceRun(rawRun({ status: 1, accessCount: 42 }))).toEqual({ kind: 'ok', exit: 1 });
  });

  it('treats a valid trace that timed out (124) as a genuine run', () => {
    expect(classifyTraceRun(rawRun({ status: 124, accessCount: 30 }))).toEqual({ kind: 'ok', exit: 124 });
  });

  it('treats a valid trace that exited 0 as a healthy run', () => {
    expect(classifyTraceRun(rawRun({ status: 0, accessCount: 50 }))).toEqual({ kind: 'ok', exit: 0 });
  });
});

describe('tracerDenialDiagnostic (#516)', () => {
  it('recognizes the ptrace-denied diagnostic strace prints', () => {
    expect(tracerDenialDiagnostic('strace: test_ptrace_get_syscall_info: PTRACE_TRACEME: Operation not permitted')).toContain('PTRACE_TRACEME');
  });

  it('recognizes a seccomp denial on a strace line', () => {
    expect(tracerDenialDiagnostic('strace: seccomp filter prevents ptrace here')).not.toBeNull();
  });

  it('ignores a Permission-denied that is trace content, not a tracer message', () => {
    expect(tracerDenialDiagnostic('100 openat(AT_FDCWD, "/etc/shadow", O_RDONLY) = -1 EACCES (Permission denied)')).toBeNull();
  });

  it('ignores benign strace progress lines', () => {
    expect(tracerDenialDiagnostic('strace: Process 1234 attached')).toBeNull();
  });
});

describe('trace-verify real advisory run (#324)', () => {
  // Gate on the capability preflight, not `strace --version`: where ptrace is denied
  // (restricted CI/containers) tracing is unavailable and this E2E cannot run (#516).
  it.skipIf(process.platform !== 'linux' || tracerPreflight().kind !== 'ok')('traces a trusted base, suggests an uncovered config input, and never edits policy', () => {
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
