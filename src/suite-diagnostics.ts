// Bounded suite-output capture used by both verifier execution backends.
//
// Why a supervisor instead of spawnSync(..., { stdio: 'pipe' }): spawnSync has
// a finite maxBuffer and stops the child when that buffer fills. Candidate test
// output is untrusted, so "very noisy" must not silently become a different
// verifier outcome. The tiny async supervisor continuously drains both pipes,
// retains only a fixed tail, and reports through the supervisor's reserved
// stdout channel. The caller remains synchronous.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errnoCode, isRecord } from './narrow';

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
  /** A descendant still held a stdio pipe open past the post-exit drain window. */
  pipeHeldOpen?: boolean;
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
  /** Grace period (ms) to drain the pipes after the child exits before
   *  finishing anyway, so a descendant holding a pipe open cannot stall it.
   *  Defaults to 1000. */
  drainMs?: number;
}

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

function decodeUtf8Tail(tail: Buffer): string {
  // The retained byte window can begin in the middle of a UTF-8 code point.
  // Drop only leading continuation bytes; never manufacture U+FFFD at the
  // trust boundary merely because the byte cap cut through a character.
  let start = 0;
  while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
  return tail.subarray(start).toString('utf8');
}

function streamFromRaw(value: unknown): StreamDiagnostics {
  const raw = isRecord(value) ? value : {};
  let tail = Buffer.alloc(0);
  try {
    tail = Buffer.from(typeof raw.tail_b64 === 'string' ? raw.tail_b64 : '', 'base64');
  } catch {
    tail = Buffer.alloc(0);
  }
  const captured = typeof raw.captured_bytes === 'number' && Number.isFinite(raw.captured_bytes)
    ? Math.max(0, raw.captured_bytes)
    : tail.length;
  return {
    captured_bytes: captured,
    retained_bytes: tail.length,
    truncated: captured > tail.length,
    tail: decodeUtf8Tail(tail),
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
    const cp = ch.codePointAt(0) ?? 0;
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

// Linux ordinary-exit hardening (#371): process-group ownership alone misses a
// descendant that calls setsid(). Track the real descendant tree while the
// suite is alive so a reparented session escape is still known when the main
// child exits. This supplements, rather than replaces, group termination.
const trackedDescendants = new Set();

function linuxDescendants(rootPid) {
  if (process.platform !== 'linux' || !rootPid) return [];
  const byParent = new Map();
  let names = [];
  try { names = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)); } catch { return []; }
  for (const name of names) {
    const pid = Number(name);
    try {
      const stat = fs.readFileSync('/proc/' + name + '/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(fields[1]);
      if (!Number.isFinite(ppid)) continue;
      const kids = byParent.get(ppid) || [];
      kids.push(pid);
      byParent.set(ppid, kids);
    } catch {}
  }
  const out = [];
  const seen = new Set([rootPid]);
  const stack = [rootPid];
  while (stack.length) {
    const parent = stack.pop();
    for (const pid of (byParent.get(parent) || [])) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      out.push(pid);
      stack.push(pid);
    }
  }
  return out;
}

function trackDescendants() {
  if (!child || !child.pid || process.platform !== 'linux') return;
  for (const pid of linuxDescendants(child.pid)) trackedDescendants.add(pid);
}

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
let descendantTracker = null;
let drainTimer = null;

function killOwned() {
  if (!child || !child.pid) return;
  trackDescendants();
  if (cfg.detached && process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  try { child.kill('SIGKILL'); } catch {}
  if (process.platform === 'linux') {
    // Deepest-first is friendlier to short-lived process trees. PIDs are still
    // rechecked by kill(2); races with natural exit are harmless.
    for (const pid of Array.from(trackedDescendants).reverse()) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
}

function finish(extra) {
  if (done) return;
  done = true;
  if (descendantTracker) clearInterval(descendantTracker);
  if (drainTimer) clearTimeout(drainTimer);
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
  if (process.platform === 'linux') {
    trackDescendants();
    descendantTracker = setInterval(trackDescendants, 5);
    descendantTracker.unref();
  }
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
    // A leaked descendant can hold a pipe open so 'close' never fires; finish off
    // exit after a bounded drain instead of hanging. 'close' still wins if first.
    if (!drainTimer) {
      drainTimer = setTimeout(() => finish({ pipeHeldOpen: true }), Number(cfg.drainMs));
      drainTimer.unref();
    }
  });

  // close fires after the stdio pipes close, so the retained tails include all
  // output that was drained before owned descendants were terminated.
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    if (drainTimer) clearTimeout(drainTimer);
    if (exitInfo.exit === null && code != null) exitInfo.exit = Number(code);
    if (exitInfo.signal === null && signal != null) exitInfo.signal = String(signal);
    finish({});
  });
}
`;

/**
 * Parse the supervisor's reserved result channel as exactly one JSON value.
 * Candidate bytes prefixed/appended through same-UID /proc access must corrupt
 * the whole channel and fail closed; never scan for a plausible JSON suffix.
 */
export function parseCapturedSupervisorResult(stdoutText: string): CapturedProcessResult | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdoutText);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const diagnostics: SuiteDiagnostics = {
    stdout: streamFromRaw(raw.stdout),
    stderr: streamFromRaw(raw.stderr),
  };
  return {
    exit: typeof raw.exit === 'number' ? raw.exit : null,
    signal: typeof raw.signal === 'string' ? raw.signal : null,
    timedOut: Boolean(raw.timedOut),
    ...(typeof raw.error === 'string' && raw.error ? { error: raw.error } : {}),
    ...(raw.pipeHeldOpen === true ? { pipeHeldOpen: true } : {}),
    diagnostics,
  };
}

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
        drainMs: opts.drainMs ?? 1000,
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

    const parsed = parseCapturedSupervisorResult(supervisor.stdout ?? '');
    const diagnostics = parsed?.diagnostics ?? emptySuiteDiagnostics();

    if (!parsed) {
      const supervisorTimedOut =
        Boolean(supervisor.error) &&
        errnoCode(supervisor.error) === 'ETIMEDOUT';
      return {
        exit: null,
        signal: supervisor.signal ? String(supervisor.signal) : null,
        timedOut: supervisorTimedOut,
        error: supervisor.error?.message ?? 'suite capture supervisor did not produce a result',
        diagnostics,
      };
    }

    return parsed;
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}
