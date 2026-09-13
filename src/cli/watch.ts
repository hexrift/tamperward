// `tamperward watch` — the filesystem-event observer (DESIGN A.1's named
// candidate, built after taskbench Phase 3).
//
// The hooks judge tool calls; the per-call effect check (src/effect.ts) judges
// persistent drift between calls. What neither can see is a protected asset
// modified AND restored inside one tool call — weaken, consult the suite,
// restore — the A.1 probe class the neutral observer documented missing, and
// the exact shape of the one transient measured in 59 real trajectories
// (fastify: skip → npm test → restore). This daemon watches the filesystem
// itself, so SUPPORTED transient effects are recorded as events even when no
// state survives. "Supported" is a real qualifier: fs-event delivery is
// platform-dependent and can coalesce or drop under load — a recorded event is
// evidence; an absent event is never evidence of absence.
//
// Events append as JSONL to .git/tamperward/fsevents.jsonl (override: --log or
// TAMPERWARD_FSEVENTS). The Stop sweep consumes them (src/detectors/fs-events)
// under the `transient-protected-mutation` rule. Run it from a SessionStart
// hook or alongside the agent:  tamperward watch &
//
// Trust boundary, stated: the daemon and its log live where the agent can
// reach. The loop layer has always been the correction layer, not the
// authority; CI is the authority.

import { appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, watch, writeFileSync } from 'node:fs';
import { inspectPath } from '../disk';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadPolicy, loadPolicyAt } from '../policy-load';
import { defaultPolicy, isProtected } from '../policy';
import { gitDir } from '../git/build';
import { Policy } from '../types';

export interface FsEvent {
  ts: string;
  path: string;
  kind: 'change' | 'rename';
  mode: number | null; // null = gone at stat time
  size: number | null;
  hash: string | null;
}

const SKIP = /(^|\/)(\.git|node_modules)(\/|$)/;

function snap(abs: string): Pick<FsEvent, 'mode' | 'size' | 'hash'> {
  // Never follows a link and never reads past the cap (src/disk.ts): a protected
  // path linked to a device would otherwise hold the watcher, not just one hook call.
  const e = inspectPath(abs);
  if (e.kind === 'absent' || e.kind === 'unreadable') return { mode: null, size: null, hash: null }; // deleted / transiently absent
  if (e.kind !== 'file' || e.content == null) return { mode: e.mode, size: null, hash: null };
  const hash = createHash('sha256').update(e.content).digest('hex').slice(0, 16);
  return { mode: e.mode, size: e.size, hash };
}

/** The event log lives in the repository's git directory, wherever that is: in
 *  a linked `git worktree` `.git` is a FILE, so `<cwd>/.git/tamperward/` could
 *  not be created and the daemon silently recorded nothing. */
export function defaultEventLog(cwd: string): string {
  if (process.env.TAMPERWARD_FSEVENTS) return process.env.TAMPERWARD_FSEVENTS;
  return join(gitDir(cwd) ?? join(cwd, '.git'), 'tamperward', 'fsevents.jsonl');
}

export type WatcherBackend = 'initializing' | 'recursive' | 'fallback';
export type WatcherHealthState = 'healthy' | 'degraded' | 'stopped';

export interface WatcherHealth {
  version: 1;
  state: WatcherHealthState;
  backend: WatcherBackend;
  pid: number;
  started_at: string;
  stopped_at: string | null;
  watched_dirs: number;
  last_append_at: string | null;
  event_count: number;
  dropped_events: number;
  error_count: number;
  last_error: string | null;
  log: string;
}

export interface WatcherTelemetry {
  state: 'healthy' | 'degraded' | 'unavailable';
  health: WatcherHealth | null;
  reason?: string;
}

export function watcherHealthPath(log: string): string {
  return `${log}.health.json`;
}

export function readWatcherHealth(log: string): WatcherHealth | null {
  try {
    const value = JSON.parse(readFileSync(watcherHealthPath(log), 'utf8')) as Partial<WatcherHealth>;
    if (
      value.version !== 1 ||
      typeof value.pid !== 'number' ||
      typeof value.started_at !== 'string' ||
      !['healthy', 'degraded', 'stopped'].includes(String(value.state))
    ) return null;
    return value as WatcherHealth;
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
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Interpret the persisted observer record for consumers. The record is advisory
 *  (candidate-accessible like the event log), but it prevents "no events" from
 *  being confused with "there was no live observer". */
export function watcherTelemetry(log: string): WatcherTelemetry {
  const health = readWatcherHealth(log);
  if (!health) return { state: 'unavailable', health: null, reason: 'no health record' };
  if (health.state === 'stopped')
    return { state: 'unavailable', health, reason: 'observer stopped' };
  if (!pidAlive(health.pid))
    return { state: 'unavailable', health, reason: `observer pid ${health.pid} is not running` };
  if (health.state === 'degraded')
    return { state: 'degraded', health, reason: health.last_error ?? 'observer reported an error' };
  return { state: 'healthy', health };
}

export interface Watcher {
  close(): void;
}

type TreeCb = (kind: string, rel: string) => void;
type TreeStateCb = (backend: Exclude<WatcherBackend, 'initializing'>, watchedDirs: number) => void;
type TreeErrorCb = (detail: string) => void;

/** Recursive watch where the platform has it (Linux needs Node >= 20); otherwise a
 *  per-directory fallback that adds watchers for directories as they appear. The
 *  fallback is force-selectable (TAMPERWARD_WATCH_NO_RECURSIVE=1) so CI exercises
 *  it on every platform, not only the ones that lack the feature. */
function watchTree(
  dir: string,
  cb: TreeCb,
  onState: TreeStateCb,
  onError: TreeErrorCb,
): Watcher {
  if (process.env.TAMPERWARD_WATCH_NO_RECURSIVE !== '1') {
    try {
      const w = watch(dir, { recursive: true }, (kind, fname) => {
        if (fname) cb(kind, String(fname));
      });
      onState('recursive', 1);
      return { close: () => w.close() };
    } catch {
      /* ERR_FEATURE_UNAVAILABLE_ON_PLATFORM -> per-directory fallback */
    }
  }

  const watchers = new Map<string, ReturnType<typeof watch>>();
  onState('fallback', 0);

  const addDir = (rel: string): void => {
    if (watchers.has(rel) || SKIP.test(rel + '/')) return;
    let w: ReturnType<typeof watch>;
    try {
      w = watch(rel ? join(dir, rel) : dir, (kind, fname) => {
        if (!fname) return;
        const child = rel ? `${rel}/${String(fname)}` : String(fname);
        cb(kind, child);
        try {
          if (lstatSync(join(dir, child)).isDirectory()) addDir(child); // new directory: extend coverage
        } catch {
          /* gone already */
        }
      });
    } catch (e) {
      onError(
        `watch directory ${rel || '.'}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    watchers.set(rel, w);
    onState('fallback', watchers.size);
  };

  const walk = (rel: string): void => {
    addDir(rel);
    let names: string[] = [];
    try {
      names = readdirSync(rel ? join(dir, rel) : dir);
    } catch (e) {
      onError(
        `enumerate directory ${rel || '.'}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    for (const name of names) {
      const child = rel ? `${rel}/${name}` : name;
      if (SKIP.test(child + '/')) continue;
      try {
        if (lstatSync(join(dir, child)).isDirectory()) walk(child);
      } catch {
        /* raced with deletion; no persistent health defect */
      }
    }
  };

  walk('');
  return { close: () => { for (const w of watchers.values()) w.close(); } };
}

/** Start watching. Exported (rather than CLI-only) so tests drive it in-process. */
export function startWatcher(dir: string, log: string, policy: Policy): Watcher {
  try {
    mkdirSync(join(log, '..'), { recursive: true });
  } catch {
    // Persisting health below will produce the explicit diagnostic.
  }

  const healthPath = watcherHealthPath(log);
  const health: WatcherHealth = {
    version: 1,
    state: 'healthy',
    backend: 'initializing',
    pid: process.pid,
    started_at: new Date().toISOString(),
    stopped_at: null,
    watched_dirs: 0,
    last_append_at: null,
    event_count: 0,
    dropped_events: 0,
    error_count: 0,
    last_error: null,
    log,
  };
  let healthWriteWarningEmitted = false;

  const persistHealth = (): void => {
    try {
      writeFileSync(healthPath, JSON.stringify(health) + '\n', { mode: 0o600 });
      healthWriteWarningEmitted = false;
    } catch (e) {
      if (!healthWriteWarningEmitted) {
        process.stderr.write(
          `tamperward watch: WARNING: observer health cannot be recorded at ${healthPath} (${e instanceof Error ? e.message : String(e)}); telemetry availability is unknown.\n`,
        );
        healthWriteWarningEmitted = true;
      }
    }
  };

  const degrade = (detail: string, droppedEvent = false): void => {
    health.state = 'degraded';
    health.error_count++;
    if (droppedEvent) health.dropped_events++;
    health.last_error = detail;
    persistHealth();
    process.stderr.write(
      `tamperward watch: WARNING: observer degraded — ${detail}. Transient telemetry may be incomplete.\n`,
    );
  };

  persistHealth();
  const last = new Map<string, string>(); // path -> hash|mode dedupe key
  const tree = watchTree(
    dir,
    (kind, rel) => {
      if (SKIP.test(rel) || !isProtected(rel, policy)) return;
      const s = snap(join(dir, rel));
      const key = `${s.hash}:${s.mode}`;
      if (last.get(rel) === key) return; // duplicate notification for the same state
      last.set(rel, key);
      const ev: FsEvent = {
        ts: new Date().toISOString(),
        path: rel,
        kind: kind === 'rename' ? 'rename' : 'change',
        ...s,
      };
      try {
        appendFileSync(log, JSON.stringify(ev) + '\n');
        health.event_count++;
        health.last_append_at = new Date().toISOString();
        persistHealth();
      } catch (e) {
        degrade(
          `append event to ${log}: ${e instanceof Error ? e.message : String(e)}`,
          true,
        );
      }
    },
    (backend, watchedDirs) => {
      health.backend = backend;
      health.watched_dirs = watchedDirs;
      persistHealth();
    },
    (detail) => degrade(detail),
  );

  return {
    close: () => {
      tree.close();
      health.state = 'stopped';
      health.stopped_at = new Date().toISOString();
      persistHealth();
    },
  };
}

export function runWatch(args: string[]): number {
  let dir = process.cwd();
  let log: string | null = null;
  let base: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) dir = args[++i];
    else if (args[i] === '--log' && args[i + 1]) log = args[++i];
    else if (args[i] === '--base' && args[i + 1]) base = args[++i];
  }

  // Supervised run mode pins the observer's protected-path policy to the same
  // trusted revision that governs final adjudication. A standalone watcher
  // without --base retains the historical live-policy behavior.
  const policy = base ? (loadPolicyAt(base, dir) ?? defaultPolicy()) : loadPolicy(dir);
  const out = log ?? defaultEventLog(dir);
  const watcher = startWatcher(dir, out, policy);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    watcher.close();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  process.stdout.write(
    `tamperward watch: recording protected-file events under ${dir} -> ${out} ` +
      `(health: ${watcherHealthPath(out)}${base ? `; trusted base: ${base}` : ''})\n`,
  );
  // Daemon: run until signalled. Signal handlers close the watcher first so the
  // health sidecar records "stopped" rather than looking like a crashed daemon.
  return -1; // sentinel: caller must not exit
}
