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

    // Ownership handoff. The client may fall back in-process only BEFORE this
    // line. Once it sees accepted=true, this service is the sole evaluator for
    // the request; a later timeout/connection loss must fail closed instead of
    // starting a second evaluation over the same session state. Run the
    // evaluator from the write callback so the acceptance line has been handed
    // to the socket before synchronous hook work blocks this event loop.
    sock.write(JSON.stringify({ v: HOOK_SERVICE_PROTOCOL, version: TW_VERSION, accepted: true }) + '\n', () => {
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
    });
  };

  const server: Server = createServer((sock) => {
    let buf = '';
    let answered = false;
    sock.setEncoding('utf8');
    sock.on('error', () => sock.destroy());
    sock.on('data', (chunk: string) => {
      if (answered) return;
      buf += chunk;
      if (buf.length > MAX_REQUEST_BYTES) {
        answered = true;
        return respond(sock, { refused: 'request too large' });
      }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      answered = true;
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
        server.close(() => {
          removeQuietly(paths.socket);
          removeQuietly(paths.state);
          resolve();
        });
      }),
  };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Stop the service recorded in the state file and remove whatever it left:
 * 'stopped' when a live one was signalled and went away, 'not-running' when
 * there was none (its leftovers are removed either way, so a stale socket can
 * never be what the next client meets).
 */
export async function stopHookService(paths: ServicePaths): Promise<'stopped' | 'not-running'> {
  const state = readServiceState(paths);
  let outcome: 'stopped' | 'not-running' = 'not-running';

  // A stale state file is not authority to signal a PID: after a crashed
  // service that PID may have been reused by an unrelated process. Confirm the
  // private socket is trusted AND that the listener reports the same pid/root/
  // version before sending SIGTERM. A timeout/refusal merely cleans stale
  // service files; it never guesses that the PID still belongs to TamperWard.
  let confirmed = false;
  if (state && state.pid !== process.pid && pidAlive(state.pid) && state.version === TW_VERSION && socketRefusal(paths) === null) {
    const req: ServiceRequest = {
      v: HOOK_SERVICE_PROTOCOL,
      version: TW_VERSION,
      kind: 'status',
      raw: '',
      cwd: process.cwd(),
      env: {},
    };
    const res = await exchange(paths, req, 1000);
    confirmed =
      isRecord(res) &&
      res.v === HOOK_SERVICE_PROTOCOL &&
      res.version === TW_VERSION &&
      res.pid === state.pid &&
      res.root === state.root;
  }
  if (state && confirmed) {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      /* raced with its exit */
    }
    // Gone means the pid is dead OR the socket is unlinked: the service removes
    // its socket as the last act before exiting, and a parent that has not yet
    // reaped it (a supervisor blocked in a synchronous wait) leaves a zombie
    // that `kill(pid, 0)` still reports alive.
    const gone = (): boolean => !pidAlive(state.pid) || !existsSync(paths.socket);
    const until = Date.now() + STOP_WAIT_MS;
    while (!gone() && Date.now() < until) sleepSync(50);
    if (!gone()) throw new Error(`hook service pid ${state.pid} did not exit within ${STOP_WAIT_MS / 1000}s`);
    outcome = 'stopped';
  }
  removeQuietly(paths.socket);
  removeQuietly(paths.state);
  return outcome;
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
        process.exit(2);
      });
    return -1;
  }
  if (sub === 'stop') {
    return stopHookService(paths).then((outcome) => {
      process.stdout.write(`tamperward hook-service: ${outcome === 'stopped' ? 'stopped' : 'not running'}; ${paths.socket} removed\n`);
      return 0;
    });
  }
  // status
  const state = readServiceState(paths);
  const refusal = socketRefusal(paths);
  const optIn = hookServiceEnabled() ? `${HOOK_SERVICE_ENV}=1 (hooks consult the service)` : `${HOOK_SERVICE_ENV} unset (hooks run in-process)`;
  if (!state || !pidAlive(state.pid) || refusal !== null) {
    process.stdout.write(`tamperward hook-service: not running (${refusal ?? 'no live pid'}); ${optIn}\n`);
    return 0;
  }
  const req: ServiceRequest = { v: HOOK_SERVICE_PROTOCOL, version: TW_VERSION, kind: 'status', raw: '', cwd: process.cwd(), env: {} };
  void exchange(paths, req, 5000).then((res) => {
    if (!isRecord(res) || typeof res.served !== 'number') {
      process.stdout.write(`tamperward hook-service: not running (pid ${state.pid} did not answer, or is another version); ${optIn}\n`);
      process.exit(0);
    }
    const cache = isRecord(res.cache) ? res.cache : {};
    process.stdout.write(
      `tamperward hook-service: running (pid ${state.pid}, tamperward@${state.version}, root ${state.root}, since ${state.started_at}); ` +
        `served: ${res.served}; snapshot cache hits/misses/entries: ${String(cache.hits ?? 0)}/${String(cache.misses ?? 0)}/${String(cache.size ?? 0)}; ${optIn}\n`,
    );
    process.exit(0);
  });
  return -1;
}
