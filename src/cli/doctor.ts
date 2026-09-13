import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { defaultPolicy, POLICY_VERSION } from '../policy';
import { loadPolicy, loadPolicyAt, PolicyError } from '../policy-load';
import { requiredVerifierAuthoritySeconds } from '../verifier-limits';
import { defaultEventLog, watcherTelemetry } from './watch';
import { planInit } from './init';
import { compareVersions, TW_VERSION } from '../wiring';

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
  /** Emit one machine-readable posture document instead of prose. */
  json?: boolean;
}

export type DoctorState = 'OK' | 'WARN' | 'BROKEN';

export interface DoctorCheck {
  id: string;
  state: DoctorState;
  detail: string;
}

export interface DoctorReport {
  command: 'doctor';
  authoritative: boolean;
  checks: DoctorCheck[];
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


function wiringState(status: string, authority: boolean): DoctorState {
  if (status === 'ok') return 'OK';
  if (status === 'skip') return 'WARN';
  return authority ? 'BROKEN' : 'WARN';
}

function pinsInFile(path: string): string[] {
  if (!existsSync(path)) return [];
  let src = '';
  try { src = readFileSync(path, 'utf8'); } catch { return []; }
  return Array.from(src.matchAll(/\btamperward@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\b/g), (m) => m[1]);
}

function workflowPermissionCheck(cwd: string): DoctorCheck {
  const rel = '.github/workflows/tamperward.yml';
  const path = join(cwd, rel);
  if (!existsSync(path)) return { id: 'workflow-permissions', state: 'BROKEN', detail: `${rel} is missing` };
  let doc: unknown;
  try {
    doc = parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return {
      id: 'workflow-permissions',
      state: 'BROKEN',
      detail: `${rel} is not valid YAML (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  const root = asMapping(doc);
  const permissions = asMapping(root?.permissions);
  if (!permissions) {
    return {
      id: 'workflow-permissions',
      state: 'BROKEN',
      detail: 'workflow does not declare least-privilege permissions; repository defaults could grant write access',
    };
  }
  const writes = Object.entries(permissions).filter(([, value]) =>
    typeof value === 'string' && /write/i.test(value),
  );
  if (writes.length) {
    return {
      id: 'workflow-permissions',
      state: 'BROKEN',
      detail: 'workflow grants write permission: ' + writes.map(([name]) => name).join(', '),
    };
  }
  if (permissions.contents !== 'read') {
    return {
      id: 'workflow-permissions',
      state: 'WARN',
      detail: 'workflow permissions are explicit but contents: read is not declared',
    };
  }
  return { id: 'workflow-permissions', state: 'OK', detail: 'workflow token is explicitly read-only (contents: read)' };
}

/**
 * Read-only local/repository posture. Reuse init's canonical wiring planner so
 * doctor cannot drift into a second definition of "correctly installed".
 */
export function collectLocalPosture(cwd: string, policy: ReturnType<typeof loadPolicy>): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  checks.push(
    policy.version <= POLICY_VERSION
      ? { id: 'policy', state: 'OK', detail: `policy version ${policy.version} is understood (current schema ${POLICY_VERSION})` }
      : { id: 'policy', state: 'WARN', detail: `policy version ${policy.version} is newer than this binary's schema ${POLICY_VERSION}; only known gates can be evaluated` },
  );

  let plan: ReturnType<typeof planInit> = [];
  try {
    plan = planInit(cwd);
  } catch (e) {
    checks.push({
      id: 'installation-plan',
      state: 'BROKEN',
      detail: `canonical wiring could not be evaluated: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const byItem = new Map(plan.map((x) => [x.item, x]));
  const addWiring = (id: string, item: string, authority: boolean): void => {
    const action = byItem.get(item);
    if (!action) {
      checks.push({ id, state: authority ? 'BROKEN' : 'WARN', detail: `${item} wiring could not be evaluated` });
      return;
    }
    checks.push({
      id,
      state: wiringState(action.status, authority),
      detail: action.status === 'ok'
        ? action.detail
        : `${action.status}: ${action.detail}`,
    });
  };

  addWiring('claude-hooks', 'agent', true);
  addWiring('pre-commit', 'pre-commit', false);
  addWiring('ci-wiring', 'ci', true);
  addWiring('codeowners', 'codeowners', true);
  checks.push(workflowPermissionCheck(cwd));

  const pins = [
    ...pinsInFile(join(cwd, '.claude', 'settings.json')),
    ...pinsInFile(join(cwd, '.git', 'hooks', 'pre-commit')),
    ...pinsInFile(join(cwd, '.husky', 'pre-commit')),
  ];
  const below = pins.filter((pin) => (compareVersions(pin, TW_VERSION) ?? 0) < 0);
  const above = pins.filter((pin) => (compareVersions(TW_VERSION, pin) ?? 0) < 0);
  checks.push(
    below.length
      ? { id: 'binary-version', state: 'BROKEN', detail: `wiring pins older TamperWard version(s): ${Array.from(new Set(below)).join(', ')}; running binary is ${TW_VERSION}` }
      : above.length
        ? { id: 'binary-version', state: 'WARN', detail: `repository wiring targets newer TamperWard version(s): ${Array.from(new Set(above)).join(', ')}; running binary is ${TW_VERSION}` }
        : pins.length
          ? { id: 'binary-version', state: 'OK', detail: `wiring pins agree with running TamperWard ${TW_VERSION}` }
          : { id: 'binary-version', state: 'WARN', detail: `no canonical TamperWard version pin was found; running binary is ${TW_VERSION}` },
  );

  if (!policy.verify?.command) {
    checks.push({ id: 'verifier', state: 'BROKEN', detail: 'verify.command is not configured' });
  } else {
    const backend = policy.verify.backend ?? 'local';
    const inputs = policy.verify.inputs?.length ?? 0;
    checks.push({
      id: 'verifier',
      state: backend === 'container' ? 'OK' : 'WARN',
      detail:
        backend === 'container'
          ? `isolated-container verifier; budget ${policy.verify.budget}s/stage; ${inputs} declared verify.inputs glob(s); runtime/image availability is checked by verify`
          : `checkpointed-local verifier; budget ${policy.verify.budget}s/stage; ${inputs} declared verify.inputs glob(s); same-host/self-restoring mutation remains a documented residual`,
    });
  }

  checks.push(
    process.platform === 'linux'
      ? { id: 'platform', state: 'OK', detail: 'Linux: POSIX generated wiring and /proc runtime/quiescence controls are available' }
      : process.platform === 'win32'
        ? { id: 'platform', state: 'WARN', detail: 'Windows: generated shell wiring has POSIX assumptions and Linux /proc survivor controls are unavailable' }
        : { id: 'platform', state: 'WARN', detail: `${process.platform}: POSIX wiring is available, but Linux /proc survivor controls are unavailable` },
  );

  return checks;
}

function observerCheck(cwd: string): DoctorCheck {
  const observer = watcherTelemetry(defaultEventLog(cwd));
  if (observer.state === 'healthy' && observer.health) {
    return {
      id: 'observer',
      state: 'OK',
      detail: `healthy ${observer.health.backend}; ${observer.health.watched_dirs} watched dir(s), ${observer.health.event_count} event(s); advisory telemetry only`,
    };
  }
  if (observer.state === 'degraded' && observer.health) {
    return {
      id: 'observer',
      state: 'WARN',
      detail: `degraded: ${observer.health.error_count} error(s), ${observer.health.dropped_events} dropped event(s); ${observer.reason ?? 'telemetry may be incomplete'}; advisory only`,
    };
  }
  return {
    id: 'observer',
    state: 'WARN',
    detail: `unavailable${observer.reason ? ': ' + observer.reason : ''}; optional/advisory, and zero events are not evidence of no transient activity`,
  };
}

function emitReport(opts: DoctorOpts, checks: DoctorCheck[]): void {
  const authoritative = !checks.some((x) => x.state === 'BROKEN');
  if (opts.json) {
    const report: DoctorReport = { command: 'doctor', authoritative, checks };
    process.stdout.write(JSON.stringify(report) + '\n');
    return;
  }
  for (const check of checks) {
    if (check.id === 'observer') {
      process.stdout.write(`tamperward doctor: transient observer: ${check.detail}\n`);
    } else {
      process.stdout.write(`tamperward doctor: [${check.state}] ${check.id} — ${check.detail}\n`);
    }
  }
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

  const checks = collectLocalPosture(cwd, policy);
  checks.push({
    id: 'ci-verifier',
    state: 'OK',
    detail: `${verifyJobCount} verify job(s); trusted budget ${policy.verify.budget}s/stage requires >=${requiredMinutes}m outer timeout`,
  });
  if (github) {
    checks.push({
      id: 'github-authority',
      state: 'OK',
      detail:
        github.repo + '#' + github.branch +
        ' requires tamperward status, Code Owner review, and stale-review dismissal on new pushes',
    });
  }
  checks.push(observerCheck(cwd));

  if (!opts.json) {
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
  }
  emitReport(opts, checks);
  return 0;
}
