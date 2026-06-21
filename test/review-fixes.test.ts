import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { policyWeakening } from '../src/detectors/policy-diff';
import { parsePolicy } from '../src/policy-load';
import { testDeletion } from '../src/detectors/test-deletion';
import { defaultPolicy } from '../src/policy';
import { changesFromClaudeHook } from '../src/adapters/claude/changes';
import { diffWorktree } from '../src/git/build';
import { loadPolicy } from '../src/policy-load';
import { evaluate } from '../src/engine';
import { noVerify } from '../src/detectors/no-verify';
import type { Change, CommandChange, FileChange, Detector } from '../src/types';

const P = defaultPolicy();
const cmd = (raw: string): CommandChange => ({ kind: 'command', raw, argv: raw.split(/\s+/) });

// ── #4 semantic policy weakening (guard the guardrail) ─────────────────────
describe('policyWeakening', () => {
  const base = [
    'rules:',
    '  no-verify: { severity: block }',
    '  test-deletion: { severity: block }',
    'protected:',
    "  tests: ['**/*.test.ts']",
    'ignore: []',
  ].join('\n');

  const reasons = (b: string, a: string) => policyWeakening(b, a) ?? [];

  it('flags an added ignore glob (the ignore:["**"] kill)', () => {
    const after = base.replace('ignore: []', "ignore: ['**']");
    expect(reasons(base, after).some((r) => /ignore/.test(r))).toBe(true);
  });
  it('flags narrowed protected globs', () => {
    const after = base.replace("tests: ['**/*.test.ts']", 'tests: []');
    expect(reasons(base, after).some((r) => /protected/.test(r))).toBe(true);
  });
  it('flags severity lowered in the MULTILINE form (the old gap)', () => {
    const b = 'rules:\n  no-verify:\n    severity: block\n';
    const a = 'rules:\n  no-verify:\n    severity: warn\n';
    expect(reasons(b, a).some((r) => /no-verify/.test(r))).toBe(true);
  });
  it('flags a removed rule and a disabled rule', () => {
    const removed = base.replace('  test-deletion: { severity: block }\n', '');
    expect(reasons(base, removed).some((r) => /removed/.test(r))).toBe(true);
    const disabled = base.replace('test-deletion: { severity: block }', 'test-deletion: { severity: block, enabled: false }');
    expect(reasons(base, disabled).some((r) => /disabled/.test(r))).toBe(true);
  });
  it('does NOT flag a strengthening edit (a protected glob ADDED)', () => {
    const after = base.replace("tests: ['**/*.test.ts']", "tests: ['**/*.test.ts', '**/*.spec.ts']");
    expect(reasons(base, after)).toHaveLength(0);
  });

  // fail-closed / fail-safe on broken YAML — the failure mode the semantic upgrade added
  it('FAILS CLOSED when the after-policy is emptied or corrupted', () => {
    expect(reasons(base, 'rules: [this is : not valid').some((r) => /corrupted|emptied/.test(r))).toBe(true);
    expect(reasons(base, '').some((r) => /corrupted|emptied/.test(r))).toBe(true);
  });
  it('returns null (defer to fallback) when the BEFORE has no baseline to compare', () => {
    expect(policyWeakening('!!!not yaml::', base)).toBeNull();
  });
  it('never throws on malformed input', () => {
    expect(() => policyWeakening('{[}', '}{]')).not.toThrow();
  });
});

// ── parsePolicy merges instead of replacing ────────────────────────────────
describe('parsePolicy merge', () => {
  it('overriding one rule keeps the other nine', () => {
    const p = parsePolicy({ rules: { 'no-verify': { severity: 'warn' } } });
    expect(p.rules['no-verify'].severity).toBe('warn');
    expect(p.rules['test-deletion'].severity).toBe('block');
    expect(Object.keys(p.rules).length).toBeGreaterThan(5);
  });
  it('setting one protected category keeps the others', () => {
    const p = parsePolicy({ protected: { tests: ['**/*.test.js'] } });
    expect(p.protected.tests).toEqual(['**/*.test.js']);
    expect(p.protected.ci).toBeDefined();
  });
});

// ── engine isolates a throwing detector (must not fail open at the hook) ────
describe('engine resilience', () => {
  it('a detector that throws is skipped, not allowed to crash the verdict', () => {
    const boom: Detector = {
      id: 'boom',
      surface: ['command'],
      certainty: 'mechanical',
      run() {
        throw new Error('deliberate');
      },
    };
    let findings: ReturnType<typeof evaluate> = [];
    expect(() => {
      findings = evaluate([cmd('git commit --no-verify')], P, [boom, noVerify]);
    }).not.toThrow();
    // the healthy detector's verdict still stands
    expect(findings.some((f) => f.rule === 'no-verify')).toBe(true);
  });
});

// ── test-deletion redirect target ──────────────────────────────────────────
describe('test-deletion redirect target', () => {
  it('does not fire when a test is read and redirected elsewhere', () => {
    expect(testDeletion.run([cmd('cat src/a.spec.ts > /tmp/x')], P)).toHaveLength(0);
  });
  it('fires when the redirect target IS the test', () => {
    expect(testDeletion.run([cmd('echo > src/a.spec.ts')], P).length).toBeGreaterThan(0);
  });
});

// ── #1 Stop sweep enriches `after` from DISK, not the stale index ───────────
describe('Stop sweep reads after-content from disk', () => {
  it('catches a test block removed on disk (unstaged)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-sweep-'));
    const g = (args: string[]) => execFileSync('git', args, { cwd: dir });
    g(['init', '-q']);
    g(['config', 'user.email', 'h@x']);
    g(['config', 'user.name', 'h']);
    writeFileSync(join(dir, 'a.spec.ts'), `it('one', () => {}); it('two', () => {});\n`);
    writeFileSync(join(dir, '.holdfast.yml'), "version: 1\nprotected:\n  tests: ['**/*.spec.ts']\n");
    g(['add', '-A']);
    g(['commit', '-qm', 'seed']);
    // agent strips one it() ON DISK, unstaged — the index still has both
    writeFileSync(join(dir, 'a.spec.ts'), `it('one', () => {});\n`);
    const findings = evaluate(diffWorktree({ cwd: dir }), loadPolicy(dir));
    rmSync(dir, { recursive: true, force: true });
    expect(findings.some((f) => f.rule === 'test-deletion')).toBe(true);
  });
});

// ── Edit reconstruction preserves $-patterns ───────────────────────────────
describe('Edit reconstruction', () => {
  it('inserts a literal $& rather than interpreting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-edit-'));
    writeFileSync(join(dir, 'x.ts'), 'const A = 1;\n');
    const changes: Change[] = changesFromClaudeHook(
      {
        tool_name: 'Edit',
        cwd: dir,
        tool_input: { file_path: join(dir, 'x.ts'), old_string: 'const A = 1;', new_string: 'const A = "$&";' },
      },
      dir,
    );
    rmSync(dir, { recursive: true, force: true });
    const fc = changes[0] as FileChange;
    expect(fc.after).toContain('$&');
  });
});
