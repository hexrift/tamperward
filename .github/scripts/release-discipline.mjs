// Release-discipline gate for pull requests (#693).
//
// CLAUDE.md's release rule — every behaviour change ships with its version bump and a
// dated CHANGELOG entry, never an [Unreleased] section — had no mechanical half: five
// behaviour changes merged on 2026-09-26 without a bump, and `main` shipped unreleased
// behaviour under the previous tag until #691 cut 2.39.1 after the fact. This helper is
// that half, for what a `pull_request` run can see. `release.yml` still guards the
// publish side (forward version, bump-head); this guards the merge side.
//
// The decision is a pure function over values git can produce (exported and unit-tested
// in test/release-discipline.test.ts); the CLI at the bottom feeds it from the PR range.
// It cannot judge patch versus minor — CONTRIBUTING "Versioning" does — it only turns
// "did this PR move the version, or did a maintainer record that it ships no behaviour"
// into an explicit, reviewed fact instead of an omission.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import semver from 'semver';

/** Paths whose change ships to users: `src/` builds into `dist/`, and `schemas/` is
 *  published as-is (package.json `files`). Docs, tests, harness and workflows are not the
 *  shipped surface and need no bump. */
export const SHIPPED_SURFACE = ['src/', 'schemas/'];

/** Maintainer-applied, head-bound override: `release-none:<hex prefix of the head sha>`.
 *  GitHub caps a label at 50 characters, so the full 40-hex sha does not fit behind the
 *  prefix; at least MIN_SHA_PREFIX hex characters of the head sha are required. Binding to
 *  the head is what makes the label an approval of THIS diff and not of whatever is pushed
 *  next — the unbound-label hole the `tw1:` sign-off closed in 1.14.7. */
export const OVERRIDE_PREFIX = 'release-none:';
export const MIN_SHA_PREFIX = 7;

const NEWEST_HEADING = /^## \[([^\]]+)\](.*)$/m;
const DATED_TAIL = /^ — (\d{4})-(\d{2})-(\d{2})\s*$/;
const UNRELEASED = /^## \[unreleased\]/im;
const SHA40 = /^[0-9a-f]{40}$/i;

/** The changed paths that ship. */
export function shippedChanges(paths) {
  return paths.filter((p) => SHIPPED_SURFACE.some((s) => p.startsWith(s)));
}

/** The override labels on the PR, split into those bound to `headSha` and the rest
 *  (malformed, too short, or bound to another head). */
export function overrideLabels(labels, headSha) {
  const head = String(headSha ?? '').toLowerCase();
  const bound = [];
  const stale = [];
  for (const raw of labels) {
    const label = String(raw);
    if (!label.startsWith(OVERRIDE_PREFIX)) continue;
    const ref = label.slice(OVERRIDE_PREFIX.length).toLowerCase();
    const wellFormed = new RegExp(`^[0-9a-f]{${MIN_SHA_PREFIX},40}$`).test(ref);
    if (wellFormed && SHA40.test(head) && head.startsWith(ref)) bound.push(label);
    else stale.push(label);
  }
  return { bound, stale };
}

/** The newest `## [version]` heading and whether it carries a real ` — YYYY-MM-DD` date. */
export function newestHeading(changelog) {
  const m = NEWEST_HEADING.exec(String(changelog ?? ''));
  if (!m) return null;
  const tail = DATED_TAIL.exec(m[2]);
  let dated = false;
  if (tail) {
    const y = Number(tail[1]);
    const mo = Number(tail[2]);
    const d = Number(tail[3]);
    const date = new Date(Date.UTC(y, mo - 1, d));
    dated = date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
  }
  return { version: m[1], dated, line: m[0] };
}

export function hasUnreleased(changelog) {
  return UNRELEASED.test(String(changelog ?? ''));
}

/**
 * The merge-side release decision.
 * @param {{ baseVersion: string, headVersion: string, changedPaths: string[], changelog: string,
 *           lockVersions?: (string|undefined)[], labels?: string[], headSha: string }} input
 * @returns {{ ok: true, notes: string[] } | { ok: false, errors: string[] }}
 */
export function decide(input) {
  const errors = [];
  const notes = [];
  const { baseVersion, headVersion, changedPaths, changelog, labels = [], headSha } = input;
  if (!semver.valid(headVersion)) {
    return { ok: false, errors: [`package.json at the PR head does not carry a valid semver version: ${JSON.stringify(headVersion)}`] };
  }
  if (!semver.valid(baseVersion)) {
    return { ok: false, errors: [`package.json at the PR base does not carry a valid semver version: ${JSON.stringify(baseVersion)}`] };
  }
  const shipped = shippedChanges(changedPaths);
  const bumped = headVersion !== baseVersion;
  const { bound, stale } = overrideLabels(labels, headSha);

  if (shipped.length > 0 && !bumped) {
    if (bound.length > 0) {
      notes.push(`${shipped.length} shipped file(s) changed without a version bump; a maintainer recorded "no behaviour shipped" with ${bound.join(', ')} for head ${headSha}`);
    } else {
      const sample = shipped.slice(0, 5).join(', ') + (shipped.length > 5 ? `, … ${shipped.length} in total` : '');
      errors.push(
        `shipped code changed (${sample}) but package.json still reads ${headVersion}. Every behaviour change ships with its bump (CLAUDE.md): ` +
          'bump the version (patch for a fix, minor for new surface — CONTRIBUTING "Versioning") and add a dated CHANGELOG entry under it; ' +
          `or, if this change ships no behaviour, a maintainer applies the label ${OVERRIDE_PREFIX}${String(headSha).slice(0, 12)} to record that for this exact head.` +
          (stale.length ? ` (${stale.join(', ')} is not bound to this head and does not count.)` : ''),
      );
    }
  }

  if (bumped) {
    if (!semver.gt(headVersion, baseVersion)) {
      errors.push(`package.json moved from ${baseVersion} to ${headVersion}, which is not a forward move; a release must move the version up.`);
    }
    const heading = newestHeading(changelog);
    if (!heading) {
      errors.push(`package.json moved to ${headVersion} but CHANGELOG.md has no "## [version]" heading at all.`);
    } else if (heading.version !== headVersion) {
      errors.push(`package.json moved to ${headVersion} but the newest CHANGELOG.md heading is "${heading.line}"; the entry for ${headVersion} must be the newest heading.`);
    } else if (!heading.dated) {
      errors.push(`the CHANGELOG.md heading for ${headVersion} is "${heading.line}"; it must read "## [${headVersion}] — YYYY-MM-DD" with a calendar date, not a placeholder.`);
    }
    const lock = input.lockVersions ?? [];
    lock.forEach((v, i) => {
      if (v !== undefined && v !== headVersion) {
        errors.push(`package-lock.json still reads ${v} (${i === 0 ? 'top-level version' : 'packages[""].version'}) while package.json reads ${headVersion}; bump both (\`npm version ${headVersion} --no-git-tag-version\` does).`);
      }
    });
  }

  if (hasUnreleased(changelog)) {
    errors.push('CHANGELOG.md carries an "[Unreleased]" heading; releases are version-driven, so date the entry under the version this PR ships (CLAUDE.md).');
  }

  if (errors.length) return { ok: false, errors };
  if (shipped.length === 0 && !bumped) notes.push('no shipped file changed and the version is unchanged');
  if (bumped) notes.push(`version moves ${baseVersion} → ${headVersion} with a dated CHANGELOG heading`);
  return { ok: true, notes };
}

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr ?? '').trim()}`);
  return r.stdout;
}

function blob(sha, path) {
  return git(['show', `${sha}:${path}`]);
}

function versionAt(sha) {
  const pkg = JSON.parse(blob(sha, 'package.json'));
  return pkg.version;
}

function lockVersionsAt(sha) {
  let text;
  try {
    text = blob(sha, 'package-lock.json');
  } catch {
    return [];
  }
  const lock = JSON.parse(text);
  return [lock.version, lock.packages?.['']?.version];
}

/** Everything the decision needs, read from the PR range. Labels arrive as the JSON array
 *  `toJSON(github.event.pull_request.labels.*.name)` through the environment. */
export function gather(baseSha, headSha, labelsJson) {
  const changedPaths = git(['diff', '--name-only', `${baseSha}...${headSha}`]).split('\n').filter(Boolean);
  const parsed = JSON.parse(labelsJson || '[]');
  if (!Array.isArray(parsed) || parsed.some((l) => typeof l !== 'string')) throw new Error('PR_LABELS_JSON is not a JSON array of strings');
  return {
    baseVersion: versionAt(baseSha),
    headVersion: versionAt(headSha),
    changedPaths,
    changelog: blob(headSha, 'CHANGELOG.md'),
    lockVersions: lockVersionsAt(headSha),
    labels: parsed,
    headSha,
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const [baseSha, headSha] = process.argv.slice(2);
  if (!SHA40.test(baseSha ?? '') || !SHA40.test(headSha ?? '')) {
    console.error('::error::release-discipline: usage: node release-discipline.mjs <base-sha> <head-sha> (40 hex each; labels via PR_LABELS_JSON)');
    process.exit(1);
  }
  let decision;
  try {
    decision = decide(gather(baseSha, headSha, process.env.PR_LABELS_JSON));
  } catch (e) {
    console.error(`::error::release-discipline could not read the PR range: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (!decision.ok) {
    for (const err of decision.errors) console.error(`::error::${err}`);
    process.exit(1);
  }
  console.log(`release discipline: ${decision.notes.join('; ')}`);
}
