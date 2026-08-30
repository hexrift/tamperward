// Effect-level protected-tree state: what the protected files ACTUALLY are on
// disk, independent of any tool-call spelling.
//
// Why this exists (taskbench Phase 3, run 07-fastify gated): one test-skip Edit
// landed without a PreToolUse deny — same edit class that was denied at
// PreToolUse in eleven other runs — and the weakened suite was consulted for
// 51 seconds before the Stop sweep caught the persistent state. Whatever ate
// that one call (a hook flake, a reconstruction mismatch), spelling-level
// inspection has a floor: some mutation will always arrive by a path the
// matcher didn't see. The answer is to check the EFFECT: hash the protected
// tree, remember what it should be, and when it drifts without a sanctioned
// edit, run the ordinary detector stack over the drift (diff vs the turn
// baseline) at the very next hook call. Findings then come from the existing,
// corpus-priced rules — this module adds observation, not new judgment.
//
// State lives in .git/tamperward/ (like the turn baseline): never committed,
// invisible to `git status`, wiped with the clone. The agent can write .git/
// — the loop layer's known trust boundary; CI remains the authority.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Policy } from './types';
import { isProtected } from './policy';

export interface PEntry {
  hash: string;
  mode: number;
  size: number;
  mtimeMs: number;
}
export type PTree = Record<string, PEntry>;

const UNSAFE = /[^A-Za-z0-9._-]/g;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn']);

function gitDir(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--git-dir'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function ptreePath(cwd: string, sessionId?: string): string | null {
  if (!sessionId) return null;
  const gd = gitDir(cwd);
  if (!gd) return null;
  const dir = join(cwd, gd, 'tamperward');
  return join(dir, `ptree-${sessionId.replace(UNSAFE, '')}.json`);
}

const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex').slice(0, 16);

/** Walk the repo and snapshot every protected file. `prev` enables the mtime+size
 *  fast path so a big suite costs one stat per file, not one read. */
export function snapshotProtected(cwd: string, policy: Policy, prev?: PTree): PTree {
  const out: PTree = {};
  const walk = (rel: string): void => {
    const abs = rel ? join(cwd, rel) : cwd;
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue;
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = statSync(join(cwd, r));
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(r);
      else if (st.isFile() && isProtected(r, policy)) {
        const p = prev?.[r];
        if (p && p.mtimeMs === st.mtimeMs && p.size === st.size && p.mode === st.mode) {
          out[r] = p;
        } else {
          let hash = '';
          try {
            hash = sha(readFileSync(join(cwd, r)));
          } catch {
            hash = 'unreadable';
          }
          out[r] = { hash, mode: st.mode, size: st.size, mtimeMs: st.mtimeMs };
        }
      }
    }
  };
  walk('');
  return out;
}

export interface Drift {
  changed: string[]; // content or mode differs from the expected state
  deleted: string[]; // expected but gone
}

export function driftBetween(expected: PTree, current: PTree): Drift {
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const [path, e] of Object.entries(expected)) {
    const c = current[path];
    if (!c) deleted.push(path);
    else if (c.hash !== e.hash || c.mode !== e.mode) changed.push(path);
  }
  // Additions are absorbed by saving the new snapshot: a brand-new protected file
  // (a first-run snapshot, a new spec) is ordinary development, same stance as
  // snapshot-rewrite's op-add exemption.
  return { changed, deleted };
}

export function loadPtree(cwd: string, sessionId?: string): PTree | null {
  const p = ptreePath(cwd, sessionId);
  if (!p || !existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PTree;
  } catch {
    return null;
  }
}

export function savePtree(cwd: string, sessionId: string | undefined, tree: PTree): void {
  const p = ptreePath(cwd, sessionId);
  if (!p) return;
  try {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, JSON.stringify(tree));
  } catch {
    /* best effort — absence of state degrades to Stop-only coverage, never to a crash */
  }
}
