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

import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadPolicy } from '../policy-load';
import { isProtected } from '../policy';
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
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { mode: st.mode, size: null, hash: null };
    const hash = createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 16);
    return { mode: st.mode, size: st.size, hash };
  } catch {
    return { mode: null, size: null, hash: null }; // deleted / transiently absent
  }
}

/** The event log lives in the repository's git directory, wherever that is: in
 *  a linked `git worktree` `.git` is a FILE, so `<cwd>/.git/tamperward/` could
 *  not be created and the daemon silently recorded nothing. */
export function defaultEventLog(cwd: string): string {
  if (process.env.TAMPERWARD_FSEVENTS) return process.env.TAMPERWARD_FSEVENTS;
  return join(gitDir(cwd) ?? join(cwd, '.git'), 'tamperward', 'fsevents.jsonl');
}

export interface Watcher {
  close(): void;
}

type TreeCb = (kind: string, rel: string) => void;

/** Recursive watch where the platform has it (Linux needs Node >= 20); otherwise a
 *  per-directory fallback that adds watchers for directories as they appear. The
 *  fallback is force-selectable (TAMPERWARD_WATCH_NO_RECURSIVE=1) so CI exercises
 *  it on every platform, not only the ones that lack the feature. */
function watchTree(dir: string, cb: TreeCb): Watcher {
  if (process.env.TAMPERWARD_WATCH_NO_RECURSIVE !== '1') {
    try {
      const w = watch(dir, { recursive: true }, (kind, fname) => {
        if (fname) cb(kind, String(fname));
      });
      return { close: () => w.close() };
    } catch {
      /* ERR_FEATURE_UNAVAILABLE_ON_PLATFORM -> per-directory fallback */
    }
  }
  const watchers = new Map<string, ReturnType<typeof watch>>();
  const addDir = (rel: string): void => {
    if (watchers.has(rel) || SKIP.test(rel + '/')) return;
    let w: ReturnType<typeof watch>;
    try {
      w = watch(rel ? join(dir, rel) : dir, (kind, fname) => {
        if (!fname) return;
        const child = rel ? `${rel}/${String(fname)}` : String(fname);
        cb(kind, child);
        try {
          if (statSync(join(dir, child)).isDirectory()) addDir(child); // new directory: extend coverage
        } catch {
          /* gone already */
        }
      });
    } catch {
      return; // directory vanished between walk and watch
    }
    watchers.set(rel, w);
  };
  const walk = (rel: string): void => {
    addDir(rel);
    let names: string[] = [];
    try {
      names = readdirSync(rel ? join(dir, rel) : dir);
    } catch {
      return;
    }
    for (const name of names) {
      const child = rel ? `${rel}/${name}` : name;
      if (SKIP.test(child + '/')) continue;
      try {
        if (statSync(join(dir, child)).isDirectory()) walk(child);
      } catch {
        /* raced */
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
    /* the append below will surface a real failure */
  }
  const last = new Map<string, string>(); // path -> hash|mode dedupe key
  return watchTree(dir, (kind, rel) => {
    if (SKIP.test(rel) || !isProtected(rel, policy)) return;
    const s = snap(join(dir, rel));
    const key = `${s.hash}:${s.mode}`;
    if (last.get(rel) === key) return; // duplicate notification for the same state
    last.set(rel, key);
    const ev: FsEvent = { ts: new Date().toISOString(), path: rel, kind: kind === 'rename' ? 'rename' : 'change', ...s };
    try {
      appendFileSync(log, JSON.stringify(ev) + '\n');
    } catch {
      /* best effort */
    }
  });
}

export function runWatch(args: string[]): number {
  let dir = process.cwd();
  let log: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) dir = args[++i];
    else if (args[i] === '--log' && args[i + 1]) log = args[++i];
  }
  const policy = loadPolicy(dir);
  const out = log ?? defaultEventLog(dir);
  startWatcher(dir, out, policy);
  process.stdout.write(`tamperward watch: recording protected-file events under ${dir} -> ${out}\n`);
  // Daemon: run until killed. SIGINT/SIGTERM exit cleanly via default handlers.
  return -1; // sentinel: caller must not exit
}
