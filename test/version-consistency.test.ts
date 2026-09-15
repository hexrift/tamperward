// The release bump touches three version fields that must never drift apart: a behaviour
// change bumps package.json (CLAUDE.md, "Releases are version-driven"), but the lockfile
// records the same version twice — at its root and at packages[""] — and both are written
// by hand-editing or an incomplete `npm install`, so a bump that forgets them ships an
// inconsistent tree. This pins all three to the same string.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(__dirname, '..', name), 'utf8'));

describe('release metadata: package.json and package-lock.json agree on the version', () => {
  const pkg = read('package.json');
  const lock = read('package-lock.json');
  const lockPackages = lock.packages as Record<string, { version?: string }>;

  it('package.json version is a valid semver string', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('package-lock root version matches package.json', () => {
    expect(lock.version).toBe(pkg.version);
  });

  it('package-lock packages[""] version matches package.json', () => {
    expect(lockPackages['']?.version).toBe(pkg.version);
  });
});
