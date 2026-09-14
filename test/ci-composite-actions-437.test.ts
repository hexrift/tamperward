// Issue #437: the `ci` category protected only `.github/workflows/**`. A workflow that
// keeps `uses: ./.github/actions/test` while the composite action behind it turns
// `run: npm test` into `run: echo ok` neutralised the check without a finding, and the
// entry files of the other CI systems (`.gitlab-ci.yml`, `.circleci/config.yml`,
// `Jenkinsfile`, `azure-pipelines.yml`, `bitbucket-pipelines.yml`, `.travis.yml`) were
// never read at all. The composite action's `runs.steps` now get the workflow's
// removal/neutralisation pass; the other entry files get the generic check-line pass
// (a removed or neutralised check line) and no trigger logic.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ciTampering } from '../src/detectors/ci-tampering';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy, isProtected } from '../src/policy';
import { Change, FileChange } from '../src/types';

const P = defaultPolicy();

function diffed(path: string, before: string, after: string): Change[] {
  const dir = mkdtempSync(join(tmpdir(), 'tw-ci437-'));
  writeFileSync(join(dir, 'a'), before);
  writeFileSync(join(dir, 'b'), after);
  let raw = '';
  try {
    raw = execFileSync('git', ['diff', '--no-index', '--no-color', join(dir, 'a'), join(dir, 'b')], { encoding: 'utf8' });
  } catch (e) {
    raw = String((e as { stdout?: Buffer }).stdout ?? '');
  }
  rmSync(dir, { recursive: true, force: true });
  const parsed = parseDiff(raw)[0] as FileChange | undefined;
  return [{ kind: 'file', path, oldPath: null, op: 'modify', before, after, binary: false, hunks: parsed?.hunks ?? [] }];
}

const msgs = (c: Change[]) => ciTampering.run(c, P).map((f) => f.message);

const ACTION = '.github/actions/test/action.yml';
const COMPOSITE =
  'name: test\ndescription: run the suite\nruns:\n  using: composite\n  steps:\n    - run: npm ci\n      shell: bash\n    - run: npm test\n      shell: bash\n';

describe('the default ci category (issue #437)', () => {
  it.each([
    '.github/actions/test/action.yml',
    '.github/actions/test/action.yaml',
    '.github/actions/nested/deeper/action.yml',
    '.gitlab-ci.yml',
    '.circleci/config.yml',
    'Jenkinsfile',
    'azure-pipelines.yml',
    'bitbucket-pipelines.yml',
    '.travis.yml',
  ])('protects %s', (path) => {
    expect(isProtected(path, P, 'ci')).toBe(true);
  });

  it.each(['.github/actions/test/README.md', '.github/actions/test/index.js', 'src/action.yml', '.github/actions/test/action.yml.bak'])(
    'leaves %s alone',
    (path) => {
      expect(isProtected(path, P, 'ci')).toBe(false);
    },
  );
});

describe('composite actions — the fixture from issue #437', () => {
  it('blocks the action whose check became `echo ok` while the workflow still uses it', () => {
    const after = COMPOSITE.replace('run: npm test', 'run: echo ok');
    const m = msgs(diffed(ACTION, COMPOSITE, after));
    expect(m.some((x) => /check command was removed/.test(x))).toBe(true);
  });

  it('is clean for a composite action that keeps its check', () => {
    const after = COMPOSITE.replace('run: npm ci', 'run: npm ci --prefer-offline').replace('description: run the suite', 'description: run the whole suite');
    expect(msgs(diffed(ACTION, COMPOSITE, after))).toEqual([]);
  });

  it('is clean when the check moves behind a reachable if: inside the action', () => {
    const after = COMPOSITE.replace('    - run: npm test\n', "    - if: inputs.skip != 'true'\n      run: npm test\n");
    expect(msgs(diffed(ACTION, COMPOSITE, after))).toEqual([]);
  });

  it('reports the check neutralised in place (`|| true`)', () => {
    const after = COMPOSITE.replace('run: npm test', 'run: npm test || true');
    expect(msgs(diffed(ACTION, COMPOSITE, after))).toEqual([
      'A CI check command was neutralised in place: it still runs, but its result no longer decides (or its suite was narrowed).',
    ]);
  });

  it('reports continue-on-error: true added on the check step', () => {
    const after = COMPOSITE.replace('    - run: npm test\n      shell: bash\n', '    - run: npm test\n      shell: bash\n      continue-on-error: true\n');
    expect(msgs(diffed(ACTION, COMPOSITE, after))).toEqual(['continue-on-error: true added — failures will no longer fail the job.']);
  });

  it('reports `set +e` added inside the check run block', () => {
    const before = 'runs:\n  using: composite\n  steps:\n    - run: |\n        npm test\n      shell: bash\n';
    const after = 'runs:\n  using: composite\n  steps:\n    - run: |\n        set +e\n        npm test\n      shell: bash\n';
    expect(msgs(diffed(ACTION, before, after))).toEqual(["A check's run block was neutralised: set +e — a failing check no longer fails the step."]);
  });

  it('a check moved from the workflow into a composite action the same change adds is kept', () => {
    const wfBefore = 'on: [push]\njobs:\n  ci:\n    steps:\n      - run: npm test\n';
    const wfAfter = 'on: [push]\njobs:\n  ci:\n    steps:\n      - uses: ./.github/actions/test\n';
    const changes = diffed('.github/workflows/ci.yml', wfBefore, wfAfter);
    changes.push({ kind: 'file', path: ACTION, oldPath: null, op: 'add', before: null, after: COMPOSITE, binary: false, hunks: [] });
    expect(msgs(changes)).toEqual([]);
  });
});

describe('the other CI systems — the generic check-line pass', () => {
  const GITLAB = 'stages: [test]\ntest:\n  stage: test\n  script:\n    - npm ci\n    - npm test\n';

  it('blocks a .gitlab-ci.yml that drops its `npm test` script line', () => {
    const after = GITLAB.replace('    - npm test\n', '');
    const m = msgs(diffed('.gitlab-ci.yml', GITLAB, after));
    expect(m.some((x) => /check command was removed/.test(x))).toBe(true);
  });

  it('is clean for a .gitlab-ci.yml that keeps its check', () => {
    const after = GITLAB.replace('- npm ci', '- npm ci --prefer-offline');
    expect(msgs(diffed('.gitlab-ci.yml', GITLAB, after))).toEqual([]);
  });

  it('reports a .gitlab-ci.yml check neutralised in place', () => {
    const after = GITLAB.replace('- npm test', '- npm test || true');
    expect(msgs(diffed('.gitlab-ci.yml', GITLAB, after))).toHaveLength(1);
  });

  it('reads an Azure `script:` step and a Jenkinsfile `sh` step as check lines', () => {
    const azure = 'trigger: [main]\nsteps:\n  - script: npm ci\n  - script: npm test\n';
    expect(msgs(diffed('azure-pipelines.yml', azure, azure.replace('  - script: npm test\n', ''))).some((x) => /removed/.test(x))).toBe(true);
    const jenkins = "pipeline {\n  stages {\n    stage('test') {\n      steps {\n        sh 'npm ci'\n        sh 'npm test'\n      }\n    }\n  }\n}\n";
    expect(msgs(diffed('Jenkinsfile', jenkins, jenkins.replace("        sh 'npm test'\n", ''))).some((x) => /removed/.test(x))).toBe(true);
    expect(msgs(diffed('Jenkinsfile', jenkins, jenkins.replace("sh 'npm ci'", "sh 'npm ci --no-audit'")))).toEqual([]);
  });

  it('applies no trigger logic to the other systems', () => {
    // A GitLab `rules:` edit, a CircleCI `filters:` edit and a Travis `branches:`
    // edit are not GitHub `on:` blocks — nothing is read as a narrowing.
    const circle =
      'version: 2.1\nworkflows:\n  main:\n    jobs:\n      - test:\n          filters:\n            branches:\n              only: main\njobs:\n  test:\n    steps:\n      - run: npm test\n';
    expect(msgs(diffed('.circleci/config.yml', circle, circle.replace('only: main', 'only: never-exists')))).toEqual([]);
    const travis = 'language: node_js\nbranches:\n  only: [main]\nscript: npm test\n';
    expect(msgs(diffed('.travis.yml', travis, travis.replace('only: [main]', 'only: [release]')))).toEqual([]);
    const gitlab = GITLAB + '  rules:\n    - if: $CI_COMMIT_BRANCH == "main"\n';
    expect(msgs(diffed('.gitlab-ci.yml', GITLAB, gitlab))).toEqual([]);
  });
});
