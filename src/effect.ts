// Effect-level protected-tree state: detects PERSISTENT protected-state drift
// independently of the mutation's command spelling. (Transient effects that
// leave no state behind are the watcher's surface, to the extent the
// platform's fs events deliver them — src/cli/watch.ts.)
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
import { isAbsolute, join } from 'node:path';
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

/** The ABSOLUTE git directory. `rev-parse --git-dir` answers `.git` from the
 *  top of an ordinary checkout and an absolute path from anywhere else — a
 *  subdirectory, a linked `git worktree`, a `.git` file. `join(cwd, gd)` on the
 *  absolute form produced `<cwd>/<absolute path>`, and `mkdirSync` then created
 *  that whole tree INSIDE the working tree: a Claude Code session in a worktree
 *  wrote its effect state to `<worktree>/tmp/.../main/.git/worktrees/x/…`. */
function gitDir(cwd: string): string | null {
  try {
    const d = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!d) return null;
    return isAbsolute(d) ? d : join(cwd, d);
  } catch {
    return null;
  }
}

function statePath(cwd: string, sessionId: string | undefined, kind: 'ptree' | 'turntree'): string | null {
  if (!sessionId) return null;
  const gd = gitDir(cwd);
  if (!gd) return null;
  const dir = join(gd, 'tamperward');
  return join(dir, `${kind}-${sessionId.replace(UNSAFE, '')}.json`);
}

export function ptreePath(cwd: string, sessionId?: string): string | null {
  return statePath(cwd, sessionId, 'ptree');
}

/** The protected tree as it stood when the TURN began — saved beside the git
 *  turn baseline (src/session.ts) and advanced with it. The ptree cannot serve
 *  here: it absorbs additions at every call, so by Stop it already contains the
 *  file the turn created. This one only moves when a turn ends clean, so an
 *  untracked protected file it does not carry (or carries with another hash) is
 *  the turn's own work, and the sweep judges it; one it carries unchanged was
 *  there before the turn and is not re-litigated. */
export function turnTreePath(cwd: string, sessionId?: string): string | null {
  return statePath(cwd, sessionId, 'turntree');
}

const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex').slice(0, 16);

/** The ptree's content hash, for a caller holding the bytes rather than a path. */
export function contentHash(content: string | Buffer): string {
  return sha(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
}

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
        // NO STAT FAST PATH. This used to reuse the previous entry when
        // mtime + size + mode all matched, skipping the hash. Every one of
        // those three is writable by the agent being watched: `it(` → `it.skip(`
        // paid for by shortening the test name keeps the size identical, and
        // `touch -r` restores the mtime from any reference file — so the
        // measured effect of the edit was remembered by stat and the drift
        // check passed a file that carried the skip. (P1-8, external review;
        // reproduced before this change.)
        //
        // This layer exists BECAUSE some mutation always arrives by a path the
        // matcher did not see; a cache keyed on data the mutation's author
        // controls reintroduces exactly the blind spot it was built to close.
        // Hash every protected file, every time.
        let hash = '';
        try {
          hash = sha(readFileSync(join(cwd, r)));
        } catch {
          hash = 'unreadable';
        }
        out[r] = { hash, mode: st.mode, size: st.size, mtimeMs: st.mtimeMs };
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

function loadTree(p: string | null): PTree | null {
  if (!p || !existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PTree;
  } catch {
    return null;
  }
}

function saveTree(p: string | null, tree: PTree): void {
  if (!p) return;
  try {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, JSON.stringify(tree));
  } catch {
    /* best effort — absence of state degrades to Stop-only coverage, never to a crash */
  }
}

export function loadPtree(cwd: string, sessionId?: string): PTree | null {
  return loadTree(ptreePath(cwd, sessionId));
}

export function savePtree(cwd: string, sessionId: string | undefined, tree: PTree): void {
  saveTree(ptreePath(cwd, sessionId), tree);
}

export function loadTurnTree(cwd: string, sessionId?: string): PTree | null {
  return loadTree(turnTreePath(cwd, sessionId));
}

export function saveTurnTree(cwd: string, sessionId: string | undefined, tree: PTree): void {
  saveTree(turnTreePath(cwd, sessionId), tree);
}
