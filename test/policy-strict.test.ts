// The loader and the policy-diff detector agree on what a policy MEANS, and both
// fail closed on what they cannot understand:
//   D-8   an `exclude`-only override keeps the baseline severity (field merge)
//   D-11a unknown top-level keys are refused, not silently ignored
//   D-11b a leading `/` on a glob is normalised away, so `/e2e/**` protects e2e/
//   D-7   the ledger must stay inside the repository; moving it is a weakening

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy, parsePolicy, PolicyError, ledgerInsideRepo } from '../src/policy-load';
import { policyWeakening } from '../src/detectors/policy-diff';
import { defaultPolicy, isIgnored, isProtected, mergeRules, normalizeGlob } from '../src/policy';
import { ledgerPath } from '../src/signoff';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function policyFile(yaml: string): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-strict-'));
  dirs.push(d);
  writeFileSync(join(d, '.tamperward.yml'), yaml);
  return d;
}

describe('D-8: an override names only the fields it changes', () => {
  it('parsePolicy keeps the baseline severity under an exclude-only override', () => {
    const p = parsePolicy({ rules: { 'test-deletion': { exclude: ['**'] } as never } });
    expect(p.rules['test-deletion'].severity).toBe('block');
    expect(p.rules['test-deletion'].exclude).toEqual(['**']);
  });

  it('parsePolicy keeps the baseline severity under an enabled-only override', () => {
    const p = parsePolicy({ rules: { 'ts-any-cast': { enabled: false } as never } });
    expect(p.rules['ts-any-cast'].severity).toBe('block');
    expect(p.rules['ts-any-cast'].enabled).toBe(false);
  });

  it('an explicit severity still wins in either direction (control)', () => {
    expect(parsePolicy({ rules: { 'test-deletion': { severity: 'warn' } } }).rules['test-deletion'].severity).toBe('warn');
    expect(parsePolicy({ rules: { 'snapshot-rewrite': { severity: 'block' } } }).rules['snapshot-rewrite'].severity).toBe('block');
  });

  it('mergeRules keeps an unknown rule name as written', () => {
    const merged = mergeRules(defaultPolicy().rules, { 'future-rule': { severity: 'warn' } });
    expect(merged['future-rule']).toEqual({ severity: 'warn' });
  });

  it('policy-diff reports exactly one finding for an added exclude — the exclude itself', () => {
    const reasons = policyWeakening('version: 1\n', "version: 1\nrules:\n  test-deletion: { exclude: ['**'] }\n") ?? [];
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/exclude globs added \(\*\*\)/);
    expect(reasons[0]).not.toMatch(/lowered/);
  });

  it('policy-diff still reports a real lowering (control)', () => {
    const reasons = policyWeakening('version: 1\n', 'version: 1\nrules:\n  test-deletion: { severity: warn }\n') ?? [];
    expect(reasons.some((r) => /"test-deletion" lowered block → warn/.test(r))).toBe(true);
  });
});

describe('D-11a: unknown top-level keys fail closed', () => {
  it.each(['Rules', 'ignored', 'protect', 'exclude'])('refuses "%s:"', (key) => {
    expect(() => parsePolicy({ [key]: {} } as never)).toThrow(PolicyError);
    expect(() => parsePolicy({ [key]: {} } as never)).toThrow(new RegExp(`unknown top-level key "${key}"`));
  });

  it('names every unknown key and the accepted vocabulary', () => {
    expect(() => parsePolicy({ Rules: {}, ignored: [] } as never)).toThrow(/keys "Rules", "ignored" \(expected one of version, protected, rules, ignore, signoff, verify\)/);
  });

  it('loadPolicy throws the same PolicyError for a file with a mistyped key', () => {
    const d = policyFile('version: 1\nRules:\n  test-deletion: { severity: warn }\n');
    expect(() => loadPolicy(d)).toThrow(PolicyError);
  });

  it('still accepts every known key and unknown RULE names (control)', () => {
    const p = parsePolicy({
      version: 1,
      protected: { tests: ['e2e/**'] },
      rules: { 'future-rule': { severity: 'block' } },
      ignore: ['docs/**'],
      signoff: { required_for: ['block'], ledger: '.tamperward/ledger.jsonl' },
      verify: { command: 'npm test' },
    });
    expect(p.rules['future-rule'].severity).toBe('block');
  });

  it("this repository's own policy still loads", () => {
    expect(() => loadPolicy(join(__dirname, '..'))).not.toThrow();
  });
});

describe('D-11b: a leading slash on a glob is normalised away', () => {
  it('normalizeGlob strips only a leading slash', () => {
    expect(normalizeGlob('/e2e/**')).toBe('e2e/**');
    expect(normalizeGlob('e2e/**')).toBe('e2e/**');
    expect(normalizeGlob('**/x/*.ts')).toBe('**/x/*.ts');
  });

  it('a protected glob written /e2e/** now protects e2e/', () => {
    const p = parsePolicy({ protected: { tests: ['/e2e/**'] } });
    expect(p.protected.tests).toContain('e2e/**');
    expect(isProtected('e2e/login.spec.js', p, 'tests')).toBe(true);
    // control: the same path under a baseline policy is not a protected test
    expect(isProtected('e2e/login.js', defaultPolicy(), 'tests')).toBe(false);
  });

  it('an ignore glob and a per-rule exclude glob are normalised the same way', () => {
    const p = parsePolicy({ ignore: ['/docs/**'], rules: { 'ts-any-cast': { severity: 'block', exclude: ['/gen/**'] } } });
    expect(isIgnored('docs/a.md', p)).toBe(true);
    expect(p.rules['ts-any-cast'].exclude).toEqual(['gen/**']);
  });

  it('policy-diff compares the normalised spelling, so /e2e/** → e2e/** is not a narrowing', () => {
    const before = "protected:\n  tests: ['/e2e/**']\n";
    const after = "protected:\n  tests: ['e2e/**']\n";
    expect(policyWeakening(before, after)).toEqual([]);
    // control: actually dropping the glob still reads as a narrowing
    expect(policyWeakening(before, 'version: 1\n')?.some((r) => /protected\.tests narrowed \(removed e2e\/\*\*\)/.test(r))).toBe(true);
  });
});

describe('D-7: the sign-off ledger stays inside the repository', () => {
  it.each(['../../x.jsonl', '../ledger.jsonl', '/tmp/ledger.jsonl', 'a/../../b.jsonl', ''])('ledgerInsideRepo rejects %j', (p) => {
    expect(ledgerInsideRepo(p)).toBe(false);
  });
  it.each(['.tamperward/ledger.jsonl', 'ledger.jsonl', 'a/../b.jsonl', './x.jsonl'])('ledgerInsideRepo accepts %j', (p) => {
    expect(ledgerInsideRepo(p)).toBe(true);
  });

  it('the loader refuses an escaping ledger path (exit-2 path)', () => {
    expect(() => parsePolicy({ signoff: { ledger: '../../x.jsonl' } })).toThrow(PolicyError);
    expect(() => parsePolicy({ signoff: { ledger: '/etc/ledger.jsonl' } })).toThrow(/signoff\.ledger must be a relative path inside the repository/);
    expect(parsePolicy({ signoff: { ledger: 'audit/ledger.jsonl' } }).signoff.ledger).toBe('audit/ledger.jsonl');
  });

  it('ledgerPath fails closed on a Policy built without the loader', () => {
    const p = { ...defaultPolicy(), signoff: { requiredFor: ['block' as const], ledger: '../../x.jsonl' } };
    expect(() => ledgerPath('/repo', p)).toThrow(PolicyError);
    expect(ledgerPath('/repo', defaultPolicy())).toBe(join('/repo', '.tamperward/ledger.jsonl'));
  });

  it('policy-diff reports a moved ledger as a weakening', () => {
    const reasons = policyWeakening('version: 1\n', 'version: 1\nsignoff: { ledger: ../../x.jsonl }\n') ?? [];
    expect(reasons.some((r) => /sign-off ledger moved \(\.tamperward\/ledger\.jsonl → \.\.\/\.\.\/x\.jsonl\)/.test(r))).toBe(true);
    // a move within the repo is still a move — the local layer trusts a different file
    expect(policyWeakening('version: 1\n', 'signoff: { ledger: audit.jsonl }\n')?.some((r) => /ledger moved/.test(r))).toBe(true);
    // control: an unchanged ledger, spelled out or inherited, is not reported
    expect(policyWeakening('version: 1\n', 'signoff: { ledger: .tamperward/ledger.jsonl }\n')).toEqual([]);
  });
});
