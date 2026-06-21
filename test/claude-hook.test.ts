import { describe, it, expect } from 'vitest';
import { changesFromClaudeHook } from '../src/adapters/claude/changes';
import { evaluate, hasBlocking } from '../src/engine';
import { defaultPolicy } from '../src/policy';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
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
