// #693: CLAUDE.md's release rule (every behaviour change ships with its bump and a dated
// CHANGELOG entry; never an [Unreleased] section) had no mechanical half — five behaviour
// changes merged on 2026-09-26 without a bump and main shipped unreleased behaviour under
// the previous tag (#691). The required `gate` now runs
// .github/scripts/release-discipline.mjs on every pull request. The decision is a pure
// function, tested here against literal inputs; the git-backed CLI is exercised against
// a throwaway repository so the plumbing (range diff, blob reads, exit codes, the
// env-carried labels) is covered without touching this checkout.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — untyped .mjs helper, imported for behaviour like the forward-guard tests
import { decide, shippedChanges, manifestSurfaceChanges, overrideLabels, newestHeading, hasUnreleased, ladderStep, OVERRIDE_PREFIX, MIN_SHA_PREFIX, PUBLISHED_MANIFEST_FIELDS, INSTALL_SCRIPTS, SHIPPED_FILES, ORDERED_MANIFEST_FIELDS } from '../.github/scripts/release-discipline.mjs';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';

const changelog = (v: string, date = '2026-09-27') =>
  `# Changelog\n\n## [${v}] — ${date}\n\n### Fixed\n\n- something (#1).\n\n## [1.0.0] — 2026-01-01\n\n### Added\n\n- the first thing.\n`;

interface Input {
  baseVersion: string;
  headVersion: string;
  changedPaths: string[];
  changelog: string;
  lockVersions?: (string | undefined)[];
  labels?: string[];
  headSha: string;
  manifestChanges?: string[];
}

const input = (over: Partial<Input> = {}): Input => ({
  baseVersion: '1.0.0',
  headVersion: '1.0.0',
  changedPaths: ['docs/guide/x.md'],
  changelog: changelog('1.0.0', '2026-01-01'),
  lockVersions: ['1.0.0', '1.0.0'],
  labels: [],
  headSha: HEAD,
  ...over,
});

const bumped = (over: Partial<Input> = {}): Input =>
  input({ headVersion: '1.0.1', changedPaths: ['src/a.ts'], changelog: changelog('1.0.1'), lockVersions: ['1.0.1', '1.0.1'], ...over });

function errorsOf(r: { ok: boolean; errors?: string[] }): string {
  expect(r.ok).toBe(false);
  return (r.errors ?? []).join('\n');
}

describe('#693 release discipline — shipped surface', () => {
  it('src/ and schemas/ ship; docs, tests, harness and workflows do not', () => {
    expect(shippedChanges(['src/a.ts', 'schemas/x.json', 'docs/a.md', 'test/a.test.ts', 'harness/x', '.github/workflows/ci.yml', 'CHANGELOG.md']))
      .toEqual(['src/a.ts', 'schemas/x.json']);
  });
  it('a docs-only PR with an unchanged version passes', () => {
    expect(decide(input())).toEqual({ ok: true, notes: ['no shipped file changed and the version is unchanged'] });
  });
  it('a test-only or workflow-only PR with an unchanged version passes', () => {
    expect(decide(input({ changedPaths: ['test/a.test.ts', '.github/workflows/ci.yml', '.github/scripts/x.mjs'] })).ok).toBe(true);
  });
  it('RED: a src/ change with an unchanged version fails, naming the file, the rule and the label to apply', () => {
    const msg = errorsOf(decide(input({ changedPaths: ['src/a.ts', 'test/a.test.ts'] })));
    expect(msg).toContain('shipped code changed (src/a.ts)');
    expect(msg).toContain('still reads 1.0.0');
    expect(msg).toContain('CLAUDE.md');
    expect(msg).toContain(`${OVERRIDE_PREFIX}${HEAD.slice(0, 12)}`);
  });
  it('a schemas/ change counts as shipped', () => {
    expect(errorsOf(decide(input({ changedPaths: ['schemas/check-v1.schema.json'] })))).toContain('schemas/check-v1.schema.json');
  });
  it('lists at most five files and the total when more changed', () => {
    const paths = Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`);
    const msg = errorsOf(decide(input({ changedPaths: paths })));
    expect(msg).toContain('src/f4.ts');
    expect(msg).not.toContain('src/f5.ts');
    expect(msg).toContain('8 in total');
  });
});

describe('#703 release discipline — the published manifest fields and LICENSE/NOTICE ship too', () => {
  const manifest = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { yaml: '^2.6.1' }, devDependencies: { vitest: '^5.0.0' }, scripts: { test: 'vitest run', build: 'esbuild' }, files: ['dist'], bin: { fixture: 'dist/cli.js' }, engines: { node: '>=20' }, type: 'module', ...over });

  it('LICENSE and NOTICE are shipped files; a docs file next to them is not', () => {
    expect(SHIPPED_FILES).toEqual(['LICENSE', 'NOTICE']);
    expect(shippedChanges(['LICENSE', 'NOTICE', 'LICENSES.md', 'README.md'])).toEqual(['LICENSE', 'NOTICE']);
  });
  it('RED: a runtime dependency range change is named; a devDependency change is not', () => {
    expect(manifestSurfaceChanges(manifest(), manifest({ dependencies: { yaml: '^2.7.0' } }))).toEqual(['dependencies']);
    expect(manifestSurfaceChanges(manifest(), manifest({ devDependencies: { vitest: '^6.0.0' } }))).toEqual([]);
  });
  it.each([
    ['bin', { bin: { fixture: 'dist/other.js' } }],
    ['engines', { engines: { node: '>=22' } }],
    ['files', { files: ['dist', 'extra'] }],
    ['exports', { exports: { '.': './dist/index.js' } }],
    ['type', { type: 'commonjs' }],
    ['peerDependencies', { peerDependencies: { typescript: '>=5' } }],
    ['optionalDependencies', { optionalDependencies: { fsevents: '*' } }],
  ])('a change to %s is named', (field, over) => {
    expect(manifestSurfaceChanges(manifest(), manifest(over))).toEqual([field]);
  });
  it('an install-time script is shipped; a test or build script is not', () => {
    expect(manifestSurfaceChanges(manifest(), manifest({ scripts: { test: 'vitest run', build: 'esbuild', postinstall: 'node setup.js' } }))).toEqual(['scripts.postinstall']);
    expect(manifestSurfaceChanges(manifest(), manifest({ scripts: { test: 'vitest run --coverage', build: 'tsup' } }))).toEqual([]);
    expect(INSTALL_SCRIPTS).toEqual(['preinstall', 'install', 'postinstall']);
  });
  it('compares by content: a reordering or reformatting of package.json is not a change', () => {
    const reordered = JSON.stringify({ type: 'module', engines: { node: '>=20' }, bin: { fixture: 'dist/cli.js' }, files: ['dist'], scripts: { build: 'esbuild', test: 'vitest run' }, devDependencies: { vitest: '^5.0.0' }, dependencies: { yaml: '^2.6.1' }, version: '1.0.0', name: 'fixture' }, null, 4);
    expect(manifestSurfaceChanges(manifest(), reordered)).toEqual([]);
    // Inside an order-insensitive map, key order is formatting too.
    expect(manifestSurfaceChanges(manifest({ dependencies: { a: '1', yaml: '^2.6.1' } }), manifest({ dependencies: { yaml: '^2.6.1', a: '1' } }))).toEqual([]);
    expect(manifestSurfaceChanges(manifest({ bin: { a: 'a.js', b: 'b.js' } }), manifest({ bin: { b: 'b.js', a: 'a.js' } }))).toEqual([]);
  });
  it('RED: a reorder of conditional-export keys IS a change — Node takes the first matching condition in object order', () => {
    expect(ORDERED_MANIFEST_FIELDS).toEqual(['exports', 'imports']);
    const before = manifest({ exports: { '.': { node: './node.js', default: './fallback.js' } } });
    const after = manifest({ exports: { '.': { default: './fallback.js', node: './node.js' } } });
    expect(manifestSurfaceChanges(before, after)).toEqual(['exports']);
    // The same two objects reformatted, order intact, are not a change.
    expect(manifestSurfaceChanges(before, JSON.stringify(JSON.parse(before), null, 4))).toEqual([]);
    // imports follow the same contract.
    const importsBefore = manifest({ imports: { '#dep': { node: './n.js', default: './d.js' } } });
    const importsAfter = manifest({ imports: { '#dep': { default: './d.js', node: './n.js' } } });
    expect(manifestSurfaceChanges(importsBefore, importsAfter)).toEqual(['imports']);
    // Conservative on purpose: a subpath-map reorder counts too (order is kept at every level).
    const subpaths = manifest({ exports: { '.': './a.js', './b': './b.js' } });
    const subpathsSwapped = manifest({ exports: { './b': './b.js', '.': './a.js' } });
    expect(manifestSurfaceChanges(subpaths, subpathsSwapped)).toEqual(['exports']);
  });
  it('removing a published field, or adding one, is a change (absence is its own value)', () => {
    expect(manifestSurfaceChanges(manifest(), manifest({ bin: undefined }))).toEqual(['bin']);
    expect(manifestSurfaceChanges(manifest({ bin: undefined }), manifest())).toEqual(['bin']);
    expect(manifestSurfaceChanges(manifest(), manifest({ os: ['linux'] }))).toEqual(['os']);
  });
  it('every field in the list is a string, once', () => {
    expect(new Set(PUBLISHED_MANIFEST_FIELDS).size).toBe(PUBLISHED_MANIFEST_FIELDS.length);
    expect(PUBLISHED_MANIFEST_FIELDS).toContain('dependencies');
    expect(PUBLISHED_MANIFEST_FIELDS).not.toContain('devDependencies');
    expect(PUBLISHED_MANIFEST_FIELDS).not.toContain('version');
  });
  it('a manifest that does not parse, or is not an object, throws instead of reading as "no change"', () => {
    expect(() => manifestSurfaceChanges('{', manifest())).toThrow(/PR base is not valid JSON/);
    expect(() => manifestSurfaceChanges(manifest(), '[]')).toThrow(/PR head is not a JSON object/);
    expect(() => manifestSurfaceChanges(manifest(), 'null')).toThrow(/PR head is not a JSON object/);
  });
  it('decide: RED a published field change without a bump fails, naming the field as package.json#<field>', () => {
    const msg = errorsOf(decide(input({ changedPaths: ['package.json', 'package-lock.json'], manifestChanges: ['dependencies'] })));
    expect(msg).toContain('shipped code changed (package.json#dependencies)');
    expect(msg).toContain('still reads 1.0.0');
  });
  it('decide: the same change with a forward bump passes, and with the head-bound label is recorded', () => {
    expect(decide(bumped({ changedPaths: ['package.json', 'package-lock.json', 'CHANGELOG.md'], manifestChanges: ['dependencies'] })).ok).toBe(true);
    const r = decide(input({ changedPaths: ['package.json'], manifestChanges: ['engines'], labels: [`${OVERRIDE_PREFIX}${HEAD.slice(0, 12)}`] }));
    expect(r.ok).toBe(true);
    expect(r.notes.join(' ')).toContain('1 shipped change(s) without a version bump');
  });
  it('decide: a package.json edit that moved no published field is not shipped', () => {
    expect(decide(input({ changedPaths: ['package.json'], manifestChanges: [] }))).toEqual({ ok: true, notes: ['no shipped file changed and the version is unchanged'] });
  });
});

describe('#693 release discipline — a bump must be forward, dated and in step', () => {
  it('GREEN: a src/ change with a forward bump and a dated newest heading passes', () => {
    expect(decide(bumped())).toEqual({ ok: true, notes: ['version moves 1.0.0 → 1.0.1 with a dated CHANGELOG heading'] });
  });
  it('a docs-only patch release (no shipped change, bump present) is allowed', () => {
    expect(decide(bumped({ changedPaths: ['docs/a.md', 'CHANGELOG.md', 'package.json', 'package-lock.json'] })).ok).toBe(true);
  });
  it('a backwards or sideways version move fails', () => {
    expect(errorsOf(decide(bumped({ baseVersion: '1.0.2' })))).toContain('not a forward move');
  });
  it('a bump whose newest heading is still the previous version fails', () => {
    const msg = errorsOf(decide(bumped({ changelog: changelog('1.0.0', '2026-01-01') })));
    expect(msg).toContain('newest CHANGELOG.md heading is "## [1.0.0] — 2026-01-01"');
  });
  it('a bump with no heading at all fails', () => {
    expect(errorsOf(decide(bumped({ changelog: '# Changelog\n\nnothing yet\n' })))).toContain('no "## [version]" heading');
  });
  it.each(['## [1.0.1]', '## [1.0.1] — TBD', '## [1.0.1] - 2026-09-27', '## [1.0.1] — 2026-13-40', '## [1.0.1] — 2026-02-30'])(
    'an undated, placeholder, wrongly punctuated or impossible-date heading fails: %s',
    (line) => {
      expect(errorsOf(decide(bumped({ changelog: `# Changelog\n\n${line}\n\n- x\n` })))).toContain('with a calendar date');
    },
  );
  it('a lock file left at the old version fails and names which field', () => {
    const msg = errorsOf(decide(bumped({ lockVersions: ['1.0.1', '1.0.0'] })));
    expect(msg).toContain('package-lock.json still reads 1.0.0 (packages[""].version)');
  });
  it('a missing lock file is not a finding (nothing to keep in step)', () => {
    expect(decide(bumped({ lockVersions: [] })).ok).toBe(true);
  });
  it('an invalid version at head or base fails closed', () => {
    expect(errorsOf(decide(input({ headVersion: 'next' })))).toContain('valid semver');
    expect(errorsOf(decide(input({ baseVersion: '' })))).toContain('valid semver');
  });
});

describe('#693 release discipline — [Unreleased] never lands', () => {
  it('detects the heading case-insensitively', () => {
    expect(hasUnreleased('# Changelog\n\n## [Unreleased]\n')).toBe(true);
    expect(hasUnreleased('# Changelog\n\n## [UNRELEASED] — soon\n')).toBe(true);
    expect(hasUnreleased(changelog('1.0.1'))).toBe(false);
  });
  it('fails even when nothing shipped and the version did not move', () => {
    const msg = errorsOf(decide(input({ changelog: '# Changelog\n\n## [Unreleased]\n\n- x\n\n## [1.0.0] — 2026-01-01\n' })));
    expect(msg).toContain('[Unreleased]');
  });
  it('fails alongside an otherwise valid bump', () => {
    const cl = '# Changelog\n\n## [1.0.1] — 2026-09-27\n\n- x\n\n## [Unreleased]\n\n- y\n';
    expect(errorsOf(decide(bumped({ changelog: cl })))).toContain('[Unreleased]');
  });
});

describe('#693 release discipline — the head-bound override label', () => {
  it('accepts a prefix of at least the minimum length that matches the head, case-insensitively', () => {
    const r = overrideLabels([`${OVERRIDE_PREFIX}${HEAD.slice(0, MIN_SHA_PREFIX).toUpperCase()}`, 'tw1:abc', 'bug'], HEAD);
    expect(r.bound).toHaveLength(1);
    expect(r.stale).toEqual([]);
  });
  it('a label bound to another head, too short, or malformed is stale', () => {
    const r = overrideLabels(
      [`${OVERRIDE_PREFIX}${OTHER.slice(0, 12)}`, `${OVERRIDE_PREFIX}${HEAD.slice(0, MIN_SHA_PREFIX - 1)}`, `${OVERRIDE_PREFIX}`, `${OVERRIDE_PREFIX}zz${HEAD.slice(2, 12)}`],
      HEAD,
    );
    expect(r.bound).toEqual([]);
    expect(r.stale).toHaveLength(4);
  });
  it('a bound label lets a shipped change through without a bump and records who said so', () => {
    const label = `${OVERRIDE_PREFIX}${HEAD.slice(0, 12)}`;
    const r = decide(input({ changedPaths: ['src/a.ts'], labels: [label] }));
    expect(r).toEqual({ ok: true, notes: [`1 shipped change(s) without a version bump; a maintainer recorded "no behaviour shipped" with ${label} for head ${HEAD}`] });
  });
  it('a label bound to a previous head does not clear a new push, and the error says so', () => {
    const stale = `${OVERRIDE_PREFIX}${OTHER.slice(0, 12)}`;
    const msg = errorsOf(decide(input({ changedPaths: ['src/a.ts'], labels: [stale] })));
    expect(msg).toContain(`${stale} is not bound to this head`);
  });
  it('the override does not excuse an [Unreleased] heading', () => {
    const label = `${OVERRIDE_PREFIX}${HEAD.slice(0, 12)}`;
    const cl = '# Changelog\n\n## [Unreleased]\n\n- x\n';
    expect(errorsOf(decide(input({ changedPaths: ['src/a.ts'], labels: [label], changelog: cl })))).toContain('[Unreleased]');
  });
});

describe('#693 release discipline — newestHeading', () => {
  it('parses the first heading and its date', () => {
    expect(newestHeading(changelog('2.39.1'))).toEqual({ version: '2.39.1', dated: true, line: '## [2.39.1] — 2026-09-27' });
    expect(newestHeading('nothing')).toBeNull();
  });
});

describe('#693 release discipline — CLI against a throwaway repository', () => {
  const SCRIPT = join(__dirname, '..', '.github', 'scripts', 'release-discipline.mjs');
  let repo = '';
  let baseSha = '';
  let noBumpSha = '';
  let bumpSha = '';
  let renameSrcSha = '';
  let renameSchemaSha = '';
  let runtimeDepSha = '';
  let devDepSha = '';
  let licenseSha = '';
  let skipSha = '';

  const g = (args: string[]): string => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (rel: string, text: string) => writeFileSync(join(repo, rel), text);
  const pkg = (v: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name: 'fixture', version: v, ...extra }, null, 2) + '\n';
  const lock = (v: string) => JSON.stringify({ name: 'fixture', version: v, lockfileVersion: 3, packages: { '': { name: 'fixture', version: v } } }, null, 2) + '\n';
  const commitAll = (msg: string): string => {
    g(['add', '-A']);
    g(['commit', '-q', '-m', msg]);
    return g(['rev-parse', 'HEAD']);
  };
  const run = (base: string, head: string, labels: string[] = []) =>
    spawnSync(process.execPath, [SCRIPT, base, head], { cwd: repo, encoding: 'utf8', env: { ...process.env, PR_LABELS_JSON: JSON.stringify(labels) } });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'tw-release-discipline-'));
    g(['init', '-q']);
    mkdirSync(join(repo, 'src'));
    write('package.json', pkg('1.0.0'));
    write('package-lock.json', lock('1.0.0'));
    write('CHANGELOG.md', changelog('1.0.0', '2026-01-01'));
    write('src/a.ts', 'export const a = 1;\n');
    mkdirSync(join(repo, 'schemas'));
    write('schemas/x.json', '{}\n');
    baseSha = commitAll('base');
    write('src/a.ts', 'export const a = 2;\n');
    noBumpSha = commitAll('change without a bump');
    write('package.json', pkg('1.0.1'));
    write('package-lock.json', lock('1.0.1'));
    write('CHANGELOG.md', changelog('1.0.1'));
    bumpSha = commitAll('release 1.0.1');
    mkdirSync(join(repo, 'docs'));
    g(['mv', 'src/a.ts', 'docs/a.ts']);
    renameSrcSha = commitAll('move a shipped file out of src without a bump');
    mkdirSync(join(repo, 'other'));
    g(['mv', 'schemas/x.json', 'other/x.json']);
    renameSchemaSha = commitAll('move a schema out of schemas without a bump');
    // #703: manifest edits without a version change — a runtime dependency range (ships),
    // then a devDependency (does not), then the license text (ships as-is).
    write('package.json', pkg('1.0.1', { dependencies: { yaml: '^2.7.0' } }));
    runtimeDepSha = commitAll('build(deps): bump yaml range without a bump');
    write('package.json', pkg('1.0.1', { dependencies: { yaml: '^2.7.0' }, devDependencies: { vitest: '^6.0.0' } }));
    devDepSha = commitAll('build(deps-dev): bump vitest without a bump');
    write('LICENSE', 'MIT, amended\n');
    licenseSha = commitAll('edit the license without a bump');
    // #711: a bump that skips a version (1.0.1 → 1.0.3) with everything else in order.
    write('package.json', pkg('1.0.3', { dependencies: { yaml: '^2.7.0' }, devDependencies: { vitest: '^6.0.0' } }));
    write('package-lock.json', lock('1.0.3'));
    write('CHANGELOG.md', changelog('1.0.3'));
    skipSha = commitAll('release 1.0.3, skipping 1.0.2');
  });
  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('fails a shipped change without a bump, as a ::error:: line', () => {
    const r = run(baseSha, noBumpSha);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^::error::shipped code changed \(src\/a\.ts\) but package\.json still reads 1\.0\.0/m);
  });
  it('passes the same head once a maintainer binds the override label to it, and says so', () => {
    const r = run(baseSha, noBumpSha, [`${OVERRIDE_PREFIX}${noBumpSha.slice(0, 12)}`]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no behaviour shipped');
  });
  it('a label for the earlier head does not clear the later push', () => {
    const r = run(baseSha, bumpSha === '' ? noBumpSha : noBumpSha, [`${OVERRIDE_PREFIX}${baseSha.slice(0, 12)}`]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is not bound to this head');
  });
  it('passes once the version moves with a dated heading and the lock in step', () => {
    const r = run(baseSha, bumpSha);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('version moves 1.0.0 → 1.0.1');
  });
  it('a rename out of src/ is a shipped-file removal, which rename detection would hide behind the postimage', () => {
    // The trap: with rename detection on, name-only lists only docs/a.ts.
    expect(g(['diff', '--name-only', '-M', `${bumpSha}...${renameSrcSha}`])).toBe('docs/a.ts');
    const r = run(bumpSha, renameSrcSha);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('shipped code changed (src/a.ts)');
  });
  it('a rename out of schemas/ is caught the same way', () => {
    expect(g(['diff', '--name-only', '-M', `${renameSrcSha}...${renameSchemaSha}`])).toBe('other/x.json');
    const r = run(renameSrcSha, renameSchemaSha);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('shipped code changed (schemas/x.json)');
  });
  it('the range is base...head, so the earlier no-bump commit is covered by the later bump', () => {
    expect(run(noBumpSha, bumpSha).status).toBe(0);
  });
  it('RED (#703): a runtime dependency range change without a bump fails, naming the field', () => {
    const r = run(renameSchemaSha, runtimeDepSha);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('shipped code changed (package.json#dependencies)');
  });
  it('a devDependency change alone is not shipped and passes', () => {
    const r = run(runtimeDepSha, devDepSha);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no shipped file changed');
  });
  it('a LICENSE edit without a bump fails: the file is published as-is', () => {
    const r = run(devDepSha, licenseSha);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('shipped code changed (LICENSE)');
  });
  it('the head-bound label clears a manifest-only change like any other', () => {
    expect(run(renameSchemaSha, runtimeDepSha, [`${OVERRIDE_PREFIX}${runtimeDepSha.slice(0, 12)}`]).status).toBe(0);
  });
  it('RED (#711): a bump that skips a version fails as a ::error:: line naming the next patch', () => {
    const r = run(licenseSha, skipSha);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('::error::package.json moves from 1.0.1 to 1.0.3, which is not the next patch (1.0.2), minor (1.1.0) or major (2.0.0) of 1.0.1: the release ladder has no gaps.');
  });

  it('rejects malformed shas and unreadable ranges instead of passing by accident', () => {
    expect(run('abc', 'def').status).toBe(1);
    expect(run(baseSha, OTHER).status).toBe(1);
  });
  it('rejects a labels payload that is not a JSON array of strings', () => {
    const r = spawnSync(process.execPath, [SCRIPT, baseSha, noBumpSha], { cwd: repo, encoding: 'utf8', env: { ...process.env, PR_LABELS_JSON: '{"x":1}' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('PR_LABELS_JSON');
  });
});

describe('#711 release discipline — the release ladder has no gaps', () => {
  const step = (baseVersion: string, headVersion: string) =>
    decide(bumped({ baseVersion, headVersion, changelog: changelog(headVersion), lockVersions: [headVersion, headVersion] }));

  it('RED: a bump that skips a version fails, naming the three next versions and the two ways out', () => {
    const msg = errorsOf(step('2.39.6', '2.39.8'));
    expect(msg).toContain('moves from 2.39.6 to 2.39.8');
    expect(msg).toContain('is not the next patch (2.39.7), minor (2.40.0) or major (3.0.0) of 2.39.6');
    expect(msg).toContain('ladder has no gaps');
    expect(msg).toMatch(/merge it first and bring main in/);
    expect(msg).toMatch(/renumber/);
  });

  it('the next patch, minor and major of the base all pass', () => {
    for (const head of ['2.39.7', '2.40.0', '3.0.0']) {
      const r = step('2.39.6', head);
      expect(r.ok, head).toBe(true);
      expect(r.notes.join('\n')).toContain(`version moves 2.39.6 → ${head}`);
    }
  });

  it('a skip by minor, by major, or a patch on a version that was never released, fails', () => {
    for (const head of ['2.41.0', '2.40.1', '3.0.1', '3.1.0', '4.0.0']) {
      expect(errorsOf(step('2.39.6', head)), head).toContain('ladder has no gaps');
    }
  });

  it('a prerelease of a next version passes; a prerelease of a skipped one does not', () => {
    expect(step('2.39.6', '2.40.0-rc.1').ok).toBe(true);
    expect(step('2.39.6', '2.39.7-beta.0').ok).toBe(true);
    expect(errorsOf(step('2.39.6', '2.39.8-rc.1'))).toContain('ladder has no gaps');
  });

  it('from a prerelease, a later prerelease of the same version or its release passes; another version fails', () => {
    expect(step('2.40.0-rc.1', '2.40.0-rc.2').ok).toBe(true);
    expect(step('2.40.0-rc.1', '2.40.0').ok).toBe(true);
    for (const head of ['2.40.1', '2.41.0', '3.0.0']) {
      const msg = errorsOf(step('2.40.0-rc.1', head));
      expect(msg, head).toContain('neither a later prerelease of 2.40.0 nor its release');
      expect(msg, head).toContain('ladder has no gaps');
    }
  });

  it('ladderStep names the next patch, minor and major of a release, and the version a prerelease belongs to', () => {
    expect(ladderStep('2.39.6', '2.39.7')).toEqual({ ok: true, next: { patch: '2.39.7', minor: '2.40.0', major: '3.0.0' }, prereleaseOf: null });
    expect(ladderStep('2.39.6', '2.39.8').ok).toBe(false);
    expect(ladderStep('2.40.0-rc.1', '2.40.0-rc.2')).toMatchObject({ ok: true, prereleaseOf: '2.40.0' });
    expect(ladderStep('2.40.0-rc.1', '2.40.0-rc.1').ok).toBe(false); // not a move at all
  });

  it('a backwards move is reported as such, not as a skipped step', () => {
    const msg = errorsOf(step('2.39.6', '2.39.5'));
    expect(msg).toContain('not a forward move');
    expect(msg).not.toContain('ladder has no gaps');
  });
});
