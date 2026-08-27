// Semantic weakening detection for the policy file itself — the "guard the guardrail"
// core. Parsing before/after YAML catches every weakening move regardless of formatting:
// lowered/disabled/removed rules (inline OR multiline), added ignore globs, narrowed
// protected globs, and weakened sign-off. A line regex can't see any of these reliably.
//
// The comparison is between EFFECTIVE policies, not raw file texts. `parsePolicy` layers
// every override on top of the baseline, so a key OMITTED from the before-file inherits a
// strong default. Diffing the texts alone therefore missed the cheapest self-authorization
// there is: ADD `test-deletion: { severity: warn }` (or `enabled: false`, or a narrow
// `protected.tests`) for a rule that was inheriting the baseline, then gut the tests.
// Both sides are merged onto the baseline first, so an inherited value is compared like a
// written one and only a real drop in effective strength is reported.

import { parse } from 'yaml';
import { defaultPolicy, mergeProtected } from '../policy';

interface RawPolicyShape {
  version?: unknown;
  rules?: Record<string, { severity?: string; enabled?: boolean }>;
  ignore?: string[];
  protected?: Record<string, string[]>;
  signoff?: { required_for?: string[]; requiredFor?: string[] };
}

interface EffectivePolicy {
  version: number;
  rules: Record<string, { severity?: string; enabled?: boolean }>;
  ignore: string[];
  protected: Record<string, string[]>;
  requiredFor: string[];
}

/** Parse to a policy object, or null if it isn't valid YAML / isn't a mapping. Never
 *  throws — a malformed `.tamperward.yml` must not be able to crash the gate. */
function safeParse(src: string): RawPolicyShape | null {
  try {
    const v = parse(src);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as RawPolicyShape;
    return null; // empty doc / scalar / list → not a policy
  } catch {
    return null;
  }
}

/** What the file actually means once the baseline is layered underneath it — the same
 *  merge `parsePolicy` performs, so the comparison sees what the engine will enforce. */
function effective(raw: RawPolicyShape): EffectivePolicy {
  // A malformed version is read as 1 here rather than thrown: this detector must never
  // crash the gate (see safeParse). The loader path (policy-load) does fail closed on it.
  const v = raw.version;
  const version = typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : 1;
  // The baseline is gated by each side's OWN declared version, so lowering `version:`
  // surfaces as the concrete rule downgrades it causes — compared exactly as the engine
  // would enforce them — not as an abstract number change alone.
  const base = defaultPolicy(version);
  return {
    version,
    rules: { ...base.rules, ...(raw.rules ?? {}) },
    ignore: raw.ignore ?? base.ignore ?? [],
    protected: mergeProtected(base.protected, raw.protected),
    requiredFor: raw.signoff?.required_for ?? raw.signoff?.requiredFor ?? base.signoff.requiredFor,
  };
}

/**
 * Reasons the after-policy is weaker than before.
 *  - [] when it's equal or stronger.
 *  - null when `before` can't be parsed (no baseline to compare) → caller should fall
 *    back to the line-regex path rather than guess.
 *  - a finding when `after` won't parse but `before` did — emptying or corrupting the
 *    policy is itself a tamper, so this fails CLOSED.
 */
export function policyWeakening(before: string, after: string): string[] | null {
  const b = safeParse(before);
  if (b === null) return null;
  const a = safeParse(after);
  if (a === null) return ['the policy no longer parses as a valid policy (emptied or corrupted)'];

  const be = effective(b);
  const ae = effective(a);
  const reasons: string[] = [];

  // version: lowering it un-opts the repo from every graduation gated above the new
  // value. Flagged even while no gate exists yet — the ONLY thing a lowering can ever
  // do is weaken, and catching the preparation beats catching the exploitation.
  if (ae.version < be.version) {
    reasons.push(
      `policy version lowered ${be.version} → ${ae.version} — un-opts this repo from rule graduations gated above ${ae.version}`,
    );
  }

  // rules: lowered, disabled, or removed — over the UNION of names, so a rule that was
  // inheriting the baseline is compared at its inherited strength, not skipped.
  for (const name of new Set([...Object.keys(be.rules), ...Object.keys(ae.rules)])) {
    const br = be.rules[name];
    const ar = ae.rules[name];
    if (!br) continue; // newly added rule — not a weakening
    if (!ar) {
      reasons.push(`rule "${name}" removed from policy`);
      continue;
    }
    if (br.severity === 'block' && ar.severity === 'warn') {
      reasons.push(`rule "${name}" lowered block → warn`);
    }
    if (ar.enabled === false && br.enabled !== false) {
      reasons.push(`rule "${name}" disabled (enabled: false)`);
    }
  }

  // ignore: any glob added disables file detection on those paths
  const beforeIgnore = new Set(be.ignore);
  const addedIgnore = ae.ignore.filter((g) => !beforeIgnore.has(g));
  if (addedIgnore.length) {
    reasons.push(`ignore globs added (${addedIgnore.join(', ')}) — disables detection on those paths`);
  }

  // protected: any glob removed narrows the safety net. Categories merge per key, so
  // REPLACING a category with a shorter list reads as the narrowing it is.
  for (const cat of new Set([...Object.keys(be.protected), ...Object.keys(ae.protected)])) {
    const stillThere = new Set(ae.protected[cat] ?? []);
    const removed = (be.protected[cat] ?? []).filter((g) => !stillThere.has(g));
    if (removed.length) reasons.push(`protected.${cat} narrowed (removed ${removed.join(', ')})`);
  }

  // signoff: block no longer requires sign-off
  if (be.requiredFor.includes('block') && !new Set(ae.requiredFor).has('block')) {
    reasons.push('sign-off no longer required for blocking findings');
  }

  return reasons;
}
