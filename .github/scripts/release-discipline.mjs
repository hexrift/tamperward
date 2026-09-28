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
//
// The shipped surface is what `npm publish` delivers (#703): `src/` built into `dist/`,
// `schemas/`, `LICENSE` and `NOTICE` as-is, and the manifest fields that decide what a
// consumer's install gets — the runtime dependency ranges (the build is
// `--packages=external`, so nothing is bundled), engines, bin, exports, files and the
// install-time scripts. `devDependencies`, `scripts.test` and the rest of package.json
// are not shipped and stay free of the bump. Fields are compared by content, so a
// reordering of package.json is not a change; a manifest that cannot be parsed at
// either end of the range fails the check rather than reading as "no change".
//
// The bump itself must be the next step from the base (#711): the next patch, minor or
// major of a release (or a prerelease of one of those), a later prerelease or the
// release from a prerelease. Two pull requests opened against the same main each took
// "the next version" and one of them carried a CHANGELOG that skipped the other's; only
// a reviewer noticed. The ladder has no gaps, and there is no override for one.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import semver from 'semver';

/** Path prefixes whose change ships to users: `src/` builds into `dist/`, and `schemas/` is
 *  published as-is (package.json `files`). Docs, tests, harness and workflows are not the
 *  shipped surface and need no bump. */
export const SHIPPED_SURFACE = ['src/', 'schemas/'];

/** Files package.json `files` publishes as-is, so a change to them ships (#703). */
export const SHIPPED_FILES = ['LICENSE', 'NOTICE'];

/** The package.json fields npm delivers to a consumer's install (#703): what is installed
 *  alongside, where it runs, what is executable and resolvable, and what is packed.
 *  `version` is judged separately; `devDependencies`, `scripts` (other than the install
 *  hooks below), `description` and the like are not shipped. */
export const PUBLISHED_MANIFEST_FIELDS = [
  'dependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'optionalDependencies',
  'bundleDependencies',
  'bundledDependencies',
  'engines',
  'os',
  'cpu',
  'bin',
  'main',
  'module',
  'exports',
  'imports',
  'type',
  'files',
  'types',
  'typings',
  'browser',
];

/** The npm lifecycle scripts that run on the CONSUMER's machine at install time. */
export const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];

/** Published fields whose OBJECT KEY ORDER is part of the contract: Node resolves
 *  conditional exports and imports by taking the first matching condition in object
 *  order, so `{ node, default }` and `{ default, node }` load different files. These are
 *  compared with insertion order kept, throughout the value — a conservative reading that
 *  also counts a subpath-map reorder as a change — while every other field compares by
 *  content with keys sorted. */
export const ORDERED_MANIFEST_FIELDS = ['exports', 'imports'];

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

/** The changed paths that ship: under a shipped prefix, or one of the files published as-is. */
export function shippedChanges(paths) {
  return paths.filter((p) => SHIPPED_SURFACE.some((s) => p.startsWith(s)) || SHIPPED_FILES.includes(p));
}

/** Deterministic JSON so two manifests compare by content and not by formatting.
 *  Object keys are sorted recursively — except when `ordered` is set, for the fields whose
 *  key order is semantic (ORDERED_MANIFEST_FIELDS), where insertion order is kept at every
 *  level. `undefined` (an absent field) is its own value, distinct from `null`. */
function canonical(value, ordered = false) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, ordered)).join(',')}]`;
  const keys = ordered ? Object.keys(value) : Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k], ordered)}`).join(',')}}`;
}

function parseManifest(text, where) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`package.json at the PR ${where} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`package.json at the PR ${where} is not a JSON object`);
  }
  return parsed;
}

/** The published manifest fields that differ between the base and head package.json,
 *  named as `dependencies`, `bin`, `scripts.postinstall`, … (#703). Either manifest failing
 *  to parse throws: the caller fails closed instead of reading garbage as "no change". */
export function manifestSurfaceChanges(baseText, headText) {
  const base = parseManifest(baseText, 'base');
  const head = parseManifest(headText, 'head');
  const changed = [];
  for (const field of PUBLISHED_MANIFEST_FIELDS) {
    const ordered = ORDERED_MANIFEST_FIELDS.includes(field);
    if (canonical(base[field], ordered) !== canonical(head[field], ordered)) changed.push(field);
  }
  const baseScripts = base.scripts !== null && typeof base.scripts === 'object' ? base.scripts : {};
  const headScripts = head.scripts !== null && typeof head.scripts === 'object' ? head.scripts : {};
  for (const script of INSTALL_SCRIPTS) {
    if (canonical(baseScripts[script]) !== canonical(headScripts[script])) changed.push(`scripts.${script}`);
  }
  return changed;
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

/** Whether `headVersion` is the next step from `baseVersion`, and what the steps are.
 *  From a release: its next patch, minor or major, or a prerelease of one of those
 *  (2.39.6 → 2.40.0-rc.1). From a prerelease: a later prerelease of the same version, or
 *  that version's release (2.40.0-rc.1 → 2.40.0-rc.2 → 2.40.0). Anything else skips a
 *  step — 2.39.6 → 2.39.8 with 2.39.7 owned by another open pull request — which
 *  `semver.gt` alone accepted (#711). */
export function ladderStep(baseVersion, headVersion) {
  const stem = (v) => `${semver.major(v)}.${semver.minor(v)}.${semver.patch(v)}`;
  const next = { patch: semver.inc(baseVersion, 'patch'), minor: semver.inc(baseVersion, 'minor'), major: semver.inc(baseVersion, 'major') };
  if (semver.prerelease(baseVersion)) {
    const prereleaseOf = stem(baseVersion);
    return { ok: stem(headVersion) === prereleaseOf && semver.gt(headVersion, baseVersion), next, prereleaseOf };
  }
  return { ok: Object.values(next).includes(stem(headVersion)), next, prereleaseOf: null };
}

/**
 * The merge-side release decision.
 * @param {{ baseVersion: string, headVersion: string, changedPaths: string[], changelog: string,
 *           lockVersions?: (string|undefined)[], labels?: string[], headSha: string,
 *           manifestChanges?: string[] }} input
 * @returns {{ ok: true, notes: string[] } | { ok: false, errors: string[] }}
 */
export function decide(input) {
  const errors = [];
  const notes = [];
  const { baseVersion, headVersion, changedPaths, changelog, labels = [], headSha, manifestChanges = [] } = input;
  if (!semver.valid(headVersion)) {
    return { ok: false, errors: [`package.json at the PR head does not carry a valid semver version: ${JSON.stringify(headVersion)}`] };
  }
  if (!semver.valid(baseVersion)) {
    return { ok: false, errors: [`package.json at the PR base does not carry a valid semver version: ${JSON.stringify(baseVersion)}`] };
  }
  // Published manifest fields count as shipped like a file under src/ (#703); they are
  // listed as `package.json#<field>` so the message names what moved.
  const shipped = [...shippedChanges(changedPaths), ...manifestChanges.map((f) => `package.json#${f}`)];
  const bumped = headVersion !== baseVersion;
  const { bound, stale } = overrideLabels(labels, headSha);

  if (shipped.length > 0 && !bumped) {
    if (bound.length > 0) {
      notes.push(`${shipped.length} shipped change(s) without a version bump; a maintainer recorded "no behaviour shipped" with ${bound.join(', ')} for head ${headSha}`);
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
    } else {
      const step = ladderStep(baseVersion, headVersion);
      if (!step.ok) {
        const where = step.prereleaseOf
          ? `which is neither a later prerelease of ${step.prereleaseOf} nor its release`
          : `which is not the next patch (${step.next.patch}), minor (${step.next.minor}) or major (${step.next.major}) of ${baseVersion}`;
        errors.push(
          `package.json moves from ${baseVersion} to ${headVersion}, ${where}: the release ladder has no gaps. ` +
            'If another open pull request owns the version in between, merge it first and bring main in (this entry then sits above it); otherwise renumber this release.',
        );
      }
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
  // `--no-renames`: a rename OUT of the shipped surface is a shipped-file removal
  // (`git mv src/a.ts docs/a.ts`), and rename detection would list only the postimage
  // `docs/a.ts`. With detection off the move is a deletion plus an addition, so both
  // the preimage and the postimage paths reach the decision.
  const changedPaths = git(['diff', '--name-only', '--no-renames', `${baseSha}...${headSha}`]).split('\n').filter(Boolean);
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
    // Only a range that touched package.json can have moved a published field; when it
    // did, both manifests must parse or the check fails (fail closed, never "no change").
    manifestChanges: changedPaths.includes('package.json') ? manifestSurfaceChanges(blob(baseSha, 'package.json'), blob(headSha, 'package.json')) : [],
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
