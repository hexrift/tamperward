// #442 — a file ADDED under `protected.hooks` is classified by what it is before it
// is judged. Every add used to fall through to the shell-script branch, so onboarding
// a `.pre-commit-config.yaml`, a `lefthook.yml` or husky's own `.husky/.gitignore`
// blocked with "a protected hook script was added that does not run the gate live".
//
//   1  the three fixtures from the issue are clean, plus the obvious neighbours
//   2  a YAML config that is added WITH a gate entry that is disabled, skipped or
//      scoped still reports — the comparator runs against a fresh base
//   3  a genuine shell hook script keeps the sign-off stance

import { describe, it, expect } from 'vitest';
import { hookTampering } from '../src/detectors/hook-tampering';
import { defaultPolicy } from '../src/policy';
import type { Change, FileChange } from '../src/types';

const P = defaultPolicy();
const G = 'npx tamperward check --staged';
const add = (path: string, after: string): FileChange => ({
  kind: 'file', path, oldPath: null, op: 'add', before: null, after, binary: false, hunks: [],
});
const run = (c: Change[]) => hookTampering.run(c, P);
const msgs = (c: Change[]) => run(c).map((f) => f.message);

const PRE_COMMIT_LINTER = `repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.6.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
`;
const LEFTHOOK_LINTER = `pre-commit:
  commands:
    lint:
      glob: "*.ts"
      run: npx eslint {staged_files}
`;
const HUSKY_GITIGNORE = '_\n';

// ── 1 · onboarding a hook config is not a script add ─────────────────────────
describe('1 · an added YAML config or note under protected.hooks is not judged as a shell script', () => {
  it.each([
    ['.pre-commit-config.yaml with a linter repo', '.pre-commit-config.yaml', PRE_COMMIT_LINTER],
    ['lefthook.yml with a linter command', 'lefthook.yml', LEFTHOOK_LINTER],
    ['.lefthook.yml with a linter command', '.lefthook.yml', LEFTHOOK_LINTER],
    ['lefthook.yaml with a linter command', 'lefthook.yaml', LEFTHOOK_LINTER],
    ['lefthook-local.yml carrying only a linter', 'lefthook-local.yml', LEFTHOOK_LINTER],
    ['a nested .pre-commit-config.yaml', 'packages/api/.pre-commit-config.yaml', PRE_COMMIT_LINTER],
    ['.pre-commit-config.yaml carrying the gate live', '.pre-commit-config.yaml', `repos:\n  - repo: local\n    hooks:\n      - id: tamperward\n        name: tamperward\n        entry: ${G}\n        language: system\n        pass_filenames: false\n`],
    ['lefthook.yml carrying the gate live', 'lefthook.yml', `pre-commit:\n  commands:\n    tamperward:\n      run: ${G}\n`],
    ['lefthook.yml carrying the gate live in --diff mode on pre-push', 'lefthook.yml', `pre-push:\n  commands:\n    tamperward:\n      run: npx tamperward check --diff origin/main...HEAD\n`],
    ['a .pre-commit-config.yaml gate on the pre-push stage only', '.pre-commit-config.yaml', `repos:\n  - repo: local\n    hooks:\n      - id: tamperward\n        name: tamperward\n        entry: npx tamperward check --diff origin/main...HEAD\n        language: system\n        stages: [pre-push]\n`],
    ['an empty lefthook.yml', 'lefthook.yml', ''],
    ['a lefthook.yml that does not parse', 'lefthook.yml', 'pre-commit: [\n'],
  ])('clean · adding %s', (_n, path, after) => {
    expect(msgs([add(path, after)])).toEqual([]);
  });

  it.each([
    ["husky's own .husky/.gitignore", '.husky/.gitignore', HUSKY_GITIGNORE],
    ['.husky/_/.gitignore', '.husky/_/.gitignore', '*\n'],
    ['.husky/.gitattributes', '.husky/.gitattributes', '* text=auto\n'],
    ['.husky/README.md', '.husky/README.md', '# hooks\n\nRun `npm install` to wire them.\n'],
    ['.husky/NOTES.txt', '.husky/NOTES.txt', 'pre-commit runs the gate\n'],
  ])('clean · adding %s', (_n, path, after) => {
    expect(msgs([add(path, after)])).toEqual([]);
  });

  it('the three fixtures together in one changeset are clean', () => {
    expect(msgs([add('.pre-commit-config.yaml', PRE_COMMIT_LINTER), add('lefthook.yml', LEFTHOOK_LINTER), add('.husky/.gitignore', HUSKY_GITIGNORE)])).toEqual([]);
  });
});

// ── 2 · a fresh config that carries a disabled gate still reports ────────────
describe('2 · an added config whose gate entry is disabled, skipped or scoped is reported as a weakening', () => {
  it.each([
    ['lefthook.yml · skip: [pre-commit] on the gate', 'lefthook.yml', `pre-commit:\n  commands:\n    tamperward:\n      run: ${G}\n      skip: [pre-commit]\n`, /skip/],
    ['lefthook.yml · skip: true on the hook carrying the gate', 'lefthook.yml', `pre-commit:\n  skip: true\n  commands:\n    tamperward:\n      run: ${G}\n`, /skip/],
    ['lefthook.yml · the gate under only: [merge]', 'lefthook.yml', `pre-commit:\n  commands:\n    tamperward:\n      run: ${G}\n      only: [merge]\n`, /only/],
    ['lefthook.yml · the gate scoped by glob', 'lefthook.yml', `pre-commit:\n  commands:\n    tamperward:\n      run: ${G}\n      glob: "*.md"\n`, /glob/],
    ['lefthook.yml · the gate || true', 'lefthook.yml', `pre-commit:\n  commands:\n    tamperward:\n      run: ${G} || true\n`, /no longer runs `tamperward check` live/],
    ['lefthook.yml · the gate with PATH in env', 'lefthook.yml', `pre-commit:\n  commands:\n    tamperward:\n      run: ${G}\n      env:\n        PATH: /tmp/x\n`, /PATH/],
    ['lefthook.yml · the gate tagged into exclude_tags', 'lefthook.yml', `pre-commit:\n  exclude_tags: [slow]\n  commands:\n    tamperward:\n      tags: [slow]\n      run: ${G}\n`, /exclude_tags/],
    ['.pre-commit-config.yaml · the gate at stages: [manual]', '.pre-commit-config.yaml', `repos:\n  - repo: local\n    hooks:\n      - id: tamperward\n        name: tamperward\n        entry: ${G}\n        language: system\n        stages: [manual]\n`, /stages/],
    ['.pre-commit-config.yaml · default_stages: [manual]', '.pre-commit-config.yaml', `default_stages: [manual]\nrepos:\n  - repo: local\n    hooks:\n      - id: tamperward\n        name: tamperward\n        entry: ${G}\n        language: system\n`, /stages/],
    ['.pre-commit-config.yaml · the gate with an exclude', '.pre-commit-config.yaml', `repos:\n  - repo: local\n    hooks:\n      - id: tamperward\n        name: tamperward\n        entry: ${G}\n        language: system\n        exclude: ".*"\n`, /exclude/],
    ['.pre-commit-config.yaml · the gate || true', '.pre-commit-config.yaml', `repos:\n  - repo: local\n    hooks:\n      - id: tamperward\n        name: tamperward\n        entry: sh -c "${G} || true"\n        language: system\n`, /no longer runs `tamperward check` live/],
    ['lefthook-local.yml · skip: true on the gate', 'lefthook-local.yml', 'pre-commit:\n  commands:\n    tamperward:\n      skip: true\n', /skip/],
  ])('reports · adding %s', (_n, path, after, re) => {
    const f = run([add(path, after)]);
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((x) => /hook configuration was weakened/.test(x.message))).toBe(true);
    expect(f.map((x) => x.message).join('\n')).toMatch(re);
    expect(f.some((x) => /hook script was added/.test(x.message))).toBe(false);
  });
});

// ── 3 · a genuine shell script keeps the sign-off stance ─────────────────────
describe('3 · a new hand-written hook script is still judged by the liveness model', () => {
  it('adding a .husky/pre-commit that does not run the gate still blocks', () => {
    const f = run([add('.husky/pre-commit', '#!/bin/sh\nnpx lint-staged\n')]);
    expect(f.length).toBe(1);
    expect(f[0].message).toMatch(/hook script was added that does not run the gate live: it runs no `tamperward check`/);
  });

  it('adding a .husky/pre-commit with the gate || true still blocks', () => {
    const f = run([add('.husky/pre-commit', `#!/bin/sh\n${G} || true\n`)]);
    expect(f.length).toBe(1);
    expect(f[0].message).toMatch(/hook script was added that does not run the gate live/);
  });

  it('adding a .husky/pre-commit that runs the gate live is clean', () => {
    expect(msgs([add('.husky/pre-commit', `#!/bin/sh\n${G}\n`)])).toEqual([]);
  });

  it('a script beside a clean config in the same changeset is still the script finding', () => {
    const f = run([add('lefthook.yml', LEFTHOOK_LINTER), add('.husky/pre-commit', '#!/bin/sh\nnpx lint-staged\n')]);
    expect(f.map((x) => x.file)).toEqual(['.husky/pre-commit']);
  });
});
