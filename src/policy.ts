// Policy helpers: deterministic glob matching of the protected assets, plus the
// baseline policy `npx tamperward init` would write. Detectors ask "is this path a
// test / config / ci / hook?" through here so the globs live in exactly one place.

import picomatch from 'picomatch';
import { Policy } from './types';

export const POLICY_FILE = '.tamperward.yml';

/** The newest policy version the baseline knows about. Declaring `version: N` in
 *  .tamperward.yml opts the repo in to every rule graduation gated at <= N. A version
 *  HIGHER than this is accepted (it passes every gate this build knows), so a policy
 *  written for a newer tamperward degrades gracefully on an older one. */
export const POLICY_VERSION = 1;

/** Rules whose BASELINE severity graduates warn -> block only at a given policy
 *  version. Below that version they stay warn, so the graduation ships in a minor
 *  without turning un-opted-in builds red (CONTRIBUTING, "Versioning"). An explicit
 *  user-written severity always wins over this gate, in either direction.
 *  EMPTY TODAY: no rule has earned a gated graduation yet. The first candidate is
 *  snapshot-rewrite, pending the SPEC 7 evidence path — landing it will look like:
 *    'snapshot-rewrite': 2   // + POLICY_VERSION = 2
 */
export const BLOCK_SINCE: Record<string, number> = {};

/** Downgrade to warn every gated rule the declared version has not opted in to.
 *  Pure — returns a new rules object. Applied to the BASELINE only, before user
 *  overrides are layered on top, so an explicit severity is never second-guessed. */
export function applyVersionGates(
  rules: Policy['rules'],
  version: number,
  gates: Record<string, number> = BLOCK_SINCE,
): Policy['rules'] {
  const out: Policy['rules'] = { ...rules };
  for (const [rule, since] of Object.entries(gates)) {
    if (since > version && out[rule]?.severity === 'block') {
      out[rule] = { ...out[rule], severity: 'warn' };
    }
  }
  return out;
}

const cache = new Map<string, (s: string) => boolean>();

function matcher(glob: string): (s: string) => boolean {
  let m = cache.get(glob);
  if (!m) {
    m = picomatch(glob, { dot: true });
    cache.set(glob, m);
  }
  return m;
}

export function matchesAny(path: string, globs?: string[]): boolean {
  return !!globs && globs.some((g) => matcher(g)(path));
}

/** The first protected category whose globs match `path`, or null. */
export function protectedCategory(path: string, policy: Policy): string | null {
  for (const [cat, globs] of Object.entries(policy.protected ?? {})) {
    if (matchesAny(path, globs)) return cat;
  }
  return null;
}

export function isProtected(path: string, policy: Policy, category?: string): boolean {
  if (category) return matchesAny(path, policy.protected?.[category]);
  return protectedCategory(path, policy) !== null;
}

/** The policy file itself, at any depth. `ignore` may never suppress a change to it:
 *  an ignore glob that hides its own introduction makes the gate self-erasing, which is
 *  the cheapest total bypass there is. Kept as a path test (not a glob) so no policy can
 *  redefine it. */
export function isPolicyFile(path: string): boolean {
  return path === POLICY_FILE || path.endsWith('/' + POLICY_FILE);
}

/** Whether a file path is excluded from file-surface detection by policy.ignore. */
export function isIgnored(path: string, policy: Policy): boolean {
  return matchesAny(path, policy.ignore);
}

/**
 * Merge user-declared protected globs ON TOP of the baseline, additively, per category.
 *
 * Replacing per category looked like "set your test globs" but actually meant "drop the
 * other baseline ones": adding a single `tests` entry silently unprotected `*.spec.ts`,
 * `*.test.tsx` and `__tests__/`, so test-deletion and test-skip stopped firing on them —
 * a large false-negative surface opened by ordinary, well-intentioned config. A protected
 * category can therefore only ever GROW here. To exclude a path from detection, use
 * `ignore` (which is reported, and cannot cover the policy file itself).
 */
export function mergeProtected(
  base: Record<string, string[]>,
  user?: Record<string, string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = { ...base };
  for (const [cat, globs] of Object.entries(user ?? {})) {
    const have = new Set(out[cat] ?? []);
    out[cat] = [...(out[cat] ?? []), ...(globs ?? []).filter((g) => !have.has(g))];
  }
  return out;
}

/** The baseline policy — mirrors the committed .tamperward.yml. */
export function defaultPolicy(version = 1): Policy {
  const p: Policy = {
    version,
    protected: {
      // Cover every JS/TS test extension, not just .test.ts — the multi-repo FP study found
      // .test.tsx/.spec.tsx (hono, zustand) slipped the glob, so legit test-file casts blocked
      // instead of warning. Kept ADDITIVE (originals + new extensions) so the policy-diff sees a
      // strengthening, not a narrowing. picomatch expands the brace.
      tests: ['**/*.test.ts', '**/*.spec.ts', '**/*.{test,spec}.{tsx,cts,mts,js,jsx,cjs,mjs}', '**/__tests__/**'],
      config: [
        '**/jest.config.*',
        '**/vitest.config.*',
        '**/tsconfig*.json',
        '**/.eslintrc*',
        '**/eslint.config.*',
        '**/package.json',
      ],
      ci: ['.github/workflows/**'],
      // Recorded expected outputs. An assertion stored as data is still an assertion;
      // rewriting it from current output is the snapshot-update move the affordance
      // experiment measured at a 70% attempt / 100% through rate (snapshot-rewrite).
      snapshots: ['**/*.snap', '**/__snapshots__/**', '**/golden/**', '**/*.golden.*'],
      hooks: ['.husky/**', '**/lefthook.*', '.tamperward.yml', '**/.tamperward.yml'],
    },
    rules: {
      'test-deletion': { severity: 'block' },
      'test-skip': { severity: 'block' },
      'ts-any-cast': { severity: 'block' }, // the unambiguous explicit casts + ts-suppression directives
      // broad any in annotation/generic position is common in legit code (measured ~84-100% FP as a
      // block rule on real TS), so it WARNs until a semantic (error-silencing-aware) signal earns block.
      'ts-any-launder': { severity: 'warn' },
      'lint-suppression': { severity: 'block' },
      'coverage-lowering': { severity: 'block' },
      'ci-tampering': { severity: 'block' },
      'hook-tampering': { severity: 'block' },
      'no-verify': { severity: 'block' },
      // mechanical but intent-ambiguous: updating a snapshot is the legitimate workflow
      // when intended output changes. WARN until the §7 evidence path earns block.
      'snapshot-rewrite': { severity: 'warn' },
      // heuristic — warn until precision is measured (SPEC §7)
      'assertion-weakening': { severity: 'warn' },
      'guard-removal': { severity: 'warn' },
    },
    ignore: [],
    signoff: { requiredFor: ['block'], ledger: '.tamperward/ledger.jsonl' },
  };
  p.rules = applyVersionGates(p.rules, version);
  return p;
}
