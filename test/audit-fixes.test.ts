// Regressions earned by the pre-go-live security audit.
// Each test below is an exploit that WORKED against the shipped engine. They exist so a
// refactor cannot quietly reopen a total bypass.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, isSuppressed, hasBlocking } from '../src/engine';
import { parsePolicy } from '../src/policy-load';
import { policyWeakening } from '../src/detectors/policy-diff';
import { preToolUseVerdict, stopVerdict } from '../src/cli/hook';
import { runCheck } from '../src/cli/check';
import { Change } from '../src/types';

function policyEdit(before: string, after: string): Change {
  return {
    kind: 'file',
    path: '.holdfast.yml',
    oldPath: null,
    op: 'modify',
    before,
    after,
    binary: false,
    hunks: [],
  };
}

function silenced<T>(fn: () => T): T {
  const w = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  (process.stdout as any).write = () => true;
  (process.stderr as any).write = () => true;
  try {
    return fn();
  } finally {
    (process.stdout as any).write = w;
    (process.stderr as any).write = e;
  }
}

// ── C1 · `ignore` may never hide the policy file that declares it ──────────────────
describe('C1 · ignore poisoning', () => {
  const poisoned = parsePolicy({ ignore: ['**'] });

  it('does not suppress a change to the policy file, even under ignore:["**"]', () => {
    expect(isSuppressed(policyEdit('rules: {}', "ignore: ['**']"), poisoned)).toBe(false);
  });

  it('still reports the weakening that a self-covering ignore glob would hide', () => {
    const f = evaluate([policyEdit('ignore: []\n', "ignore: ['**']\n")], poisoned);
    expect(f.some((x) => x.rule === 'hook-tampering' && /ignore/.test(x.evidence))).toBe(true);
  });

  it('still suppresses an ordinary ignored path (self-hosting exception intact)', () => {
    const c: Change = { ...(policyEdit('a', 'b') as any), path: 'docs/notes.md' };
    expect(isSuppressed(c, parsePolicy({ ignore: ['**/*.md'] }))).toBe(true);
  });
});

// ── C3 · a weakening override ADDED for an inherited rule is still a weakening ─────
describe('C3 · policy-diff baseline blindness', () => {
  const reasons = (b: string, a: string) => policyWeakening(b, a) ?? [];
  const before = 'rules:\n  test-skip: { severity: block }\n';

  it('catches lowering a rule that was inheriting the baseline block', () => {
    const after = before + '  test-deletion: { severity: warn }\n';
    expect(reasons(before, after).some((r) => /test-deletion.*block/.test(r))).toBe(true);
  });

  it('catches disabling a rule that was inheriting the baseline', () => {
    const after = before + '  test-deletion: { enabled: false }\n';
    expect(reasons(before, after).some((r) => /test-deletion.*disabled/.test(r))).toBe(true);
  });

  it('makes gutting a protected category impossible rather than merely detectable (H8)', () => {
    const after = before + "protected:\n  tests: ['no-such-glob/**']\n";
    // the merge is additive, so the baseline globs survive the "replacement" outright
    const eff = parsePolicy({ protected: { tests: ['no-such-glob/**'] } });
    expect(eff.protected.tests).toContain('**/*.spec.ts');
    expect(eff.protected.tests).toContain('no-such-glob/**');
    // and with nothing actually narrowed, there is no weakening left to report
    expect(reasons(before, after).some((r) => /protected\.tests narrowed/.test(r))).toBe(false);
  });

  it('catches dropping sign-off when the before-file inherited it', () => {
    const after = before + 'signoff:\n  required_for: []\n';
    expect(reasons(before, after).some((r) => /sign-off/.test(r))).toBe(true);
  });
});

// ── C1b · the head's own policy cannot govern the head's verdict ───────────────────
describe('C1b · trusted-base policy at the CI layer', () => {
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hf-trustbase-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    g('init', '-q');
    g('config', 'user.email', 't@t.co');
    g('config', 'user.name', 't');
    writeFileSync(join(dir, '.holdfast.yml'), 'version: 1\nignore: []\n');
    writeFileSync(join(dir, 'a.spec.ts'), `it('one', () => {});\n`);
    g('add', '-A');
    g('commit', '-qm', 'init');
    return dir;
  }

  it('blocks a PR that disables the gate on itself via ignore:["**"]', () => {
    const dir = repo();
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    writeFileSync(join(dir, '.holdfast.yml'), "version: 1\nignore:\n  - '**'\n");
    g('rm', '-q', 'a.spec.ts');
    g('add', '-A');
    g('commit', '-qm', 'refactor');

    const code = silenced(() => runCheck({ diff: `${base}...HEAD`, cwd: dir }));
    expect(code).toBe(1); // was 0 — "clean, 3 file(s) ignored by policy"
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── C2 · the hook fails CLOSED when it cannot evaluate ─────────────────────────────
describe('C2 · hook fail-closed', () => {
  function brokenPolicyCwd(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hf-failclosed-'));
    // a merge-conflicted policy file: valid on disk, unparseable as YAML
    writeFileSync(join(dir, '.holdfast.yml'), '<<<<<<< HEAD\nrules: {}\n=======\nrules: {}\n>>>>>>> other\n');
    return dir;
  }

  it('DENIES a blocked command instead of crashing when the policy will not parse', () => {
    const dir = brokenPolicyCwd();
    const r = preToolUseVerdict({ tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m x' }, cwd: dir } as any);
    expect(r.exitCode).toBe(0); // exit 2 or 1 would make Claude Code ignore/bypass the verdict
    expect(r.stdout).toContain('"permissionDecision":"deny"');
    expect(r.stdout).not.toContain('--no-verify'); // the reason never echoes the command line
    rmSync(dir, { recursive: true, force: true });
  });

  it('Stop sweep blocks on a failed evaluation but still allows outside a git repo', () => {
    const dir = brokenPolicyCwd();
    // not a git repo → genuinely nothing to compare → allow
    expect(stopVerdict({ cwd: dir } as any)).toEqual({ exitCode: 0, stdout: '' });

    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
    const r = stopVerdict({ cwd: dir } as any);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('"decision":"block"'); // was a silent allow
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── the engine still behaves for ordinary input ────────────────────────────────────
describe('no collateral damage', () => {
  it('a clean policy edit that STRENGTHENS reports nothing', () => {
    const f = evaluate(
      [policyEdit('rules:\n  test-skip: { severity: warn }\n', 'rules:\n  test-skip: { severity: block }\n')],
      parsePolicy({}),
    );
    expect(hasBlocking(f)).toBe(false);
  });
});
