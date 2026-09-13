// Bounded suite-output capture used by both verifier execution backends.
//
// Why a supervisor instead of spawnSync(..., { stdio: 'pipe' }): spawnSync has
// a finite maxBuffer and stops the child when that buffer fills. Candidate test
// output is untrusted, so "very noisy" must not silently become a different
// verifier outcome. The tiny async supervisor continuously drains both pipes,
// retains only a fixed tail, and reports through a file outside the candidate
// worktree. The caller remains synchronous.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DIAGNOSTIC_TAIL_BYTES = 16 * 1024;

export interface StreamDiagnostics {
  captured_bytes: number;
  retained_bytes: number;
  truncated: boolean;
  tail: string;
}

export interface SuiteDiagnostics {
  stdout: StreamDiagnostics;
  stderr: StreamDiagnostics;
}

export interface CapturedProcessResult {
  exit: number | null;
  signal: string | null;
  timedOut: boolean;
  error?: string;
  diagnostics: SuiteDiagnostics;
}

export interface CapturedProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Put the child in a new POSIX process group. */
  detached?: boolean;
  /** Kill that process group when the main child exits or times out. */
  killGroupOnFinish?: boolean;
  /** Extra allowance for supervisor/cleanup after the trusted timeout. */
  backstopMs?: number;
}

type RawStream = { captured_bytes?: number; tail_b64?: string };
type RawResult = {
  exit?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  error?: string;
  stdout?: RawStream;
  stderr?: RawStream;
};

const EMPTY_STREAM: StreamDiagnostics = {
  captured_bytes: 0,
  retained_bytes: 0,
  truncated: false,
  tail: '',
};

export function emptySuiteDiagnostics(): SuiteDiagnostics {
  return {
    stdout: { ...EMPTY_STREAM },
    stderr: { ...EMPTY_STREAM },
  };
}

function streamFromRaw(raw: RawStream | undefined): StreamDiagnostics {
  let tail = Buffer.alloc(0);
  try {
    tail = Buffer.from(raw?.tail_b64 ?? '', 'base64');
  } catch {
    tail = Buffer.alloc(0);
  }
  const captured = Number.isFinite(raw?.captured_bytes)
    ? Math.max(0, Number(raw?.captured_bytes))
    : tail.length;
  return {
    captured_bytes: captured,
    retained_bytes: tail.length,
    truncated: captured > tail.length,
    tail: tail.toString('utf8'),
  };
}

/**
 * Candidate text is data, never terminal/workflow syntax.
 *
 * - preserve newline + tab so diagnostics remain readable;
 * - escape C0/C1/DEL controls, especially ESC/CR;
 * - callers prefix every rendered line, so GitHub's ::command:: grammar can
 *   never begin at column zero even when the candidate prints it literally.
 */
export function scrubDiagnosticText(input: string): string {
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\n' || ch === '\t') {
      out += ch;
    } else if (cp === 0x0d) {
      out += '\\r';
    } else if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) {
      out += cp <= 0xff
        ? `\\x${cp.toString(16).padStart(2, '0')}`
        : `\\u{${cp.toString(16)}}`;
    } else {
      out += ch;
    }
  }
  return out;
}

export function diagnosticLines(stage: string, diagnostics: SuiteDiagnostics): string[] {
  const lines: string[] = [];
  for (const streamName of ['stdout', 'stderr'] as const) {
    const stream = diagnostics[streamName];
    if (stream.captured_bytes === 0) continue;
    const suffix = stream.truncated
      ? ` — tail ${stream.retained_bytes}/${stream.captured_bytes} bytes retained`
      : ` — ${stream.captured_bytes} bytes`;
    lines.push(`${stage} suite ${streamName}${suffix}:`);
    const scrubbed = scrubDiagnosticText(stream.tail);
    const body = scrubbed.split('\n');
    // Avoid manufacturing one extra empty visual row for a trailing newline.
    if (body.at(-1) === '') body.pop();
    for (const line of body) lines.push(`  | ${line}`);
  }
  return lines;
}

// Runs under process.execPath, with the caller-supplied trusted environment.
// Configuration is read from a trusted temp file rather than argv so a long
// suite command cannot run into platform argv limits earlier than the suite
// itself would.
const CAPTURE_SUPERVISOR = String.raw`
const cp = require('node:child_process');
const fs = require('node:fs');

const [configFile] = process.argv.slice(1);
const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const CAP = Number(cfg.captureBytes);

const fresh = () => ({ total: 0, tail: Buffer.alloc(0) });
const stdout = fresh();
const stderr = fresh();

function append(state, chunk) {
  const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.total += b.length;
  if (b.length >= CAP) {
    state.tail = Buffer.from(b.subarray(b.length - CAP));
    return;
  }
  if (state.tail.length + b.length <= CAP) {
    state.tail = Buffer.concat([state.tail, b]);
    return;
  }
  const keep = CAP - b.length;
  state.tail = Buffer.concat([state.tail.subarray(state.tail.length - keep), b]);
}

function diag(state) {
  return {
    captured_bytes: state.total,
    tail_b64: state.tail.toString('base64'),
  };
}

let child;
let done = false;
let timedOut = false;
let exitInfo = { exit: null, signal: null };

function killOwned() {
  if (!child || !child.pid) return;
  if (cfg.detached && process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  try { child.kill('SIGKILL'); } catch {}
}

function finish(extra) {
  if (done) return;
  done = true;
  try {
    // stdout is reserved for the trusted supervisor result. Candidate suite
    // stdout/stderr are separate pipes and are never inherited here.
    process.stdout.write(JSON.stringify({
      ...exitInfo,
      timedOut,
      ...extra,
      stdout: diag(stdout),
      stderr: diag(stderr),
    }));
  } catch {}
  process.exit(0);
}

try {
  child = cp.spawn(cfg.executable, cfg.args, {
    cwd: cfg.cwd,
    env: process.env,
    detached: Boolean(cfg.detached) && process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  finish({ error: String(e) });
}

if (child) {
  child.stdout.on('data', (b) => append(stdout, b));
  child.stderr.on('data', (b) => append(stderr, b));

  const timer = setTimeout(() => {
    timedOut = true;
    killOwned();
    // Backstop if a platform fails to emit close after the forced kill.
    setTimeout(() => finish({}), 1000).unref();
  }, Number(cfg.timeoutMs));
  timer.unref();

  child.on('error', (e) => {
    clearTimeout(timer);
    killOwned();
    finish({ error: String(e) });
  });

  child.on('exit', (code, signal) => {
    exitInfo = {
      exit: code == null ? null : Number(code),
      signal: signal == null ? null : String(signal),
    };
    if (cfg.killGroupOnFinish) killOwned();
  });

  // close fires after the stdio pipes close, so the retained tails include all
  // output that was drained before owned descendants were terminated.
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    if (exitInfo.exit === null && code != null) exitInfo.exit = Number(code);
    if (exitInfo.signal === null && signal != null) exitInfo.signal = String(signal);
    finish({});
  });
}
`;

export function runCapturedProcessSync(
  executable: string,
  args: string[],
  opts: CapturedProcessOptions,
): CapturedProcessResult {
  const stateDir = mkdtempSync(join(tmpdir(), 'tw-suite-capture-'));
  const configFile = join(stateDir, 'config.json');
  const backstop = opts.backstopMs ?? 30_000;
  try {
    writeFileSync(
      configFile,
      JSON.stringify({
        executable,
        args,
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        detached: Boolean(opts.detached),
        killGroupOnFinish: Boolean(opts.killGroupOnFinish),
        captureBytes: DIAGNOSTIC_TAIL_BYTES,
      }),
      { mode: 0o600 },
    );

    const supervisor = spawnSync(
      process.execPath,
      ['-e', CAPTURE_SUPERVISOR, configFile],
      {
        cwd: opts.cwd,
        env: opts.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        // The trusted result is at most two 16 KiB tails plus small metadata.
        // A candidate that somehow writes into the supervisor's stdout through
        // same-UID /proc can only overflow/corrupt this bounded channel and make
        // parsing fail closed; its suite streams are never inherited here.
        maxBuffer: 256 * 1024,
        timeout: opts.timeoutMs + backstop,
        killSignal: 'SIGKILL',
      },
    );

    let raw: RawResult | null = null;
    try {
      raw = JSON.parse(supervisor.stdout ?? '') as RawResult;
    } catch {
      raw = null;
    }

    const diagnostics: SuiteDiagnostics = raw
      ? {
          stdout: streamFromRaw(raw.stdout),
          stderr: streamFromRaw(raw.stderr),
        }
      : emptySuiteDiagnostics();

    if (!raw) {
      const supervisorTimedOut =
        Boolean(supervisor.error) &&
        (supervisor.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
      return {
        exit: null,
        signal: supervisor.signal ? String(supervisor.signal) : null,
        timedOut: supervisorTimedOut,
        error: supervisor.error?.message ?? 'suite capture supervisor did not produce a result',
        diagnostics,
      };
    }

    return {
      exit: typeof raw.exit === 'number' ? raw.exit : null,
      signal: raw.signal ?? null,
      timedOut: Boolean(raw.timedOut),
      ...(raw.error ? { error: raw.error } : {}),
      diagnostics,
    };
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}
