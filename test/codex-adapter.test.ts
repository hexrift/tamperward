// #482 / #563: the EXPERIMENTAL Codex RuntimeAdapter conforms to the neutral steering
// contract, reconstructs Codex operations into the shared Change[] shape, runs the SAME
// engine as the Claude path for its pre-action content decision, and is honest about the
// capabilities it does NOT yet prove on a pinned Codex build. Payloads are synthetic and
// inline; there are no fixture files.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAdapter, CodexRuntimeAdapter } from '../src/adapters/codex/adapter';
import { codexDenyWire, codexWire } from '../src/adapters/codex/deny';
import { normalizeCodexEvent, codexOperationKind } from '../src/adapters/codex/schema';
import { formatDenial } from '../src/adapters/claude/deny';
import { OPERATION_KINDS } from '../src/adapters/contract';
import { Finding } from '../src/types';

function repoFixture(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hf-codex-')));
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

describe('CodexRuntimeAdapter — identity and capabilities honesty', () => {
  it('exposes a stable name and a fresh instance equals the singleton', () => {
    expect(codexAdapter.name).toBe('codex');
    expect(new CodexRuntimeAdapter().name).toBe('codex');
  });

  it('is CONSERVATIVE: preDeny is empty and unsupported names the unproven gaps', () => {
    const caps = codexAdapter.capabilities;
    // Pre-action deny enforcement is NOT proven on a pinned Codex build → claim nothing.
    expect(caps.preDeny).toEqual([]);
    expect(caps.endOfTurn).toBe(true);
    expect([...caps.postObserve].sort()).toEqual([...OPERATION_KINDS].sort());
    // The gaps are named in prose, including the two milestone-critical ones.
    expect(caps.unsupported.some((u) => /pre-action deny enforcement not yet proven/i.test(u))).toBe(true);
    expect(caps.unsupported.some((u) => /fail-closed hook transport not yet proven/i.test(u) && /41979/.test(u))).toBe(true);
  });
});

describe('normalizeCodexEvent — tool-name → OperationKind and per-phase shape', () => {
  it('maps each Codex tool family to the right operation kind', () => {
    expect(codexOperationKind('shell_command')).toBe('shell');
    expect(codexOperationKind('exec_command')).toBe('shell');
    expect(codexOperationKind('unified_exec')).toBe('shell');
    expect(codexOperationKind('apply_patch')).toBe('file-edit');
    expect(codexOperationKind('write_file')).toBe('file-edit');
    expect(codexOperationKind('edit_file')).toBe('file-edit');
    expect(codexOperationKind('read_file')).toBe('file-read');
    expect(codexOperationKind('grep')).toBe('file-read');
    expect(codexOperationKind('mcp__server__tool')).toBe('mcp');
    expect(codexOperationKind('something_unknown')).toBe('other');
    expect(codexOperationKind(undefined)).toBe('other');
  });

  it('parseEvent classifies a pre-action tool call with verbatim args', () => {
    const raw = JSON.stringify({ tool_name: 'shell_command', tool_input: { command: 'rm x' }, cwd: '/repo', session_id: 's1' });
    const ev = codexAdapter.parseEvent(raw, 'pre-action');
    expect('failure' in ev).toBe(false);
    if ('failure' in ev) return;
    expect(ev.operation.kind).toBe('shell');
    expect(ev.operation.name).toBe('shell_command');
    expect(ev.operation.args).toEqual({ command: 'rm x' });
    expect(ev.identity).toEqual({ claimedCwd: '/repo', sessionId: 's1' });
  });

  it('end-of-turn is a synthetic stop op regardless of payload tool_name', () => {
    const raw = JSON.stringify({ tool_name: 'shell_command', cwd: '/repo' });
    const ev = normalizeCodexEvent(raw, 'end-of-turn');
    expect('failure' in ev).toBe(false);
    if ('failure' in ev) return;
    expect(ev.operation).toEqual({ kind: 'other', name: 'stop', args: {} });
  });

  it('empty stdin is a well-formed absence, not a parse failure', () => {
    const ev = normalizeCodexEvent('', 'pre-action');
    expect('failure' in ev).toBe(false);
  });

  it('a JSON array / primitive is a malformed shape → parse-failure', () => {
    expect(normalizeCodexEvent('[1,2,3]', 'pre-action')).toMatchObject({ failure: 'parse-failure' });
    expect(normalizeCodexEvent('42', 'pre-action')).toMatchObject({ failure: 'parse-failure' });
    expect(normalizeCodexEvent('{ "tool_name":', 'pre-action')).toMatchObject({ failure: 'parse-failure' });
  });
});

describe('CodexRuntimeAdapter.decide — pre-action content verdict via the SAME engine', () => {
  it('denies a protected test-weakening edit (write of it.skip)', () => {
    const cwd = repoFixture();
    try {
      const raw = JSON.stringify({
        tool_name: 'write_file',
        cwd,
        tool_input: { path: join(cwd, 'src', 'a.spec.ts'), content: `it('one', () => {});\nit.skip('two', () => {});\n` },
      });
      const r = codexAdapter.decide(raw, 'pre-action', cwd);
      expect(r.outcome).toBe('ok');
      expect(r.decision?.verdict).toBe('deny');
      expect(r.wire).toContain('test-skip');
      const j = JSON.parse(r.wire as string);
      expect(j.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(j.hookSpecificOutput.permissionDecision).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('denies a protected test deletion via shell', () => {
    const cwd = repoFixture();
    try {
      const raw = JSON.stringify({ tool_name: 'shell_command', cwd, tool_input: { command: 'rm src/a.spec.ts' } });
      const r = codexAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.wire).toContain('test-deletion');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('denies a protected test removal reconstructed from an apply_patch update', () => {
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
      const raw = JSON.stringify({ tool_name: 'apply_patch', cwd, tool_input: { patch } });
      const r = codexAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.wire).toContain('test-deletion');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('an apply_patch whose hunk cannot be located fails CLOSED to deny', () => {
    const cwd = repoFixture();
    try {
      const patch = [
        '*** Begin Patch',
        '*** Update File: src/a.spec.ts',
        '@@',
        '-this line is not in the file at all',
        '+something else',
        '*** End Patch',
      ].join('\n');
      const raw = JSON.stringify({ tool_name: 'apply_patch', cwd, tool_input: { patch } });
      const r = codexAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.decision?.findings[0].rule).toBe('tamperward-unavailable');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('allows an ordinary edit to a non-protected file (empty wire = allow)', () => {
    const cwd = repoFixture();
    try {
      const raw = JSON.stringify({
        tool_name: 'write_file',
        cwd,
        tool_input: { path: join(cwd, 'src', 'feature.ts'), content: 'export const x = 1;\n' },
      });
      const r = codexAdapter.decide(raw, 'pre-action', cwd);
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
      const r = codexAdapter.decide('', 'pre-action', cwd);
      expect(r.outcome).toBe('ok');
      expect(r.decision?.verdict).toBe('allow');
      expect(r.wire).toBe('');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('CodexRuntimeAdapter.decide — pre-action pins the Stop-sweep baseline at turn start', () => {
  it('pins the session baseline so a mutation COMMITTED mid-turn stays visible to the sweep', () => {
    const cwd = repoFixture();
    const sessionId = 'codexsess1';
    try {
      // A benign first tool call must still pin turn start.
      const first = codexAdapter.decide(
        JSON.stringify({ tool_name: 'read_file', cwd, session_id: sessionId, tool_input: { path: join(cwd, 'src', 'a.spec.ts') } }),
        'pre-action',
        cwd,
      );
      expect(first.decision?.verdict).toBe('allow');
      expect(existsSync(join(cwd, '.git', 'tamperward', `session-${sessionId}`))).toBe(true);

      // Now the turn weakens the spec and COMMITS it. Without a turn-start baseline the
      // sweep would compare post-commit HEAD against a post-commit baseline and miss it.
      writeFileSync(join(cwd, 'src', 'a.spec.ts'), `it('one', () => {});\n`);
      const g = (args: string[]) => execFileSync('git', args, { cwd });
      g(['commit', '-qam', 'mid-turn tamper']);

      const stop = codexAdapter.decide(JSON.stringify({ cwd, session_id: sessionId }), 'end-of-turn', cwd);
      expect(stop.decision?.verdict).toBe('deny');
      expect(stop.wire).toContain('test-deletion');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('CodexRuntimeAdapter.decide — end-of-turn sweep in Codex wire', () => {
  it('denies a landed shell mutation and emits the Codex Stop envelope', () => {
    const cwd = repoFixture();
    try {
      writeFileSync(join(cwd, 'src', 'a.spec.ts'), `it('one', () => {});\n`);
      const raw = JSON.stringify({ cwd });
      const r = codexAdapter.decide(raw, 'end-of-turn', cwd);
      expect(r.outcome).toBe('ok');
      expect(r.decision?.verdict).toBe('deny');
      const j = JSON.parse(r.wire as string);
      expect(j.hookSpecificOutput.hookEventName).toBe('Stop');
      expect(j.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(j.hookSpecificOutput.permissionDecisionReason).toContain('test-deletion');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a clean turn allows (empty wire)', () => {
    const cwd = repoFixture();
    try {
      const r = codexAdapter.decide(JSON.stringify({ cwd }), 'end-of-turn', cwd);
      expect(r.decision?.verdict).toBe('allow');
      expect(r.wire).toBe('');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('CodexRuntimeAdapter.decide — failure states fail CLOSED (deny)', () => {
  it('a parse-failure is classified and fails closed', () => {
    const r = codexAdapter.decide('[1,2,3]', 'pre-action');
    expect(r.outcome).toBe('parse-failure');
    expect(r.decision?.verdict).toBe('deny');
    const j = JSON.parse(r.wire as string);
    expect(j.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(j.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('a cross-repo identity claim fails closed BEFORE evaluation', () => {
    const A = repoFixture();
    const B = repoFixture();
    try {
      const raw = JSON.stringify({ tool_name: 'shell_command', tool_input: { command: 'rm src/a.spec.ts' }, cwd: B });
      const r = codexAdapter.decide(raw, 'pre-action', A);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.detail).toMatch(/different repository/);
      const j = JSON.parse(r.wire as string);
      expect(j.hookSpecificOutput.permissionDecisionReason).toMatch(/identity claim rejected/i);
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });

  it('a malformed (empty) identity claim fails closed', () => {
    const A = repoFixture();
    try {
      const raw = JSON.stringify({ tool_name: 'shell_command', tool_input: { command: 'rm x' }, cwd: '   ' });
      const r = codexAdapter.decide(raw, 'pre-action', A);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.detail).toMatch(/malformed/);
    } finally {
      rmSync(A, { recursive: true, force: true });
    }
  });

  it('failClosed maps transport/not-invoked to a deny wire', () => {
    const t = codexAdapter.failClosed('transport-failure', 'hook unreachable', 'pre-action');
    expect(t.outcome).toBe('transport-failure');
    expect(t.decision?.verdict).toBe('deny');
    expect(t.decision?.findings[0].rule).toBe('tamperward-unavailable');
    const n = codexAdapter.failClosed('not-invoked', 'PreToolUse did not fire', 'pre-action');
    expect(n.outcome).toBe('not-invoked');
    expect(n.decision?.verdict).toBe('deny');
  });
});

describe('CodexRuntimeAdapter — post-action is observation-only', () => {
  it('decide(..., post-action) returns unsupported, no wire, no decision', () => {
    const cwd = repoFixture();
    try {
      const raw = JSON.stringify({ tool_name: 'shell_command', tool_input: { command: 'rm src/a.spec.ts' }, cwd });
      const r = codexAdapter.decide(raw, 'post-action', cwd);
      expect(r.outcome).toBe('unsupported');
      expect(r.wire).toBeUndefined();
      expect(r.decision).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('codexDenyWire — the documented Codex deny envelope', () => {
  it('pre-action carries hookEventName PreToolUse and the shared denial reason', () => {
    const wire = codexDenyWire(findings, 'pre-action');
    const j = JSON.parse(wire);
    expect(j.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(j.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(j.hookSpecificOutput.permissionDecisionReason).toBe(formatDenial(findings));
    expect(wire.endsWith('\n')).toBe(true);
  });

  it('end-of-turn carries hookEventName Stop', () => {
    const j = JSON.parse(codexDenyWire(findings, 'end-of-turn'));
    expect(j.hookSpecificOutput.hookEventName).toBe('Stop');
  });

  it('an allow (no findings) writes an empty string', () => {
    expect(codexDenyWire([], 'pre-action')).toBe('');
  });

  it('codexWire serialises a raw reason into the same envelope', () => {
    const j = JSON.parse(codexWire('because', 'pre-action'));
    expect(j.hookSpecificOutput.permissionDecisionReason).toBe('because');
  });
});
