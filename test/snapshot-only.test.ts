// snapshot-only-rewrite: the FP study's narrow signal as a distinct rule. Two things
// are load-bearing and both are tested here: the signal itself (all changed files are
// moving snapshots), and the GRANULARITY guard — the rule must stay silent on any view
// where "no accompanying change" is meaningless (a single PreToolUse edit, a turn
// sweep), because at those scopes every legitimate snapshot update looks snapshot-only.

import { describe, expect, it } from 'vitest';
import { snapshotOnlyRewrite } from '../src/detectors/snapshot-only';
import { evaluate } from '../src/engine';
import { defaultPolicy } from '../src/policy';
import { Change, FileOp, Policy, View } from '../src/types';

const file = (path: string, op: FileOp, oldPath: string | null = null): Change => ({
  kind: 'file', path, oldPath, op, before: op === 'add' ? null : 'old', after: op === 'delete' ? null : 'new', binary: false, hunks: [],
});
const cmd = (raw: string): Change => ({ kind: 'command', raw, argv: raw.split(/\s+/) });
const run = (cs: Change[], view: View | undefined, policy: Policy = defaultPolicy()) =>
  snapshotOnlyRewrite.run(cs, policy, view);

describe('the signal, at commit granularity', () => {
  it('fires when the diff is nothing but a modified snapshot', () => {
    const f = run([file('src/__snapshots__/app.test.ts.snap', 'modify')], 'staged');
    expect(f).toHaveLength(1);
    expect(f[0].rule).toBe('snapshot-only-rewrite');
    expect(f[0].severity).toBe('warn');
  });

  it('fires on the range view — the CI authority', () => {
    expect(run([file('golden/out.golden.txt', 'modify')], 'range')).toHaveLength(1);
  });

  it('fires when several snapshots move together and nothing else does', () => {
    const f = run(
      [file('a/__snapshots__/x.snap', 'modify'), file('a/__snapshots__/y.snap', 'delete')],
      'staged',
    );
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain('2 snapshot files');
  });

  it('counts a rename OUT of the snapshot glob as a moving snapshot', () => {
    expect(
      run([file('golden/out.bak', 'rename', 'golden/out.golden.txt')], 'staged'),
    ).toHaveLength(1);
  });

  it('stays quiet when a source change accompanies the snapshot — the 215/216 case', () => {
    expect(
      run([file('src/__snapshots__/app.test.ts.snap', 'modify'), file('src/app.ts', 'modify')], 'staged'),
    ).toHaveLength(0);
  });

  it('stays quiet for a brand-new snapshot, matching the broad rule', () => {
    expect(run([file('src/__snapshots__/new.test.ts.snap', 'add')], 'staged')).toHaveLength(0);
  });

  it('stays quiet on an empty diff', () => {
    expect(run([], 'staged')).toHaveLength(0);
  });
});

describe('the granularity guard', () => {
  const snapOnly = [file('src/__snapshots__/app.test.ts.snap', 'modify')];

  it('never fires at tool-call scope — a single snapshot Edit is always "only"', () => {
    expect(run(snapOnly, 'tool-call')).toHaveLength(0);
  });

  it('never fires at turn scope — a legit source+snap update can straddle turns', () => {
    expect(run(snapOnly, 'turn')).toHaveLength(0);
  });

  it('never fires on the worktree view or with no view at all', () => {
    expect(run(snapOnly, 'worktree')).toHaveLength(0);
    expect(run(snapOnly, undefined)).toHaveLength(0);
  });

  it('ignores command changes when judging "only" (they are not part of a diff)', () => {
    expect(run([cmd('git status'), ...snapOnly], 'staged')).toHaveLength(1);
  });
});

describe('through the engine', () => {
  it('is reachable via evaluate() with the staged view and dedupes against the broad rule', () => {
    const findings = evaluate(
      [file('src/__snapshots__/app.test.ts.snap', 'modify')],
      defaultPolicy(),
      undefined,
      'staged',
    );
    const rules = findings.map((f) => f.rule).sort();
    // Both the broad rule and the narrow one speak: same event, two distinct claims.
    expect(rules).toContain('snapshot-rewrite');
    expect(rules).toContain('snapshot-only-rewrite');
  });

  it('is disableable in policy without touching the broad rule', () => {
    const p = defaultPolicy();
    p.rules['snapshot-only-rewrite'] = { severity: 'warn', enabled: false };
    const findings = evaluate(
      [file('src/__snapshots__/app.test.ts.snap', 'modify')],
      p,
      undefined,
      'staged',
    );
    expect(findings.map((f) => f.rule)).toContain('snapshot-rewrite');
    expect(findings.map((f) => f.rule)).not.toContain('snapshot-only-rewrite');
  });
});
