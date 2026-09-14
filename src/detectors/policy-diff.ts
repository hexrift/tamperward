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

import { yaml } from '../lazy-deps';
import { defaultPolicy, isNegatedGlob, isProtected, matchesAny, mergeProtected, normalizeGlob, protectedCategory } from '../policy';
import { Policy } from '../types';
import { isRecord } from '../narrow';
import { isCodeFile } from './files';
import { CANONICAL_SAMPLES, PYTEST_CANONICAL_SAMPLES } from './suite-config';

/** A policy document as parsed, before any validation: every field is unknown
 *  and is narrowed where it is read. This detector must never crash the gate. */
type RawPolicyShape = Record<string, unknown>;

/** The verify block as written, each field kept only when it has the type the
 *  comparison below reads; a mistyped field compares as absent. */
function verifyBlock(v: unknown): { command?: string; budget?: number; inputs?: string[]; backend?: string; image?: string } | undefined {
  if (!isRecord(v)) return undefined;
  return {
    ...(typeof v.command === 'string' ? { command: v.command } : {}),
    ...(typeof v.budget === 'number' ? { budget: v.budget } : {}),
    ...(Array.isArray(v.inputs) ? { inputs: v.inputs.filter((g): g is string => typeof g === 'string') } : {}),
    ...(typeof v.backend === 'string' ? { backend: v.backend } : {}),
    ...(typeof v.image === 'string' ? { image: v.image } : {}),
  };
}

/** The rule overrides as written: each entry a mapping whose fields are read
 *  with the same tolerance the loader's validation would reject on. */
function ruleOverrides(v: unknown): Record<string, { severity?: unknown; enabled?: unknown; exclude?: unknown }> {
  if (!isRecord(v)) return {};
  return Object.fromEntries(Object.entries(v).map(([name, cfg]) => [name, isRecord(cfg) ? cfg : {}]));
}

interface EffectivePolicy {
  version: number;
  /** Overrides are carried as written so a mistyped value (`BLOCK`, `7`) is
   *  reported as the lowering it is, not silently read as the baseline. */
  rules: Record<string, { severity?: unknown; enabled?: unknown; exclude?: string[] }>;
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
    const v = yaml.parse(src);
    if (isRecord(v)) return v;
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
  for (const [name, over] of Object.entries(ruleOverrides(raw.rules))) {
    rules[name] = {
      ...(rules[name] ?? {}),
      ...(over.severity !== undefined ? { severity: over.severity } : {}),
      ...(over.enabled !== undefined ? { enabled: over.enabled } : {}),
      ...(over.exclude !== undefined ? { exclude: globs(over.exclude) } : {}),
    };
  }
  const userProtected = isRecord(raw.protected)
    ? Object.fromEntries(Object.entries(raw.protected).map(([cat, list]) => [cat, globs(list)]))
    : undefined;
  const signoff = isRecord(raw.signoff) ? raw.signoff : {};
  const requiredFor = [signoff.required_for, signoff.requiredFor].find(Array.isArray);
  return {
    version,
    rules,
    ignore: raw.ignore ? globs(raw.ignore) : (base.ignore ?? []),
    protected: mergeProtected(base.protected, userProtected),
    requiredFor: requiredFor ? requiredFor.filter((s): s is string => typeof s === 'string') : base.signoff.requiredFor,
    ledger: typeof signoff.ledger === 'string' ? signoff.ledger : base.signoff.ledger,
  };
}

/**
 * Rule REACH (#434). The glob lists are not the whole story: a rule's jurisdiction is
 * a predicate over categories, and `mergeProtected` only ever GROWS a category, so
 * the one weakening a category ADD can cause is invisible to a per-list comparison.
 * The spec rules judge `tests && !snapshots` — growing `snapshots` over the specs
 * demoted test-deletion to snapshot-rewrite with no finding — and the cast rules
 * judge `category !== tests`, so `tests: ['!zzz']` (picomatch: every path) made
 * every source file a test file and switched them off. Each rule's predicate is
 * evaluated over a PROBE LISTING before and after the edit; a path that leaves a
 * rule's reach is reported naming the path and the rule. The listing is the
 * repository's own files when the caller has them, always joined with the
 * conventional samples so a repository that holds no `.snap` today still sees a
 * glob that would demote its specs tomorrow.
 */
const SOURCE_SAMPLES = ['src/index.ts', 'src/lib/util.ts', 'app/main.tsx', 'lib/a.js', 'packages/core/src/index.ts'];
const SNAPSHOT_SAMPLES = [
  'src/__snapshots__/a.test.ts.snap',
  'test/__snapshots__/a.snap',
  'src/__tests__/__snapshots__/a.snap',
  'tap-snapshots/a.cjs',
  'golden/a.txt',
  'test/a.golden.json',
];

const spec = (p: string, pol: Policy): boolean => isProtected(p, pol, 'tests') && !isProtected(p, pol, 'snapshots');
const cast = (p: string, pol: Policy): boolean => isCodeFile(p) && protectedCategory(p, pol) !== 'tests';
/** Each rule's jurisdiction. `broad` marks the cast rules: they cede test files BY
 *  DESIGN (a cast in a spec warns), so a new `tests` glob that names a real test
 *  layout (a new package's integration specs) honestly takes those files out of
 *  their reach. That loss is reported only when the same edit also takes a
 *  CONVENTIONAL SOURCE path (`src/index.ts`, `lib/a.js`, …) out of reach: a glob no
 *  honest test layout names, the signature of a negated glob or a bare TS glob. The spec rules
 *  have no such honest loss — nothing in a category add should stop judging a spec. */
const REACH: ReadonlyArray<{ rule: string; reaches: (p: string, pol: Policy) => boolean; broad?: true }> = [
  { rule: 'test-deletion', reaches: spec },
  { rule: 'test-content-removal', reaches: spec },
  { rule: 'assertion-weakening', reaches: spec },
  { rule: 'test-skip', reaches: (p, pol) => isProtected(p, pol, 'tests') },
  { rule: 'ts-any-cast', reaches: cast, broad: true },
  { rule: 'ts-cast-growth', reaches: cast, broad: true },
];

/** The probe listing: the caller's paths first (so a reason names a real file), then
 *  the conventional samples, each path once. */
function probeListing(probe: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...(probe ?? []), ...CANONICAL_SAMPLES, ...PYTEST_CANONICAL_SAMPLES, ...SOURCE_SAMPLES, ...SNAPSHOT_SAMPLES]) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/** A Policy carrying the effective protected globs, for the category predicates. */
const withProtected = (e: EffectivePolicy): Policy => ({ ...defaultPolicy(e.version), protected: e.protected });

const SHOWN = 5;
const list = (paths: string[]): string => paths.slice(0, SHOWN).join(', ') + (paths.length > SHOWN ? ` (+${paths.length - SHOWN} more)` : '');

/** Per rule, the probe paths it judged before the edit and no longer judges after. */
function reachLost(be: EffectivePolicy, ae: EffectivePolicy, probe: readonly string[] | undefined): string[] {
  const paths = probeListing(probe);
  const before = withProtected(be);
  const after = withProtected(ae);
  const reasons: string[] = [];
  for (const { rule, reaches, broad } of REACH) {
    const lost = paths.filter((p) => reaches(p, before) && !reaches(p, after));
    if (broad && !lost.some((p) => SOURCE_SAMPLES.includes(p))) continue; // a named test layout, ceded by design
    if (lost.length) {
      reasons.push(`rule "${rule}" no longer reaches ${list(lost)} — the protected globs changed what it judges`);
    }
  }
  return reasons;
}

/**
 * Example paths a glob matches, from the glob's own text: `**` and `*` stand in for
 * a segment or a name, the first brace alternative and the first bracket character
 * are taken. Each candidate is kept only if the glob really matches it. Used to ask
 * whether a NEW `tests` glob reaches into snapshot territory — a path in both
 * categories is judged as a snapshot, not a spec — without a listing to consult.
 */
function exemplars(glob: string): string[] {
  const base = glob
    .replace(/\{([^{}]*)\}/g, (_m, alts: string) => alts.split(',')[0] ?? '')
    .replace(/\[!?([^\]])[^\]]*\]/g, '$1');
  const variants = [base.replace(/\*\*\//g, ''), base.replace(/\*\*\//g, 'x/'), base.replace(/\/\*\*$/, '/x'), base.replace(/\/\*\*$/, '/x/y')];
  const out = new Set<string>();
  for (const v of variants) {
    const path = v.replace(/\*\*/g, 'x').replace(/\*/g, 'a');
    if (path && matchesAny(path, [glob])) out.add(path);
  }
  return [...out];
}

/**
 * Reasons the after-policy is weaker than before.
 *  - [] when it's equal or stronger.
 *  - null when `before` can't be parsed (no baseline to compare) → caller should fall
 *    back to the line-regex path rather than guess.
 *  - a finding when `after` won't parse but `before` did — emptying or corrupting the
 *    policy is itself a tamper, so this fails CLOSED.
 */
export function policyWeakening(before: string, after: string, probe?: readonly string[]): string[] | null {
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

    // ADDED globs (#434). A category can only grow, but growth is not always a
    // strengthening: membership in `snapshots` LOWERS the spec rules (they judge
    // `tests && !snapshots`), so a glob added there demotes every spec it covers;
    // a negated glob matches every path, so it moves every file into the category
    // (the loader refuses it, but this detector judges the EDIT, with the pre-edit
    // policy, before the loader ever sees the new file); and a `tests` glob that
    // reaches into snapshot territory puts those paths in both categories, where
    // they are judged as snapshots.
    const had = new Set(be.protected[cat] ?? []);
    const added = (ae.protected[cat] ?? []).filter((g) => !had.has(g));
    if (!added.length) continue;
    const negated = added.filter(isNegatedGlob);
    if (negated.length) {
      reasons.push(`protected.${cat} gained a negated glob (${negated.join(', ')}) — a "!" pattern matches every path, so every file becomes ${cat === 'tests' ? 'a test file and the source-only rules go quiet' : `a ${cat} file`}`);
    }
    const plain = added.filter((g) => !isNegatedGlob(g));
    if (cat === 'snapshots' && plain.length) {
      reasons.push(`protected.snapshots widened (added ${plain.join(', ')}) — membership in snapshots lowers test-deletion, test-content-removal and assertion-weakening on those paths`);
    }
    if (cat === 'tests' && plain.length) {
      const snaps = ae.protected.snapshots ?? [];
      const snapProbes = [...SNAPSHOT_SAMPLES, ...(probe ?? []).filter((p) => matchesAny(p, snaps))];
      const overlapping = plain.filter((g) => [...exemplars(g), ...snapProbes].some((p) => matchesAny(p, [g]) && matchesAny(p, snaps)));
      if (overlapping.length) {
        reasons.push(`protected.tests gained a glob that also matches snapshot paths (${overlapping.join(', ')}) — a path in both categories is judged as a snapshot, not a spec`);
      }
    }
  }
  reasons.push(...reachLost(be, ae, probe));

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
  const bv = verifyBlock(b.verify);
  const av = verifyBlock(a.verify);
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

      // Backend identity is authority identity. Once a trusted policy requires
      // container isolation, omitting/changing it falls back to the weaker
      // same-host verifier. Changing the pinned image swaps the verifier's
      // runtime/dependency authority just as surely as changing command swaps
      // the suite.
      const beforeBackend = bv.backend ?? 'local';
      const afterBackend = av.backend ?? 'local';
      if (beforeBackend === 'container' && afterBackend !== 'container') {
        reasons.push(
          `verify.backend lowered container → ${afterBackend} — final verification would leave the isolated trust domain`,
        );
      }
      if (
        beforeBackend === 'container' &&
        afterBackend === 'container' &&
        av.image !== bv.image
      ) {
        reasons.push(
          `verify.image changed (${bv.image ?? '<missing>'} → ${av.image ?? '<missing>'}) — the trusted verifier image identity changed`,
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
export function policyAddWeakening(after: string, probe?: readonly string[]): string[] {
  let doc: unknown;
  try {
    doc = yaml.parse(after);
  } catch {
    return ['the added policy is not valid YAML — the gate fails closed until it is fixed'];
  }
  if (doc === null || doc === undefined) return [];
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    return ['the added policy is not a policy mapping — the gate fails closed until it is fixed'];
  }
  // `{}` is the baseline restated (`''` parses to null and would give no baseline).
  return policyWeakening('{}', after, probe) ?? [];
}
