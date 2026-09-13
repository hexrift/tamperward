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
    const quoted = afterCall.match(/"((?:\\.|[^"])*)"/);
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
      const keyPath = isTracked ? rel! : (rel === null ? resolve(opts.root, item.path) : null);
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
  const base = prefix.split(sep).at(-1)!;
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

function runOneTrace(
  cwd: string,
  base: string,
  command: string,
  budget: number,
): { exit: number; accesses: TraceFileAccess[] } {
  const root = mkdtempSync(join(tmpdir(), 'tw-trace-base-'));
  const traceDir = mkdtempSync(join(tmpdir(), 'tw-trace-log-'));
  try {
    materializeBase(base, cwd, root);
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
    if (traced.error) throw traced.error;

    const logs = traceFiles(prefix);
    if (logs.length === 0) {
      throw new Error('strace produced no trace files');
    }
    const accesses = logs.flatMap((path) => parseStraceFileAccess(readFileSync(path, 'utf8')));
    return {
      exit: traced.status ?? 1,
      accesses: rewriteTraceRoot(accesses, root),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(traceDir, { recursive: true, force: true });
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

  const atBase = trackedAt(base, cwd);
  const tracked = new Set(atBase);
  const covered = verifierCoveredInputs(command, atBase, policy);

  const observed: TraceFileAccess[][] = [];
  const runExits: number[] = [];
  try {
    for (let i = 0; i < runs; i++) {
      const result = runOneTrace(cwd, base, command, budget);
      observed.push(result.accesses);
      runExits.push(result.exit);
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
