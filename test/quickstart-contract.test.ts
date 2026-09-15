// Contract check for the onboarding entry page docs/guide/quickstart.md (#529).
//
// The quickstart presents concrete, threat-first examples of TamperWard's output.
// A marketing entry page must not drift ahead of what the tool actually does, so
// this suite re-derives the load-bearing facts from the source of truth and fails
// if the page oversells:
//
//   - every rule the page tags BLOCK/WARN must carry that severity in defaultPolicy;
//   - the heuristic assertion-weakening signal is warn, never shown as a block;
//   - `verify` reports a suite-level verdict, not a per-file causal diagnosis;
//   - missing required repository authority is INCOMPLETE, not a healthy posture;
//   - the Windows checkpointed-local verify limitation is stated.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultPolicy } from '../src/policy';

const page = readFileSync(join(__dirname, '..', 'docs', 'guide', 'quickstart.md'), 'utf8');
const P = defaultPolicy();

function fencedBlocks(md: string): string[] {
  return md.match(/```[\s\S]*?```/g) ?? [];
}

describe('quickstart page contract (#529)', () => {
  it('tags every named rule with its actual default severity', () => {
    const tokens = [...page.matchAll(/\b(BLOCK|WARN)\s+([a-z][a-z0-9-]+)/g)];
    // At least the test-skip (block) and assertion-weakening (warn) examples.
    const named = tokens.filter(([, , rule]) => P.rules[rule]);
    expect(named.length).toBeGreaterThanOrEqual(2);
    for (const [, verb, rule] of named) {
      const want = verb === 'BLOCK' ? 'block' : 'warn';
      expect(P.rules[rule].severity, `${rule} shown as ${verb}`).toBe(want);
    }
  });

  it('shows assertion-weakening as WARN, never BLOCK (it is warn by default)', () => {
    expect(P.rules['assertion-weakening'].severity).toBe('warn');
    expect(page).not.toMatch(/BLOCK\s+assertion/i);
    expect(page).toMatch(/WARN\s+assertion-weakening/);
  });

  it('does not claim a per-file causal diagnosis that verify cannot make', () => {
    expect(page).not.toMatch(/assertion weakened between base and candidate/i);
  });

  it('resolves the failed-authority posture to INCOMPLETE, not a healthy state', () => {
    const block = fencedBlocks(page).find((b) => /not enforced/.test(b) && /not dismissed/.test(b));
    expect(block, 'failed-authority posture example present').toBeTruthy();
    expect(block!).toMatch(/INCOMPLETE/);
    // A block whose required controls failed must not carry a READY verdict.
    expect(block!).not.toMatch(/\bREADY\b/);
  });

  it('states the Windows checkpointed-local verify limitation', () => {
    expect(page).toMatch(/Windows[\s\S]{0,120}unsupported/i);
  });
});
