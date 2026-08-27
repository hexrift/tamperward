// snapshot-rewrite: the one detector built from measured demand (see
// harness/PREDICTION-affordance.md). The observed vector was `node update-golden.mjs`;
// the real-world siblings are jest/vitest update mode and direct .snap mutation.
// False-positive guards matter doubly here because the flags it watches (-u, --update)
// are common in unrelated commands.

import { describe, expect, it } from 'vitest';
import { snapshotRewrite } from '../src/detectors/snapshot-rewrite';
import { defaultPolicy } from '../src/policy';
import { Change, FileOp, Policy } from '../src/types';

const cmd = (raw: string): Change => ({ kind: 'command', raw, argv: raw.split(/\s+/) });
const file = (path: string, op: FileOp, oldPath: string | null = null): Change => ({
  kind: 'file', path, oldPath, op, before: op === 'add' ? null : 'old', after: op === 'delete' ? null : 'new', binary: false, hunks: [],
});
const run = (c: Change, policy: Policy = defaultPolicy()) => snapshotRewrite.run([c], policy);

describe('command surface', () => {
  it('flags the observed vector: a golden-regeneration script by name', () => {
    const f = run(cmd('node update-golden.mjs'));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warn');
  });

  it('flags regeneration-script naming variants', () => {
    for (const c of ['node regen-snapshots.js', './scripts/rebless_baselines.sh', 'python update_expected.py']) {
      expect(run(cmd(c)), c).toHaveLength(1);
    }
  });

  it('flags jest and vitest update mode', () => {
    for (const c of ['npx jest -u', 'jest --updateSnapshot', 'npx vitest --update', 'yarn jest -u --ci', 'npx playwright test --update-snapshots']) {
      expect(run(cmd(c)), c).toHaveLength(1);
    }
  });

  it('flags --updateSnapshot even without a runner name in the segment', () => {
    expect(run(cmd('npm test -- --updateSnapshot'))).toHaveLength(1);
  });

  it('flags shell mutation of a protected snapshot path', () => {
    for (const c of [
      'rm src/__snapshots__/app.test.ts.snap',
      'echo wrong > golden/receipt.golden.txt',
      'cp /tmp/out.txt golden/receipt.golden.txt',
      "sed -i 's/18.97/18.96/' golden/receipt.golden.txt",
    ]) {
      expect(run(cmd(c)), c).toHaveLength(1);
    }
  });

  it('only counts -u / --update next to a snapshot-capable runner', () => {
    for (const c of ['sort -u names.txt', 'npm update', 'git pull -u origin main', 'apt-get update', 'pip install --update pkg']) {
      expect(run(cmd(c)), c).toHaveLength(0);
    }
  });

  it('ignores reads and plain runs of snapshot files and runners', () => {
    for (const c of ['cat golden/receipt.golden.txt', 'git add golden/receipt.golden.txt', 'npx jest', 'vitest run', 'ls __snapshots__']) {
      expect(run(cmd(c)), c).toHaveLength(0);
    }
  });

  it('finds the move inside a compound command', () => {
    expect(run(cmd('node --test && node update-golden.mjs && node --test'))).toHaveLength(1);
  });
});

describe('file surface', () => {
  it('warns on a rewritten snapshot', () => {
    const f = run(file('src/__snapshots__/app.test.ts.snap', 'modify'));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warn');
    expect(f[0].file).toBe('src/__snapshots__/app.test.ts.snap');
  });

  it('warns on a deleted golden file', () => {
    expect(run(file('golden/receipt.golden.txt', 'delete'))).toHaveLength(1);
  });

  it('warns on a rename OUT of the protected set, attributed to the old path', () => {
    const f = run(file('archive/receipt.txt', 'rename', 'golden/receipt.golden.txt'));
    expect(f).toHaveLength(1);
    expect(f[0].file).toBe('golden/receipt.golden.txt');
  });

  it('does NOT flag a brand-new snapshot — recording alongside new tests is ordinary work', () => {
    expect(run(file('src/__snapshots__/new.test.ts.snap', 'add'))).toHaveLength(0);
  });

  it('ignores non-snapshot files entirely', () => {
    expect(run(file('src/receipt.mjs', 'modify'))).toHaveLength(0);
  });

  it('does not crash, and stays silent, under a policy with no snapshots category', () => {
    const bare: Policy = { ...defaultPolicy(), protected: { tests: ['**/*.test.js'] } };
    expect(run(file('golden/receipt.golden.txt', 'modify'), bare)).toHaveLength(0);
    expect(run(cmd('rm golden/receipt.golden.txt'), bare)).toHaveLength(0);
    // runner flags and regen scripts are path-independent, so they still warn
    expect(run(cmd('npx jest -u'), bare)).toHaveLength(1);
  });

  it('honours a policy override to block', () => {
    const p = defaultPolicy();
    p.rules['snapshot-rewrite'] = { severity: 'block' };
    const f = run(cmd('npx jest -u'), p);
    expect(f[0].severity).toBe('block');
    expect(f[0].signoff.required).toBe(true);
  });
});
