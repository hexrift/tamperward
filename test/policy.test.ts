import { describe, it, expect } from 'vitest';
import { defaultPolicy, isProtected, isIgnored } from '../src/policy';
import { parsePolicy } from '../src/policy-load';
import { evaluate, activeChanges } from '../src/engine';
import type { Change } from '../src/types';

describe('protected globs', () => {
  const P = defaultPolicy();
  it('matches specs at root and nested', () => {
    expect(isProtected('a.spec.ts', P, 'tests')).toBe(true);
    expect(isProtected('src/deep/a.spec.ts', P, 'tests')).toBe(true);
    expect(isProtected('src/a.ts', P, 'tests')).toBe(false);
  });
  it('treats package.json and ci files as protected', () => {
    expect(isProtected('package.json', P, 'config')).toBe(true);
    expect(isProtected('.github/workflows/ci.yml', P, 'ci')).toBe(true);
  });
});

describe('parsePolicy', () => {
  it('maps required_for and ignore, falling back to defaults', () => {
    const p = parsePolicy({
      version: 1,
      ignore: ['docs/**'],
      signoff: { required_for: ['block'], ledger: '.x' },
    });
    expect(p.ignore).toEqual(['docs/**']);
    expect(p.signoff.requiredFor).toEqual(['block']);
    expect(p.rules['no-verify'].severity).toBe('block'); // from defaults
  });
  it('returns the baseline when given nothing', () => {
    expect(parsePolicy(null).rules['ts-any-cast'].severity).toBe('block');
  });
});

describe('ignore filtering', () => {
  const policy = { ...defaultPolicy(), ignore: ['src/detectors/**'] };

  it('isIgnored matches the configured globs', () => {
    expect(isIgnored('src/detectors/no-verify.ts', policy)).toBe(true);
    expect(isIgnored('src/engine.ts', policy)).toBe(false);
  });

  it('drops ignored file changes but keeps commands', () => {
    const changes: Change[] = [
      { kind: 'command', raw: 'git commit --no-verify', argv: [] },
      { kind: 'file', path: 'src/detectors/x.ts', oldPath: null, op: 'modify', before: null, after: null, binary: false, hunks: [] },
    ];
    expect(activeChanges(changes, policy)).toHaveLength(1);
  });

  it('does not flag an "as any" added inside an ignored detector file', () => {
    const changes: Change[] = [
      {
        kind: 'file', path: 'src/detectors/ts-any-cast.ts', oldPath: null, op: 'modify',
        before: null, after: null, binary: false,
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [
          { type: 'add', content: 'const x = y as any;', oldLine: null, newLine: 1 },
        ] }],
      },
    ];
    expect(evaluate(changes, policy)).toHaveLength(0);
  });
});
