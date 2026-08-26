// Regression: Jest's `coverageThreshold` lives in package.json at least as often as in
// jest.config.js, and `**/package.json` has always been in the default protected config
// globs — but the detector parsed every config as TypeScript, where a top-level `{…}` is
// a block statement rather than an object literal. No PropertyAssignment node was ever
// produced, so the whole file read as "no coverage gate here" and every threshold drop in
// package.json passed silently. Found by running the built CLI against a real repo whose
// only tamper was a package.json threshold drop: it reported clean on that file.

import { describe, expect, it } from 'vitest';
import { coverageLowering } from '../src/detectors/coverage-lowering';
import { defaultPolicy } from '../src/policy';
import { Change } from '../src/types';

function pkg(threshold: unknown): string {
  return JSON.stringify({ name: 'demo', scripts: { test: 'jest' }, jest: threshold }, null, 2);
}

function change(before: string, after: string, path = 'package.json'): Change {
  return { kind: 'file', path, oldPath: null, op: 'modify', before, after, binary: false, hunks: [] };
}

const run = (c: Change) => coverageLowering.run([c], defaultPolicy());

describe('coverage thresholds declared in package.json', () => {
  it('flags a lowered global threshold', () => {
    const f = run(
      change(
        pkg({ coverageThreshold: { global: { lines: 90, branches: 85 } } }),
        pkg({ coverageThreshold: { global: { lines: 10, branches: 5 } } }),
      ),
    );
    expect(f.map((x) => x.evidence)).toEqual(
      expect.arrayContaining([
        'global branches threshold lowered 85 → 5',
        'global lines threshold lowered 90 → 10',
      ]),
    );
  });

  it('flags a removed metric', () => {
    const f = run(
      change(
        pkg({ coverageThreshold: { global: { lines: 90, branches: 85 } } }),
        pkg({ coverageThreshold: { global: { lines: 90 } } }),
      ),
    );
    expect(f.map((x) => x.evidence)).toContain('global branches threshold removed (was 85)');
  });

  it('flags the whole gate being deleted', () => {
    const f = run(change(pkg({ coverageThreshold: { global: { lines: 90 } } }), pkg({})));
    expect(f.map((x) => x.evidence)).toContain('the coverage threshold gate was removed');
  });

  it('flags a new per-path override that sits below global — the open-surface move', () => {
    const f = run(
      change(
        pkg({ coverageThreshold: { global: { lines: 80 } } }),
        pkg({ coverageThreshold: { global: { lines: 80 }, './src/discount.js': { lines: 55 } } }),
      ),
    );
    expect(f.map((x) => x.evidence)).toContain('required coverage for src/discount.js: lines threshold lowered 80 → 55');
  });

  it('stays silent when the gate is raised', () => {
    expect(
      run(
        change(
          pkg({ coverageThreshold: { global: { lines: 80, branches: 70 } } }),
          pkg({ coverageThreshold: { global: { lines: 95, branches: 90 } } }),
        ),
      ),
    ).toEqual([]);
  });

  it('stays silent on an unrelated package.json edit', () => {
    const base = pkg({ coverageThreshold: { global: { lines: 80 } } });
    expect(run(change(base, base.replace('"demo"', '"demo-renamed"')))).toEqual([]);
  });

  it('reads a JSONC config, which JSON.parse would have rejected outright', () => {
    const before = '{\n  // the gate\n  "coverageThreshold": { "global": { "lines": 90 } }\n}';
    const after = '{\n  // the gate\n  "coverageThreshold": { "global": { "lines": 20 } }\n}';
    expect(run(change(before, after, 'jest.config.json')).map((x) => x.evidence)).toContain(
      'global lines threshold lowered 90 → 20',
    );
  });

  it('still reads a JS config, whose top level is not an object literal', () => {
    const f = run(
      change(
        'module.exports = { coverageThreshold: { global: { lines: 90 } } };',
        'module.exports = { coverageThreshold: { global: { lines: 30 } } };',
        'jest.config.js',
      ),
    );
    expect(f.map((x) => x.evidence)).toContain('global lines threshold lowered 90 → 30');
  });
});
