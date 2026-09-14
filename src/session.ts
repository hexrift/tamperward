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
//
// The marker is written to a temp file and renamed into place, so a parallel hook never
// reads a half-written sha, and it is read only as a FULL 40-hex object name: anything
// else is a torn or foreign file, treated as absent and re-established. A marker that
// cannot be recorded is a turn the sweep cannot judge — `git diff HEAD` would make a
// mid-turn commit invisible again — so the write failure is raised, and the hook denies
// with the diagnostic rather than degrading (#417).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitDir, headSha } from './git/build';

const UNSAFE = /[^A-Za-z0-9_-]/g;
const SHA = /^[0-9a-f]{40}$/;

/** The turn baseline could not be recorded; the sweep must not fall back to HEAD. */
export class BaselineWriteError extends Error {
  constructor(path: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`turn baseline could not be recorded at ${path}: ${detail}`);
    this.name = 'BaselineWriteError';
  }
}

/** Write `sha` atomically: a temp file beside the marker, renamed into place. */
function writeBaseline(p: string, sha: string): void {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, sha);
    renameSync(tmp, p);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* the temp file is the lesser leak */ }
    throw e;
  }
}

function baselinePath(cwd: string, sessionId: string): string | null {
  const gd = gitDir(cwd);
  if (!gd) return null;
  return join(gd, 'tamperward', `session-${sessionId.replace(UNSAFE, '')}`);
}

/**
 * The commit this turn started from, recording it on first sight. Returns null when there
 * is no session id, no repo, or no commit yet (an unborn branch) — the caller then falls
 * back to the working-tree view, which is all there is to compare. Throws
 * `BaselineWriteError` when the marker cannot be recorded: that turn has no trustworthy
 * baseline, and the hook denies it rather than judging against HEAD.
 */
export function turnBaseline(cwd: string, sessionId?: string): string | null {
  if (!sessionId) return null;
  const p = baselinePath(cwd, sessionId);
  if (!p) return null;
  try {
    if (existsSync(p)) {
      const v = readFileSync(p, 'utf8').trim();
      if (SHA.test(v)) return v;
    }
  } catch {
    /* an unreadable marker is absent, and is re-established below */
  }
  const head = headSha(cwd);
  if (!head) return null;
  try {
    writeBaseline(p, head);
  } catch (e) {
    throw new BaselineWriteError(p, e);
  }
  return head;
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
    writeBaseline(p, head);
  } catch {
    /* best effort: a marker that fails to advance keeps the OLDER baseline, so the next
       turn re-reports more, never less */
  }
}
