// The bump commit for the release workflow (#701): the most recent commit in which
// package.json's `version` differs from its first parent's.
//
// release.yml refuses to publish a `main` head that is not the reviewed bump commit
// (#420): after a failed release, the next unrelated merge must not ship under the
// pending version with provenance and a tag pointing at code the CHANGELOG entry never
// described. The check resolved that commit with `git log -1 -- package.json` — the last
// commit that touched the FILE — which any dependency, script or `files` edit satisfies
// without moving the version. So in exactly the window the check exists for, a Dependabot
// dev-dependency bump merged after a failed release compared equal to HEAD, passed, and
// would have been published as the pending release. The bump commit is now found by
// CONTENT: walk the commits that touched package.json, newest first, and stop at the
// first whose version differs from its parent's.
//
// Pure `bumpCommit()` over rows is unit-tested against literal inputs; the git-backed
// walk is lazy (two blob reads per commit, stopping at the first change) and is
// exercised against fixture repositories in test/release-bump-commit.test.ts. Node
// built-ins only: the plan step runs before `npm ci`.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const MANIFEST = 'package.json';

/** The `version` a package.json text declares, or null when there is no text, it is
 *  not JSON, or it declares no string version. A null is a value like any other to
 *  `bumpCommit`: a commit that removed or broke the manifest still changed it. */
export function versionOf(text) {
  if (typeof text !== 'string') return null;
  try {
    const v = JSON.parse(text).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * The sha of the first row (newest first) whose version differs from its parent's, or
 * null when no row changes the version.
 * @param {Iterable<{sha: string, version: string|null, parent: string|null}>} rows
 */
export function bumpCommit(rows) {
  for (const r of rows) {
    if (r.version !== r.parent) return r.sha;
  }
  return null;
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr ?? '').trim()}`);
  return r.stdout;
}

/** The blob at `<rev>:<path>`, or null when the revision or the path does not exist
 *  there (a root commit has no parent; a manifest may not exist yet). */
function blobOrNull(rev, path, cwd) {
  const r = spawnSync('git', ['show', `${rev}:${path}`], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** Rows for every commit that touched the manifest, newest first, read lazily so the
 *  walk stops at the first version change. */
export function* gather(cwd = process.cwd(), path = MANIFEST) {
  const shas = git(['log', '--format=%H', '--', path], cwd).split('\n').filter(Boolean);
  for (const sha of shas) {
    yield { sha, version: versionOf(blobOrNull(sha, path, cwd)), parent: versionOf(blobOrNull(`${sha}^`, path, cwd)) };
  }
}

/** CLI: print the bump commit's sha, or fail closed when none can be found. */
export function main(cwd = process.cwd()) {
  const sha = bumpCommit(gather(cwd));
  if (sha === null) {
    return { code: 1, out: '', err: `::error::no commit in this history changes the version in ${MANIFEST}; the bump commit cannot be identified, so nothing is published\n` };
  }
  return { code: 0, out: `${sha}\n`, err: '' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = main(process.argv[2] ?? process.cwd());
  process.stdout.write(r.out);
  process.stderr.write(r.err);
  process.exit(r.code);
}
