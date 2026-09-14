// #434: a policy edit could DEMOTE the spec rules without a finding by growing a
// category whose membership lowers them (`protected.snapshots`), and a negated glob
// (`!x`) compiled to "every path" — every source file became a test file, so the
// cast rules went quiet. Both are judged here as what they are: the loader refuses
// negated globs outright, and policy-diff compares the RULES' REACH over a probe
// listing before and after, not only the glob lists.
import { describe, it, expect } from 'vitest';
import { parsePolicy, PolicyError } from '../src/policy-load';
import { policyAddWeakening, policyWeakening } from '../src/detectors/policy-diff';
import { defaultPolicy, isProtected } from '../src/policy';
import { parseDiff } from '../src/diff/parse';
import { evaluate } from '../src/engine';
import type { Change } from '../src/types';

const V1 = 'version: 1\n';

describe('#434 loader: negated globs fail closed', () => {
  it.each(['tests', 'snapshots', 'config', 'ci', 'hooks', 'custom'])('refuses a "!" glob in protected.%s', (cat) => {
    const raw = { protected: { [cat]: ['!zzz'] } };
    expect(() => parsePolicy(raw)).toThrow(PolicyError);
    expect(() => parsePolicy(raw)).toThrow(new RegExp(`protected\\.${cat}: negated glob "!zzz"`));
    expect(() => parsePolicy(raw)).toThrow(/matches every path/);
  });

  it('refuses a "!" glob in ignore and in a per-rule exclude', () => {
    expect(() => parsePolicy({ ignore: ['!keep.ts'] })).toThrow(/ignore: negated glob "!keep\.ts" .*matches every path/);
    expect(() => parsePolicy({ rules: { 'ts-any-cast': { exclude: ['!x'] } } })).toThrow(/rules\.ts-any-cast\.exclude: negated glob "!x"/);
  });

  it('a leading slash does not hide the negation', () => {
    expect(() => parsePolicy({ protected: { tests: ['/!zzz'] } })).toThrow(/negated glob/);
  });

  it('control: ordinary globs still load and a `!` inside a glob is not a negation', () => {
    const p = parsePolicy({ protected: { tests: ['packages/new/**/*.integration.ts', 'weird/[!a]*.ts'] }, ignore: ['vendor/**'] });
    expect(isProtected('packages/new/x/y.integration.ts', p, 'tests')).toBe(true);
    expect(isProtected('src/index.ts', p, 'tests')).toBe(false);
  });
});

describe('#434 policy-diff: the two fixtures from the issue block as weakening', () => {
  it('a glob added to protected.snapshots demotes the spec rules and is reported', () => {
    const reasons = policyWeakening(V1, "version: 1\nprotected:\n  snapshots: ['**/*.test.ts']\n") ?? [];
    expect(reasons.some((r) => /protected\.snapshots widened \(added \*\*\/\*\.test\.ts\)/.test(r))).toBe(true);
    // the reach comparison names the rule and a path it no longer judges
    expect(reasons.some((r) => /rule "test-deletion" no longer reaches .*src\/a\.test\.ts/.test(r))).toBe(true);
    expect(reasons.some((r) => /rule "test-content-removal" no longer reaches/.test(r))).toBe(true);
  });

  it('a negated glob added to protected.tests makes every file a test and is reported', () => {
    const reasons = policyWeakening(V1, "version: 1\nprotected:\n  tests: ['!zzz']\n") ?? [];
    expect(reasons.some((r) => /protected\.tests gained a negated glob \(!zzz\) — a "!" pattern matches every path/.test(r))).toBe(true);
    expect(reasons.some((r) => /rule "ts-any-cast" no longer reaches .*src\/index\.ts/.test(r))).toBe(true);
    expect(reasons.some((r) => /rule "ts-cast-growth" no longer reaches/.test(r))).toBe(true);
  });

  it('a negated glob in any other protected category is reported too', () => {
    for (const cat of ['config', 'ci', 'hooks', 'snapshots']) {
      const reasons = policyWeakening(V1, `version: 1\nprotected:\n  ${cat}: ['!nothing']\n`) ?? [];
      expect(reasons.some((r) => new RegExp(`protected\\.${cat} gained a negated glob`).test(r)), cat).toBe(true);
    }
  });

  it('a tests glob that also matches snapshot paths is reported', () => {
    const reasons = policyWeakening(V1, "version: 1\nprotected:\n  tests: ['**/__snapshots__/**']\n") ?? [];
    expect(reasons.some((r) => /protected\.tests gained a glob that also matches snapshot paths \(\*\*\/__snapshots__\/\*\*\)/.test(r))).toBe(true);
  });

  it('the reach comparison uses the repository listing when one is given', () => {
    const probe = ['packages/core/src/index.ts', 'packages/core/test/index.test.ts', 'README.md'];
    const reasons = policyWeakening(V1, "version: 1\nprotected:\n  snapshots: ['packages/**/*.test.ts']\n", probe) ?? [];
    expect(reasons.some((r) => /rule "test-deletion" no longer reaches packages\/core\/test\/index\.test\.ts/.test(r))).toBe(true);
    // the negation fixture, named by a real source path
    const neg = policyWeakening(V1, "version: 1\nprotected:\n  tests: ['!zzz']\n", probe) ?? [];
    expect(neg.some((r) => /rule "ts-any-cast" no longer reaches packages\/core\/src\/index\.ts/.test(r))).toBe(true);
  });

  it('an ADDED policy file is compared to the baseline the same way', () => {
    const reasons = policyAddWeakening("protected:\n  snapshots: ['**/*.test.ts']\n");
    expect(reasons.some((r) => /protected\.snapshots widened/.test(r))).toBe(true);
  });

  it('the reach comparison itself is enough: a category the glob lists do not name', () => {
    // A rename of a probe out of reach through TWO honest-looking edits at once:
    // tests grows (fine on its own) while snapshots grows over the same paths.
    const reasons = policyWeakening(
      "version: 1\nprotected:\n  tests: ['e2e/**/*.ts']\n",
      "version: 1\nprotected:\n  tests: ['e2e/**/*.ts']\n  snapshots: ['e2e/**']\n",
      ['e2e/login.ts', 'src/a.ts'],
    ) ?? [];
    expect(reasons.some((r) => /rule "test-deletion" no longer reaches e2e\/login\.ts/.test(r))).toBe(true);
  });
});

describe('#434 precision: legitimate policy edits stay clean', () => {
  it('a new tests glob for a new package is not a weakening', () => {
    expect(policyWeakening(V1, "version: 1\nprotected:\n  tests: ['packages/new/**/*.integration.ts']\n")).toEqual([]);
    expect(policyWeakening(V1, "version: 1\nprotected:\n  tests: ['packages/new/**/*.integration.ts']\n", ['packages/new/src/a.ts', 'packages/new/a.integration.ts'])).toEqual([]);
  });

  it('a tests glob naming a real layout cedes those files to the test rules by design, but a glob that swallows source does not', () => {
    // packages/new/a.ts is now a test file: casts there warn instead of block — the documented trade-off, not a weakening
    expect(policyWeakening(V1, "version: 1\nprotected:\n  tests: ['packages/new/**/*.ts']\n", ['packages/new/a.ts', 'src/index.ts'])).toEqual([]);
    // `**/*.ts` takes src/index.ts with it: every TypeScript file is a test file and the cast rules go quiet
    const broad = policyWeakening(V1, "version: 1\nprotected:\n  tests: ['**/*.ts']\n", ['packages/new/a.ts', 'src/index.ts']) ?? [];
    expect(broad.some((r) => /rule "ts-any-cast" no longer reaches packages\/new\/a\.ts, src\/index\.ts/.test(r))).toBe(true);
  });

  it('widening config, ci or hooks is not a weakening', () => {
    expect(policyWeakening(V1, "version: 1\nprotected:\n  config: ['**/karma.conf.*']\n  ci: ['.gitlab-ci.yml']\n  hooks: ['scripts/git-hooks/**']\n")).toEqual([]);
  });

  it('restating the baseline and an unchanged file are not weakenings', () => {
    const p = defaultPolicy();
    const restated = `version: 1\nprotected:\n  snapshots: [${p.protected.snapshots.map((g) => `'${g}'`).join(', ')}]\n`;
    expect(policyWeakening(V1, restated)).toEqual([]);
    expect(policyWeakening(restated, restated)).toEqual([]);
  });

  it('a new spec-shaped tests glob that happens to cover a snapshot-named file is reported ONLY for that overlap', () => {
    const reasons = policyWeakening(V1, "version: 1\nprotected:\n  tests: ['golden/**/*.test.ts']\n") ?? [];
    expect(reasons.every((r) => /also matches snapshot paths/.test(r))).toBe(true);
  });
});

describe('#434 the exclusion cannot be weaponised by the edit that adds the glob', () => {
  const policyEdit: Change = {
    kind: 'file',
    path: '.tamperward.yml',
    oldPath: null,
    op: 'modify',
    before: V1,
    after: "version: 1\nprotected:\n  snapshots: ['**/*.test.ts']\n",
    binary: false,
    hunks: [],
  };
  const deletion = parseDiff(`diff --git a/src/a.test.ts b/src/a.test.ts
deleted file mode 100644
index 1..0
--- a/src/a.test.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-it('x', () => {});`);

  it('the deletion is judged under the BEFORE policy and the policy edit is blocked beside it', () => {
    const findings = evaluate([policyEdit, ...deletion], defaultPolicy());
    expect(findings.some((f) => f.rule === 'test-deletion' && f.severity === 'block')).toBe(true);
    const tamper = findings.filter((f) => f.rule === 'hook-tampering' && f.file === '.tamperward.yml');
    expect(tamper.length).toBeGreaterThan(0);
    expect(tamper.every((f) => f.severity === 'block')).toBe(true);
    expect(tamper.some((f) => /protected\.snapshots widened/.test(f.message))).toBe(true);
  });

  it('control: under the AFTER policy the deletion would have degraded to snapshot-rewrite — which is why the edit must block', () => {
    const after = parsePolicy({ protected: { snapshots: ['**/*.test.ts'] } });
    const findings = evaluate(deletion, after);
    expect(findings.some((f) => f.rule === 'test-deletion')).toBe(false);
  });
});
