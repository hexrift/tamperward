// Policy helpers: deterministic glob matching of the protected assets, plus the
// baseline policy `npx holdfast init` would write. Detectors ask "is this path a
// test / config / ci / hook?" through here so the globs live in exactly one place.

import picomatch from 'picomatch';
import { Policy } from './types';

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

/** Whether a file path is excluded from file-surface detection by policy.ignore. */
export function isIgnored(path: string, policy: Policy): boolean {
  return matchesAny(path, policy.ignore);
}

/** The baseline policy — mirrors the committed .holdfast.yml. */
export function defaultPolicy(): Policy {
  return {
    version: 1,
    protected: {
      tests: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**'],
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
      'ts-any-cast': { severity: 'block' },
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
