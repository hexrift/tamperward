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

function asPolicy(src: string): RawPolicyShape {
  try {
    return (parse(src) ?? {}) as RawPolicyShape;
  } catch {
    return {};
  }
}

/** Reasons the after-policy is weaker than before. Empty if it's equal or stronger. */
export function policyWeakening(before: string, after: string): string[] {
  const b = asPolicy(before);
  const a = asPolicy(after);
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
