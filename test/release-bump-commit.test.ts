// #701: release.yml's bump-commit check (#420) must compare HEAD with the commit that
// last changed the VERSION in package.json, not the last commit that touched the file —
// a dependency, script or `files` edit satisfies the latter without moving the version,
// which defeated the check in exactly the failed-release window it exists for.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — untyped .mjs helper, imported for behaviour like the release-discipline tests
import { bumpCommit, versionOf, gather, main, MANIFEST } from '../.github/scripts/bump-commit.mjs';

const SCRIPT = join(__dirname, '..', '.github', 'scripts', 'bump-commit.mjs');

describe('#701 bumpCommit — the newest row whose version differs from its parent', () => {
  it('a version change in the newest row is the bump commit', () => {
    expect(bumpCommit([{ sha: 'b', version: '1.0.1', parent: '1.0.0' }, { sha: 'a', version: '1.0.0', parent: null }])).toBe('b');
  });
  it('RED: a package.json edit above the bump that leaves the version alone is skipped', () => {
    const rows = [
      { sha: 'deps', version: '1.0.1', parent: '1.0.1' }, // a dependency edit — what `git log -1 -- package.json` names
      { sha: 'bump', version: '1.0.1', parent: '1.0.0' },
      { sha: 'root', version: '1.0.0', parent: null },
    ];
    expect(bumpCommit(rows)).toBe('bump');
  });
  it('the root commit that introduced the version is the bump commit when nothing later moved it', () => {
    expect(bumpCommit([{ sha: 'deps', version: '1.0.0', parent: '1.0.0' }, { sha: 'root', version: '1.0.0', parent: null }])).toBe('root');
  });
  it('no rows, or rows that never change the version, yield null (the CLI fails closed on it)', () => {
    expect(bumpCommit([])).toBeNull();
    expect(bumpCommit([{ sha: 'a', version: null, parent: null }])).toBeNull();
  });
  it('a removed or broken manifest counts as a change, never as "same version"', () => {
    expect(bumpCommit([{ sha: 'broke', version: null, parent: '1.0.0' }])).toBe('broke');
  });
  it('versionOf reads only a string version', () => {
    expect(versionOf('{"version":"1.2.3"}')).toBe('1.2.3');
    expect(versionOf('{"version":3}')).toBeNull();
    expect(versionOf('{}')).toBeNull();
    expect(versionOf('not json')).toBeNull();
    expect(versionOf(null)).toBeNull();
  });
});

describe('#701 bump-commit.mjs against fixture repositories', () => {
  let repo = '';
  let rootSha = '';
  let bumpSha = '';
  let depsSha = '';

  const g = (args: string[], cwd = repo): string => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const pkg = (v: string, dev: Record<string, string> = {}) => JSON.stringify({ name: 'fixture', version: v, devDependencies: dev }, null, 2) + '\n';
  const commitAll = (msg: string, cwd = repo): string => {
    g(['add', '-A'], cwd);
    g(['commit', '-q', '-m', msg], cwd);
    return g(['rev-parse', 'HEAD'], cwd);
  };
  const run = (cwd = repo) => spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'tw-bump-commit-'));
    g(['init', '-q']);
    writeFileSync(join(repo, MANIFEST), pkg('1.0.0'));
    rootSha = commitAll('root');
    writeFileSync(join(repo, MANIFEST), pkg('1.0.1'));
    writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.1] — 2026-09-27\n\n- x\n');
    bumpSha = commitAll('release: 1.0.1');
    writeFileSync(join(repo, MANIFEST), pkg('1.0.1', { vitest: '5.0.1' }));
    depsSha = commitAll('build(deps-dev): bump vitest');
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('RED: `git log -1 -- package.json` names the dependency edit at HEAD, not the bump', () => {
    expect(g(['log', '-1', '--format=%H', '--', MANIFEST])).toBe(depsSha);
    expect(depsSha).not.toBe(bumpSha);
  });
  it('the script names the bump commit, so the release check refuses the dependency-edit HEAD', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(bumpSha);
    expect(r.stderr).toBe('');
  });
  it('gather walks newest first and stops being needed at the first version change', () => {
    const rows = [...gather(repo)] as Array<{ sha: string; version: string | null; parent: string | null }>;
    expect(rows.map((r) => r.sha)).toEqual([depsSha, bumpSha, rootSha]);
    expect(rows[0]).toEqual({ sha: depsSha, version: '1.0.1', parent: '1.0.1' });
    expect(rows[1]).toEqual({ sha: bumpSha, version: '1.0.1', parent: '1.0.0' });
    expect(rows[2]).toEqual({ sha: rootSha, version: '1.0.0', parent: null });
  });
  it('when HEAD is the bump commit the script names HEAD', () => {
    const d = mkdtempSync(join(tmpdir(), 'tw-bump-commit-head-'));
    try {
      g(['init', '-q'], d);
      writeFileSync(join(d, MANIFEST), pkg('2.0.0'));
      const root = commitAll('root', d);
      writeFileSync(join(d, MANIFEST), pkg('2.0.1'));
      const head = commitAll('release: 2.0.1', d);
      expect(run(d).stdout.trim()).toBe(head);
      expect(head).not.toBe(root);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('a root-only history is its own bump commit', () => {
    const d = mkdtempSync(join(tmpdir(), 'tw-bump-commit-root-'));
    try {
      g(['init', '-q'], d);
      writeFileSync(join(d, MANIFEST), pkg('0.1.0'));
      const root = commitAll('root', d);
      expect(run(d).stdout.trim()).toBe(root);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('fails closed when no commit changes the version: exit 1 and a ::error:: line, nothing on stdout', () => {
    const d = mkdtempSync(join(tmpdir(), 'tw-bump-commit-none-'));
    try {
      g(['init', '-q'], d);
      writeFileSync(join(d, MANIFEST), '{"name":"fixture"}\n'); // no version, ever
      commitAll('root', d);
      writeFileSync(join(d, MANIFEST), '{"name":"fixture","devDependencies":{"x":"1"}}\n');
      commitAll('deps', d);
      const r = run(d);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('::error::');
      expect(r.stderr).toContain('cannot be identified');
      expect(main(d)).toEqual({ code: 1, out: '', err: expect.stringContaining('::error::') });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
