import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { defaultPolicy } from '../policy';
import { loadPolicy, loadPolicyAt, PolicyError } from '../policy-load';
import { requiredVerifierAuthoritySeconds } from '../verifier-limits';

export interface DoctorOpts {
  cwd?: string;
  /** Trusted policy revision. Generated PR CI passes the pull request base SHA. */
  base?: string;
  /** Workflow to inspect. Defaults to the file tamperward init generates. */
  workflow?: string;
}

const DEFAULT_WORKFLOW = '.github/workflows/tamperward.yml';
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

  const workflowRel = opts.workflow ?? DEFAULT_WORKFLOW;
  const workflowPath = resolve(cwd, workflowRel);
  if (!existsSync(workflowPath)) {
    return err(`${workflowRel}: workflow does not exist`);
  }

  let doc: unknown;
  try {
    doc = parse(readFileSync(workflowPath, 'utf8'));
  } catch (e) {
    return err(`${workflowRel}: workflow is not valid YAML (${e instanceof Error ? e.message : String(e)})`);
  }

  const jobs = verifyJobs(doc);
  if (jobs.length === 0) {
    return err(`${workflowRel}: no job contains a tamperward verify step`);
  }

  const requiredSecs = requiredVerifierAuthoritySeconds(policy.verify.budget);
  const requiredMinutes = Math.ceil(requiredSecs / 60);

  for (const { name, job } of jobs) {
    const timeout = job['timeout-minutes'];
    if (timeout === undefined || timeout === null) {
      return err(`${workflowRel} job "${name}": timeout-minutes is missing; requires at least ${requiredMinutes} minutes`);
    }
    if (typeof timeout === 'string' && timeout.includes('${{')) {
      return err(`${workflowRel} job "${name}": timeout-minutes must be a static numeric value; requires at least ${requiredMinutes} minutes`);
    }
    if (typeof timeout !== 'number' || !Number.isFinite(timeout)) {
      return err(`${workflowRel} job "${name}": timeout-minutes must be numeric; got ${JSON.stringify(timeout)}`);
    }
    if (timeout <= 0) {
      return err(`${workflowRel} job "${name}": timeout-minutes must be positive; got ${timeout}`);
    }
    if (!Number.isInteger(timeout)) {
      return err(`${workflowRel} job "${name}": timeout-minutes must be a whole number; got ${timeout}`);
    }
    if (timeout < requiredMinutes) {
      return err(
        `${workflowRel} job "${name}": timeout-minutes ${timeout} is too small; trusted verify.budget ${policy.verify.budget}s requires at least ${requiredMinutes} minutes for visible + pristine + authority overhead`,
      );
    }
  }

  process.stdout.write(
    `tamperward doctor: CI verifier envelope OK — ${jobs.length} verify job(s), trusted budget ${policy.verify.budget}s/stage, requires >=${requiredMinutes}m outer timeout.\n`,
  );
  return 0;
}
