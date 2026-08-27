// The version: opt-in mechanism (CONTRIBUTING, "Versioning"). The contract under test:
// a rule graduation gated at version N blocks only for policies declaring version >= N,
// stays warn below, and an explicit user-written severity always wins in either
// direction. This is what lets a graduation ship in a MINOR without turning anyone's
// green build red. No gate exists in the shipped table yet, so these tests inject one —
// simulating exactly what graduating snapshot-rewrite will look like.

import { afterEach, describe, expect, it } from 'vitest';
import { applyVersionGates, BLOCK_SINCE, defaultPolicy } from '../src/policy';
import { parsePolicy, PolicyError } from '../src/policy-load';
import { policyWeakening } from '../src/detectors/policy-diff';

afterEach(() => {
  for (const k of Object.keys(BLOCK_SINCE)) delete BLOCK_SINCE[k];
});

describe('applyVersionGates', () => {
  const rules = { a: { severity: 'block' as const }, b: { severity: 'block' as const } };

  it('downgrades a gated rule below its version and leaves it at or above', () => {
    expect(applyVersionGates(rules, 1, { a: 2 }).a.severity).toBe('warn');
    expect(applyVersionGates(rules, 2, { a: 2 }).a.severity).toBe('block');
    expect(applyVersionGates(rules, 3, { a: 2 }).a.severity).toBe('block');
  });

  it('touches only gated rules, and never mutates its input', () => {
    const out = applyVersionGates(rules, 1, { a: 2 });
    expect(out.b.severity).toBe('block');
    expect(rules.a.severity).toBe('block');
  });

  it('a gate on a warn or absent rule is a no-op', () => {
    const warnRules = { w: { severity: 'warn' as const } };
    expect(applyVersionGates(warnRules, 1, { w: 2 }).w.severity).toBe('warn');
    expect(applyVersionGates(warnRules, 1, { missing: 2 })).toEqual(warnRules);
  });
});

describe('version parsing', () => {
  it('missing version means 1 — nobody is opted in to anything they did not write', () => {
    expect(parsePolicy({}).version).toBe(1);
    expect(parsePolicy(undefined).version).toBe(1);
  });

  it('stores a declared version', () => {
    expect(parsePolicy({ version: 3 }).version).toBe(3);
  });

  it('fails CLOSED on a version that cannot be understood', () => {
    for (const bad of [0, -1, 1.5, 'two', true, [1]]) {
      expect(() => parsePolicy({ version: bad as never }), JSON.stringify(bad)).toThrow(PolicyError);
    }
  });

  it('accepts a version newer than this build knows — it passes every known gate', () => {
    expect(parsePolicy({ version: 99 }).version).toBe(99);
  });
});

describe('a simulated future graduation (what shipping snapshot-rewrite@block will do)', () => {
  it('blocks for opted-in policies, warns for everyone else, explicit severity wins', () => {
    BLOCK_SINCE['ci-tampering'] = 2;

    // not opted in (no version, or version 1): the graduated rule stays warn
    expect(parsePolicy({}).rules['ci-tampering'].severity).toBe('warn');
    expect(parsePolicy({ version: 1 }).rules['ci-tampering'].severity).toBe('warn');

    // opted in: block
    expect(parsePolicy({ version: 2 }).rules['ci-tampering'].severity).toBe('block');

    // an explicit user severity wins in BOTH directions, whatever the version says
    expect(
      parsePolicy({ version: 1, rules: { 'ci-tampering': { severity: 'block' } } }).rules['ci-tampering'].severity,
    ).toBe('block');
    expect(
      parsePolicy({ version: 2, rules: { 'ci-tampering': { severity: 'warn' } } }).rules['ci-tampering'].severity,
    ).toBe('warn');
  });

  it('defaultPolicy (no policy file) stays at version 1 — a graduation cannot flip it', () => {
    BLOCK_SINCE['ci-tampering'] = 2;
    expect(defaultPolicy().rules['ci-tampering'].severity).toBe('warn');
    expect(defaultPolicy(2).rules['ci-tampering'].severity).toBe('block');
  });
});

describe('policy-diff sees version moves', () => {
  it('flags a version lowering even with no gate shipped', () => {
    const reasons = policyWeakening('version: 2\n', 'version: 1\n');
    expect(reasons?.some((r) => /version lowered 2 → 1/.test(r))).toBe(true);
  });

  it('reports the CONCRETE rule downgrade a lowering causes once a gate exists', () => {
    BLOCK_SINCE['ci-tampering'] = 2;
    const reasons = policyWeakening('version: 2\n', 'version: 1\n');
    expect(reasons?.some((r) => /"ci-tampering" lowered block → warn/.test(r))).toBe(true);
  });

  it('raising the version is a strengthening, not a finding', () => {
    expect(policyWeakening('version: 1\n', 'version: 2\n')).toEqual([]);
  });

  it('reads a malformed version as 1 rather than crashing the gate', () => {
    const reasons = policyWeakening('version: 2\n', 'version: banana\n');
    expect(reasons?.some((r) => /version lowered 2 → 1/.test(r))).toBe(true);
  });
});
