// Load .tamperward.yml into a Policy, falling back to the baseline when absent. The
// YAML file uses snake_case (signoff.required_for) per convention; this maps it onto
// the camelCase Policy shape. parsePolicy is pure so it can be tested without disk I/O.

import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import { parse } from 'yaml';
import { Policy, Severity } from './types';
import { defaultPolicy, mergeProtected, mergeRules, normalizeGlob, POLICY_FILE } from './policy';
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

const SEVERITIES: ReadonlyArray<Severity> = ['block', 'warn'];
const isSeverity = (v: unknown): v is Severity => (SEVERITIES as readonly unknown[]).includes(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
const isMapping = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The top-level keys a policy may carry — `src/types.ts` `Policy`, in file spelling. */
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(['version', 'protected', 'rules', 'ignore', 'signoff', 'verify']);

/**
 * Whether a ledger path stays inside the repository. The ledger is the one file the
 * LOCAL layer trusts, so a policy that points it at `../../shared.jsonl` (or an
 * absolute path) hands the sign-off channel to whoever controls that location —
 * outside the diff, outside CODEOWNERS, outside every view the gate reads.
 */
export function ledgerInsideRepo(ledger: string): boolean {
  if (!ledger.trim() || isAbsolute(ledger) || /^[A-Za-z]:[\\/]/.test(ledger)) return false;
  const norm = posix.normalize(ledger.replace(/\\/g, '/'));
  return norm !== '..' && !norm.startsWith('../') && !norm.startsWith('/');
}

/**
 * Validate every override the file may carry, failing CLOSED on anything not
 * understood — the same stance `version:` already took.
 *
 * `rules.<name>.severity: BLOCK` (or `blocc`, or `blocking`) used to parse
 * cleanly and produce findings that were neither `block` nor `warn`. Nothing
 * treats such a finding as blocking, so the hook, the Stop sweep and the
 * pre-commit check all allowed what the rule exists to deny — and policy-diff
 * did not report the edit that introduced it, because it compared for `warn`
 * only. One mistyped word switched a rule off at every local layer with no
 * finding anywhere. A value that cannot be understood is now rejected exactly
 * like invalid YAML: `check` exits 2, the hook denies until the file is fixed.
 * Unknown RULE NAMES are still accepted (a policy written for a newer build
 * must keep loading on an older one); it is the VALUES that must be exact.
 */
function validate(r: RawPolicy, where: string): void {
  function bad(msg: string): never {
    throw new PolicyError(`${where}: ${msg}`);
  }
  const show = (v: unknown): string => JSON.stringify(v) ?? String(v);

  // UNKNOWN TOP-LEVEL KEYS fail closed like unknown values do. `Rules:` (a
  // capital) or `ignored:` parsed as a policy that said nothing — the author
  // wrote an override that was silently not in force, which is exactly the
  // "weaker gate than written" case every other check here exists to refuse.
  // Rule NAMES under `rules` stay open (a policy for a newer build must load);
  // it is the schema's own vocabulary that must be exact.
  const unknown = Object.keys(r as Record<string, unknown>).filter((k) => !TOP_LEVEL_KEYS.has(k));
  if (unknown.length) {
    bad(`unknown top-level key${unknown.length === 1 ? '' : 's'} ${unknown.map((k) => JSON.stringify(k)).join(', ')} (expected one of ${[...TOP_LEVEL_KEYS].join(', ')})`);
  }

  if (r.rules !== undefined) {
    if (!isMapping(r.rules)) bad(`rules must be a mapping of rule name to { severity, enabled, exclude }, got ${show(r.rules)}`);
    for (const [name, cfg] of Object.entries(r.rules as Record<string, unknown>)) {
      if (!isMapping(cfg)) bad(`rules.${name} must be a mapping like { severity: block }, got ${show(cfg)}`);
      if (cfg.severity !== undefined && !isSeverity(cfg.severity)) {
        bad(`rules.${name}.severity must be "block" or "warn", got ${show(cfg.severity)}`);
      }
      if (cfg.enabled !== undefined && typeof cfg.enabled !== 'boolean') {
        bad(`rules.${name}.enabled must be true or false, got ${show(cfg.enabled)}`);
      }
      if (cfg.exclude !== undefined && !isStringList(cfg.exclude)) {
        bad(`rules.${name}.exclude must be a list of globs, got ${show(cfg.exclude)}`);
      }
    }
  }
  if (r.ignore !== undefined && !isStringList(r.ignore)) bad(`ignore must be a list of globs, got ${show(r.ignore)}`);
  if (r.protected !== undefined) {
    if (!isMapping(r.protected)) bad(`protected must be a mapping of category to a list of globs, got ${show(r.protected)}`);
    for (const [cat, globs] of Object.entries(r.protected as Record<string, unknown>)) {
      if (!isStringList(globs)) bad(`protected.${cat} must be a list of globs, got ${show(globs)}`);
    }
  }
  if (r.signoff !== undefined) {
    if (!isMapping(r.signoff)) bad(`signoff must be a mapping, got ${show(r.signoff)}`);
    for (const key of ['required_for', 'requiredFor'] as const) {
      const v = (r.signoff as Record<string, unknown>)[key];
      if (v !== undefined && !(Array.isArray(v) && v.every(isSeverity))) {
        bad(`signoff.${key} must be a list of "block" / "warn", got ${show(v)}`);
      }
    }
    const ledger = (r.signoff as Record<string, unknown>).ledger;
    if (ledger !== undefined && typeof ledger !== 'string') bad(`signoff.ledger must be a path, got ${show(ledger)}`);
    if (typeof ledger === 'string' && !ledgerInsideRepo(ledger)) {
      bad(`signoff.ledger must be a relative path inside the repository, got ${show(ledger)}`);
    }
  }
  if (r.verify !== undefined) {
    if (!isMapping(r.verify)) bad(`verify must be a mapping like { command: "npm test" }, got ${show(r.verify)}`);
    const v = r.verify as Record<string, unknown>;
    if (v.command !== undefined && typeof v.command !== 'string') bad(`verify.command must be a string, got ${show(v.command)}`);
    if (v.budget !== undefined && !(typeof v.budget === 'number' && Number.isFinite(v.budget) && v.budget > 0)) {
      bad(`verify.budget must be a positive number of seconds, got ${show(v.budget)}`);
    }
    if (v.inputs !== undefined && !isStringList(v.inputs)) bad(`verify.inputs must be a list of globs, got ${show(v.inputs)}`);
  }
}

export function parsePolicy(raw: RawPolicy | null | undefined, where: string = POLICY_FILE): Policy {
  const r = raw ?? {};
  const version = normalizeVersion(r.version, where);
  validate(r, where);
  // The baseline is gated by the DECLARED version before user rules overlay it, so a
  // gated graduation applies only to opted-in policies while an explicit severity —
  // written by the user, in either direction — always wins.
  const base = defaultPolicy(version);
  const globs = (list: string[] | undefined): string[] | undefined => list?.map(normalizeGlob);
  const userProtected = r.protected
    ? Object.fromEntries(Object.entries(r.protected).map(([cat, list]) => [cat, globs(list) ?? []]))
    : undefined;
  const userRules = r.rules
    ? Object.fromEntries(
        Object.entries(r.rules).map(([name, cfg]) => [name, cfg?.exclude ? { ...cfg, exclude: globs(cfg.exclude) } : cfg]),
      )
    : undefined;
  return {
    version,
    // Merge with the baseline, never replace. For an integrity tool, a config that sets
    // one rule's severity must NOT silently drop the other nine — nor may naming one
    // protected glob wipe out the rest of its category (see mergeProtected), nor may
    // an `exclude`-only override drop the rule's baseline severity (see mergeRules).
    protected: mergeProtected(base.protected, userProtected),
    rules: mergeRules(base.rules, userRules),
    ignore: globs(r.ignore) ?? base.ignore,
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
  return parsePolicy(raw as RawPolicy, where);
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
