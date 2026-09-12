// Filesystem fingerprint of the candidate working tree a verdict describes.
//
// Installed dependency environments have a different trust model and are
// frozen/attested in src/dependency-env.ts. Keeping that boundary separate is
// deliberate: absence of node_modules is not evidence that a Python/Ruby/JVM
// verifier has no mutable execution environment.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inspectRel } from './disk';
import { ignoredPaths } from './git/build';
import { trustedGitEnv } from './git/trusted';

/** Filesystem-identity fingerprint of every tracked/untracked file, plus ignored
 *  files selected by `keepIgnored` (normally the frozen policy's protected set).
 *
 *  Used by two callers with the same need: the envelope adjudicates a LIVE tree
 *  across three sequential checks, and `verify` now materialises its pristine
 *  copy only AFTER the visible run has executed — so both must be able to prove
 *  the tree they are describing is the tree that was there when they started.
 *  (P0-5; and H1, below.) */
export function treeFingerprint(cwd: string, keepIgnored?: (rel: string) => boolean): string {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: trustedGitEnv(),
  })
    .split('\0')
    .filter(Boolean);
  // Ignored files are intentionally absent from the normal listing, but an
  // ignored protected file is executable security state (conftest.py and local
  // hook/config files are examples). Keep the expensive ignored walk scoped to
  // the caller's protected predicate, as the worktree checker does.
  const files = [...new Set([...listed, ...(keepIgnored ? ignoredPaths({ cwd }, keepIgnored) : [])])].sort();
  const h = createHash('sha256');
  for (const rel of files) {
    h.update(rel);
    h.update('\0');
    const entry = inspectRel(cwd, rel);
    // Content alone aliases identities that execute differently: 0644 vs 0755,
    // a regular file vs a symlink with identical bytes, and an unreadable special
    // file vs another unreadable kind. Hash type + complete stat mode as well as
    // git-recordable content; never use mtime/size as a substitute for bytes.
    h.update(entry.kind);
    h.update('\0');
    h.update(String(entry.mode));
    h.update('\0');
    h.update(entry.content ?? `<${entry.kind}:${entry.detail}>`);
    h.update('\0');
  }
  return h.digest('hex');
}
