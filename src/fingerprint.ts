// Content fingerprints of the two things a verdict is about but no diff view
// covers: the working tree it describes, and the installed dependency tree it
// executes through.
//
// `verify` symlinks node_modules into the visible AND the pristine copy: it is
// gitignored, so no diff view sees it, and it is where the suite's own runner
// lives. Hashed rather than stat-compared, because P1-8 is the standing lesson
// that mtime and size are the agent's to choose.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { trustedGitEnv } from './git/trusted';

/** Content fingerprint of every non-ignored file (tracked + untracked).
 *
 *  Used by two callers with the same need: the envelope adjudicates a LIVE tree
 *  across three sequential checks, and `verify` now materialises its pristine
 *  copy only AFTER the visible run has executed — so both must be able to prove
 *  the tree they are describing is the tree that was there when they started.
 *  (P0-5; and H1, below.) */
export function treeFingerprint(cwd: string): string {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: trustedGitEnv(),
  })
    .split('\0')
    .filter(Boolean)
    .sort();
  const h = createHash('sha256');
  for (const rel of files) {
    h.update(rel);
    h.update('\0');
    try {
      h.update(readFileSync(join(cwd, rel)));
    } catch {
      h.update('<unreadable>');
    }
    h.update('\0');
  }
  return h.digest('hex');
}

/** Content fingerprint of the installed dependency tree.
 *
 *  `verify` symlinks node_modules into BOTH copies, so an agent that writes
 *  `node_modules/.bin/<runner>` replaces the program that decides both
 *  verdicts. Neither the policy check (git-scoped) nor the tree fingerprint
 *  (ls-files, ignores excluded) can see it. (P0-6, external review.)
 *
 *  Measured 3.4s over 145MB / 5.4k files, inside a command that already runs
 *  the suite twice. */
export function depsFingerprint(cwd: string): string {
  const root = join(cwd, 'node_modules');
  const h = createHash('sha256');
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        h.update(p);
        try {
          h.update(readFileSync(p));
          h.update(String(statSync(p).mode)); // the exec bit is part of identity
        } catch {
          h.update('<unreadable>');
        }
      } else if (e.isSymbolicLink()) {
        h.update(p);
        try {
          h.update(readlinkSync(p));
        } catch {
          h.update('<unreadable-link>');
        }
      }
    }
  };
  try {
    if (!statSync(root).isDirectory()) return 'none';
  } catch {
    return 'none'; // no installed tree: nothing to drift
  }
  walk(root);
  return h.digest('hex');
}
