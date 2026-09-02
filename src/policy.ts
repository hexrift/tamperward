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

/**
 * Canonical spelling of a policy glob. Paths in every git view are repo-relative
 * with no leading slash, so a glob written `/e2e/**` — the gitignore and CODEOWNERS
 * habit for "anchored at the root" — never matched anything under picomatch: a
 * protected glob that protects nothing, silently. The leading slash is dropped
 * here, in the one place globs are normalised, so `/e2e/**` and `e2e/**` are the
 * same rule at load time and in the policy-diff comparison.
 */
export function normalizeGlob(glob: string): string {
  return glob.startsWith('/') ? glob.replace(/^\/+/, '') : glob;
}

/**
 * Overlay user rule overrides on the baseline FIELD BY FIELD. Replacing the whole
 * rule object meant `test-deletion: { exclude: ['**'] }` dropped the baseline
 * `severity: block` on the floor — the rule loaded with no severity at all, and
 * policy-diff reported the edit as "lowered block → undefined". An override names
 * only the fields it changes; everything it leaves out keeps the baseline value.
 */
export function mergeRules(base: Policy['rules'], user?: Policy['rules']): Policy['rules'] {
  const out: Policy['rules'] = { ...base };
  for (const [name, cfg] of Object.entries(user ?? {})) {
    out[name] = { ...(out[name] ?? {}), ...(cfg ?? {}) } as Policy['rules'][string];
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

/** The baseline policy. The committed .tamperward.yml is an OVERLAY on this (see
 *  parsePolicy: protected globs merge per category, rules overlay by name), so it
 *  lists only what this repo adds — it is not a copy of the baseline. */
export function defaultPolicy(version = 1): Policy {
  const p: Policy = {
    version,
    protected: {
      // Cover every JS/TS test extension, not just .test.ts — the multi-repo FP study found
      // .test.tsx/.spec.tsx (hono, zustand) slipped the glob, so legit test-file casts blocked
      // instead of warning. Kept ADDITIVE (originals + new extensions) so the policy-diff sees a
      // strengthening, not a narrowing. picomatch expands the brace.
      // test-skip, test-deletion and test-content-removal all gate on this
      // class, so a repo it does not match gets rules that can NEVER fire —
      // protection that is silently absent rather than visibly off. The JS/TS
      // list shipped alone; these are the conventional layouts of the other
      // ecosystems `init` is run in. (P2-13, external review.)
      tests: [
        // JavaScript / TypeScript
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/*.{test,spec}.{tsx,cts,mts,js,jsx,cjs,mjs}',
        '**/__tests__/**',
        // Python (pytest / unittest layouts)
        '**/test_*.py',
        '**/*_test.py',
        '**/conftest.py',
        // Go
        '**/*_test.go',
        // Rust (integration tests live in tests/, unit tests inline)
        '**/tests/**/*.rs',
        // Ruby (RSpec / minitest)
        '**/*_spec.rb',
        '**/*_test.rb',
        // Java / Kotlin / Scala (Maven & Gradle convention)
        '**/src/test/**',
        // PHP (PHPUnit)
        '**/*Test.php',
        // C# (.NET)
        '**/*Tests.cs',
        '**/*Test.cs',
      ],
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
      // tap-snapshots/** added from Phase-3 evidence: node-tar's recorded expectations
      // live there as .cjs and were rewritten unseen (PHASE3.md §4).
      snapshots: ['**/*.snap', '**/__snapshots__/**', '**/tap-snapshots/**', '**/golden/**', '**/*.golden.*'],
      // The wiring IS the enforcement: settings.json carries the PreToolUse and
      // Stop hooks, and a pre-commit config carries the commit-time gate. These
      // were installed by `init` and protected by nothing, so editing them out
      // fired no rule at all. (.git/hooks/** is outside every git view and so
      // cannot be covered here — noted in SECURITY-ENVELOPE.md.) (P1-4, review.)
      hooks: [
        '.husky/**',
        '**/lefthook.*',
        '.tamperward.yml',
        '**/.tamperward.yml',
        '.claude/settings.json',
        '.claude/settings.local.json',
        '**/.pre-commit-config.yaml',
        // CODEOWNERS is enforcement wiring, not documentation: it is the only
        // thing that can require a human on a change to the workflow that
        // decides whether the gate runs at all. GitHub reads it from any of
        // these three locations. (H2.)
        '.github/CODEOWNERS',
        'CODEOWNERS',
        'docs/CODEOWNERS',
      ],
    },
    rules: {
      'test-deletion': { severity: 'block' },
      // content gutted from a surviving spec — the class Phase 3 measured walking
      // through the block-count rule (rows, assertion arguments, setup). Severity
      // backed by the real-commit corpus measurement recorded in the rule's SPEC row.
      'test-content-removal': { severity: 'block' },
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
      // the watcher's transient class (modified-and-restored within a turn). WARN by
      // default: a Stop block already forces restores, and a compliant restore reads
      // as churn — block-by-default would deadlock the honest path. Harnesses that own
      // that semantics raise it via TAMPERWARD_TRANSIENT=block.
      'transient-protected-mutation': { severity: 'warn' },
      // the narrow graduation candidate: snapshot moved with NO accompanying change.
      // ~0.06% FP on 1,652 audited mainline commits, 7/7 TP on observed tampers
      // (harness/fp-study/). warn until a version: gate graduates it (BLOCK_SINCE).
      'snapshot-only-rewrite': { severity: 'warn' },
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
