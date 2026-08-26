import { describe, it, expect } from 'vitest';
import { changesFromClaudeHook } from '../src/adapters/claude/changes';
import { evaluate, hasBlocking } from '../src/engine';
import { preToolUseVerdict, stopVerdict } from '../src/cli/hook';
import { defaultPolicy } from '../src/policy';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const P = defaultPolicy();

// a throwaway cwd with a real spec file on disk, so before-content is read for real
function fixtureCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hf-hooktest-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.spec.ts'), `it('one', () => {}); it('two', () => {});\n`);
  return dir;
}

function evalHook(input: object, cwd: string) {
  return evaluate(changesFromClaudeHook(input, cwd), P);
}

describe('claude PreToolUse adapter', () => {
  it('denies a Bash --no-verify before it runs', () => {
    const f = evalHook({ tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m wip' } }, '/tmp');
    expect(hasBlocking(f)).toBe(true);
    expect(f[0].rule).toBe('no-verify');
  });

  it('denies a Bash rm of a test file', () => {
    const cwd = fixtureCwd();
    const f = evalHook({ tool_name: 'Bash', tool_input: { command: 'rm src/a.spec.ts' }, cwd }, cwd);
    expect(f.some((x) => x.rule === 'test-deletion')).toBe(true);
  });

  it('denies an Edit that removes a test block (AST, before read from disk)', () => {
    const cwd = fixtureCwd();
    const f = evalHook(
      {
        tool_name: 'Edit',
        cwd,
        tool_input: {
          file_path: join(cwd, 'src/a.spec.ts'),
          old_string: `it('one', () => {}); it('two', () => {});`,
          new_string: `it('one', () => {});`,
        },
      },
      cwd,
    );
    expect(f.some((x) => x.rule === 'test-deletion')).toBe(true);
  });

  it('denies a Write that empties a spec', () => {
    const cwd = fixtureCwd();
    const f = evalHook(
      { tool_name: 'Write', cwd, tool_input: { file_path: join(cwd, 'src/a.spec.ts'), content: '' } },
      cwd,
    );
    expect(f.some((x) => x.rule === 'test-deletion')).toBe(true);
  });

  it('denies a Write that introduces an unsafe cast', () => {
    const cwd = fixtureCwd();
    const f = evalHook(
      {
        tool_name: 'Write',
        cwd,
        tool_input: { file_path: join(cwd, 'src/x.ts'), content: 'export const f = (v: unknown) => v as any;\n' },
      },
      cwd,
    );
    expect(f.some((x) => x.rule === 'ts-any-cast')).toBe(true);
  });

  it('allows a legitimate Write to non-protected code', () => {
    const cwd = fixtureCwd();
    const f = evalHook(
      {
        tool_name: 'Write',
        cwd,
        tool_input: { file_path: join(cwd, 'src/add.ts'), content: 'export const add = (a: number, b: number) => a + b;\n' },
      },
      cwd,
    );
    expect(f).toHaveLength(0);
  });
});

// ── the JSON deny channel — exit-0 + JSON, NEVER exit 2 ─────────────────────
describe('PreToolUse JSON deny contract', () => {
  it('a block is exit 0 + permissionDecision:deny (exit 2 would make Claude ignore the JSON)', () => {
    const r = preToolUseVerdict({ tool_name: 'Bash', tool_input: { command: 'git commit --no-verify' } });
    expect(r.exitCode).toBe(0); // <-- the regression guard: must be 0, not 2
    const j = JSON.parse(r.stdout);
    expect(j.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(j.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(j.hookSpecificOutput.permissionDecisionReason).toContain('no-verify');
  });

  it('the reason carries only the correction — no command line / env leak', () => {
    const r = preToolUseVerdict({ tool_name: 'Bash', tool_input: { command: 'git commit --no-verify' } });
    expect(r.stdout).not.toContain('TAMPERWARD_DENYLOG');
    expect(r.stdout).not.toContain('node ');
    expect(r.stdout).not.toContain('dist/cli');
  });

  it('an allowed call is exit 0 + empty stdout', () => {
    expect(preToolUseVerdict({ tool_name: 'Bash', tool_input: { command: 'npm test' } })).toEqual({
      exitCode: 0,
      stdout: '',
    });
  });
});

describe('Stop block JSON contract', () => {
  it('respects stop_hook_active (no re-block loop)', () => {
    expect(stopVerdict({ stop_hook_active: true })).toEqual({ exitCode: 0, stdout: '' });
  });

  it('a real worktree tamper → exit 0 + decision:block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-stop-'));
    const g = (args: string[]) => execFileSync('git', args, { cwd: dir });
    g(['init', '-q']);
    g(['config', 'user.email', 'h@x']);
    g(['config', 'user.name', 'h']);
    writeFileSync(join(dir, 'a.spec.ts'), `it('one', () => {}); it('two', () => {});\n`);
    writeFileSync(join(dir, '.tamperward.yml'), "version: 1\nprotected:\n  tests: ['**/*.spec.ts']\n");
    g(['add', '-A']);
    g(['commit', '-qm', 'seed']);
    writeFileSync(join(dir, 'a.spec.ts'), `it('one', () => {});\n`); // strip a block on disk
    const r = stopVerdict({ cwd: dir });
    rmSync(dir, { recursive: true, force: true });
    expect(r.exitCode).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.decision).toBe('block');
    expect(j.reason).toContain('test-deletion');
  });
});
