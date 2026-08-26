// Policy helpers: deterministic glob matching of the protected assets, plus the
// baseline policy `npx holdfast init` would write. Detectors ask "is this path a
// test / config / ci / hook?" through here so the globs live in exactly one place.

import picomatch from 'picomatch';
import { Policy } from './types';

export const POLICY_FILE = '.holdfast.yml';

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

/** The baseline policy — mirrors the committed .holdfast.yml. */
export function defaultPolicy(): Policy {
  return {
    version: 1,
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
      hooks: ['.husky/**', '**/lefthook.*', '.holdfast.yml', '**/.holdfast.yml'],
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
      // heuristic — warn until precision is measured (SPEC §7)
      'assertion-weakening': { severity: 'warn' },
      'guard-removal': { severity: 'warn' },
    },
    ignore: [],
    signoff: { requiredFor: ['block'], ledger: '.holdfast/ledger.jsonl' },
  };
}
