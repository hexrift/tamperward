import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GENERATED_CI_MIN_OVERHEAD_RESERVE_SECS,
  GENERATED_CI_TIMEOUT_MINUTES,
  VERIFIER_STAGE_COUNT,
  maxStageBudgetForOuterTimeout,
  requiredVerifierAuthoritySeconds,
} from '../src/verifier-limits';
import { evaluateGitHubProtection, githubApiInvocation, githubRepoFromRemote, runDoctor } from '../src/cli/doctor';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(budget: number): string {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-doctor-ci-'));
  dirs.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  writeFileSync(
    join(cwd, '.tamperward.yml'),
    `version: 1\nverify:\n  command: npm test\n  budget: ${budget}\n`,
  );
  git('add', '.tamperward.yml');
  git('commit', '-qm', 'trusted policy');
  return cwd;
}

function writeWorkflow(cwd: string, name: string, body: string): void {
  mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(cwd, '.github', 'workflows', name), body);
}

function workflow(cwd: string, timeout: string | number | undefined, job = 'ci'): void {
  const timeoutLine = timeout === undefined ? '' : `    timeout-minutes: ${timeout}\n`;
  writeWorkflow(
    cwd,
    'tamperward.yml',
    `name: ci\non: pull_request\njobs:\n  ${job}:\n    runs-on: ubuntu-latest\n${timeoutLine}    steps:\n      - run: tamperward verify --base main\n`,
  );
}

function capture(fn: () => number): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string | Uint8Array) => {
    out += String(s); return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((s: string | Uint8Array) => {
    err += String(s); return true;
  }) as typeof process.stderr.write);
  const code = fn();
  return { code, out, err };
}

describe('CI verifier envelope arithmetic (#331)', () => {
  it('derives the supported stage budget from stage count + reserve, not independent literals', () => {
    expect(VERIFIER_STAGE_COUNT).toBe(2);
    expect(GENERATED_CI_MIN_OVERHEAD_RESERVE_SECS).toBe(3_600);
    expect(GENERATED_CI_TIMEOUT_MINUTES).toBe(360);
    expect(maxStageBudgetForOuterTimeout(GENERATED_CI_TIMEOUT_MINUTES)).toBe(9_000);
    expect(requiredVerifierAuthoritySeconds(9_000)).toBe(18_000 + 3_600);
    expect(requiredVerifierAuthoritySeconds(9_000)).toBeLessThanOrEqual(GENERATED_CI_TIMEOUT_MINUTES * 60);
    expect(requiredVerifierAuthoritySeconds(9_001)).toBeGreaterThan(GENERATED_CI_TIMEOUT_MINUTES * 60);
  });
});

describe('tamperward doctor CI envelope (#331)', () => {
  it('accepts a custom job whose numeric outer timeout covers the trusted two-stage budget + reserve', () => {
    const cwd = repo(9_000);
    workflow(cwd, 360, 'security');
    expect(runDoctor({ cwd, base: 'HEAD' })).toBe(0);
  });

  it('refuses an outer timeout that cannot cover the trusted policy budget', () => {
    const cwd = repo(300);
    workflow(cwd, 10);
    const r = capture(() => runDoctor({ cwd, base: 'HEAD' }));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/timeout-minutes.*10.*requires at least 70/i);
  });

  it.each([
    [undefined, /timeout-minutes is missing/i],
    ['nope', /timeout-minutes.*numeric/i],
    ['${{ vars.TIMEOUT }}', /timeout-minutes.*static numeric/i],
    [0, /timeout-minutes.*positive/i],
  ])('refuses missing/malformed timeout %j', (timeout, reason) => {
    const cwd = repo(300);
    workflow(cwd, timeout as string | number | undefined);
    const r = capture(() => runDoctor({ cwd, base: 'HEAD' }));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(reason);
  });

  it('uses the trusted base policy rather than a candidate-edited working policy', () => {
    const cwd = repo(9_000);
    workflow(cwd, 360);
    writeFileSync(
      join(cwd, '.tamperward.yml'),
      'version: 1\nverify:\n  command: npm test\n  budget: 1\n',
    );
    expect(runDoctor({ cwd, base: 'HEAD' })).toBe(0);

    workflow(cwd, 100);
    const r = capture(() => runDoctor({ cwd, base: 'HEAD' }));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/requires at least 360/i);
  });
  it('discovers custom workflow files when no explicit --workflow is supplied', () => {
    const cwd = repo(300);
    writeWorkflow(
      cwd,
      'security.yaml',
      'name: security\njobs:\n  verify-security:\n    timeout-minutes: 70\n    steps:\n      - run: /usr/local/bin/tamperward verify --base main\n',
    );
    expect(runDoctor({ cwd, base: 'HEAD' })).toBe(0);
  });

  it('validates every discovered verify job and never lets an unrelated roomy job mask an undersized authority', () => {
    const cwd = repo(300);
    writeWorkflow(
      cwd,
      'unrelated.yml',
      'name: unrelated\njobs:\n  roomy:\n    timeout-minutes: 360\n    steps:\n      - run: echo tamperward is installed\n',
    );
    writeWorkflow(
      cwd,
      'verify-a.yml',
      'name: a\njobs:\n  verify-a:\n    timeout-minutes: 70\n    steps:\n      - run: tamperward verify --base main\n',
    );
    writeWorkflow(
      cwd,
      'verify-b.yaml',
      'name: b\njobs:\n  verify-b:\n    timeout-minutes: 10\n    steps:\n      - run: tamperward verify --base main\n',
    );
    const r = capture(() => runDoctor({ cwd, base: 'HEAD' }));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/verify-b\.yaml.*verify-b.*timeout-minutes 10/i);
  });

  it('validates all verify jobs in one workflow, not just a convenient sufficient one', () => {
    const cwd = repo(300);
    writeWorkflow(
      cwd,
      'multi.yml',
      'name: multi\njobs:\n  good:\n    timeout-minutes: 70\n    steps:\n      - run: tamperward verify\n  bad:\n    timeout-minutes: 5\n    steps:\n      - run: tamperward verify\n',
    );
    const r = capture(() => runDoctor({ cwd, base: 'HEAD' }));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/multi\.yml.*bad.*timeout-minutes 5/i);
  });

  it('fails closed on invalid YAML while discovering workflows', () => {
    const cwd = repo(300);
    writeWorkflow(cwd, 'broken.yml', 'jobs:\n  x: [unterminated\n');
    const r = capture(() => runDoctor({ cwd, base: 'HEAD' }));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/broken\.yml.*not valid YAML/i);
  });

  it('fails closed when discovery finds no TamperWard verify job', () => {
    const cwd = repo(300);
    writeWorkflow(
      cwd,
      'build.yml',
      'name: build\njobs:\n  build:\n    timeout-minutes: 360\n    steps:\n      - run: npm test\n',
    );
    const r = capture(() => runDoctor({ cwd, base: 'HEAD' }));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/no job contains a tamperward verify step/i);
  });

  it('an explicit workflow path validates only that authority, even if another workflow is malformed', () => {
    const cwd = repo(300);
    workflow(cwd, 70);
    writeWorkflow(cwd, 'broken.yml', 'jobs:\n  x: [unterminated\n');
    expect(runDoctor({
      cwd,
      base: 'HEAD',
      workflow: '.github/workflows/tamperward.yml',
    })).toBe(0);
  });
});


describe('GitHub human-boundary freshness (#332)', () => {
  const healthyRules = [
    {
      type: 'pull_request',
      parameters: {
        require_code_owner_review: true,
        dismiss_stale_reviews_on_push: true,
        require_last_push_approval: false,
      },
    },
    {
      type: 'required_status_checks',
      parameters: {
        required_status_checks: [{ context: 'tamperward' }],
      },
    },
  ];

  it('accepts an active ruleset that binds Code Owner approval to the current pushed diff', () => {
    expect(evaluateGitHubProtection({ rules: healthyRules })).toEqual([]);
  });

  it('does not treat last-push approval alone as fresh Code Owner approval', () => {
    const rules = structuredClone(healthyRules);
    (rules[0].parameters as Record<string, unknown>).dismiss_stale_reviews_on_push = false;
    (rules[0].parameters as Record<string, unknown>).require_last_push_approval = true;
    const findings = evaluateGitHubProtection({ rules });
    expect(findings).toContain('dismiss stale pull request approvals on new pushes');
    expect(findings).not.toContain('require Code Owner review');
  });

  it('accepts equivalent classic branch protection fields', () => {
    expect(evaluateGitHubProtection({
      branchProtection: {
        required_pull_request_reviews: {
          require_code_owner_reviews: true,
          dismiss_stale_reviews: true,
          require_last_push_approval: false,
        },
        required_status_checks: {
          contexts: ['tamperward'],
        },
      },
    })).toEqual([]);
  });

  it('composes effective rules across rulesets and classic branch protection', () => {
    expect(evaluateGitHubProtection({
      rules: [{
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'tamperward' }] },
      }],
      branchProtection: {
        required_pull_request_reviews: {
          require_code_owner_reviews: true,
          dismiss_stale_reviews: true,
        },
      },
    })).toEqual([]);
  });

  it('reports every missing repository-authority requirement', () => {
    expect(evaluateGitHubProtection({ rules: [] })).toEqual([
      'require the tamperward status check',
      'require Code Owner review',
      'dismiss stale pull request approvals on new pushes',
    ]);
  });
});




describe('GitHub doctor transport boundary (#332)', () => {
  it('uses TamperWard own Node executable and a minimal environment, not candidate PATH startup authority', () => {
    const invocation = githubApiInvocation(
      'repos/acme/project/rules/branches/main',
      'secret-token',
    );
    expect(invocation.executable).toBe(process.execPath);
    expect(invocation.args[0]).toBe('-e');
    expect(invocation.args.at(-1)).toBe('repos/acme/project/rules/branches/main');
    expect(invocation.env).toEqual({
      TAMPERWARD_GITHUB_TOKEN: 'secret-token',
      LANG: 'C',
      LC_ALL: 'C',
    });
    expect(invocation.env).not.toHaveProperty('PATH');
    expect(invocation.env).not.toHaveProperty('NODE_OPTIONS');
    expect(invocation.env).not.toHaveProperty('NODE_PATH');
  });
});


describe('GitHub repository inference (#332)', () => {
  it.each([
    ['https://github.com/acme/project.git', 'acme/project'],
    ['git@github.com:acme/project.git', 'acme/project'],
    ['ssh://git@github.com/acme/project.git', 'acme/project'],
  ])('parses %s', (remote, expected) => {
    expect(githubRepoFromRemote(remote)).toBe(expected);
  });

  it('refuses non-GitHub and malformed remotes', () => {
    expect(githubRepoFromRemote('https://gitlab.com/acme/project.git')).toBeNull();
    expect(githubRepoFromRemote('not-a-remote')).toBeNull();
  });
});
