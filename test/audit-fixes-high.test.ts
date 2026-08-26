// Regressions for the HIGH-severity findings of the pre-go-live audit (H1–H8).
// Every case below is a single-move evasion that WORKED against the shipped detectors.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coverageLowering } from '../src/detectors/coverage-lowering';
import { hookTampering } from '../src/detectors/hook-tampering';
import { ciTampering } from '../src/detectors/ci-tampering';
import { parseDiff, unquotePath } from '../src/diff/parse';
import { parsePolicy } from '../src/policy-load';
import { defaultPolicy } from '../src/policy';
import { preToolUseVerdict, stopVerdict } from '../src/cli/hook';
import { changesFromClaudeHook } from '../src/adapters/claude/changes';
import { Change, Detector, FileChange } from '../src/types';

const P = defaultPolicy();

function file(path: string, before: string, after: string): FileChange {
  return { kind: 'file', path, oldPath: null, op: 'modify', before, after, binary: false, hunks: [] };
}

/** A change carrying real hunks, for the line-surface detectors. */
function diffed(path: string, before: string, after: string): Change[] {
  const dir = mkdtempSync(join(tmpdir(), 'hf-h-'));
  writeFileSync(join(dir, 'a'), before);
  writeFileSync(join(dir, 'b'), after);
  let raw = '';
  try {
    raw = execFileSync('git', ['diff', '--no-index', '--no-color', join(dir, 'a'), join(dir, 'b')], { encoding: 'utf8' });
  } catch (e) {
    raw = String((e as { stdout?: Buffer }).stdout ?? '');
  }
  rmSync(dir, { recursive: true, force: true });
  const parsed = parseDiff(raw)[0] as FileChange | undefined;
  return [{ ...(file(path, before, after) as FileChange), hunks: parsed?.hunks ?? [] }];
}

const msgs = (d: Detector, c: Change[]) => d.run(c, P).map((f) => f.message);

// ── H1 · every threshold metric, not just `lines` ─────────────────────────────────
describe('H1 · coverage-lowering reads all four metrics', () => {
  it('flags branches/functions dropped while lines is left untouched', () => {
    const m = msgs(coverageLowering, [
      file(
        'jest.config.js',
        'module.exports={coverageThreshold:{global:{lines:80,branches:90,functions:90}}}',
        'module.exports={coverageThreshold:{global:{lines:80,branches:0,functions:0}}}',
      ),
    ]);
    expect(m.some((x) => /branches/.test(x))).toBe(true);
    expect(m.some((x) => /functions/.test(x))).toBe(true);
  });

  it('does not fire when every metric is raised', () => {
    expect(
      msgs(coverageLowering, [
        file('jest.config.js', 'module.exports={coverageThreshold:{global:{lines:80,branches:80}}}', 'module.exports={coverageThreshold:{global:{lines:90,branches:95}}}'),
      ]),
    ).toHaveLength(0);
  });
});

// ── H2 · the Vitest config shape ──────────────────────────────────────────────────
describe('H2 · coverage-lowering understands Vitest thresholds', () => {
  it('flags lowering test.coverage.thresholds', () => {
    expect(
      msgs(coverageLowering, [
        file('vitest.config.ts', 'export default {test:{coverage:{thresholds:{lines:80,branches:80}}}}', 'export default {test:{coverage:{thresholds:{lines:0,branches:0}}}}'),
      ]).length,
    ).toBeGreaterThan(0);
  });

  it('ignores a `thresholds` key that is not a coverage gate', () => {
    expect(
      msgs(coverageLowering, [
        file('vitest.config.ts', 'export default {alerts:{thresholds:{lines:80}}}', 'export default {alerts:{thresholds:{lines:0}}}'),
      ]),
    ).toHaveLength(0);
  });
});

// ── H3 · gutting a hook body ──────────────────────────────────────────────────────
describe('H3 · hook-tampering sees a hook gutted in place', () => {
  it('flags an inserted early exit 0', () => {
    const m = msgs(hookTampering, diffed('.husky/pre-commit', '#!/bin/sh\nnpx holdfast check --staged\n', '#!/bin/sh\nexit 0\nnpx holdfast check --staged\n'));
    expect(m.some((x) => /exit 0/.test(x))).toBe(true);
  });

  it('flags the gate invocation being removed or commented out', () => {
    const removed = msgs(hookTampering, diffed('.husky/pre-commit', '#!/bin/sh\nnpx holdfast check --staged\n', '#!/bin/sh\n'));
    expect(removed.some((x) => /removed from a protected hook/.test(x))).toBe(true);
    const commented = msgs(hookTampering, diffed('.husky/pre-commit', '#!/bin/sh\nnpx holdfast check --staged\n', '#!/bin/sh\n# npx holdfast check --staged\n'));
    expect(commented.some((x) => /removed from a protected hook/.test(x))).toBe(true);
  });

  it('flags shell rewrites and an octal chmod that clears +x (M2)', () => {
    const cmd = (raw: string): Change[] => [{ kind: 'command', raw, argv: raw.split(/\s+/) }];
    expect(msgs(hookTampering, cmd('chmod 644 .husky/pre-commit')).length).toBeGreaterThan(0);
    expect(msgs(hookTampering, cmd("printf 'exit 0' | tee .husky/pre-commit")).length).toBeGreaterThan(0);
    expect(msgs(hookTampering, cmd("sed -i 's/holdfast/true/' .husky/pre-commit")).length).toBeGreaterThan(0);
    // chmod that KEEPS the execute bit is not a tamper signal on its own
    expect(msgs(hookTampering, cmd('chmod 755 .husky/pre-commit'))).toHaveLength(0);
  });
});

// ── H4 · checks removed from a multi-line run block ───────────────────────────────
describe('H4 · ci-tampering sees into run blocks', () => {
  const WF = '.github/workflows/ci.yml';
  const before = 'jobs:\n  ci:\n    steps:\n      - run: |\n          npm run typecheck\n          npm run test\n';

  it('flags a deleted multi-line check step', () => {
    const m = msgs(ciTampering, diffed(WF, before, 'jobs:\n  ci:\n    steps:\n      - run: echo ok\n'));
    expect(m.some((x) => /run block|check step/.test(x))).toBe(true);
  });

  it('flags the expression spellings of if:false / continue-on-error (M1)', () => {
    const off = msgs(ciTampering, diffed(WF, before, before + '        if: ${{ false }}\n'));
    expect(off.some((x) => /can never run/.test(x))).toBe(true);
    const coe = msgs(ciTampering, diffed(WF, before, before + '        continue-on-error: ${{ true }}\n'));
    expect(coe.some((x) => /continue-on-error/.test(x))).toBe(true);
  });

  it('does not fire on an unrelated workflow edit', () => {
    expect(msgs(ciTampering, diffed(WF, before, before.replace('  ci:', '  build:')))).toHaveLength(0);
  });
});

// ── H5 · a tamper COMMITTED mid-turn is still the turn's work ─────────────────────
describe('H5 · Stop sweep sees in-turn commits', () => {
  it('blocks a test deletion the agent committed before the turn ended', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-turn-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    g('init', '-q');
    g('config', 'user.email', 't@t.co');
    g('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.spec.ts'), `it('one', () => {});\n`);
    g('add', '-A');
    g('commit', '-qm', 'init');

    const session = 'sess-abc';
    // first tool call pins the turn baseline
    preToolUseVerdict({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: dir, session_id: session });

    // the agent deletes the test and COMMITS it — a plain commit, so no-verify never fires
    g('rm', '-q', 'a.spec.ts');
    g('commit', '-qm', 'wip');

    const r = stopVerdict({ cwd: dir, session_id: session });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('"decision":"block"'); // was an empty `git diff HEAD` → silent allow
    expect(r.stdout).toContain('test-deletion');
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── H6 · the matcher must name every tool the adapter models ──────────────────────
describe('H6 · PreToolUse tool coverage', () => {
  it('SPEC wires a matcher covering every file-mutating tool the adapter handles', () => {
    const spec = readFileSync(join(__dirname, '..', 'SPEC.md'), 'utf8');
    const matcher = spec.match(/"matcher":\s*"([^"]+)"/)?.[1] ?? '';
    for (const tool of ['Bash', 'Edit', 'Write', 'MultiEdit']) {
      expect(matcher.split('|')).toContain(tool);
    }
  });

  it('the MultiEdit branch really produces a change (it was dead at the matcher)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-me-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.spec.ts'), `it('one', () => {});\nit('two', () => {});\n`);
    const changes = changesFromClaudeHook(
      {
        tool_name: 'MultiEdit',
        tool_input: { file_path: 'src/a.spec.ts', edits: [{ old_string: `it('two', () => {});\n`, new_string: '' }] },
        cwd: dir,
      },
      dir,
    );
    expect(changes.length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── H7 · git's quoted paths ───────────────────────────────────────────────────────
describe('H7 · C-quoted paths are decoded', () => {
  it('decodes octal byte escapes back to UTF-8', () => {
    expect(unquotePath('"caf\\303\\251.spec.ts"')).toBe('café.spec.ts');
    expect(unquotePath('plain.spec.ts')).toBe('plain.spec.ts');
  });

  it('parses a delete of a non-ASCII protected test to its real path', () => {
    const raw = [
      'diff --git "a/caf\\303\\251.spec.ts" "b/caf\\303\\251.spec.ts"',
      'deleted file mode 100644',
      'index e5f4aa2..0000000',
      '--- "a/caf\\303\\251.spec.ts"',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      `-it("x", () => {});`,
      '',
    ].join('\n');
    const c = parseDiff(raw)[0] as FileChange;
    expect(c.path).toBe('café.spec.ts');
    expect(c.op).toBe('delete');
  });
});

// ── H8 · protected categories grow, never shrink ──────────────────────────────────
describe('H8 · protected globs merge additively', () => {
  it('adding a test glob keeps every baseline test glob', () => {
    const p = parsePolicy({ protected: { tests: ['e2e/**'] } });
    expect(p.protected.tests).toContain('e2e/**');
    expect(p.protected.tests).toContain('**/*.spec.ts');
    expect(p.protected.tests).toContain('**/__tests__/**');
  });
});
