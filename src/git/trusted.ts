// Trusted git reads — the object layer under the trust anchor.
//
// Every guarantee in this tool reduces to one sentence: "the base commit says
// X". Three git mechanisms let a process with write access to `.git` change
// what that sentence resolves to, without touching a single tracked file and
// without moving a single ref:
//
//   refs/replace/<sha>   `git replace` — every read of <sha> transparently
//                        returns another object instead. `git show base:t.py`,
//                        `git ls-tree base`, `git merge-base` all follow it.
//   .git/info/grafts     rewrites the parent list of a commit, so ancestry —
//                        and therefore merge-base — answers differently.
//   .git/shallow         the same, by truncating history at a boundary.
//
// The verifier restores "the protected files as they are at the base" and the
// envelope asserts "HEAD is a descendant of the base". Both are object-layer
// reads. An agent that runs `git replace base <its-own-commit>` gets a pristine
// run overlaid from a tree it wrote, reported as VERIFIED — no diff rule sees
// it, because no file changed.
//
// Two defences, because the mechanisms differ:
//
//   1. GIT_NO_REPLACE_OBJECTS=1 on every read whose answer is trusted. This is
//      complete for replace refs: git resolves the real object.
//   2. Grafts and shallow have no such switch — they are read from `.git`
//      unconditionally. So the envelope FINGERPRINTS the rewrite state before
//      the agent starts and again at adjudication, and a change is a
//      non-quiescence finding like any other tree movement. It cannot prevent
//      a pre-existing graft (that predates the envelope's authority); it does
//      close the case where the agent installs one during its run.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * Environment for a git command whose answer is trusted.
 *
 * `GIT_NO_REPLACE_OBJECTS=1` is the env form of `--no-replace-objects`; using
 * the env var means it also covers the git that a helper or a sub-invocation
 * spawns, which a per-command flag would not.
 */
export function trustedGitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };
}

function gitDirOf(cwd: string): string | null {
  try {
    const d = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: trustedGitEnv(),
    }).trim();
    if (!d) return null;
    return isAbsolute(d) ? d : join(cwd, d);
  } catch {
    return null;
  }
}

/**
 * A fingerprint of everything that can make an object read answer differently
 * without any ref or file changing: the replace refs, `info/grafts`, and
 * `shallow`. Compared, never interpreted — the envelope only needs to know
 * whether it moved.
 *
 * Unreadable inputs hash to a distinct marker rather than to "absent", so
 * losing the ability to look is not silently the same as looking and finding
 * nothing.
 */
export function objectRewriteState(cwd: string): string {
  const parts: string[] = [];
  try {
    parts.push(
      'replace:' +
        execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/replace/'], {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: trustedGitEnv(),
        }).trim(),
    );
  } catch {
    parts.push('replace:<unreadable>');
  }
  const dir = gitDirOf(cwd);
  for (const rel of ['info/grafts', 'shallow']) {
    if (dir === null) {
      parts.push(`${rel}:<no-git-dir>`);
      continue;
    }
    const p = join(dir, rel);
    try {
      parts.push(`${rel}:` + (existsSync(p) ? readFileSync(p, 'utf8').trim() : ''));
    } catch {
      parts.push(`${rel}:<unreadable>`);
    }
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}
