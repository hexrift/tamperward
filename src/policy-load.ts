// Load .tamperward.yml into a Policy, falling back to the baseline when absent. The
// YAML file uses snake_case (signoff.required_for) per convention; this maps it onto
// the camelCase Policy shape. parsePolicy is pure so it can be tested without disk I/O.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { Policy, Severity } from './types';
import { defaultPolicy, mergeProtected, POLICY_FILE } from './policy';
import { fileAt } from './git/build';

/** A policy file that exists but cannot be understood. Never swallowed into the
 *  baseline: falling back silently would run a WEAKER gate than the author wrote. */
export class PolicyError extends Error {}

type RawPolicy = {
  version?: number;
  protected?: Record<string, string[]>;
  rules?: Policy['rules'];
  ignore?: string[];
  signoff?: { required_for?: Severity[]; requiredFor?: Severity[]; ledger?: string };
  verify?: { command?: string; budget?: number; inputs?: string[] };
};

/** `version:` opts in to rule graduations, so a value that cannot be understood must
 *  fail CLOSED like any other unparseable policy — silently reading garbage as 1 would
 *  run a weaker gate than the author may have meant to write. */
function normalizeVersion(v: unknown, where = POLICY_FILE): number {
  if (v === undefined || v === null) return 1; // launch version: opted in to nothing
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new PolicyError(`${where}: version must be a positive integer, got ${JSON.stringify(v)}`);
  }
  return v; // a version newer than this build passes every gate it knows — see POLICY_VERSION
}

export function parsePolicy(raw: RawPolicy | null | undefined): Policy {
  const r = raw ?? {};
  const version = normalizeVersion(r.version);
  // The baseline is gated by the DECLARED version before user rules overlay it, so a
  // gated graduation applies only to opted-in policies while an explicit severity —
  // written by the user, in either direction — always wins.
  const base = defaultPolicy(version);
  return {
    version,
    // Merge with the baseline, never replace. For an integrity tool, a config that sets
    // one rule's severity must NOT silently drop the other nine — nor may naming one
    // protected glob wipe out the rest of its category (see mergeProtected).
    protected: mergeProtected(base.protected, r.protected),
    rules: { ...base.rules, ...(r.rules ?? {}) },
    ignore: r.ignore ?? base.ignore,
    signoff: {
      requiredFor: r.signoff?.required_for ?? r.signoff?.requiredFor ?? base.signoff.requiredFor,
      ledger: r.signoff?.ledger ?? base.signoff.ledger,
    },
    ...(r.verify?.command
      ? {
          verify: {
            command: r.verify.command,
            budget: r.verify.budget ?? 300,
            // Rebuilding the block field-by-field means a field added later and
            // not listed here is SILENTLY DROPPED — which is how `inputs` first
            // shipped as a no-op that parsed, validated, and restored nothing.
            ...(Array.isArray(r.verify.inputs) ? { inputs: r.verify.inputs.map(String) } : {}),
          },
        }
      : {}),
  };
}

function parseOrThrow(src: string, where: string): Policy {
  let raw: unknown;
  try {
    raw = parse(src);
  } catch (e) {
    throw new PolicyError(`${where} is not valid YAML: ${(e as Error).message}`);
  }
  if (raw !== null && raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new PolicyError(`${where} is not a policy mapping`);
  }
  return parsePolicy(raw as RawPolicy);
}

export function loadPolicy(cwd: string = process.cwd()): Policy {
  const path = join(cwd, POLICY_FILE);
  if (!existsSync(path)) return defaultPolicy();
  return parseOrThrow(readFileSync(path, 'utf8'), POLICY_FILE);
}

/**
 * The policy as of a TRUSTED revision, or null when that revision has no policy file.
 *
 * The head of a branch is agent-authorable, so its `.tamperward.yml` must not govern its own
 * verdict — the same principle SPEC §5.4 already applies to sign-off. At the CI layer the
 * governing policy is read from the merge-base instead, which is what the branch forked
 * from and therefore nothing on the branch can have altered. A weakening edit still shows
 * up as a finding (hook-tampering); it simply doesn't take effect until a human merges it.
 */
export function loadPolicyAt(rev: string, cwd?: string): Policy | null {
  const src = fileAt(rev, POLICY_FILE, { cwd });
  if (src == null) return null;
  return parseOrThrow(src, `${POLICY_FILE} at ${rev}`);
}
