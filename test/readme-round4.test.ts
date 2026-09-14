import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The README's Round 4 numbers must equal the sealed record so the front page
// cannot drift from ROUND4-RESULTS.json (#310). The sealed file is read-only
// evidence here: this test never writes it and never re-derives a verdict.
const root = join(__dirname, '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const sealed = JSON.parse(
  readFileSync(join(root, 'harness/taskbench/round4/ROUND4-RESULTS.json'), 'utf8'),
) as {
  payload_sha256: string;
  primary: {
    primary_tasks: number;
    valid_pairs: number;
    b_prevention: number;
    c_induced_harm: number;
    exact_mcnemar_p_two_sided: number;
    reject_H0: boolean;
    floor_met: boolean;
    interpretation_floor_required: number;
    ungated_opportunities_a_plus_b: number;
  };
  integrity: { measured: number; strict_tamper_bypass: number };
  denominators: { primary_start: number; realized_valid_pairs: number };
};

const round4Row = readme.split('\n').find((line) => line.startsWith('| **Round 4**'));

describe('README Round 4 row matches the sealed record (#310)', () => {
  it('has a Round 4 row in "What we have actually measured"', () => {
    expect(round4Row).toBeDefined();
  });

  it('quotes the registered primary endpoint exactly as sealed', () => {
    const { primary } = sealed;
    expect(round4Row).toContain(`b=${primary.b_prevention} / c=${primary.c_induced_harm}`);
    expect(round4Row).toContain(`p = ${primary.exact_mcnemar_p_two_sided}`);
    expect(round4Row).toContain(`${primary.valid_pairs}/${primary.primary_tasks}`);
    expect(primary.valid_pairs).toBe(sealed.denominators.realized_valid_pairs);
    expect(primary.primary_tasks).toBe(sealed.denominators.primary_start);
    // The registered decision is "do not reject H0"; the README must say so and
    // must not upgrade the primary result.
    expect(primary.reject_H0).toBe(false);
    expect(round4Row).toMatch(/did not reject|not rejected|null not rejected/i);
    expect(primary.floor_met).toBe(true);
    expect(round4Row).toMatch(/interpretation floor (was )?met/i);
    expect(round4Row).toContain(`a + b = ${primary.ungated_opportunities_a_plus_b}`);
    expect(round4Row).toContain(`floor ${primary.interpretation_floor_required}`);
  });

  it('keeps the integrity observation separate and narrower than the primary claim', () => {
    const { integrity } = sealed;
    expect(integrity.strict_tamper_bypass).toBe(0);
    expect(round4Row).toContain(`${integrity.measured} measured trajectories`);
    expect(round4Row).toContain(`${integrity.strict_tamper_bypass} strict tamper bypass`);
    // The failed primary prediction comes first in the row; the zero-bypass
    // observation follows it and is labelled as a separate, narrower result.
    const primaryAt = round4Row?.indexOf('did not replicate') ?? -1;
    const integrityAt = round4Row?.indexOf('strict tamper bypass') ?? -1;
    expect(primaryAt).toBeGreaterThanOrEqual(0);
    expect(integrityAt).toBeGreaterThan(primaryAt);
    expect(round4Row).toMatch(/separate|narrower/i);
  });

  it('links the sealed analysis, the sealed results, and the attrition caveat', () => {
    expect(round4Row).toContain('./harness/taskbench/round4/ROUND4-ANALYSIS.md');
    expect(readme).toContain('./harness/taskbench/round4/ROUND4-RESULTS.json');
    expect(readme).toContain(sealed.payload_sha256.slice(0, 8));
    // Attrition (79 of 110 pairs) is a linked caveat, not a hidden one.
    expect(readme).toMatch(/attrition[\s\S]{0,400}selection bias|selection bias[\s\S]{0,400}attrition/i);
  });

  it('pairs the before and after Round 4 articles and drops the future-tense wording', () => {
    expect(readme).toContain('./docs/blog/how-round-4-is-built-to-be-hard-to-fool.md');
    expect(readme).toContain('./docs/blog/the-prevention-bet-didnt-replicate-no-surviving-tampering-was-certified-clean.md');
    expect(readme).not.toMatch(/not yet run/i);
    expect(readme).not.toMatch(/registered and frozen, not yet/i);
  });
});
