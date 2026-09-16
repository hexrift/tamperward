// `tamperward hook-service start|stop|status` — the opt-in persistent hook
// service (#322).
//
// Every PreToolUse call launches the pinned hook as a fresh Node process, and
// most of that call is startup: loading the bundle and the `typescript` package
// the AST detectors import, before a byte of policy is read. This service keeps
// ONE such process warm, per user, per repository, and evaluates hook requests
// handed to it over a unix socket by the thin client (src/cli/hook-client.ts).
// It runs the very same `preToolUseFromRaw` / `stopFromRaw` the in-process hook
// runs, on the same stdin bytes, with the client's cwd and the client's
// per-session environment; the verdict is the same object, relayed.
//
// What it keeps warm beyond the process: the protected-tree snapshot cache
// (src/ptree-cache.ts), in its own memory, keyed on ctime and never on the stat
// triple the candidate can set. Everything else — the policy, the git views,
// the `.git/tamperward` state — is read fresh per request, as before.
//
// Lifecycle is the OPERATOR'S: `start` is a foreground process (run it from a
// SessionStart hook, a terminal, or a supervisor), `stop` signals it, `status`
// asks it. The client only ever consults it under TAMPERWARD_HOOK_SERVICE=1.
// Before a request is handed off, an absent/stale/dead/wrong-version/untrusted
// service falls back to the ordinary in-process hook. After handoff, ambiguous
// transport failure fails closed rather than launching a concurrent second
// evaluation. Nothing here can turn service failure into an allow.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, Server, Socket } from 'node:net';
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { errnoCode, isRecord } from '../narrow';
import { TW_VERSION } from '../wiring';
import { SnapshotCache } from '../ptree-cache';
import { repoRoot } from '../repo-context';
import { preToolUseFromRaw, setSnapshotCache, stopFromRaw } from './hook';
import { exitAfterFlush } from './exit';
import {
  exchange,
  FORWARDED_ENV,
  HOOK_SERVICE_ENV,
  HOOK_SERVICE_PROTOCOL,
  hookServiceEnabled,
  servicePaths,
  socketRefusal,
  type ServicePaths,
  type ServiceRequest,
} from './hook-client';

const MAX_REQUEST_BYTES = 64 * 1024 * 1024; // a Write payload carries the whole file
const STOP_WAIT_MS = 10_000;
// Cap a client that never finishes its request line, so it cannot hold a socket open.
const REQUEST_DEADLINE_MS = 30_000;
// Grace for an in-flight evaluation to finish during shutdown before its socket is destroyed.
const SHUTDOWN_DRAIN_MS = 5_000;

export interface ServiceState {
  pid: number;
  version: string;
  root: string;
  started_at: string;
}

export interface StartOptions {
  /** The repository the service is bound to: requests from outside it are refused. */
  root: string;
  paths?: ServicePaths | null;
  cache?: SnapshotCache;
}

export interface RunningService {
  paths: ServicePaths;
  root: string;
  readonly served: number;
  close(): Promise<void>;
}

/** The state file, or null when absent or not the shape this module writes. */
export function readServiceState(paths: ServicePaths): ServiceState | null {
  try {
    const v: unknown = JSON.parse(readFileSync(paths.state, 'utf8'));
    if (!isRecord(v)) return null;
    const { pid, version, root, started_at } = v;
    if (typeof pid !== 'number' || typeof version !== 'string' || typeof root !== 'string' || typeof started_at !== 'string') return null;
    return { pid, version, root, started_at };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errnoCode(e) === 'EPERM';
  }
}

/** Whether a connection to the socket is accepted within a second. */
function listening(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection(socket);
    const done = (v: boolean): void => {
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(false), 1000);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function within(root: string, cwd: string): boolean {
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    return false;
  }
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The cwd the payload names, when it names one — checked against the binding
 *  the same way the client's own cwd is. Lenient on purpose: the hook's own
 *  parser decides what the payload means; this only asks where it points. */
function payloadCwd(raw: string): string | null {
  try {
    const v: unknown = JSON.parse(raw);
    return isRecord(v) && typeof v.cwd === 'string' ? v.cwd : null;
  } catch {
    return null;
  }
}

function requestFrom(value: unknown): ServiceRequest | null {
  if (!isRecord(value)) return null;
  const { v, version, kind, raw, cwd, env } = value;
  if (typeof v !== 'number' || typeof version !== 'string' || typeof cwd !== 'string') return null;
  if (kind !== 'PreToolUse' && kind !== 'Stop' && kind !== 'status') return null;
  if (typeof raw !== 'string') return null;
  const fwd: Record<string, string> = {};
  if (isRecord(env)) {
    for (const k of FORWARDED_ENV) if (typeof env[k] === 'string') fwd[k] = env[k];
  }
  return { v, version, kind, raw, cwd, env: fwd };
}

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const saved: Array<[string, string | undefined]> = FORWARDED_ENV.map((k) => [k, process.env[k]]);
  for (const k of FORWARDED_ENV) {
    if (k in env) process.env[k] = env[k];
    else delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function removeQuietly(p: string): void {
  try {
    rmSync(p, { force: true });
  } catch {
    /* best effort */
  }
}

/** Make sure the runtime directory is ours, private, and a directory. */
function ensurePrivateDir(dir: string, uid: number): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (st.uid !== uid) throw new Error(`${dir} is owned by uid ${st.uid}, not ${uid}; refusing to serve from it`);
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/** Start serving. Exported so tests drive it in-process; the CLI wraps it below. */
export async function startHookService(opts: StartOptions): Promise<RunningService> {
  const paths = opts.paths === undefined ? servicePaths() : opts.paths;
  if (!paths) {
    throw new Error(
      'the persistent hook service needs a per-user unix socket; this release has no Windows named-pipe transport, so the hook runs in-process there',
    );
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid === undefined) throw new Error('no uid on this platform; refusing to start');
  let root: string;
  try {
    // Bound to the REPOSITORY, not to the directory the service was started
    // from: a service started in `packages/x` serves the whole checkout, and
    // every verdict it computes is rooted (#412).
    root = realpathSync(repoRoot(realpathSync(opts.root)));
  } catch {
    throw new Error(`cannot resolve ${opts.root}`);
  }
  ensurePrivateDir(paths.dir, uid);
  // Is anything actually answering on the socket? The state file's pid is
  // advisory (a crashed service leaves it behind; a test starts two in one
  // process); a live listener is the fact that matters.
  if (socketRefusal(paths, uid) === null && (await listening(paths.socket))) {
    const prior = readServiceState(paths);
    throw new Error(`a hook service is already running${prior ? ` (pid ${prior.pid}) for ${prior.root}` : ''} on ${paths.socket}`);
  }
  // Whatever is left of an earlier service that did not get to clean up.
  removeQuietly(paths.socket);
  removeQuietly(paths.state);

  const cache = opts.cache ?? new SnapshotCache();
  let served = 0;
  // This process evaluates synchronously and is single-threaded. Only ONE
  // PreToolUse/Stop evaluation may own the session state at a time; a second
  // request that arrives while one is in flight is refused BEFORE acceptance so
  // its client falls back in-process exactly once, rather than queueing behind
  // the first — where the client's timer (started at connect) can fire, deny,
  // and yet leave this service to evaluate it anyway and apply side effects
  // (predicted-write sanctions, ptree saves, turn-baseline advances) for a tool
  // call the client already abandoned (#416). A refused request is never
  // evaluated here, so it records no side effects.
  let inFlight = false;
  // All open connections, so shutdown can destroy any that outlive the drain window;
  // acceptedSocket is the one with an evaluation in flight, which gets the drain first.
  const sockets = new Set<Socket>();
  let acceptedSocket: Socket | null = null;
  const startedAt = new Date().toISOString();

  const respond = (sock: Socket, body: Record<string, unknown>): void => {
    try {
      sock.end(JSON.stringify({ v: HOOK_SERVICE_PROTOCOL, version: TW_VERSION, ...body }) + '\n');
    } catch {
      /* the client is gone; pre-accept refusal may fall back, post-handoff loss is fail-closed */
    }
  };

  const handle = (sock: Socket, line: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return respond(sock, { refused: 'malformed request' });
    }
    const req = requestFrom(parsed);
    if (!req) return respond(sock, { refused: 'malformed request' });
    if (req.v !== HOOK_SERVICE_PROTOCOL) return respond(sock, { refused: `protocol ${req.v}` });
    if (req.version !== TW_VERSION) return respond(sock, { refused: `version ${req.version}` });
    if (req.kind === 'status') {
      return respond(sock, {
        pid: process.pid,
        root,
        started_at: startedAt,
        served,
        cache: { hits: cache.stats.hits, misses: cache.stats.misses, size: cache.size },
      });
    }
    if (!within(root, req.cwd)) return respond(sock, { refused: 'cwd outside the bound repository' });
    const named = payloadCwd(req.raw);
    if (named !== null && !within(root, named)) return respond(sock, { refused: 'payload cwd outside the bound repository' });

    // Single-owner evaluation. If another request already owns the evaluator,
    // refuse this one BEFORE any acceptance: the client then falls back to the
    // in-process gate exactly once, and this service never evaluates it, so no
    // side effects are recorded for a request it did not serve (#416). The flag
    // is set synchronously here and cleared only after the accepted request's
    // evaluation completes.
    if (inFlight) return respond(sock, { refused: 'another request is in flight' });
    inFlight = true;
    acceptedSocket = sock;

    // Ownership handoff. The client may fall back in-process only BEFORE this
    // line. Once it sees accepted=true, this service is the sole evaluator for
    // the request; a later timeout/connection loss must fail closed instead of
    // starting a second evaluation over the same session state.
    sock.write(JSON.stringify({ v: HOOK_SERVICE_PROTOCOL, version: TW_VERSION, accepted: true }) + '\n');
    // Defer the synchronous evaluation to the CHECK phase (setImmediate), which
    // runs strictly after every poll-phase read. Any request already pending on
    // another connection is therefore read — and refused above, since inFlight
    // is already set — before this blocks the event loop, rather than queueing
    // behind it until the client's timer fires. It also flushes the acceptance
    // line first (safety does not depend on the client seeing it before a
    // timeout, but the ordering keeps the wire behaviour as before).
    setImmediate(() => {
      try {
        // The client already abandoned this request: its timer fired and it
        // destroyed the socket, so its own post-handoff path fails closed.
        // Evaluating now would apply side effects (predicted-write sanctions,
        // ptree saves, turn-baseline advances) for a tool call no one is
        // waiting on, diverging from the in-process path. Skip it.
        if (sock.destroyed || sock.writableEnded) return;
        let result;
        try {
          result = withEnv(req.env, () => (req.kind === 'PreToolUse' ? preToolUseFromRaw(req.raw, req.cwd) : stopFromRaw(req.raw, req.cwd)));
        } catch (e) {
          // The request is already accepted, so returning a refusal would invite
          // an unsafe fallback. Send a fail-closed HookResult-shaped denial.
          const detail = e instanceof Error ? e.message : String(e);
          const reason =
            `Tamperward's hook service could not complete the accepted evaluation (${detail}), so it is denied rather than retried concurrently.`;
          const stdout =
            req.kind === 'PreToolUse'
              ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n'
              : JSON.stringify({ decision: 'block', reason }) + '\n';
          served++;
          return respond(sock, { exitCode: 0, stdout });
        }
        served++;
        respond(sock, { exitCode: result.exitCode, stdout: result.stdout });
      } finally {
        inFlight = false;
        acceptedSocket = null;
      }
    });
  };

  const server: Server = createServer((sock) => {
    sockets.add(sock);
    let buf = '';
    let answered = false;
    sock.setEncoding('utf8');
    const deadline = setTimeout(() => {
      if (answered) return;
      answered = true;
      respond(sock, { refused: 'request deadline exceeded' });
    }, REQUEST_DEADLINE_MS);
    deadline.unref?.();
    sock.on('error', () => sock.destroy());
    sock.on('close', () => {
      clearTimeout(deadline);
      sockets.delete(sock);
    });
    sock.on('data', (chunk: string) => {
      if (answered) return;
      buf += chunk;
      if (buf.length > MAX_REQUEST_BYTES) {
        answered = true;
        clearTimeout(deadline);
        return respond(sock, { refused: 'request too large' });
      }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      answered = true;
      clearTimeout(deadline);
      handle(sock, buf.slice(0, nl));
    });
  });

  // The socket is created with the process umask; hold it at 0077 across the
  // bind so no other user can connect in the instant before the chmod.
  const umask = process.umask(0o077);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(paths.socket, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } finally {
    process.umask(umask);
  }
  chmodSync(paths.socket, 0o600);
  const state: ServiceState = { pid: process.pid, version: TW_VERSION, root, started_at: startedAt };
  writeFileSync(paths.state, JSON.stringify(state) + '\n', { mode: 0o600 });
  setSnapshotCache(cache);

  let closed = false;
  return {
    paths,
    root,
    get served() {
      return served;
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (closed) return resolve();
        closed = true;
        setSnapshotCache(null);
        let settled = false;
        let drain: ReturnType<typeof setTimeout>;
        // Resolves once the server has stopped accepting and all sockets are closed.
        const finalize = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(drain);
          removeQuietly(paths.socket);
          removeQuietly(paths.state);
          resolve();
        };
        server.close(finalize);
        // Destroy idle connections at once; an in-flight evaluation gets the drain below.
        for (const sock of sockets) if (sock !== acceptedSocket) sock.destroy();
        drain = setTimeout(() => {
          for (const sock of sockets) sock.destroy();
        }, SHUTDOWN_DRAIN_MS);
        drain.unref?.();
      }),
  };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** What the process actually holding the socket reports about itself, read from
 *  the live listener rather than the candidate-writable state file. */
export interface SocketStatus {
  pid: number;
  root: string;
  version: string;
}

/**
 * Ask the socket itself who is listening. Distinguishes three cases:
 *   - `answered: false`  — nothing connected (no live listener; stale/absent socket);
 *   - `answered: true, status: null`  — a listener answered but not with a status
 *     this version can read (for example a different TamperWard version refusing
 *     the status request);
 *   - `answered: true, status: {...}`  — a live listener reported its pid/root/version.
 * A trusted socket is a precondition: an untrusted socket (wrong owner/mode, not
 * a socket) is treated as no listener, exactly as the client refuses to consult it.
 */
async function probeSocket(paths: ServicePaths): Promise<{ answered: boolean; status: SocketStatus | null }> {
  if (socketRefusal(paths) !== null) return { answered: false, status: null };
  const req: ServiceRequest = { v: HOOK_SERVICE_PROTOCOL, version: TW_VERSION, kind: 'status', raw: '', cwd: process.cwd(), env: {} };
  const res = await exchange(paths, req, 1000);
  // `exchange` returns null only when the connection never handed off — i.e. no
  // listener accepted it. Any record (a status answer, a refusal, or a synthetic
  // post-handoff failure) means something IS listening on the socket.
  if (res === null) return { answered: false, status: null };
  if (
    isRecord(res) &&
    res.v === HOOK_SERVICE_PROTOCOL &&
    typeof res.pid === 'number' &&
    typeof res.root === 'string' &&
    typeof res.version === 'string'
  ) {
    return { answered: true, status: { pid: res.pid, root: res.root, version: res.version } };
  }
  return { answered: true, status: null };
}

function describeStateFile(state: ServiceState | null): string {
  return state ? `records pid ${state.pid}, root ${state.root}, tamperward@${state.version}` : 'is absent or unreadable';
}

export interface StopResult {
  /**
   * - `stopped`   — a live listener whose state file agreed was signalled and went away;
   * - `not-running` — nothing was listening; any stale socket/state files were removed;
   * - `mismatch`  — a live listener answered but the state file disagrees with it (or it
   *   could not be authenticated); the socket is LEFT INTACT and never reported as
   *   "not running", so a live service is never orphaned behind an unlinked socket (#416).
   */
  outcome: 'stopped' | 'not-running' | 'mismatch';
  /** The answering listener's pid when it reported one, else the state file's pid. */
  pid?: number;
  root?: string;
  detail?: string;
}

/**
 * Stop the service and remove whatever it left. A socket that ANSWERS is a live
 * listener: it is never orphaned by an unlink and never reported "not running".
 * The state file is candidate-writable, so it is advisory — the live listener's
 * own status is authority. SIGTERM is sent only when the listener's status and
 * the state file agree (a crash could otherwise have handed that PID to an
 * unrelated process). When they disagree, the socket is left intact and the
 * mismatch is reported for the operator to resolve.
 */
export async function stopHookService(paths: ServicePaths): Promise<StopResult> {
  const probe = await probeSocket(paths);
  const state = readServiceState(paths);

  if (probe.answered) {
    const st = probe.status;
    const agrees =
      st !== null && state !== null && state.pid === st.pid && state.root === st.root && state.version === st.version;
    if (agrees && st.pid !== process.pid) {
      try {
        process.kill(st.pid, 'SIGTERM');
      } catch {
        /* raced with its exit */
      }
      // Gone means the pid is dead OR the socket is unlinked: the service removes
      // its socket as the last act before exiting, and a parent that has not yet
      // reaped it (a supervisor blocked in a synchronous wait) leaves a zombie
      // that `kill(pid, 0)` still reports alive.
      const gone = (): boolean => !pidAlive(st.pid) || !existsSync(paths.socket);
      const until = Date.now() + STOP_WAIT_MS;
      while (!gone() && Date.now() < until) sleepSync(50);
      if (!gone()) throw new Error(`hook service pid ${st.pid} did not exit within ${STOP_WAIT_MS / 1000}s`);
      removeQuietly(paths.socket);
      removeQuietly(paths.state);
      return { outcome: 'stopped', pid: st.pid };
    }
    // A live listener is on the socket but its identity cannot be confirmed
    // against the state file. Never orphan it: leave the socket AND the state
    // file untouched and report the mismatch. `stop` is deliberately unwilling
    // to SIGTERM a pid it cannot authenticate from the socket's own answer.
    const detail = st
      ? `a listener answered on ${paths.socket} (pid ${st.pid}, root ${st.root}, tamperward@${st.version}) but the state file ${describeStateFile(state)}`
      : `a listener answered on ${paths.socket} but did not report a readable status (possibly a different tamperward version); the state file ${describeStateFile(state)}`;
    return { outcome: 'mismatch', pid: st?.pid ?? state?.pid, root: st?.root ?? state?.root, detail };
  }

  // Nothing is listening. Whatever files remain are stale; remove them so a
  // dead socket can never be what the next client meets.
  removeQuietly(paths.socket);
  removeQuietly(paths.state);
  return { outcome: 'not-running' };
}

function parseStart(args: string[]): { dir: string } {
  let dir = process.cwd();
  for (let i = 0; i < args.length; i++) if (args[i] === '--dir' && args[i + 1]) dir = args[++i];
  return { dir };
}

/** The CLI. `start` returns the -1 sentinel (the event loop is the service's
 *  lifetime, like `watch`); `stop` is synchronous; `status` answers over the
 *  socket and exits itself when it has printed. */
export function runHookService(args: string[]): number | Promise<number> {
  const sub = args[0];
  const paths = servicePaths();
  if (!paths) {
    process.stderr.write(
      'tamperward hook-service: unsupported on this platform — this release has no Windows named-pipe transport; the hook runs in-process here\n',
    );
    return 2;
  }
  if (sub === 'start') {
    const { dir } = parseStart(args.slice(1));
    startHookService({ root: dir, paths })
      .then((svc) => {
        let closing = false;
        const shutdown = (): void => {
          if (closing) return;
          closing = true;
          void svc.close().then(() => process.exit(0));
        };
        process.once('SIGTERM', shutdown);
        process.once('SIGINT', shutdown);
        process.stdout.write(
          `tamperward hook-service: listening on ${paths.socket} for ${svc.root} (pid ${process.pid}, tamperward@${TW_VERSION}); ` +
            `hooks consult it only under ${HOOK_SERVICE_ENV}=1\n`,
        );
      })
      .catch((e: unknown) => {
        process.stderr.write(`tamperward hook-service: ${e instanceof Error ? e.message : String(e)}\n`);
        exitAfterFlush(2);
      });
    return -1;
  }
  if (sub === 'stop') {
    return stopHookService(paths).then((res) => {
      if (res.outcome === 'stopped') {
        process.stdout.write(`tamperward hook-service: stopped (pid ${res.pid}); ${paths.socket} removed\n`);
        return 0;
      }
      if (res.outcome === 'mismatch') {
        // A live listener answered but could not be authenticated from the state
        // file. Do not pretend it stopped, and do not remove its socket (#416).
        process.stderr.write(
          `tamperward hook-service: NOT stopped — ${res.detail}. The socket was left intact; a live listener is never orphaned. ` +
            (res.pid ? `If you mean to stop it, signal it directly: kill ${res.pid}.\n` : `Inspect the process holding ${paths.socket} to stop it.\n`),
        );
        return 1;
      }
      process.stdout.write(`tamperward hook-service: not running; ${paths.socket} removed\n`);
      return 0;
    });
  }
  // status
  const state = readServiceState(paths);
  const refusal = socketRefusal(paths);
  const optIn = hookServiceEnabled() ? `${HOOK_SERVICE_ENV}=1 (hooks consult the service)` : `${HOOK_SERVICE_ENV} unset (hooks run in-process)`;
  // A trusted socket must be consulted directly: the state file may name a wrong
  // pid or version, but a socket that ANSWERS is a live service and must never be
  // reported "not running" (#416). Only an untrusted/absent socket short-circuits.
  if (refusal !== null) {
    process.stdout.write(`tamperward hook-service: not running (${refusal}); ${optIn}\n`);
    return 0;
  }
  const req: ServiceRequest = { v: HOOK_SERVICE_PROTOCOL, version: TW_VERSION, kind: 'status', raw: '', cwd: process.cwd(), env: {} };
  void exchange(paths, req, 5000).then((res) => {
    // `exchange` returns null only when nothing accepted the connection.
    if (res === null) {
      process.stdout.write(`tamperward hook-service: not running (socket did not connect); ${optIn}\n`);
      exitAfterFlush(0);
      return;
    }
    // A listener answered, but not with a status this version can read (a refusal
    // from a different TamperWard version, say). Report that it is alive, never
    // "not running".
    if (!isRecord(res) || typeof res.served !== 'number' || typeof res.pid !== 'number' || typeof res.root !== 'string' || typeof res.version !== 'string') {
      process.stdout.write(
        `tamperward hook-service: a listener answered on ${paths.socket} but did not report a readable status ` +
          `(possibly a different tamperward version); the state file ${state ? `records pid ${state.pid}, tamperward@${state.version}` : 'is absent or unreadable'}; ${optIn}\n`,
      );
      exitAfterFlush(0);
      return;
    }
    const cache = isRecord(res.cache) ? res.cache : {};
    const startedAt = typeof res.started_at === 'string' ? res.started_at : (state?.started_at ?? 'unknown');
    // Report what the LIVE listener says about itself. Flag any disagreement with
    // the state file rather than trusting the (candidate-writable) file.
    const disagrees = !state || state.pid !== res.pid || state.root !== res.root || state.version !== res.version;
    const warn = disagrees ? `WARNING: the state file ${describeStateFile(state)}, which disagrees with the live listener; ` : '';
    process.stdout.write(
      `tamperward hook-service: running (pid ${res.pid}, tamperward@${res.version}, root ${res.root}, since ${startedAt}); ` +
        `served: ${res.served}; snapshot cache hits/misses/entries: ${String(cache.hits ?? 0)}/${String(cache.misses ?? 0)}/${String(cache.size ?? 0)}; ${warn}${optIn}\n`,
    );
    exitAfterFlush(0);
  });
  return -1;
}
