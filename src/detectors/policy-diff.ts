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
import { defaultPolicy, mergeProtected, normalizeGlob } from '../policy';

interface RawPolicyShape {
  version?: unknown;
  rules?: Record<string, { severity?: string; enabled?: boolean; exclude?: string[] }>;
  ignore?: string[];
  protected?: Record<string, string[]>;
  signoff?: { required_for?: string[]; requiredFor?: string[]; ledger?: string };
  verify?: { command?: string; budget?: number; inputs?: string[] };
}

interface EffectivePolicy {
  version: number;
  rules: Record<string, { severity?: string; enabled?: boolean; exclude?: string[] }>;
  ignore: string[];
  protected: Record<string, string[]>;
  requiredFor: string[];
  ledger: string;
}

const globs = (list: unknown): string[] =>
  Array.isArray(list) ? list.filter((g): g is string => typeof g === 'string').map(normalizeGlob) : [];

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
  // Overlay FIELD BY FIELD, as the loader does (mergeRules): an override that names
  // only `exclude` keeps the baseline severity. Replacing the whole rule object read
  // `test-deletion: { exclude: ['**'] }` as "lowered block → undefined" — a false
  // finding on top of the exclude finding that IS the weakening. Done inline rather
  // than through mergeRules because the raw shape here is unvalidated.
  const rules: EffectivePolicy['rules'] = { ...base.rules };
  for (const [name, cfg] of Object.entries(raw.rules ?? {})) {
    const over = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
    rules[name] = { ...(rules[name] ?? {}), ...over, ...(over.exclude ? { exclude: globs(over.exclude) } : {}) };
  }
  const userProtected = raw.protected && typeof raw.protected === 'object'
    ? Object.fromEntries(Object.entries(raw.protected).map(([cat, list]) => [cat, globs(list)]))
    : undefined;
  return {
    version,
    rules,
    ignore: raw.ignore ? globs(raw.ignore) : (base.ignore ?? []),
    protected: mergeProtected(base.protected, userProtected),
    requiredFor: raw.signoff?.required_for ?? raw.signoff?.requiredFor ?? base.signoff.requiredFor,
    ledger: typeof raw.signoff?.ledger === 'string' ? raw.signoff.ledger : base.signoff.ledger,
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
    // ANY departure from `block` is a lowering, not only the spelling `warn`. The
    // loader now rejects an unknown severity outright, but this detector judges
    // the EDIT that introduces it — with the pre-edit policy, before the loader
    // ever sees the new file — and comparing for `warn` alone let `BLOCK`,
    // `blocc` or `blocking` through as no change at all.
    if (br.severity === 'block' && ar.severity !== 'block') {
      const to = typeof ar.severity === 'string' ? ar.severity : JSON.stringify(ar.severity);
      reasons.push(
        ar.severity === 'warn'
          ? `rule "${name}" lowered block → warn`
          : `rule "${name}" lowered block → ${to} (not a valid severity; the rule would no longer block)`,
      );
    }
    if (ar.enabled === false && br.enabled !== false) {
      reasons.push(`rule "${name}" disabled (enabled: false)`);
    }
    // exclude: a per-rule glob added blinds this one rule on those paths — the same
    // weakening class as an added `ignore` glob, in its newer per-rule spelling. Added
    // the day the feature shipped, not after an evasion measured the gap.
    const beforeEx = new Set(br.exclude ?? []);
    const addedEx = (ar.exclude ?? []).filter((g) => !beforeEx.has(g));
    if (addedEx.length) {
      reasons.push(`rule "${name}" exclude globs added (${addedEx.join(', ')}) — blinds this rule on those paths`);
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
  // signoff.ledger: the one file the LOCAL layer trusts. Moving it — to a path the
  // branch already seeds, or out of the repository altogether — swaps the sign-off
  // record for one nobody reviewed, so ANY change is reported, not only an escape.
  if (ae.ledger !== be.ledger) {
    reasons.push(`sign-off ledger moved (${be.ledger} → ${ae.ledger}) — the local layer would trust a different file`);
  }

  // verify: the pristine-suite re-execution config is itself a guarded surface.
  // A verify whose command an agent can rewrite (to `true`, to a filtered runner)
  // or whose budget can be starved is no verification at all, so ANY command
  // change and any budget lowering read as weakening; removal likewise. Adding
  // verify where none existed is a strengthening and passes.
  const bv = b.verify;
  const av = a.verify;
  if (bv?.command) {
    if (!av?.command) {
      reasons.push('verify block removed — pristine-suite re-execution disabled');
    } else {
      if (av.command !== bv.command) {
        reasons.push(
          `verify.command changed ("${bv.command}" → "${av.command}") — the re-executed suite is no longer the one that was configured`,
        );
      }
      const bb = bv.budget ?? 300;
      const ab = av.budget ?? 300;
      if (ab < bb) {
        reasons.push(`verify.budget lowered ${bb}s → ${ab}s — starving the budget turns "cannot verify" into a pressure point`);
      }
      // inputs: the globs naming what the verifier command executes. Dropping
      // one hands the pristine run back the agent's copy of that file — the
      // same weakening as narrowing `protected`, aimed at the runner instead
      // of the tests.
      const stillInput = new Set(av.inputs ?? []);
      const droppedInputs = (bv.inputs ?? []).filter((g) => !stillInput.has(g));
      if (droppedInputs.length) {
        reasons.push(
          `verify.inputs narrowed (removed ${droppedInputs.join(', ')}) — the pristine run would execute the candidate's copy of those files`,
        );
      }
    }
  }

  return reasons;
}

/**
 * Reasons an ADDED policy file is weaker than the baseline it displaces.
 *
 * A repo with no `.tamperward.yml` runs the baseline, so the first policy file
 * is an edit FROM the baseline — `ignore: ['**']` on a fresh file switches the
 * gate off exactly as it would on an existing one. The comparison used to be
 * gated on a before-text, so the add was never compared to anything. An empty
 * or comment-only file (the YAML document is null) restates the baseline and
 * yields nothing; a document that is not a mapping cannot be loaded at all and
 * is reported, since the loader fails closed on it.
 */
export function policyAddWeakening(after: string): string[] {
  let doc: unknown;
  try {
    doc = parse(after);
  } catch {
    return ['the added policy is not valid YAML — the gate fails closed until it is fixed'];
  }
  if (doc === null || doc === undefined) return [];
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    return ['the added policy is not a policy mapping — the gate fails closed until it is fixed'];
  }
  // `{}` is the baseline restated (`''` parses to null and would give no baseline).
  return policyWeakening('{}', after) ?? [];
}
