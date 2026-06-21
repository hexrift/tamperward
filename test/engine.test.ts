import { describe, it, expect } from 'vitest';
import { evaluate, hasBlocking } from '../src/engine';
import { defaultPolicy } from '../src/policy';
import { parseDiff } from '../src/diff/parse';
import type { Change, Policy } from '../src/types';

describe('engine', () => {
  it('runs all detectors and reports blocking findings', () => {
    const changes: Change[] = [
      { kind: 'command', raw: 'git commit --no-verify -m wip', argv: [] },
      ...parseDiff(`diff --git a/src/x.ts b/src/x.ts
index 1..2 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,0 +1,1 @@
+const y = z as any;`),
    ];
    const findings = evaluate(changes, defaultPolicy());
    const rules = findings.map((f) => f.rule).sort();
    expect(rules).toEqual(['no-verify', 'ts-any-cast']);
    expect(hasBlocking(findings)).toBe(true);
  });

  it('respects a disabled rule in policy', () => {
    const policy: Policy = defaultPolicy();
    policy.rules['no-verify'] = { severity: 'block', enabled: false };
    const findings = evaluate([{ kind: 'command', raw: 'git commit --no-verify', argv: [] }], policy);
    expect(findings).toHaveLength(0);
  });

  it('de-duplicates identical findings', () => {
    const dup: Change[] = [
      { kind: 'command', raw: 'git commit --no-verify', argv: [] },
      { kind: 'command', raw: 'git commit --no-verify', argv: [] },
    ];
    expect(evaluate(dup, defaultPolicy())).toHaveLength(1);
  });
});
