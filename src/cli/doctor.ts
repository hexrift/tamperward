import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { defaultPolicy } from '../policy';
import { loadPolicy, loadPolicyAt, PolicyError } from '../policy-load';
import { requiredVerifierAuthoritySeconds } from '../verifier-limits';

export interface DoctorOpts {
  cwd?: string;
  /** Trusted policy revision. Generated PR CI passes the pull request base SHA. */
  base?: string;
  /** Workflow to inspect. When omitted, discover every .yml/.yaml workflow. */
  workflow?: string;
  /** Also validate GitHub repository authority on the protected branch. */
  github?: boolean;
  /** GitHub repository in OWNER/REPO form. Inferred from env/origin when omitted. */
  repo?: string;
  /** Protected branch. Defaults to GITHUB_BASE_REF or GitHub's default branch. */
  branch?: string;
}

const VERIFY_COMMAND = /\btamperward(?:@\S+)?\s+verify\b/;

function err(message: string): number {
  process.stderr.write(`tamperward doctor: ${message}\n`);
  return 2;
}

function policyFor(opts: DoctorOpts, cwd: string) {
  if (!opts.base) return loadPolicy(cwd);
  const atBase = loadPolicyAt(opts.base, cwd);
  return atBase ?? defaultPolicy();
}

function asMapping(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export interface GitHubProtectionSnapshot {
  rules?: unknown;
  branchProtection?: unknown;
}

export function evaluateGitHubProtection(
  snapshot: GitHubProtectionSnapshot,
  requiredCheck = 'tamperward',
): string[] {
  let hasRequiredCheck = false;
  let hasCodeOwnerReview = false;
  let dismissesStaleReviews = false;

  if (Array.isArray(snapshot.rules)) {
    for (const raw of snapshot.rules) {
      const rule = asMapping(raw);
      const params = asMapping(rule?.parameters);
      if (!rule || !params) continue;

      if (rule.type === 'pull_request') {
        if (params.require_code_owner_review === true) hasCodeOwnerReview = true;
        if (params.dismiss_stale_reviews_on_push === true) dismissesStaleReviews = true;
      }

      if (rule.type === 'required_status_checks') {
        const checks = params.required_status_checks;
        if (Array.isArray(checks)) {
          hasRequiredCheck ||= checks.some((rawCheck) => {
            const check = asMapping(rawCheck);
            return check?.context === requiredCheck;
          });
        }
      }
    }
  }

  const classic = asMapping(snapshot.branchProtection);
  const reviews = asMapping(classic?.required_pull_request_reviews);
  if (reviews?.require_code_owner_reviews === true) hasCodeOwnerReview = true;
  if (reviews?.dismiss_stale_reviews === true) dismissesStaleReviews = true;

  const status = asMapping(classic?.required_status_checks);
  if (status) {
    const contexts = status.contexts;
    if (Array.isArray(contexts)) {
      hasRequiredCheck ||= contexts.some((x) => x === requiredCheck);
    }
    const checks = status.checks;
    if (Array.isArray(checks)) {
      hasRequiredCheck ||= checks.some((rawCheck) => {
        const check = asMapping(rawCheck);
        return check?.context === requiredCheck;
      });
    }
  }

  const findings: string[] = [];
  if (!hasRequiredCheck) findings.push('require the tamperward status check');
  if (!hasCodeOwnerReview) findings.push('require Code Owner review');
  if (!dismissesStaleReviews) findings.push('dismiss stale pull request approvals on new pushes');
  return findings;
}

function gitText(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function githubRepoFromRemote(remote: string): string | null {
  const m = remote.match(/github\.com(?::|\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  return m ? m[1] + '/' + m[2].replace(/\.git$/i, '') : null;
}

function inferGitHubRepo(cwd: string): string | null {
  const envRepo = process.env.GITHUB_REPOSITORY;
  if (envRepo && /^[^/\s]+\/[^/\s]+$/.test(envRepo)) return envRepo;

  const remote = gitText(cwd, ['config', '--get', 'remote.origin.url']);
  return remote ? githubRepoFromRemote(remote) : null;
}

const GITHUB_API_SCRIPT = [
  "const endpoint = process.argv[1];",
  "const token = process.env.TAMPERWARD_GITHUB_TOKEN || '';",
  "const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'tamperward-doctor' };",
  "if (token) headers.Authorization = 'Bearer ' + token;",
  "fetch('https://api.github.com/' + endpoint, { headers }).then(async (r) => {",
  "  const body = await r.text();",
  "  if (!r.ok) { process.stderr.write('HTTP ' + r.status + ': ' + body); process.exit(22); }",
  "  process.stdout.write(body);",
  "}).catch((e) => { process.stderr.write(String(e)); process.exit(23); });",
].join('\n');

/** @internal Pure description of the trusted GitHub API subprocess. */
export function githubApiInvocation(endpoint: string, token: string): {
  executable: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    executable: process.execPath,
    args: ['-e', GITHUB_API_SCRIPT, endpoint],
    env: {
      TAMPERWARD_GITHUB_TOKEN: token,
      LANG: 'C',
      LC_ALL: 'C',
    },
  };
}

function githubApi(cwd: string, endpoint: string): unknown {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
  const invocation = githubApiInvocation(endpoint, token);
  try {
    const stdout = execFileSync(
      invocation.executable,
      invocation.args,
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: invocation.env,
        timeout: 15_000,
      },
    );
    return JSON.parse(stdout);
  } catch (e) {
    const x = e as Error & { stderr?: string | Buffer };
    const detail = x.stderr ? String(x.stderr).replace(/\s+/g, ' ').trim() : x.message;
    throw new Error(
      'GitHub API ' + endpoint + ' failed: ' + (detail || 'unknown error'),
    );
  }
}

function githubAuthority(
  opts: DoctorOpts,
  cwd: string,
): { repo: string; branch: string; findings: string[] } {
  const repo = opts.repo ?? inferGitHubRepo(cwd);
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error(
      'cannot determine GitHub repository; pass --repo OWNER/REPO or configure a github.com origin',
    );
  }

  let branch = opts.branch ?? process.env.GITHUB_BASE_REF ?? '';
  if (!branch) {
    const meta = asMapping(githubApi(cwd, 'repos/' + repo));
    if (typeof meta?.default_branch === 'string') branch = meta.default_branch;
  }
  if (!branch) throw new Error('cannot determine protected branch; pass --branch BRANCH');

  let rules: unknown;
  let rulesError: Error | null = null;
  try {
    rules = githubApi(cwd, 'repos/' + repo + '/rules/branches/' + encodeURIComponent(branch));
  } catch (e) {
    rulesError = e instanceof Error ? e : new Error(String(e));
  }

  let findings = evaluateGitHubProtection({ rules });
  if (findings.length === 0) return { repo, branch, findings };

  let branchProtection: unknown;
  let classicError: Error | null = null;
  try {
    branchProtection = githubApi(
      cwd,
      'repos/' + repo + '/branches/' + encodeURIComponent(branch) + '/protection',
    );
  } catch (e) {
    classicError = e instanceof Error ? e : new Error(String(e));
  }

  findings = evaluateGitHubProtection({ rules, branchProtection });
  if (findings.length > 0 && rules === undefined && branchProtection === undefined) {
    throw new Error(
      'cannot inspect GitHub repository authority. Rules API: ' +
        (rulesError?.message ?? 'unavailable') +
        '. Classic branch protection API: ' +
        (classicError?.message ?? 'unavailable') +
        '. Authenticate gh with metadata read; classic-protection fallback may also need Administration read.',
    );
  }

  if (findings.length > 0 && branchProtection === undefined && classicError) {
    findings.push(
      'classic branch protection could not be inspected; if it supplies a missing requirement, use GH_TOKEN/GITHUB_TOKEN with Administration read',
    );
  }

  return { repo, branch, findings };
}

function verifyJobs(doc: unknown): Array<{ name: string; job: Record<string, unknown> }> {
  const root = asMapping(doc);
  const jobs = asMapping(root?.jobs);
  if (!jobs) return [];
  const found: Array<{ name: string; job: Record<string, unknown> }> = [];
  for (const [name, raw] of Object.entries(jobs)) {
    const job = asMapping(raw);
    if (!job || !Array.isArray(job.steps)) continue;
    const hasVerify = job.steps.some((step) => {
      const item = asMapping(step);
      return typeof item?.run === 'string' && VERIFY_COMMAND.test(item.run);
    });
    if (hasVerify) found.push({ name, job });
  }
  return found;
}

/**
 * Validate that every job which runs TamperWard verify has enough outer wall
 * clock for the trusted policy's visible + pristine stage budgets plus the
 * fixed authority reserve.
 *
 * This is deliberately a diagnostic, not a policy-schema restriction. A large
 * verify.budget remains valid for custom runners; generated GitHub CI refuses
 * to pretend its own outer timeout can accommodate one that exceeds its host.
 */
export function runDoctor(opts: DoctorOpts = {}): number {
  const cwd = resolve(opts.cwd ?? process.cwd());

  let policy;
  try {
    policy = policyFor(opts, cwd);
  } catch (e) {
    return err(e instanceof PolicyError || e instanceof Error ? e.message : String(e));
  }

  if (!policy.verify?.command) {
    return err('trusted policy has no verify.command; generated CI cannot verify this repository');
  }

  const workflowRels: string[] = [];
  if (opts.workflow) {
    workflowRels.push(opts.workflow);
  } else {
    const workflowDirRel = '.github/workflows';
    const workflowDir = resolve(cwd, workflowDirRel);
    if (!existsSync(workflowDir)) {
      return err(`${workflowDirRel}: workflow directory does not exist`);
    }
    let entries: string[];
    try {
      entries = readdirSync(workflowDir)
        .filter((name) => /\.ya?ml$/i.test(name))
        .sort();
    } catch (e) {
      return err(
        `${workflowDirRel}: could not enumerate workflows (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    for (const name of entries) workflowRels.push(join(workflowDirRel, name));
  }

  const requiredSecs = requiredVerifierAuthoritySeconds(policy.verify.budget);
  const requiredMinutes = Math.ceil(requiredSecs / 60);
  let verifyJobCount = 0;

  for (const workflowRel of workflowRels) {
    const workflowPath = resolve(cwd, workflowRel);
    if (!existsSync(workflowPath)) {
      return err(`${workflowRel}: workflow does not exist`);
    }

    let doc: unknown;
    try {
      doc = parse(readFileSync(workflowPath, 'utf8'));
    } catch (e) {
      return err(
        `${workflowRel}: workflow is not valid YAML (${e instanceof Error ? e.message : String(e)})`,
      );
    }

    const jobs = verifyJobs(doc);
    verifyJobCount += jobs.length;

    for (const { name, job } of jobs) {
      const timeout = job['timeout-minutes'];
      if (timeout === undefined || timeout === null) {
        return err(
          `${workflowRel} job "${name}": timeout-minutes is missing; requires at least ${requiredMinutes} minutes`,
        );
      }
      if (typeof timeout === 'string' && timeout.includes('${{')) {
        return err(
          `${workflowRel} job "${name}": timeout-minutes must be a static numeric value; requires at least ${requiredMinutes} minutes`,
        );
      }
      if (typeof timeout !== 'number' || !Number.isFinite(timeout)) {
        return err(
          `${workflowRel} job "${name}": timeout-minutes must be numeric; got ${JSON.stringify(timeout)}`,
        );
      }
      if (timeout <= 0) {
        return err(
          `${workflowRel} job "${name}": timeout-minutes must be positive; got ${timeout}`,
        );
      }
      if (!Number.isInteger(timeout)) {
        return err(
          `${workflowRel} job "${name}": timeout-minutes must be a whole number; got ${timeout}`,
        );
      }
      if (timeout < requiredMinutes) {
        return err(
          `${workflowRel} job "${name}": timeout-minutes ${timeout} is too small; trusted verify.budget ${policy.verify.budget}s requires at least ${requiredMinutes} minutes for visible + pristine + authority overhead`,
        );
      }
    }
  }

  if (verifyJobCount === 0) {
    const scope = opts.workflow ?? '.github/workflows/*.yml|*.yaml';
    return err(`${scope}: no job contains a tamperward verify step`);
  }

  let github: { repo: string; branch: string; findings: string[] } | null = null;
  if (opts.github) {
    try {
      github = githubAuthority(opts, cwd);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
    if (github.findings.length > 0) {
      return err(
        'GitHub repository authority for ' + github.repo + '#' + github.branch +
          ' is incomplete: ' + github.findings.join('; '),
      );
    }
  }

  process.stdout.write(
    `tamperward doctor: CI verifier envelope OK — ${verifyJobCount} verify job(s), trusted budget ${policy.verify.budget}s/stage, requires >=${requiredMinutes}m outer timeout.\n`,
  );
  if (github) {
    process.stdout.write(
      'tamperward doctor: GitHub repository authority OK — ' + github.repo + '#' +
        github.branch +
        ' requires tamperward, Code Owner review, and stale-review dismissal on new pushes.\n',
    );
  }
  return 0;
}
