// Regressions from the third external audit: five ways the gate failed OPEN.
// Each case below is an exploit that worked against 1.14.6 — reproduced against
// the built CLI before the fix, kept here so no refactor reopens it.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePolicy, loadPolicy, PolicyError } from '../src/policy-load';
import { policyWeakening } from '../src/detectors/policy-diff';
import { hookTampering } from '../src/detectors/hook-tampering';
import { changesFromClaudeHook, synthFileChange } from '../src/adapters/claude/changes';
import { preToolUseVerdict } from '../src/cli/hook';
import { evaluate, hasBlocking } from '../src/engine';
import { parseDiff } from '../src/diff/parse';
import { diffStaged, diffWorktree } from '../src/git/build';
import { runVerify } from '../src/cli/verify';
import { defaultPolicy } from '../src/policy';
import type { Change, CommandChange, FileChange } from '../src/types';

const P = defaultPolicy();
const cmd = (raw: string): CommandChange => ({ kind: 'command', raw, argv: raw.split(/\s+/) });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function gitRepo(prefix: string): string {
  const d = tmp(prefix);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  return d;
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

// ── 1 · a mistyped severity must not switch a rule off ────────────────────────
describe('1 · policy values are validated; a typo fails closed', () => {
  it.each(['BLOCK', 'Block', 'blocc', 'blocking', 1, true, null])('rejects severity %j', (sev) => {
    expect(() => parsePolicy({ rules: { 'test-deletion': { severity: sev as any } } })).toThrow(PolicyError);
  });

  it('rejects the other malformed shapes instead of reading them as something weaker', () => {
    expect(() => parsePolicy({ rules: { 'test-deletion': { enabled: 'false' } as any } })).toThrow(PolicyError);
    expect(() => parsePolicy({ rules: { 'test-deletion': null as any } })).toThrow(PolicyError);
    expect(() => parsePolicy({ rules: ['test-deletion'] as any })).toThrow(PolicyError);
    expect(() => parsePolicy({ ignore: 'src/**' as any })).toThrow(PolicyError);
    expect(() => parsePolicy({ protected: { tests: 'e2e/**' as any } })).toThrow(PolicyError);
    expect(() => parsePolicy({ signoff: { required_for: ['blocker' as any] } })).toThrow(PolicyError);
    expect(() => parsePolicy({ verify: { command: 'npm test', budget: 'lots' as any } })).toThrow(PolicyError);
    expect(() => parsePolicy({ verify: { command: 'npm test', budget: 0 } })).toThrow(PolicyError);
  });

  it('still accepts every valid spelling, including unknown rule names', () => {
    const p = parsePolicy({
      version: 2,
      rules: { 'test-deletion': { severity: 'warn' }, 'future-rule': { severity: 'block', enabled: false, exclude: ['a/**'] } },
      ignore: ['docs/**'],
      protected: { tests: ['e2e/**'] },
      signoff: { required_for: ['block', 'warn'], ledger: '.x' },
      verify: { command: 'npm test', budget: 60, inputs: ['scripts/**'] },
    });
    expect(p.rules['test-deletion'].severity).toBe('warn');
    expect(p.rules['future-rule'].enabled).toBe(false);
    expect(p.verify?.budget).toBe(60);
  });

  it('names the file and the offending key in the error', () => {
    const cwd = tmp('tw-pol-');
    writeFileSync(join(cwd, '.tamperward.yml'), 'rules:\n  test-deletion: { severity: BLOCK }\n');
    expect(() => loadPolicy(cwd)).toThrow(/\.tamperward\.yml: rules\.test-deletion\.severity must be "block" or "warn", got "BLOCK"/);
  });

  it('the EDIT that introduces the typo is reported as a lowering by policy-diff', () => {
    const before = 'version: 1\n';
    for (const after of [
      'rules:\n  test-deletion: { severity: BLOCK }\n',
      'rules:\n  test-deletion: { severity: blocc }\n',
      'rules:\n  test-deletion: { severity: 7 }\n',
    ]) {
      const reasons = policyWeakening(before, after) ?? [];
      expect(reasons.some((r) => /test-deletion.*lowered block/.test(r))).toBe(true);
    }
    // and an honest strengthening is not
    expect(policyWeakening(before, 'rules:\n  snapshot-rewrite: { severity: block }\n')).toEqual([]);
  });

  it('end to end: the hook denies the write that would corrupt the policy, then denies until it is fixed', () => {
    const cwd = gitRepo('tw-pol-e2e-');
    writeFileSync(join(cwd, '.tamperward.yml'), 'version: 1\n');
    writeFileSync(join(cwd, 'a.test.js'), 'test("x", () => {});\n');
    execFileSync('git', ['add', '-A'], { cwd });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd });

    const corrupt = 'version: 1\nrules:\n  test-deletion: { severity: BLOCK }\n';
    const write = preToolUseVerdict({
      tool_name: 'Write',
      tool_input: { file_path: join(cwd, '.tamperward.yml'), content: corrupt },
      cwd,
    });
    expect(write.stdout).toContain('"deny"');
    expect(write.stdout).toContain('lowered block');

    // Suppose it landed anyway (a path the hook did not see). Nothing may pass.
    writeFileSync(join(cwd, '.tamperward.yml'), corrupt);
    const rm = preToolUseVerdict({ tool_name: 'Bash', tool_input: { command: 'rm a.test.js' }, cwd });
    expect(rm.stdout).toContain('"deny"');
    expect(rm.stdout).toContain('tamperward-unavailable');
  });
});

// ── 2 · a diff past 1 MiB must not be read as a smaller edit ─────────────────
describe('2 · large tool-call diffs fail closed, never truncated', () => {
  it('a Write whose diff exceeds 1 MiB still carries the hunk with the skip', () => {
    let before = '';
    for (let i = 0; i < 20000; i++) before += `test("case ${i} does the thing number ${i}", () => { expect(1).toBe(1); });\n`;
    const after = before.replace(/does the thing/g, 'does the  thing') + 'test.skip("the failing one", () => {});\n';
    const [c] = synthFileChange('big.test.js', before, after);
    const added = c.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'add').map((l) => l.content));
    expect(added.length).toBeGreaterThan(20000);
    expect(added[added.length - 1]).toContain('test.skip');
    const f = evaluate([c], P, undefined, 'tool-call');
    expect(f.some((x) => x.rule === 'test-skip' && x.severity === 'block')).toBe(true);
  }, 30_000);
});

// ── 3 · a redundant path segment must not dodge an exact-path glob ───────────
describe('3 · tool-call paths are normalised before matching', () => {
  it.each(['./.claude/settings.json', 'src/../.claude/settings.json', 'a/b/../../.tamperward.yml'])(
    'resolves %s to the protected file',
    (spelling) => {
      const cwd = tmp('tw-path-');
      mkdirSync(join(cwd, '.claude'));
      writeFileSync(join(cwd, '.claude', 'settings.json'), '{"hooks":{"PreToolUse":[{"hooks":[{"command":"npx --yes tamperward hook claude"}]}]}}\n');
      writeFileSync(join(cwd, '.tamperward.yml'), 'version: 1\n');
      const [c] = changesFromClaudeHook(
        { tool_name: 'Write', tool_input: { file_path: join(cwd, spelling), content: '{}' } },
        cwd,
      ) as FileChange[];
      expect(c.path).toBe(spelling.replace(/^(\.\/|src\/\.\.\/|a\/b\/\.\.\/\.\.\/)/, ''));
    },
  );

  it('the hook denies an Edit that removes the gate command via a ../ spelling', () => {
    const cwd = tmp('tw-path-e2e-');
    mkdirSync(join(cwd, '.claude'));
    writeFileSync(join(cwd, '.claude', 'settings.json'), '{"hooks":{"PreToolUse":[{"hooks":[{"command":"npx --yes tamperward hook claude"}]}]}}\n');
    const r = preToolUseVerdict({
      tool_name: 'Edit',
      tool_input: { file_path: join(cwd, 'src', '..', '.claude', 'settings.json'), old_string: 'npx --yes tamperward hook claude', new_string: 'true' },
      cwd,
    });
    expect(r.stdout).toContain('"deny"');
    expect(r.stdout).toContain('hook-tampering');
  });

  it('a file outside the cwd keeps its absolute path (no false relative match)', () => {
    const cwd = tmp('tw-path-out-');
    const other = tmp('tw-path-other-');
    const [c] = changesFromClaudeHook(
      { tool_name: 'Write', tool_input: { file_path: join(other, 'x.txt'), content: 'a' } },
      cwd,
    ) as FileChange[];
    expect(c.path).toBe(join(other, 'x.txt'));
  });
});

// ── 4 · losing the execute bit on a hook is a finding on every surface ───────
describe('4 · chmod on a hook: every spelling, and the mode-only diff', () => {
  it.each([
    'chmod -x .husky/pre-commit',
    'chmod u-x .husky/pre-commit',
    'chmod a-x .husky/pre-commit',
    'chmod go-x,u-x .husky/pre-commit',
    'chmod u=rw .husky/pre-commit',
    'chmod ugo=rw .husky/pre-commit',
    'chmod 644 .husky/pre-commit',
    'chmod 0600 .husky/pre-commit',
    'chmod -R u-x .husky',
  ])('flags: %s', (c) => {
    const f = hookTampering.run([cmd(c)], P);
    expect(f.length).toBeGreaterThan(0);
    expect(f[0].message).toMatch(/execute permission/);
  });

  it.each(['chmod 755 .husky/pre-commit', 'chmod u=rwx .husky/pre-commit', 'chmod u+w .husky/pre-commit', 'chmod -R 755 .husky'])(
    'does not flag a chmod that keeps the bit: %s',
    (c) => {
      expect(hookTampering.run([cmd(c)], P)).toHaveLength(0);
    },
  );

  it('parseDiff records old/new modes and hook-tampering flags the drop', () => {
    const diff = `diff --git a/.husky/pre-commit b/.husky/pre-commit
old mode 100755
new mode 100644
`;
    const [c] = parseDiff(diff) as FileChange[];
    expect(c.op).toBe('modify');
    expect(c.oldMode).toBe('100755');
    expect(c.newMode).toBe('100644');
    expect(c.hunks).toHaveLength(0);
    const f = evaluate([c], P, undefined, 'staged');
    expect(f.some((x) => x.rule === 'hook-tampering' && /Execute permission was removed/.test(x.message))).toBe(true);
  });

  it('a plain modify with no mode lines carries no mode fields (shape unchanged)', () => {
    const [c] = parseDiff(`diff --git a/x.ts b/x.ts
index 1..2 100644
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-a
+b
`) as FileChange[];
    expect('oldMode' in c).toBe(false);
    expect('newMode' in c).toBe(false);
  });

  it('end to end: chmod u-x on a committed husky hook is blocked in the worktree AND staged views', () => {
    const cwd = gitRepo('tw-mode-');
    mkdirSync(join(cwd, '.husky'));
    const hook = join(cwd, '.husky', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nnpx --yes tamperward check --staged\n');
    chmodSync(hook, 0o755);
    execFileSync('git', ['add', '-A'], { cwd });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd });
    chmodSync(hook, 0o644);

    const work = evaluate(diffWorktree({ cwd }), P, undefined, 'worktree');
    expect(hasBlocking(work)).toBe(true);
    expect(work[0].rule).toBe('hook-tampering');

    execFileSync('git', ['add', '-A'], { cwd });
    const staged = evaluate(diffStaged({ cwd }), P, undefined, 'staged');
    expect(hasBlocking(staged)).toBe(true);
  });

  it('adding a NEW executable hook, or a mode change on a non-hook, is not a finding', () => {
    const added = parseDiff(`diff --git a/.husky/pre-push b/.husky/pre-push
new file mode 100755
--- /dev/null
+++ b/.husky/pre-push
@@ -0,0 +1 @@
+npx --yes tamperward check --staged
`);
    expect(hookTampering.run(added, P)).toHaveLength(0);
    const script = parseDiff(`diff --git a/scripts/build.sh b/scripts/build.sh
old mode 100755
new mode 100644
`);
    expect(hookTampering.run(script, P)).toHaveLength(0);
  });
});

// ── 5 · a budget kill must take the whole suite with it ───────────────────────
describe('5 · verify kills the suite process group on budget exhaustion', () => {
  it('no child of the suite survives a BUDGET_EXCEEDED verdict', () => {
    const cwd = gitRepo('tw-kill-');
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
    execFileSync('git', ['add', '-A'], { cwd });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd });
    const pidfile = join(tmp('tw-kill-pid-'), 'pids');
    // a runner that forks a worker which outlives the shell by design
    const suite = `sleep 30 & echo $! >> "${pidfile}"; wait`;
    const code = silenced(() => runVerify({ cwd, cmd: suite, budget: 1, json: true }));
    expect(code).toBe(2);
    expect(existsSync(pidfile)).toBe(true);
    const pids = readFileSync(pidfile, 'utf8').split('\n').filter(Boolean).map(Number);
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) {
      let alive = true;
      try {
        process.kill(pid, 0);
        // A container without an init never reaps orphans: a KILLED worker stays a
        // zombie with PPid 1, and kill(pid, 0) still succeeds on a zombie. Read
        // the state where /proc exists; a zombie is dead for every purpose here.
        try {
          if (/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8'))) alive = false;
        } catch {
          /* no /proc: kill(0) is the answer */
        }
      } catch {
        alive = false;
      }
      if (alive) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* raced */ }
      }
      expect(alive).toBe(false);
    }
  }, 30_000);
});

// keeps the unused-import lint honest
void (null as unknown as Change);
