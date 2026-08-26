// The turn baseline: the commit a turn started from.
//
// The Stop sweep used `git diff HEAD`, which only sees the WORKING TREE. An agent that
// committed its tamper mid-turn (`git add -A && git commit -m wip` — a plain commit, so
// no-verify never fires and PreToolUse allows it) left the working tree equal to HEAD, the
// sweep saw an empty diff, and the turn ended green. Every shell- and interpreter-mediated
// mutation §5.2 relies on the sweep to catch could be hidden that way.
//
// So the sweep compares against the commit the turn STARTED at, recorded on the first tool
// call of the session. The marker lives in .git/ (not the work tree): it is never committed,
// never shows up in a diff, and does not need a policy exception.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitDir, headSha } from './git/build';

const UNSAFE = /[^A-Za-z0-9_-]/g;
const SHA = /^[0-9a-f]{7,40}$/;

function baselinePath(cwd: string, sessionId: string): string | null {
  const gd = gitDir(cwd);
  if (!gd) return null;
  return join(gd, 'tamperward', `session-${sessionId.replace(UNSAFE, '')}`);
}

/**
 * The commit this turn started from, recording it on first sight. Returns null when there
 * is no session id or no repo — the caller then falls back to the working-tree view, which
 * is no worse than the old behaviour.
 */
export function turnBaseline(cwd: string, sessionId?: string): string | null {
  if (!sessionId) return null;
  try {
    const p = baselinePath(cwd, sessionId);
    if (!p) return null;
    if (existsSync(p)) {
      const v = readFileSync(p, 'utf8').trim();
      if (SHA.test(v)) return v;
    }
    const head = headSha(cwd);
    if (!head) return null;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, head);
    return head;
  } catch {
    return null; // never let bookkeeping break the verdict
  }
}

/** Move the baseline forward once a turn has ended clean, so the next turn is judged on
 *  its own work rather than re-reporting everything since the session began. A turn that
 *  ended BLOCKED deliberately keeps its baseline: the tamper stays visible until fixed. */
export function advanceTurnBaseline(cwd: string, sessionId?: string): void {
  if (!sessionId) return;
  try {
    const p = baselinePath(cwd, sessionId);
    const head = headSha(cwd);
    if (!p || !head) return;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, head);
  } catch {
    /* best effort */
  }
}
