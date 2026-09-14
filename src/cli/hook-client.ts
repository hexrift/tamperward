// The thin client of the persistent hook service (#322).
//
// This module is what `tamperward hook claude` / `sweep claude` run FIRST when the
// operator has opted in (TAMPERWARD_HOOK_SERVICE=1): it hands the raw stdin
// payload to the warm service over a per-user unix socket and relays the verdict.
// It imports node built-ins and the shipped version only — never the engine, never
// the detectors, never `typescript` — because the whole saving is not loading
// those. The launcher (src/cli/index.ts) loads the full CLI only when this
// returns null.
//
// Null means SAFE FALLBACK, and fallback means the ordinary in-process evaluation:
// the same code, the same verdict, only slower. It is returned only while the
// service has not taken ownership of the request (or explicitly refuses before
// evaluation). After handoff, ambiguity is a fail-closed HookResult instead. There
// is no path here that turns service failure into an allow:
//
//   - no opt-in, or Windows (no per-user unix socket contract in this release);
//   - the socket's directory is not a directory this uid owns at mode 0700;
//   - the socket is not a socket (a link, a file), or not this uid's, or its mode
//     lets any other user connect;
//   - the service answers on a different protocol, or is a different TamperWard
//     version from the client (the pinned hook command decides the version, not
//     whatever process happens to be listening);
//   - the service refuses the request before accepting ownership (for example a
//     cwd outside the bound repository), or cannot be reached at all.
//
// Once the socket connects and the request is handed off, fallback is deliberately
// no longer allowed: the service may have received it even if an ACK is delayed.
// Only an explicit service refusal proves evaluation never started. An ambiguous
// timeout, disconnect or malformed response after handoff becomes a fail-closed
// HookResult so there is still exactly one authority evaluation.
//
// Trust argument, stated once. The service runs as the same uid as the hook and
// as the candidate; a same-uid candidate could stop it and start something else
// on the socket. That is the loop layer's existing boundary — the candidate can
// already write `.git/tamperward/*` and the settings that wire the hook — and it
// widens no authority: the Stop sweep, pre-commit and CI read none of this. What
// the socket checks close is the cross-uid case (a shared /tmp on a multi-user
// host) and the accidental case (a stale socket, a wrong version).

import { lstatSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookResult } from './hook';
import { TW_VERSION } from '../wiring';

export const HOOK_SERVICE_PROTOCOL = 1;
export const HOOK_SERVICE_ENV = 'TAMPERWARD_HOOK_SERVICE';
export const HOOK_SERVICE_DIR_ENV = 'TAMPERWARD_HOOK_SERVICE_DIR';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface ServicePaths {
  dir: string;
  socket: string;
  state: string;
}

export type HookKind = 'PreToolUse' | 'Stop';

export interface ServicePathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  tmp?: string;
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/** Whether the operator opted the hook in to consulting the service. Off by default. */
export function hookServiceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HOOK_SERVICE_ENV] === '1';
}

/**
 * Where this user's service lives: `$XDG_RUNTIME_DIR/tamperward-hook` when the
 * platform provides a private runtime directory, else `<tmp>/tamperward-hook-<uid>`.
 * `TAMPERWARD_HOOK_SERVICE_DIR` overrides both (tests, unusual layouts); the
 * ownership and mode checks apply to it just the same. Null on Windows: this
 * release has no named-pipe transport, and the launcher then never consults a
 * service — the hook is the ordinary in-process one.
 */
export function servicePaths(opts: ServicePathOptions = {}): ServicePaths | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const uid = opts.uid ?? currentUid();
  if (platform === 'win32' || uid === undefined) return null;
  const override = env[HOOK_SERVICE_DIR_ENV];
  const runtime = env.XDG_RUNTIME_DIR;
  const dir = override && override.trim() ? override : runtime && runtime.trim() ? join(runtime, 'tamperward-hook') : join(opts.tmp ?? tmpdir(), `tamperward-hook-${uid}`);
  return { dir, socket: join(dir, 'hook.sock'), state: join(dir, 'hook-service.json') };
}

/**
 * Why the socket must not be used, or null when it may. Never follows a link:
 * the socket path is inspected with lstat, so a symbolic link planted at it is
 * "not a socket", whatever it points at.
 */
export function socketRefusal(paths: ServicePaths, uid: number | undefined = currentUid()): string | null {
  if (uid === undefined) return 'no uid on this platform';
  let dir;
  try {
    dir = lstatSync(paths.dir);
  } catch {
    return `service directory ${paths.dir} is absent`;
  }
  if (!dir.isDirectory()) return `service directory ${paths.dir} is not a directory`;
  if (dir.uid !== uid) return `service directory ${paths.dir} is owned by uid ${dir.uid}, not ${uid}`;
  if ((dir.mode & 0o077) !== 0) return `service directory ${paths.dir} mode ${(dir.mode & 0o777).toString(8)} is not 0700`;
  let sock;
  try {
    sock = lstatSync(paths.socket);
  } catch {
    return `service socket ${paths.socket} is absent`;
  }
  if (!sock.isSocket()) return `service socket ${paths.socket} is not a socket`;
  if (sock.uid !== uid) return `service socket ${paths.socket} is owned by uid ${sock.uid}, not ${uid}`;
  if ((sock.mode & 0o077) !== 0) return `service socket ${paths.socket} mode ${(sock.mode & 0o777).toString(8)} is not 0600`;
  return null;
}

/** The environment the service must evaluate under on the client's behalf.
 * Keep this list to variables the hook engine itself interprets. In particular
 * Claude's config/home roots are verdict inputs: they decide whether an absolute
 * path names live hook wiring. A warm service may have been started from a
 * different shell/supervisor, so consulting its ambient values would make the
 * same payload produce a different verdict than the in-process hook. */
export const FORWARDED_ENV = [
  'TAMPERWARD_DENYLOG',
  'TAMPERWARD_FSEVENTS',
  'TAMPERWARD_TRANSIENT',
  'CLAUDE_CONFIG_DIR',
  'HOME',
  'USERPROFILE',
] as const;

export interface ServiceRequest {
  v: number;
  version: string;
  kind: HookKind | 'status';
  raw: string;
  cwd: string;
  env: Record<string, string>;
}

export interface RequestOptions {
  paths?: ServicePaths | null;
  cwd?: string;
  uid?: number;
  version?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function forwardedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of FORWARDED_ENV) {
    const v = env[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

interface AcceptedFailure {
  accepted: true;
  failure: 'timeout' | 'connection-closed' | 'response-too-large' | 'malformed-response';
}

/** One request, one connection. The request becomes single-owner as soon as
 * the socket connects and the bytes are handed to the service: after that point
 * a timeout cannot prove the service did not receive/start it. An explicit
 * refusal response is the only post-connect route back to in-process fallback.
 * The service's `accepted` line remains an observable protocol boundary, but
 * safety does not depend on the client receiving it before a timer fires. */
export function exchange(paths: ServicePaths, req: ServiceRequest, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve) => {
    let done = false;
    let handedOff = false;
    let accepted = false;
    let buf = '';
    const acceptedFailure = (failure: AcceptedFailure['failure']): AcceptedFailure => ({ accepted: true, failure });
    const finish = (value: unknown): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(value);
    };
    const sock = createConnection(paths.socket);
    const timer = setTimeout(() => finish(handedOff ? acceptedFailure('timeout') : null), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('error', () => finish(handedOff ? acceptedFailure('connection-closed') : null));
    sock.on('connect', () => {
      handedOff = true;
      sock.write(JSON.stringify(req) + '\n');
    });
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_RESPONSE_BYTES) return finish(handedOff ? acceptedFailure('response-too-large') : null);
      while (!done) {
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return finish(handedOff ? acceptedFailure('malformed-response') : null);
        }
        if (
          !accepted &&
          isRecord(parsed) &&
          parsed.v === HOOK_SERVICE_PROTOCOL &&
          parsed.version === req.version &&
          parsed.accepted === true
        ) {
          accepted = true;
          continue;
        }
        finish(parsed);
      }
    });
    sock.on('close', () => finish(handedOff ? acceptedFailure('connection-closed') : null));
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function acceptedFailureResult(kind: HookKind, failure: string): HookResult {
  const reason =
    `Tamperward handed this hook evaluation to the service but did not receive a verdict (${failure}). ` +
    'It is denied rather than evaluated a second time concurrently.';
  const payload =
    kind === 'PreToolUse'
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
      : { decision: 'block', reason };
  return { exitCode: 0, stdout: JSON.stringify(payload) + '\n' };
}

/**
 * The verdict the service gives `raw`, or null only while it is still safe for
 * the in-process gate to decide instead (the service has not accepted ownership).
 * After acceptance, transport failure becomes a synthetic fail-closed HookResult
 * rather than a concurrent retry. Normal HookResults are still relayed byte for byte.
 */
export async function requestVerdict(kind: HookKind, raw: string, opts: RequestOptions = {}): Promise<HookResult | null> {
  const paths = opts.paths === undefined ? servicePaths() : opts.paths;
  if (!paths) return null;
  if (socketRefusal(paths, opts.uid) !== null) return null;
  const version = opts.version ?? TW_VERSION;
  const req: ServiceRequest = {
    v: HOOK_SERVICE_PROTOCOL,
    version,
    kind,
    raw,
    cwd: opts.cwd ?? process.cwd(),
    env: forwardedEnv(opts.env ?? process.env),
  };
  const res = await exchange(paths, req, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!isRecord(res)) return null;
  if (res.accepted === true && typeof res.failure === 'string') {
    return acceptedFailureResult(kind, res.failure);
  }
  if (res.v !== HOOK_SERVICE_PROTOCOL || res.version !== version) return null;
  if (typeof res.exitCode !== 'number' || typeof res.stdout !== 'string') return null;
  return { exitCode: res.exitCode, stdout: res.stdout };
}
