// Advisory verifier-input discovery.
//
// This command is deliberately NOT an enforcement verdict. It observes a known-good
// trusted base under Linux strace, unions repeated runs, and tells a maintainer which
// tracked repository files the verifier actually consulted that are not already on
// TamperWard's pristine-verification surface. The human may then copy reviewed paths
// into verify.inputs. Nothing in this module writes .tamperward.yml.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertRev } from '../git/build';
import { trustedGitEnv } from '../git/trusted';
import { defaultPolicy } from '../policy';
import { loadPolicyAt } from '../policy-load';
import { verifierCoveredInputs } from './verify';

export interface TraceVerifyOpts {
  cwd?: string;
  base?: string;
  cmd?: string;
  budget?: number;
  runs?: number;
  json?: boolean;
}

export interface TraceFileAccess {
  path: string;
  access: 'read' | 'exec';
}

export interface TraceRepositoryInput {
  path: string;
  accesses: Array<'read' | 'exec'>;
  config: boolean;
  covered: boolean;
  observed_runs: number;
  dynamic: boolean;
}

export interface TraceExternalInput {
  path: string;
  accesses: Array<'read' | 'exec'>;
  observed_runs: number;
  dynamic: boolean;
}

export interface TraceSummary {
  repository_inputs: TraceRepositoryInput[];
  external_inputs: TraceExternalInput[];
  uncovered_repository_inputs: string[];
  suggested_verify_inputs: string[];
}

export interface TraceVerifyReport extends TraceSummary {
  advisory: true;
  platform: string;
  base: string;
  command: string;
  runs_requested: number;
  runs_completed: number;
  run_exits: number[];
  trace_complete: boolean;
  notes: string[];
}

interface SummarizeOpts {
  root: string;
  runs: TraceFileAccess[][];
  tracked: Set<string>;
  covered: Set<string>;
}

const TRACE_ROOT = '/__tamperward_trusted_base__';

function unescapeStraceString(s: string): string {
  return s
    .replace(/\\([0-7]{1,3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * Parse successful path-bearing file syscalls from strace output.
 *
 * This is intentionally conservative: failed probes (ENOENT, EACCES, etc.) are not
 * called inputs. A path the runner merely wondered about is different from one it
 * actually read/stat'ed/executed.
 */
export function parseStraceFileAccess(raw: string): TraceFileAccess[] {
  const out: TraceFileAccess[] = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    if (!line.trim() || /\)\s+=\s+-1\b/.test(line)) continue;
    const call = line.match(/\b(execveat|execve|openat2|openat|open|newfstatat|fstatat|statx|lstat|stat|access|readlinkat|readlink)\s*\(/);
    if (!call) continue;
    const afterCall = line.slice((call.index ?? 0) + call[0].length);
    const quoted = afterCall.match(/"([^"\\]*(?:\\.[^"\\]*)*)"/);
    if (!quoted) continue;
    const path = unescapeStraceString(quoted[1]);
    if (!path) continue;
    const access: 'read' | 'exec' = call[1].startsWith('execve') ? 'exec' : 'read';
    const key = `${access}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, access });
  }
  return out;
}

/**
 * The observable result of one `strace` invocation, reduced to the signals the
 * classifier needs. Kept as plain data so the classification is pure and unit-
 * testable without a real tracer (which a restricted CI cannot run).
 */
export interface RawTraceRun {
  /** spawnSync `.error?.message` — e.g. the `strace` binary itself was not found. */
  spawnError: string | null;
  /** `strace`'s own exit status. When the tracer attached, this is the tracee's. */
  status: number | null;
  /** The signal that killed `strace`, if any (e.g. `SIGKILL`). */
  signal: string | null;
  /** Bounded `strace` stderr — its own diagnostics, not the trace (which goes to files). */
  stderr: string;
  /** How many `-o` trace files `strace` produced. */
  traceFileCount: number;
  /** Parsed `%file` accesses across all trace files. Zero means the tracer saw nothing. */
  accessCount: number;
}

export type TraceRunOutcome =
  // The tracer attached and observed a real run; `exit` is the TRACEE's exit code
  // (0 healthy, non-zero — including a `timeout` 124 — reportable incomplete evidence).
  | { kind: 'ok'; exit: number }
  // The tracer could not attach/observe: ptrace/seccomp/Yama denial, a killed tracer,
  // a missing binary, or an empty trace. This is a tooling failure (exit 2), never a
  // verifier result — no advisory report may be emitted from it.
  | { kind: 'tracer-error'; diagnostic: string };

// `strace`'s own diagnostics when the kernel denies tracing: ptrace blocked by
// seccomp, Yama (`ptrace_scope`), no-new-privs, or a container policy. Matched only on
// `strace:`-prefixed stderr lines, which carry the tracer's messages, never the trace.
const TRACER_DENIAL_RE =
  /\b(?:PTRACE_[A-Z_]+|ptrace|seccomp|no[-_ ]new[-_ ]privs|yama)\b|Operation not permitted|Permission denied/i;

/** The first `strace:` diagnostic line that names a tracing-capability denial, or null. */
export function tracerDenialDiagnostic(stderr: string): string | null {
  for (const raw of stderr.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('strace:') && TRACER_DENIAL_RE.test(line)) return line;
  }
  return null;
}

/**
 * Classify one `strace` invocation as a genuine traced run or a tracer-infrastructure
 * failure. The distinction the bug missed (#516): `strace --version` succeeding does not
 * mean the process may trace. When ptrace is denied, `strace` exits non-zero with a
 * denial diagnostic and an empty trace — that is a tooling failure (exit 2), NOT a
 * known-good verifier run that happened to exit 1. Only once a valid trace exists is
 * `strace`'s status the tracee's own exit.
 */
export function classifyTraceRun(r: RawTraceRun): TraceRunOutcome {
  if (r.spawnError) return { kind: 'tracer-error', diagnostic: `strace could not be launched: ${r.spawnError}` };
  const denial = tracerDenialDiagnostic(r.stderr);
  if (denial) return { kind: 'tracer-error', diagnostic: denial };
  if (r.signal) return { kind: 'tracer-error', diagnostic: `strace was killed by ${r.signal} before the trace completed` };
  if (r.traceFileCount === 0) return { kind: 'tracer-error', diagnostic: 'strace produced no trace files; the tracer did not attach (ptrace may be denied)' };
  if (r.accessCount === 0) return { kind: 'tracer-error', diagnostic: 'strace recorded no file syscalls; the tracer attached to nothing (ptrace may be denied)' };
  return { kind: 'ok', exit: r.status ?? 1 };
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalRepoPath(root: string, raw: string): string | null {
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  if (!inside(root, abs)) return null;
  const rel = relative(root, abs).split(sep).join('/');
  return rel && rel !== '..' ? rel : null;
}

const CONFIG_BASENAMES = new Set([
  'package.json',
  'pytest.ini',
  '.pytest.ini',
  'setup.cfg',
  'setup.py',
  'tox.ini',
  'pyproject.toml',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'pnpm-workspace.yaml',
  '.pnpmfile.cjs',
  '.pnp.cjs',
  '.pnp.js',
  '.pnp.loader.mjs',
  '.nvmrc',
  '.node-version',
  '.python-version',
  '.gitattributes',
  '.rspec',
  'phpunit.xml',
  'phpunit.xml.dist',
]);

function likelyConfig(path: string): boolean {
  const base = path.split('/').at(-1) ?? path;
  return (
    CONFIG_BASENAMES.has(base) ||
    /(?:^|\/)(?:config|configs)\//.test(path) ||
    /^\.env(?:\.|$)/.test(base) ||
    /^(?:jest|vitest|playwright|cypress|vite|babel|karma|ava)\.config\./.test(base) ||
    /^tsconfig(?:\..+)?\.json$/.test(base) ||
    /^\.?(?:babelrc|swcrc|nycrc|c8rc)/.test(base) ||
    /(?:^|\/)conftest\.py$/.test(path)
  );
}

function sortAccesses(values: Set<'read' | 'exec'>): Array<'read' | 'exec'> {
  return [...values].sort((a, b) => a.localeCompare(b));
}

/**
 * Pure report projection used by both tests and the real tracer.
 *
 * Paths inside the traced root are candidates only when they existed in the trusted
 * base. Generated caches/results are observations, but never suggestions for
 * verify.inputs. Anything outside the root is reported separately as runtime/
 * dependency evidence.
 */
export function summarizeTraceRuns(opts: SummarizeOpts): TraceSummary {
  type Acc = { accesses: Set<'read' | 'exec'>; runs: Set<number> };
  const repo = new Map<string, Acc>();
  const external = new Map<string, Acc>();

  opts.runs.forEach((run, index) => {
    const perRun = new Set<string>();
    for (const item of run) {
      const rel = normalRepoPath(opts.root, item.path);
      const isTracked = rel !== null && opts.tracked.has(rel);
      const keyPath = rel !== null ? (opts.tracked.has(rel) ? rel : null) : resolve(opts.root, item.path);
      if (keyPath === null) continue; // generated/untracked path inside the trace root

      const target = isTracked ? repo : external;
      const key = `${isTracked ? 'repo' : 'external'}\0${keyPath}`;
      let acc = target.get(keyPath);
      if (!acc) {
        acc = { accesses: new Set(), runs: new Set() };
        target.set(keyPath, acc);
      }
      acc.accesses.add(item.access);
      if (!perRun.has(key)) {
        acc.runs.add(index);
        perRun.add(key);
      }
    }
  });

  const totalRuns = opts.runs.length;
  const repository_inputs: TraceRepositoryInput[] = [...repo.entries()]
    .map(([path, acc]) => ({
      path,
      accesses: sortAccesses(acc.accesses),
      config: likelyConfig(path),
      covered: opts.covered.has(path),
      observed_runs: acc.runs.size,
      dynamic: acc.runs.size < totalRuns,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const external_inputs: TraceExternalInput[] = [...external.entries()]
    .map(([path, acc]) => ({
      path,
      accesses: sortAccesses(acc.accesses),
      observed_runs: acc.runs.size,
      dynamic: acc.runs.size < totalRuns,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const uncovered_repository_inputs = repository_inputs
    .filter((x) => !x.covered)
    .map((x) => x.path);

  return {
    repository_inputs,
    external_inputs,
    uncovered_repository_inputs,
    // Exact paths are intentionally conservative. A maintainer may widen them to
    // reviewed globs, but TamperWard never invents a broader trust surface.
    suggested_verify_inputs: [...uncovered_repository_inputs],
  };
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: trustedGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commandExists(command: string): boolean {
  const r = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

function trackedAt(base: string, cwd: string): string[] {
  return git(['ls-tree', '-r', '-z', '--name-only', base], cwd).split('\0').filter(Boolean);
}

function materializeBase(base: string, cwd: string, dest: string): void {
  const archive = spawnSync('git', ['archive', '--format=tar', base], {
    cwd,
    env: trustedGitEnv(),
    maxBuffer: 256 * 1024 * 1024,
  });
  if (archive.error || archive.status !== 0 || !archive.stdout) {
    throw new Error(
      `git archive failed${archive.stderr?.length ? `: ${String(archive.stderr).trim()}` : ''}`,
    );
  }
  const untar = spawnSync('tar', ['-xf', '-', '-C', dest], {
    input: archive.stdout,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (untar.error || untar.status !== 0) {
    throw new Error(
      `tar extraction failed${untar.stderr?.length ? `: ${String(untar.stderr).trim()}` : ''}`,
    );
  }

  // Make the common delegated Node verifier usable without copying candidate-
  // mutable dependencies into the trusted-base archive. The trace will resolve
  // accesses through this link back to the external dependency path and report
  // them as external/runtime evidence, never as suggested verify.inputs.
  const hostModules = join(cwd, 'node_modules');
  const tracedModules = join(dest, 'node_modules');
  if (existsSync(hostModules) && !existsSync(tracedModules)) {
    symlinkSync(resolve(hostModules), tracedModules, 'dir');
  }
}

function traceFiles(prefix: string): string[] {
  const dir = resolve(prefix, '..');
  const base = prefix.split(sep).at(-1) ?? prefix;
  return readdirSync(dir)
    .filter((name) => name === base || name.startsWith(base + '.'))
    .map((name) => join(dir, name))
    .sort();
}

function rewriteTraceRoot(
  accesses: TraceFileAccess[],
  actualRoot: string,
): TraceFileAccess[] {
  return accesses.map((item) => {
    const abs = isAbsolute(item.path) ? resolve(item.path) : resolve(actualRoot, item.path);
    if (!inside(actualRoot, abs)) return { ...item, path: abs };
    const rel = relative(actualRoot, abs).split(sep).join('/');

    // Resolve external dependency links while the materialisation still exists.
    try {
      const real = resolve(realpathSync(abs));
      if (!inside(actualRoot, real)) return { ...item, path: real };
    } catch {
      // Missing/generated path: preserve the lexical in-root spelling.
    }
    return { ...item, path: join(TRACE_ROOT, ...rel.split('/')) };
  });
}

/**
 * One `strace` invocation in `root`, reduced to a RawTraceRun plus the parsed file
 * accesses. It never throws on a tracer failure — an empty or absent trace, a denial
 * diagnostic, or a killed tracer are returned as data for `classifyTraceRun` to judge,
 * so the tracer's own status is never mistaken for the verifier's exit (#516).
 */
function straceOnce(
  root: string,
  command: string,
  budget: number,
): { raw: RawTraceRun; accesses: TraceFileAccess[] } {
  const traceDir = mkdtempSync(join(tmpdir(), 'tw-trace-log-'));
  try {
    const prefix = join(traceDir, 'trace');
    const traced = spawnSync(
      'strace',
      [
        '-ff',
        '-qq',
        '-s',
        '4096',
        '-e',
        'trace=%file',
        '-o',
        prefix,
        '--',
        'timeout',
        '--signal=TERM',
        '--kill-after=2s',
        `${budget}s`,
        'sh',
        '-c',
        command,
      ],
      {
        cwd: root,
        env: process.env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const logs = traced.error ? [] : traceFiles(prefix);
    const accesses = logs.flatMap((path) => parseStraceFileAccess(readFileSync(path, 'utf8')));
    const raw: RawTraceRun = {
      spawnError: traced.error ? traced.error.message : null,
      status: traced.status,
      signal: traced.signal ?? null,
      stderr: String(traced.stderr ?? '').slice(0, 8192),
      traceFileCount: logs.length,
      accessCount: accesses.length,
    };
    return { raw, accesses };
  } finally {
    rmSync(traceDir, { recursive: true, force: true });
  }
}

/**
 * Trace the trusted base once. `materializeBase` may throw (git/tar failure) and that
 * propagates as a genuine infrastructure error; the tracer's own outcome is classified,
 * so a ptrace denial mid-run is a `tracer-error`, not a misread verifier exit (#516).
 */
function runOneTrace(
  cwd: string,
  base: string,
  command: string,
  budget: number,
): { outcome: TraceRunOutcome; accesses: TraceFileAccess[] } {
  const root = mkdtempSync(join(tmpdir(), 'tw-trace-base-'));
  try {
    materializeBase(base, cwd, root);
    const { raw, accesses } = straceOnce(root, command, budget);
    return { outcome: classifyTraceRun(raw), accesses: rewriteTraceRoot(accesses, root) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Whether this environment can actually trace, learned by tracing a trusted no-op —
 * not by asking `strace --version`, which succeeds even when ptrace is denied (#516).
 * Runs in a throwaway directory, so the probe touches nothing in the repository.
 */
export function tracerPreflight(budget = 10): TraceRunOutcome {
  const probeRoot = mkdtempSync(join(tmpdir(), 'tw-trace-probe-'));
  try {
    const { raw } = straceOnce(probeRoot, 'true', Math.max(1, Math.min(budget, 10)));
    return classifyTraceRun(raw);
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

function renderText(report: TraceVerifyReport): void {
  const out = (s = ''): void => void process.stdout.write(s + '\n');
  out('tamperward trace-verify — ADVISORY observation, not an enforcement verdict');
  out(`trusted base: ${report.base}`);
  out(`command: ${report.command}`);
  out(`runs: ${report.runs_completed}/${report.runs_requested}; exits: ${report.run_exits.join(', ')}`);
  out();

  out('repository inputs observed:');
  if (!report.repository_inputs.length) out('  (none)');
  for (const item of report.repository_inputs) {
    const flags = [
      item.covered ? 'covered' : 'UNCOVERED',
      item.config ? 'config' : null,
      item.dynamic ? `dynamic ${item.observed_runs}/${report.runs_completed}` : null,
      item.accesses.join('+'),
    ].filter(Boolean).join(', ');
    out(`  ${item.path}  [${flags}]`);
  }

  out();
  out('external dependency/runtime paths observed:');
  if (!report.external_inputs.length) out('  (none)');
  for (const item of report.external_inputs) {
    out(
      `  ${item.path}  [${item.accesses.join('+')}${item.dynamic ? `, dynamic ${item.observed_runs}/${report.runs_completed}` : ''}]`,
    );
  }

  out();
  out('candidate verify.inputs entries for HUMAN REVIEW:');
  if (!report.suggested_verify_inputs.length) out('  (none — all observed tracked inputs are already covered)');
  for (const path of report.suggested_verify_inputs) out(`  - ${JSON.stringify(path)}`);

  out();
  for (const note of report.notes) out(`note: ${note}`);
}

export function runTraceVerify(opts: TraceVerifyOpts = {}): number {
  const cwd = resolve(opts.cwd ?? process.cwd());
  if (process.platform !== 'linux') {
    process.stderr.write('tamperward trace-verify: Linux only in this release; unsupported platform — no parity is implied.\n');
    return 2;
  }
  if (!commandExists('strace')) {
    process.stderr.write('tamperward trace-verify: strace is required on Linux but was not found.\n');
    return 2;
  }
  if (!commandExists('tar')) {
    process.stderr.write('tamperward trace-verify: tar is required to materialize the trusted base but was not found.\n');
    return 2;
  }
  if (!commandExists('timeout')) {
    process.stderr.write('tamperward trace-verify: GNU timeout is required to bound traced verifier runs but was not found.\n');
    return 2;
  }

  const runs = opts.runs ?? 2;
  if (!Number.isInteger(runs) || runs <= 0) {
    process.stderr.write(`tamperward trace-verify: --runs needs a positive integer (got ${JSON.stringify(opts.runs)}).\n`);
    return 2;
  }
  const requestedBase = opts.base ?? 'HEAD';
  let base: string;
  try {
    const baseArg = assertRev(requestedBase);
    base = git(['rev-parse', '--verify', `${baseArg}^{commit}`], cwd).trim();
  } catch (e) {
    process.stderr.write(`tamperward trace-verify: cannot resolve trusted base ${JSON.stringify(requestedBase)} (${e instanceof Error ? e.message : String(e)}).\n`);
    return 2;
  }

  let policy;
  try {
    policy = loadPolicyAt(base, cwd) ?? defaultPolicy();
  } catch (e) {
    process.stderr.write(`tamperward trace-verify: cannot load policy at trusted base (${e instanceof Error ? e.message : String(e)}).\n`);
    return 2;
  }
  const command = opts.cmd ?? policy.verify?.command;
  if (!command) {
    process.stderr.write('tamperward trace-verify: no verifier command; set verify.command at the base or pass --cmd.\n');
    return 2;
  }
  const budget = opts.budget ?? policy.verify?.budget ?? 300;
  if (!Number.isFinite(budget) || budget <= 0) {
    process.stderr.write(`tamperward trace-verify: --budget needs a positive number of seconds (got ${JSON.stringify(budget)}).\n`);
    return 2;
  }

  // Capability preflight (#516): `strace --version` succeeding does not mean the
  // process may trace. Prove tracing works on a trusted no-op before running the
  // verifier; a ptrace/seccomp/Yama denial is a tooling failure (exit 2), never a
  // verifier result — and no advisory report is emitted from an environment that could
  // observe nothing.
  const preflight = tracerPreflight(budget);
  if (preflight.kind === 'tracer-error') {
    process.stderr.write(
      `tamperward trace-verify: the tracer cannot observe in this environment, so no verifier input can be discovered — ${preflight.diagnostic}.\n` +
        'This is a tracing/tooling limitation (e.g. ptrace denied by seccomp or Yama), not a verifier result.\n',
    );
    return 2;
  }

  const atBase = trackedAt(base, cwd);
  const tracked = new Set(atBase);
  const covered = verifierCoveredInputs(command, atBase, policy);

  const observed: TraceFileAccess[][] = [];
  const runExits: number[] = [];
  try {
    for (let i = 0; i < runs; i++) {
      const { outcome, accesses } = runOneTrace(cwd, base, command, budget);
      if (outcome.kind === 'tracer-error') {
        // A tracer failure mid-run compromises the whole observation. Return the
        // tooling-failure code with a specific diagnostic and NO advisory report,
        // rather than a report of zero observations that reads like verifier evidence.
        process.stderr.write(
          `tamperward trace-verify: tracing failed during run ${i + 1}/${runs} — ${outcome.diagnostic}. No advisory report emitted.\n`,
        );
        return 2;
      }
      observed.push(accesses);
      runExits.push(outcome.exit);
    }
  } catch (e) {
    process.stderr.write(`tamperward trace-verify: tracing failed (${e instanceof Error ? e.message : String(e)}).\n`);
    return 2;
  }

  const summary = summarizeTraceRuns({
    root: TRACE_ROOT,
    runs: observed,
    tracked,
    covered,
  });
  const report: TraceVerifyReport = {
    advisory: true,
    platform: process.platform,
    base,
    command,
    runs_requested: runs,
    runs_completed: observed.length,
    run_exits: runExits,
    trace_complete: runExits.every((code) => code === 0),
    ...summary,
    notes: [
      'Observed reads are evidence from these runs, not proof that an unobserved path can never be read.',
      'Dynamic paths are those observed in fewer than all repeated traces.',
      'Suggestions are exact tracked paths only; TamperWard never edits .tamperward.yml or widens a glob automatically.',
      'Review every suggestion before adding it to verify.inputs.',
    ],
  };

  if (opts.json) process.stdout.write(JSON.stringify(report) + '\n');
  else renderText(report);

  // A failed known-good run makes the observation incomplete. Keep the report, but
  // do not return success as though the trace represented a healthy verifier.
  return report.trace_complete ? 0 : 1;
}

export function parseTraceVerify(args: string[]): TraceVerifyOpts {
  const out: TraceVerifyOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') out.json = true;
    else if (a === '--base') out.base = args[++i];
    else if (a === '--cmd') out.cmd = args[++i];
    else if (a === '--cwd') out.cwd = args[++i];
    else if (a === '--budget') out.budget = Number(args[++i]);
    else if (a === '--runs') out.runs = Number(args[++i]);
  }
  return out;
}
