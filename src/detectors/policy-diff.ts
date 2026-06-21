// Semantic weakening detection for the policy file itself — the "guard the guardrail"
// core. Parsing before/after YAML catches every weakening move regardless of formatting:
// lowered/disabled/removed rules (inline OR multiline), added ignore globs, narrowed
// protected globs, and weakened sign-off. A line regex can't see any of these reliably.

import { parse } from 'yaml';

interface RawPolicyShape {
  rules?: Record<string, { severity?: string; enabled?: boolean }>;
  ignore?: string[];
  protected?: Record<string, string[]>;
  signoff?: { required_for?: string[]; requiredFor?: string[] };
}

/** Parse to a policy object, or null if it isn't valid YAML / isn't a mapping. Never
 *  throws — a malformed `.holdfast.yml` must not be able to crash the gate. */
function safeParse(src: string): RawPolicyShape | null {
  try {
    const v = parse(src);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as RawPolicyShape;
    return null; // empty doc / scalar / list → not a policy
  } catch {
    return null;
  }
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

  const reasons: string[] = [];

  // rules: lowered, disabled, or removed
  const bRules = b.rules ?? {};
  const aRules = a.rules ?? {};
  for (const [name, br] of Object.entries(bRules)) {
    const ar = aRules[name];
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
  const beforeIgnore = new Set(b.ignore ?? []);
  const addedIgnore = (a.ignore ?? []).filter((g) => !beforeIgnore.has(g));
  if (addedIgnore.length) {
    reasons.push(`ignore globs added (${addedIgnore.join(', ')}) — disables detection on those paths`);
  }

  // protected: any glob removed narrows the safety net
  const bProt = b.protected ?? {};
  const aProt = a.protected ?? {};
  for (const [cat, globs] of Object.entries(bProt)) {
    const stillThere = new Set(aProt[cat] ?? []);
    const removed = (globs ?? []).filter((g) => !stillThere.has(g));
    if (removed.length) reasons.push(`protected.${cat} narrowed (removed ${removed.join(', ')})`);
  }

  // signoff: block no longer requires sign-off
  const bReq = b.signoff?.required_for ?? b.signoff?.requiredFor ?? [];
  const aReq = new Set(a.signoff?.required_for ?? a.signoff?.requiredFor ?? []);
  if (bReq.includes('block') && !aReq.has('block')) {
    reasons.push('sign-off no longer required for blocking findings');
  }

  return reasons;
}
