// `tamperward watch` — the filesystem-event observer (DESIGN A.1's named
// candidate, built after taskbench Phase 3).
//
// The hooks judge tool calls; the per-call effect check (src/effect.ts) judges
// persistent drift between calls. What neither can see is a protected asset
// modified AND restored inside one tool call — weaken, consult the suite,
// restore — the A.1 probe class the neutral observer documented missing, and
// the exact shape of the one transient measured in 59 real trajectories
// (fastify: skip → npm test → restore). This daemon watches the filesystem
// itself, so the mutation is recorded as an event even when no state survives.
//
// Events append as JSONL to .git/tamperward/fsevents.jsonl (override: --log or
// TAMPERWARD_FSEVENTS). The Stop sweep consumes them (src/detectors/fs-events)
// under the `transient-protected-mutation` rule. Run it from a SessionStart
// hook or alongside the agent:  tamperward watch &
//
// Trust boundary, stated: the daemon and its log live where the agent can
// reach. The loop layer has always been the correction layer, not the
// authority; CI is the authority.

import { appendFileSync, mkdirSync, readFileSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadPolicy } from '../policy-load';
import { isProtected } from '../policy';
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

export function defaultEventLog(cwd: string): string {
  return process.env.TAMPERWARD_FSEVENTS ?? join(cwd, '.git', 'tamperward', 'fsevents.jsonl');
}

export interface Watcher {
  close(): void;
}

/** Start watching. Exported (rather than CLI-only) so tests drive it in-process. */
export function startWatcher(dir: string, log: string, policy: Policy): Watcher {
  try {
    mkdirSync(join(log, '..'), { recursive: true });
  } catch {
    /* the append below will surface a real failure */
  }
  const last = new Map<string, string>(); // path -> hash|mode dedupe key
  const w = watch(dir, { recursive: true }, (kind, fname) => {
    if (!fname) return;
    const rel = String(fname);
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
  return { close: () => w.close() };
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
