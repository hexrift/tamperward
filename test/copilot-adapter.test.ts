// #482 / #598: the EXPERIMENTAL GitHub Copilot CLI RuntimeAdapter conforms to the neutral
// steering contract, over BOTH documented Copilot hook wire formats (native camelCase and the
// PascalCase / Claude-compatible format), reconstructs Copilot operations — including the
// first-party apply_patch and str_replace_editor tools — into the shared Change[] shape, runs
// the SAME engine as the Claude path for its pre-action content decision, and is honest about
// the capabilities it does NOT yet prove on a pinned Copilot CLI build. Payloads are synthetic
// and inline; there are no fixture files.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copilotAdapter, CopilotRuntimeAdapter } from '../src/adapters/copilot/adapter';
import { copilotDenyWire, copilotWire } from '../src/adapters/copilot/deny';
import { normalizeCopilotEvent, copilotOperationKind, copilotStopInput } from '../src/adapters/copilot/schema';
import { formatDenial } from '../src/adapters/claude/deny';
import { Finding } from '../src/types';

function repoFixture(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hf-copilot-')));
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir });
  g(['init', '-q']);
  g(['config', 'user.email', 'h@x']);
  g(['config', 'user.name', 'h']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.spec.ts'), `it('one', () => {}); it('two', () => {});\n`);
  writeFileSync(
    join(dir, '.tamperward.yml'),
    "version: 1\nprotected:\n  tests: ['**/*.spec.ts']\n  ci: ['.github/workflows/**']\n",
  );
  writeFileSync(
    join(dir, '.github', 'workflows', 'ci.yml'),
    'name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
  );
  g(['add', '-A']);
  g(['commit', '-qm', 'seed']);
  return dir;
}

const findings: Finding[] = [
  {
    rule: 'test-deletion',
    severity: 'block',
    file: 'src/a.spec.ts',
    message: 'A protected test file was removed.',
    evidence: 'rm src/a.spec.ts',
    remediation: 'Fix the failing test, do not delete it.',
    signoff: { required: true, command: 'tamperward allow test-deletion --reason "..."' },
  },
];

// A native camelCase preToolUse payload: toolName + toolArgs (a JSON STRING) + sessionId/cwd.
function nativePre(cwd: string, toolName: string, args: unknown, sessionId?: string): string {
  return JSON.stringify({
    sessionId: sessionId ?? 's-native',
    timestamp: 1_700_000_000_000,
    cwd,
    toolName,
    toolArgs: JSON.stringify(args),
  });
}

// A PascalCase (Claude-compatible) PreToolUse payload: tool_name (a Claude tool name) +
// tool_input (an object) + session_id/cwd.
function pascalPre(cwd: string, tool_name: string, tool_input: unknown, session_id?: string): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: session_id ?? 's-pascal',
    timestamp: 1_700_000_000_000,
    cwd,
    tool_name,
    tool_input,
  });
}

describe('CopilotRuntimeAdapter — identity and capabilities honesty', () => {
  it('exposes a stable name and a fresh instance equals the singleton', () => {
    expect(copilotAdapter.name).toBe('github-copilot-cli');
    expect(new CopilotRuntimeAdapter().name).toBe('github-copilot-cli');
  });

  it('is CONSERVATIVE: preDeny and postObserve empty; unsupported names the real Copilot semantics', () => {
    const caps = copilotAdapter.capabilities;
    expect(caps.preDeny).toEqual([]);
    expect(caps.endOfTurn).toBe(true);
    // Milestone one does not consume postToolUse (decide(post-action) → unsupported), so the
    // adapter advertises NO post-observe capability rather than contradicting itself.
    expect(caps.postObserve).toEqual([]);
    const u = caps.unsupported.join(' | ');
    expect(u).toMatch(/pre-action deny enforcement not yet proven/i);
    // fail-open is scoped to command hooks, and HTTP hooks fail open too.
    expect(u).toMatch(/COMMAND preToolUse hook timeout fails OPEN/i);
    expect(u).toMatch(/HTTP preToolUse hook fails OPEN/i);
    // agentStop is a lifecycle continuation control, plus the 8-block override.
    expect(u).toMatch(/agentStop can only block turn completion and force continuation/i);
    expect(u).toMatch(/8 consecutive blocks/i);
    // apply_patch / str_replace_editor payloads modelled but pending a real fixture.
    expect(u).toMatch(/apply_patch \/ str_replace_editor/i);
    // shell-session write tools are recorded as mutation-capable, payload pending a fixture.
    expect(u).toMatch(/write_bash \/ write_powershell/i);
  });
});

describe('copilotOperationKind — both documented tool vocabularies', () => {
  it('maps native lowercase and PascalCase Claude tool names to the right kind', () => {
    // native
    expect(copilotOperationKind('bash')).toBe('shell');
    expect(copilotOperationKind('powershell')).toBe('shell');
    // shell-SESSION write tools send input to a running shell → mutation-capable shell.
    expect(copilotOperationKind('write_bash')).toBe('shell');
    expect(copilotOperationKind('write_powershell')).toBe('shell');
    // read/list/stop session tools do not send input → non-mutating.
    expect(copilotOperationKind('read_bash')).toBe('other');
    expect(copilotOperationKind('stop_bash')).toBe('other');
    expect(copilotOperationKind('create')).toBe('file-edit');
    expect(copilotOperationKind('edit')).toBe('file-edit');
    expect(copilotOperationKind('apply_patch')).toBe('file-edit');
    expect(copilotOperationKind('str_replace_editor')).toBe('file-edit');
    expect(copilotOperationKind('view')).toBe('file-read');
    // PascalCase / Claude-compatible
    expect(copilotOperationKind('Bash')).toBe('shell');
    expect(copilotOperationKind('Write')).toBe('file-edit');
    expect(copilotOperationKind('Edit')).toBe('file-edit');
    expect(copilotOperationKind('MultiEdit')).toBe('file-edit');
    expect(copilotOperationKind('Read')).toBe('file-read');
    // MCP remains an explicitly non-mutating path; unknown names stay distinct so the adapter can fail closed.
    expect(copilotOperationKind('mcp__filesystem__write_file')).toBe('mcp');
    expect(copilotOperationKind('fetch')).toBe('unknown');
    expect(copilotOperationKind('grep')).toBe('file-read');
    expect(copilotOperationKind('rg')).toBe('file-read');
    expect(copilotOperationKind('glob')).toBe('file-read');
    expect(copilotOperationKind('Grep')).toBe('file-read');
    expect(copilotOperationKind('Glob')).toBe('file-read');
    for (const name of ['web_fetch', 'web_search', 'ask_user', 'report_intent', 'task', 'skill', 'update_todo', 'web_fetch', 'WebFetch', 'AskUserQuestion', 'Agent', 'TodoWrite']) {
      expect(copilotOperationKind(name)).toBe('other');
    }
    expect(copilotOperationKind(undefined)).toBe('other');
  });
});

describe('normalizeCopilotEvent — parses both wire formats', () => {
  it('native camelCase: toolName + toolArgs (a JSON string) is parsed into args', () => {
    const ev = normalizeCopilotEvent(nativePre('/repo', 'bash', { command: 'rm x' }, 's1'), 'pre-action');
    expect('failure' in ev).toBe(false);
    if ('failure' in ev) return;
    expect(ev.operation.kind).toBe('shell');
    expect(ev.operation.name).toBe('bash');
    expect(ev.operation.args).toEqual({ command: 'rm x' });
    expect(ev.identity).toEqual({ claimedCwd: '/repo', sessionId: 's1' });
  });

  it('PascalCase: tool_name (Claude name) + tool_input object', () => {
    const ev = normalizeCopilotEvent(pascalPre('/repo', 'Bash', { command: 'rm x' }, 's2'), 'pre-action');
    expect('failure' in ev).toBe(false);
    if ('failure' in ev) return;
    expect(ev.operation.kind).toBe('shell');
    expect(ev.operation.name).toBe('Bash');
    expect(ev.operation.args).toEqual({ command: 'rm x' });
    expect(ev.identity).toEqual({ claimedCwd: '/repo', sessionId: 's2' });
  });

  it('a toolArgs string that is not valid JSON is dropped (reconstruction then fails closed)', () => {
    const raw = JSON.stringify({ sessionId: 's', cwd: '/repo', toolName: 'bash', toolArgs: 'not json{' });
    const ev = normalizeCopilotEvent(raw, 'pre-action');
    expect('failure' in ev).toBe(false);
    if ('failure' in ev) return;
    expect(ev.operation.args).toEqual({});
  });

  it('end-of-turn is a synthetic stop op regardless of payload tool_name', () => {
    const ev = normalizeCopilotEvent(pascalPre('/repo', 'Bash', {}), 'end-of-turn');
    expect('failure' in ev).toBe(false);
    if ('failure' in ev) return;
    expect(ev.operation).toEqual({ kind: 'other', name: 'stop', args: {} });
  });

  it('empty stdin is a well-formed absence, not a parse failure', () => {
    expect('failure' in normalizeCopilotEvent('', 'pre-action')).toBe(false);
  });

  it('a JSON array / primitive / truncated object is a parse-failure', () => {
    expect(normalizeCopilotEvent('[1,2,3]', 'pre-action')).toMatchObject({ failure: 'parse-failure' });
    expect(normalizeCopilotEvent('42', 'pre-action')).toMatchObject({ failure: 'parse-failure' });
    expect(normalizeCopilotEvent('{ "toolName":', 'pre-action')).toMatchObject({ failure: 'parse-failure' });
  });
});

describe('copilotStopInput — normalizes either agentStop / Stop format to the Claude Stop shape', () => {
  it('native agentStop sessionId → session_id; PascalCase Stop passes session_id through', () => {
    const native = copilotStopInput(JSON.stringify({ sessionId: 's9', cwd: '/repo', stopReason: 'end' }));
    expect(JSON.parse(native as string)).toEqual({ cwd: '/repo', session_id: 's9' });
    const pascal = copilotStopInput(JSON.stringify({ session_id: 's9', cwd: '/repo', stop_hook_active: true }));
    expect(JSON.parse(pascal as string)).toEqual({ cwd: '/repo', session_id: 's9', stop_hook_active: true });
  });

  it('empty stdin normalizes to an empty object (a clean stop)', () => {
    expect(copilotStopInput('')).toBe('{}');
  });
});

describe('CopilotRuntimeAdapter.decide — pre-action denies protected mutations in BOTH formats', () => {
  it.each([
    ['native bash rm', (cwd: string) => nativePre(cwd, 'bash', { command: 'rm src/a.spec.ts' })],
    ['native powershell rm', (cwd: string) => nativePre(cwd, 'powershell', { command: 'rm src/a.spec.ts' })],
    ['pascal Bash rm', (cwd: string) => pascalPre(cwd, 'Bash', { command: 'rm src/a.spec.ts' })],
    ['pascal Bash git restore', (cwd: string) => pascalPre(cwd, 'Bash', { command: 'git restore --source=HEAD~1 --worktree src/a.spec.ts' })],
  ])('denies %s', (_desc, mk) => {
    const cwd = repoFixture();
    try {
      const r = copilotAdapter.decide(mk(cwd), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.wire).toContain('test-deletion');
      const j = JSON.parse(r.wire as string);
      expect(j.permissionDecision).toBe('deny'); // Copilot's FLAT control shape
      expect(j.hookSpecificOutput).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('denies an unrecognized tool instead of treating it as a no-op', () => {
    const cwd = repoFixture();
    try {
      const raw = nativePre(cwd, 'future_mutating_tool', {
        path: join(cwd, 'src', 'a.spec.ts'),
        content: "it.skip('one', () => {});\n",
      });
      const r = copilotAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.decision?.findings[0].rule).toBe('unknown-tool');
      expect(JSON.parse(r.wire as string).permissionDecision).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    ['grep', (cwd: string) => nativePre(cwd, 'grep', { pattern: 'needle' })],
    ['glob', (cwd: string) => nativePre(cwd, 'glob', { pattern: '**/*.ts' })],
    ['web_fetch', (cwd: string) => nativePre(cwd, 'web_fetch', { url: 'https://example.com' })],
    ['ask_user', (cwd: string) => nativePre(cwd, 'ask_user', { question: 'continue?' })],
    ['task', (cwd: string) => nativePre(cwd, 'task', { prompt: 'inspect' })],
    ['skill', (cwd: string) => nativePre(cwd, 'skill', { name: 'review' })],
    ['update_todo', (cwd: string) => nativePre(cwd, 'update_todo', { todos: [] })],
    ['Grep', (cwd: string) => pascalPre(cwd, 'Grep', { pattern: 'needle' })],
    ['Glob', (cwd: string) => pascalPre(cwd, 'Glob', { pattern: '**/*.ts' })],
    ['WebFetch', (cwd: string) => pascalPre(cwd, 'WebFetch', { url: 'https://example.com' })],
    ['AskUserQuestion', (cwd: string) => pascalPre(cwd, 'AskUserQuestion', { question: 'continue?' })],
    ['Agent', (cwd: string) => pascalPre(cwd, 'Agent', { prompt: 'inspect' })],
    ['TodoWrite', (cwd: string) => pascalPre(cwd, 'TodoWrite', { todos: [] })],
  ])('allows known non-mutating tool %s without treating it as an unknown no-op', (_name, mk) => {
    const cwd = repoFixture();
    try {
      const r = copilotAdapter.decide(mk(cwd), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('allow');
      expect(r.decision?.findings).toEqual([]);
      expect(r.wire).toBe('');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('denies a mutating write_bash (input sent to a shell session), not a silent allow', () => {
    const cwd = repoFixture();
    try {
      // write_bash sends `input` to an existing shell session — judged as a command.
      const raw = nativePre(cwd, 'write_bash', { input: 'rm src/a.spec.ts' });
      const r = copilotAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.wire).toContain('test-deletion');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a write_bash carrying no reconstructable input fails CLOSED (never a silent allow)', () => {
    const cwd = repoFixture();
    try {
      const r = copilotAdapter.decide(nativePre(cwd, 'write_bash', { sessionId: 'sh1' }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.decision?.findings[0].rule).toBe('tamperward-unavailable');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('denies a test-skip via native create (whole-file write, toolArgs.content)', () => {
    const cwd = repoFixture();
    try {
      const raw = nativePre(cwd, 'create', {
        path: join(cwd, 'src', 'a.spec.ts'),
        content: `it('one', () => {});\nit.skip('two', () => {});\n`,
      });
      const r = copilotAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.wire).toContain('test-skip');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('denies a protected test removal via PascalCase Edit (old_string → shorter)', () => {
    const cwd = repoFixture();
    try {
      const raw = pascalPre(cwd, 'Edit', {
        file_path: join(cwd, 'src', 'a.spec.ts'),
        old_string: "it('one', () => {}); it('two', () => {});",
        new_string: "it('one', () => {});",
      });
      const r = copilotAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.wire).toContain('test-deletion');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('denies a PascalCase MultiEdit that skips a protected test', () => {
    const cwd = repoFixture();
    try {
      const raw = pascalPre(cwd, 'MultiEdit', {
        file_path: join(cwd, 'src', 'a.spec.ts'),
        edits: [{ old_string: "it('two', () => {});", new_string: "it.skip('two', () => {});" }],
      });
      const r = copilotAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.wire).toContain('test-skip');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('models apply_patch: a protected test removal via the real patch envelope is DENIED', () => {
    const cwd = repoFixture();
    try {
      const patch = [
        '*** Begin Patch',
        '*** Update File: src/a.spec.ts',
        '@@',
        "-it('one', () => {}); it('two', () => {});",
        "+it('one', () => {});",
        '*** End Patch',
      ].join('\n');
      // native apply_patch: toolArgs carries the envelope under `input`.
      const raw = nativePre(cwd, 'apply_patch', { input: patch });
      const r = copilotAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.wire).toContain('test-deletion'); // proves it MODELS apply_patch, not just fail-closed
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('an apply_patch whose hunk cannot be located fails CLOSED to deny', () => {
    const cwd = repoFixture();
    try {
      const patch = ['*** Begin Patch', '*** Update File: src/a.spec.ts', '@@', '-nope not here', '+x', '*** End Patch'].join('\n');
      const r = copilotAdapter.decide(nativePre(cwd, 'apply_patch', { input: patch }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.decision?.findings[0].rule).toBe('tamperward-unavailable');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('models str_replace_editor str_replace (old_str/new_str → deny)', () => {
    const cwd = repoFixture();
    try {
      const raw = nativePre(cwd, 'str_replace_editor', {
        command: 'str_replace',
        path: join(cwd, 'src', 'a.spec.ts'),
        old_str: "it('two', () => {});",
        new_str: "it.skip('two', () => {});",
      });
      const r = copilotAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.wire).toContain('test-skip');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a str_replace_editor sub-op it cannot reconstruct exactly (insert) fails CLOSED', () => {
    const cwd = repoFixture();
    try {
      const raw = nativePre(cwd, 'str_replace_editor', {
        command: 'insert',
        path: join(cwd, 'src', 'a.spec.ts'),
        insert_line: 1,
      });
      const r = copilotAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.decision?.findings[0].rule).toBe('tamperward-unavailable');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('allows an ordinary create of a non-protected file (empty wire = allow)', () => {
    const cwd = repoFixture();
    try {
      const raw = pascalPre(cwd, 'Write', { file_path: join(cwd, 'src', 'feature.ts'), content: 'export const x = 1;\n' });
      const r = copilotAdapter.decide(raw, 'pre-action', cwd);
      expect(r.outcome).toBe('ok');
      expect(r.decision?.verdict).toBe('allow');
      expect(r.wire).toBe('');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('empty stdin is an allow', () => {
    const cwd = repoFixture();
    try {
      const r = copilotAdapter.decide('', 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('allow');
      expect(r.wire).toBe('');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('CopilotRuntimeAdapter.decide — end-of-turn sweep over both stop formats', () => {
  it('native agentStop (sessionId) pins & sweeps a mid-turn-committed mutation', () => {
    const cwd = repoFixture();
    const sessionId = 'copilotnative1';
    try {
      // Pin turn start with a benign NATIVE pre-action carrying sessionId.
      const first = copilotAdapter.decide(nativePre(cwd, 'bash', { command: 'cat src/a.spec.ts' }, sessionId), 'pre-action', cwd);
      expect(first.decision?.verdict).toBe('allow');
      expect(existsSync(join(cwd, '.git', 'tamperward', `session-${sessionId}`))).toBe(true);

      writeFileSync(join(cwd, 'src', 'a.spec.ts'), `it('one', () => {});\n`);
      execFileSync('git', ['commit', '-qam', 'mid-turn tamper'], { cwd });

      // Native agentStop uses sessionId — normalization must thread it to the same baseline.
      const stop = copilotAdapter.decide(JSON.stringify({ sessionId, cwd, stopReason: 'end' }), 'end-of-turn', cwd);
      expect(stop.decision?.verdict).toBe('deny');
      expect(stop.wire).toContain('test-deletion');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("denies a landed mutation and emits Copilot's agentStop {decision:block, reason}", () => {
    const cwd = repoFixture();
    try {
      writeFileSync(join(cwd, 'src', 'a.spec.ts'), `it('one', () => {});\n`);
      const r = copilotAdapter.decide(JSON.stringify({ session_id: 's', cwd }), 'end-of-turn', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.decision?.findings[0]?.rule).toBe('test-deletion');
      expect(r.decision?.findings[0]?.file).toBe('src/a.spec.ts');
      const j = JSON.parse(r.wire as string);
      expect(j.decision).toBe('block');
      expect(j.reason).toContain('test-deletion');
      expect(j.hookSpecificOutput).toBeUndefined();
      expect(j.permissionDecision).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a clean turn allows (empty wire)', () => {
    const cwd = repoFixture();
    try {
      const r = copilotAdapter.decide(JSON.stringify({ session_id: 's', cwd }), 'end-of-turn', cwd);
      expect(r.decision?.verdict).toBe('allow');
      expect(r.wire).toBe('');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('CopilotRuntimeAdapter.decide — failure states fail CLOSED (deny)', () => {
  it('a parse-failure at pre-action fails closed in the flat Copilot wire', () => {
    const r = copilotAdapter.decide('[1,2,3]', 'pre-action');
    expect(r.outcome).toBe('parse-failure');
    expect(r.decision?.verdict).toBe('deny');
    const j = JSON.parse(r.wire as string);
    expect(j.permissionDecision).toBe('deny');
  });

  it('a parse-failure at end-of-turn fails closed in the agentStop wire', () => {
    const r = copilotAdapter.decide('[1,2,3]', 'end-of-turn');
    expect(r.outcome).toBe('parse-failure');
    expect(r.decision?.verdict).toBe('deny');
    const j = JSON.parse(r.wire as string);
    expect(j.decision).toBe('block');
  });

  it('a cross-repo identity claim fails closed BEFORE evaluation', () => {
    const A = repoFixture();
    const B = repoFixture();
    try {
      const r = copilotAdapter.decide(nativePre(B, 'bash', { command: 'rm src/a.spec.ts' }), 'pre-action', A);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.detail).toMatch(/different repository/);
      const j = JSON.parse(r.wire as string);
      expect(j.permissionDecisionReason).toMatch(/identity claim rejected/i);
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });

  it('a malformed (empty) identity claim fails closed', () => {
    const A = repoFixture();
    try {
      const r = copilotAdapter.decide(nativePre('   ', 'bash', { command: 'rm x' }), 'pre-action', A);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.detail).toMatch(/malformed/);
    } finally {
      rmSync(A, { recursive: true, force: true });
    }
  });

  it('an edit event with no path fails CLOSED', () => {
    const cwd = repoFixture();
    try {
      const r = copilotAdapter.decide(pascalPre(cwd, 'Edit', { old_string: 'a', new_string: 'b' }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a create event with a path but no content fails CLOSED', () => {
    const cwd = repoFixture();
    try {
      const r = copilotAdapter.decide(nativePre(cwd, 'create', { path: join(cwd, 'src', 'x.ts') }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a bash event with no command fails CLOSED', () => {
    const cwd = repoFixture();
    try {
      for (const args of [{}, { command: '' }, { argv: [] }]) {
        const r = copilotAdapter.decide(nativePre(cwd, 'bash', args), 'pre-action', cwd);
        expect(r.decision?.verdict).toBe('deny');
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('failClosed maps supported transport outcomes to an explicit deny wire', () => {
    for (const [outcome, detail] of [
      ['transport-failure', 'malformed, empty, missing-executable, or non-zero hook response'],
      ['not-invoked', 'preToolUse did not fire'],
    ] as const) {
      const result = copilotAdapter.failClosed(outcome, detail, 'pre-action');
      expect(result.outcome).toBe(outcome);
      expect(result.decision?.verdict).toBe('deny');
      expect(result.decision?.findings[0].rule).toBe('tamperward-unavailable');
      expect(JSON.parse(result.wire as string).permissionDecision).toBe('deny');
    }
  });
});

describe('CopilotRuntimeAdapter — post-action is observation-only', () => {
  it('decide(..., post-action) returns unsupported, no wire, no decision', () => {
    const cwd = repoFixture();
    try {
      const r = copilotAdapter.decide(nativePre(cwd, 'bash', { command: 'rm src/a.spec.ts' }), 'post-action', cwd);
      expect(r.outcome).toBe('unsupported');
      expect(r.wire).toBeUndefined();
      expect(r.decision).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('copilotDenyWire — the documented Copilot deny envelopes', () => {
  it('pre-action carries the flat permissionDecision:deny and the shared denial reason', () => {
    const wire = copilotDenyWire(findings, 'pre-action');
    const j = JSON.parse(wire);
    expect(j.permissionDecision).toBe('deny');
    expect(j.permissionDecisionReason).toBe(formatDenial(findings));
    expect(j.hookSpecificOutput).toBeUndefined();
    expect(j.decision).toBeUndefined();
    expect(wire.endsWith('\n')).toBe(true);
  });

  it('end-of-turn carries {decision:block, reason} and NO permissionDecision', () => {
    const j = JSON.parse(copilotDenyWire(findings, 'end-of-turn'));
    expect(j.decision).toBe('block');
    expect(j.reason).toBe(formatDenial(findings));
    expect(j.permissionDecision).toBeUndefined();
  });

  it('an allow (no findings) writes an empty string', () => {
    expect(copilotDenyWire([], 'pre-action')).toBe('');
    expect(copilotDenyWire([], 'end-of-turn')).toBe('');
  });

  it('copilotWire serialises a raw reason into the same envelope', () => {
    expect(JSON.parse(copilotWire('because', 'pre-action')).permissionDecisionReason).toBe('because');
  });

  it('rejects observation-only post-action', () => {
    expect(() => copilotWire('because', 'post-action' as never)).toThrow(/unsupported Copilot wire phase/);
    expect(() => copilotAdapter.denyPayload(findings, 'post-action')).toThrow(/observation-only and cannot produce a deny wire/);
  });
});
