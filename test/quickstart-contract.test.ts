// Contract check for the onboarding entry page docs/guide/quickstart.md (#529).
//
// A marketing entry page must not drift ahead of what the tool actually does, so
// this suite binds the page's load-bearing claims to PRODUCTION contracts rather
// than to hard-coded prose: the defaultPolicy severities, the exported verify
// verdict renderer, the onboard postureOf mapping, and the localVerifierShell
// platform contract. A future change to any of those fails here instead of
// silently leaving the page stale.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultPolicy } from '../src/policy';
import { postureOf } from '../src/cli/onboard';
import { verifyVerdictLine, localVerifierShell } from '../src/cli/verify';
import type { DoctorOutcome } from '../src/cli/doctor';

const page = readFileSync(join(__dirname, '..', 'docs', 'guide', 'quickstart.md'), 'utf8');
const P = defaultPolicy();

// A severity-tagged rule line inside an illustrative fence, e.g.
//   "  BLOCK  test-skip — tests/auth.test.ts"
// The trailing em dash distinguishes a real tag from prose like "`WARN` surfaces …".
function taggedRules(md: string): Array<{ verb: 'BLOCK' | 'WARN'; rule: string }> {
  return [...md.matchAll(/^\s*(BLOCK|WARN)\s+([a-z][a-z0-9-]+)\s+—/gm)].map((m) => ({
    verb: m[1] as 'BLOCK' | 'WARN',
    rule: m[2],
  }));
}

// The assertion under test, factored out so the negative regression can prove it
// throws for an unknown rule rather than silently passing.
function assertSeveritiesResolve(md: string): void {
  for (const { verb, rule } of taggedRules(md)) {
    expect(P.rules[rule], `${rule} must exist in defaultPolicy`).toBeDefined();
    expect(P.rules[rule].severity, `${rule} tagged ${verb}`).toBe(verb === 'BLOCK' ? 'block' : 'warn');
  }
}

function fences(md: string): string[] {
  return md.match(/```[\s\S]*?```/g) ?? [];
}

describe('quickstart page contract (#529)', () => {
  it('every severity-tagged rule resolves in defaultPolicy with the shown severity', () => {
    expect(taggedRules(page).length).toBeGreaterThanOrEqual(2); // test-skip (block) + assertion-weakening (warn)
    assertSeveritiesResolve(page);
  });

  it('an unknown tagged rule fails the check, and is not filtered out (negative regression)', () => {
    const bogus = '```\n  BLOCK  test-skip-typo — x/y.test.ts\n```';
    expect(taggedRules(bogus)).toEqual([{ verb: 'BLOCK', rule: 'test-skip-typo' }]);
    expect(() => assertSeveritiesResolve(bogus)).toThrow();
  });

  it('assertion-weakening is warn in policy and shown as WARN, never BLOCK', () => {
    expect(P.rules['assertion-weakening'].severity).toBe('warn');
    expect(page).toMatch(/WARN\s+assertion-weakening/);
    expect(page).not.toMatch(/BLOCK\s+assertion/i);
  });

  it('the verify transcript uses the production MASKED_FAILURE renderer, not a per-file diagnosis', () => {
    const line = verifyVerdictLine('MASKED_FAILURE', {
      restored: 1,
      base: 'deadbeefcafe',
      visibleExit: 0,
      pristineExit: 1,
      budget: 300,
    });
    for (const phrase of ['the visible suite passes, but with the', 'does not pass the original suite']) {
      expect(line, 'renderer emits the phrase').toContain(phrase);
      expect(page, `page transcript must match production phrase: ${phrase}`).toContain(phrase);
    }
    // The renderer never emits a per-file causal diagnosis, and neither may the page.
    expect(line).not.toMatch(/weakened between base and candidate/i);
    expect(page).not.toMatch(/assertion weakened between base and candidate/i);
  });

  it('failed required repository authority is INCOMPLETE in production and on the page', () => {
    const failed: DoctorOutcome = {
      code: 2,
      authoritative: false,
      checks: [],
      failure: { id: 'repository-authority', message: 'a required control is missing' },
      summary: [],
    };
    const ready: DoctorOutcome = { code: 0, authoritative: true, checks: [], summary: [] };
    expect(postureOf(failed)).toBe('INCOMPLETE');
    expect(postureOf(ready)).toBe('READY');

    const failedBlock = fences(page).find((b) => /not enforced/.test(b) && /not dismissed/.test(b));
    expect(failedBlock, 'failed-authority posture example present').toBeTruthy();
    expect(failedBlock!).toContain('INCOMPLETE');
    expect(failedBlock!, 'a block with failed required controls must not read READY').not.toMatch(/\bREADY\b/);
  });

  it('platform statements match the production localVerifierShell contract', () => {
    // Production truth: checkpointed-local verify is unsupported on Windows and
    // supported on Linux and macOS.
    expect(localVerifierShell('win32', 'npm test')).toBeNull();
    expect(localVerifierShell('linux', 'npm test')).not.toBeNull();
    expect(localVerifierShell('darwin', 'npm test')).not.toBeNull();
    expect(page).toMatch(/Windows[\s\S]{0,120}unsupported/i);
    expect(page).toMatch(/\bLinux-only\b/);
  });
});
