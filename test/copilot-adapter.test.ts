// #482 / #598: the EXPERIMENTAL GitHub Copilot CLI RuntimeAdapter conforms to the neutral
// steering contract, reconstructs Copilot operations into the shared Change[] shape, runs
// the SAME engine as the Claude path for its pre-action content decision, and is honest
// about the capabilities it does NOT yet prove on a pinned Copilot CLI build. Payloads are
// synthetic and inline; there are no fixture files.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copilotAdapter, CopilotRuntimeAdapter } from '../src/adapters/copilot/adapter';
import { copilotDenyWire, copilotWire } from '../src/adapters/copilot/deny';
import { normalizeCopilotEvent, copilotOperationKind } from '../src/adapters/copilot/schema';
import { formatDenial } from '../src/adapters/claude/deny';
import { OPERATION_KINDS } from '../src/adapters/contract';
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

describe('CopilotRuntimeAdapter — identity and capabilities honesty', () => {
  it('exposes a stable name and a fresh instance equals the singleton', () => {
    expect(copilotAdapter.name).toBe('github-copilot-cli');
    expect(new CopilotRuntimeAdapter().name).toBe('github-copilot-cli');
  });

  it('is CONSERVATIVE: preDeny is empty and unsupported names the unproven gaps', () => {
    const caps = copilotAdapter.capabilities;
    // Pre-action deny enforcement is NOT proven on a pinned Copilot build → claim nothing.
    expect(caps.preDeny).toEqual([]);
    expect(caps.endOfTurn).toBe(true);
    expect([...caps.postObserve].sort()).toEqual([...OPERATION_KINDS].sort());
    // The milestone-critical gaps are named in prose, including Copilot's fail-OPEN timeout.
    expect(caps.unsupported.some((u) => /pre-action deny enforcement not yet proven/i.test(u))).toBe(true);
    expect(caps.unsupported.some((u) => /timeout fails OPEN/i.test(u))).toBe(true);
    expect(caps.unsupported.some((u) => /only preToolUse is a control point/i.test(u))).toBe(true);
  });
});

describe('normalizeCopilotEvent — tool-name → OperationKind and per-phase shape', () => {
  it('maps each canonical Copilot hook tool name to the right operation kind', () => {
    // Grounded in the GitHub Copilot hooks reference tool vocabulary.
    expect(copilotOperationKind('bash')).toBe('shell');
    expect(copilotOperationKind('powershell')).toBe('shell');
    expect(copilotOperationKind('create')).toBe('file-edit');
    expect(copilotOperationKind('edit')).toBe('file-edit');
    expect(copilotOperationKind('str_replace')).toBe('file-edit');
    expect(copilotOperationKind('write')).toBe('file-edit');
    expect(copilotOperationKind('mcp__filesystem__write_file')).toBe('mcp');
    expect(copilotOperationKind('view')).toBe('file-read');
    expect(copilotOperationKind('read')).toBe('file-read');
    expect(copilotOperationKind('fetch')).toBe('other');
    expect(copilotOperationKind(undefined)).toBe('other');
  });

  it('matches tool names case-insensitively', () => {
    expect(copilotOperationKind('Bash')).toBe('shell');
    expect(copilotOperationKind('CREATE')).toBe('file-edit');
  });

  it('normalizes MCP operations without guessing capability availability', () => {
    for (const tool_name of ['mcp__filesystem__write_file', 'mcp__unknown__do_thing']) {
      const raw = JSON.stringify({ tool_name, tool_input: { path: 'src/a.spec.ts', arguments: { mode: 'write' } }, cwd: '/repo', session_id: 's1' });
      const ev = copilotAdapter.parseEvent(raw, 'pre-action');
      expect('failure' in ev).toBe(false);
      if ('failure' in ev) continue;
      expect(ev.operation.kind).toBe('mcp');
      expect(ev.operation.name).toBe(tool_name);
      expect(ev.operation.args).toEqual({ path: 'src/a.spec.ts', arguments: { mode: 'write' } });
    }
  });

  it('parseEvent classifies a pre-action bash call with verbatim args', () => {
    const raw = JSON.stringify({ tool_name: 'bash', tool_input: { command: 'rm x' }, cwd: '/repo', session_id: 's1', tool_use_id: 'tu1' });
    const ev = copilotAdapter.parseEvent(raw, 'pre-action');
    expect('failure' in ev).toBe(false);
    if ('failure' in ev) return;
    expect(ev.operation.kind).toBe('shell');
    expect(ev.operation.name).toBe('bash');
    expect(ev.operation.args).toEqual({ command: 'rm x' });
    expect(ev.identity).toEqual({ claimedCwd: '/repo', sessionId: 's1' });
  });

  it('end-of-turn is a synthetic stop op regardless of payload tool_name', () => {
    const raw = JSON.stringify({ tool_name: 'bash', cwd: '/repo' });
    const ev = normalizeCopilotEvent(raw, 'end-of-turn');
    expect('failure' in ev).toBe(false);
    if ('failure' in ev) return;
    expect(ev.operation).toEqual({ kind: 'other', name: 'stop', args: {} });
  });

  it('empty stdin is a well-formed absence, not a parse failure', () => {
    const ev = normalizeCopilotEvent('', 'pre-action');
    expect('failure' in ev).toBe(false);
  });

  it('a JSON array / primitive / truncated object is a malformed shape → parse-failure', () => {
    expect(normalizeCopilotEvent('[1,2,3]', 'pre-action')).toMatchObject({ failure: 'parse-failure' });
    expect(normalizeCopilotEvent('42', 'pre-action')).toMatchObject({ failure: 'parse-failure' });
    expect(normalizeCopilotEvent('{ "tool_name":', 'pre-action')).toMatchObject({ failure: 'parse-failure' });
  });
});

describe('CopilotRuntimeAdapter.decide — pre-action content verdict via the SAME engine', () => {
  it('denies a protected test deletion via a bash command (real hook shape)', () => {
    const cwd = repoFixture();
    try {
      const raw = JSON.stringify({ tool_name: 'bash', cwd, tool_input: { command: 'rm src/a.spec.ts' } });
      const r = copilotAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.wire).toContain('test-deletion');
      const j = JSON.parse(r.wire as string);
      // Copilot's FLAT control shape — no hookSpecificOutput wrapper.
      expect(j.permissionDecision).toBe('deny');
      expect(typeof j.permissionDecisionReason).toBe('string');
      expect(j.hookSpecificOutput).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    ['rm src/a.spec.ts', 'delete'],
    ['mv src/a.spec.ts src/a.disabled.ts', 'rename'],
    ['git checkout HEAD~1 -- src/a.spec.ts', 'checkout'],
    ['git restore src/a.spec.ts', 'restore'],
    ['git restore --source=HEAD~1 --worktree src/a.spec.ts', 'restore from older source'],
    ['git reset --hard HEAD', 'reset'],
  ])('denies Copilot bash %s', (command) => {
    const cwd = repoFixture();
    try {
      const raw = JSON.stringify({ tool_name: 'bash', cwd, tool_input: { command } });
      const r = copilotAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.wire).toContain('test-deletion');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('denies a powershell delete of a protected test', () => {
    const cwd = repoFixture();
    try {
      const raw = JSON.stringify({ tool_name: 'powershell', cwd, tool_input: { command: 'rm src/a.spec.ts' } });
      const r = copilotAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.wire).toContain('test-deletion');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('allows a path-limited mixed reset that only unstages a protected file', () => {
    const cwd = repoFixture();
    try {
      const raw = JSON.stringify({ tool_name: 'bash', cwd, tool_input: { command: 'git reset HEAD -- src/a.spec.ts' } });
      const r = copilotAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('allow');
      expect(r.wire).toBe('');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('denies a test-skip reconstructed from a create (whole-file) write', () => {
    const cwd = repoFixture();
    try {
      const raw = JSON.stringify({
        tool_name: 'create',
        cwd,
        tool_input: { path: join(cwd, 'src', 'a.spec.ts'), content: `it('one', () => {});\nit.skip('two', () => {});\n` },
      });
      const r = copilotAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.wire).toContain('test-skip');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('denies a protected test removal reconstructed from an edit (old_string → shorter)', () => {
    const cwd = repoFixture();
    try {
      const raw = JSON.stringify({
        tool_name: 'edit',
        cwd,
        tool_input: {
          path: join(cwd, 'src', 'a.spec.ts'),
          old_string: "it('one', () => {}); it('two', () => {});",
          new_string: "it('one', () => {});",
        },
      });
      const r = copilotAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.wire).toContain('test-deletion');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('accepts the str_replace edit alias with old_str/new_str spellings (it.skip → deny)', () => {
    const cwd = repoFixture();
    try {
      const raw = JSON.stringify({
        tool_name: 'str_replace',
        cwd,
        tool_input: {
          file_path: join(cwd, 'src', 'a.spec.ts'),
          old_str: "it('two', () => {});",
          new_str: "it.skip('two', () => {});",
        },
      });
      const r = copilotAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.wire).toContain('test-skip');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('allows an ordinary create of a non-protected file (empty wire = allow)', () => {
    const cwd = repoFixture();
    try {
      const raw = JSON.stringify({
        tool_name: 'create',
        cwd,
        tool_input: { path: join(cwd, 'src', 'feature.ts'), content: 'export const x = 1;\n' },
      });
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
      expect(r.outcome).toBe('ok');
      expect(r.decision?.verdict).toBe('allow');
      expect(r.wire).toBe('');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('CopilotRuntimeAdapter.decide — pre-action pins the Stop-sweep baseline at turn start', () => {
  it('pins the session baseline so a mutation COMMITTED mid-turn stays visible to the sweep', () => {
    const cwd = repoFixture();
    const sessionId = 'copilotsess1';
    try {
      const first = copilotAdapter.decide(
        JSON.stringify({ tool_name: 'bash', cwd, session_id: sessionId, tool_input: { command: 'cat src/a.spec.ts' } }),
        'pre-action',
        cwd,
      );
      expect(first.decision?.verdict).toBe('allow');
      expect(existsSync(join(cwd, '.git', 'tamperward', `session-${sessionId}`))).toBe(true);

      writeFileSync(join(cwd, 'src', 'a.spec.ts'), `it('one', () => {});\n`);
      const g = (args: string[]) => execFileSync('git', args, { cwd });
      g(['commit', '-qam', 'mid-turn tamper']);

      const stop = copilotAdapter.decide(JSON.stringify({ cwd, session_id: sessionId }), 'end-of-turn', cwd);
      expect(stop.decision?.verdict).toBe('deny');
      expect(stop.wire).toContain('test-deletion');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('CopilotRuntimeAdapter.decide — end-of-turn sweep in Copilot agentStop wire', () => {
  it("denies a landed shell mutation and emits Copilot's agentStop envelope {decision:block, reason}", () => {
    const cwd = repoFixture();
    try {
      writeFileSync(join(cwd, 'src', 'a.spec.ts'), `it('one', () => {});\n`);
      const raw = JSON.stringify({ cwd });
      const r = copilotAdapter.decide(raw, 'end-of-turn', cwd);
      expect(r.outcome).toBe('ok');
      expect(r.decision?.verdict).toBe('deny');
      const j = JSON.parse(r.wire as string);
      // agentStop output is a flat {decision:block, reason}, no hookSpecificOutput.
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
      const r = copilotAdapter.decide(JSON.stringify({ cwd }), 'end-of-turn', cwd);
      expect(r.decision?.verdict).toBe('allow');
      expect(r.wire).toBe('');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('CopilotRuntimeAdapter.decide — failure states fail CLOSED (deny)', () => {
  it('a parse-failure is classified and fails closed in the flat Copilot wire', () => {
    const r = copilotAdapter.decide('[1,2,3]', 'pre-action');
    expect(r.outcome).toBe('parse-failure');
    expect(r.decision?.verdict).toBe('deny');
    const j = JSON.parse(r.wire as string);
    expect(j.permissionDecision).toBe('deny');
    expect(j.hookSpecificOutput).toBeUndefined();
  });

  it('a cross-repo identity claim fails closed BEFORE evaluation', () => {
    const A = repoFixture();
    const B = repoFixture();
    try {
      const raw = JSON.stringify({ tool_name: 'bash', tool_input: { command: 'rm src/a.spec.ts' }, cwd: B });
      const r = copilotAdapter.decide(raw, 'pre-action', A);
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
      const raw = JSON.stringify({ tool_name: 'bash', tool_input: { command: 'rm x' }, cwd: '   ' });
      const r = copilotAdapter.decide(raw, 'pre-action', A);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.detail).toMatch(/malformed/);
    } finally {
      rmSync(A, { recursive: true, force: true });
    }
  });

  it('an edit event with no path fails CLOSED, never allow', () => {
    const cwd = repoFixture();
    try {
      const raw = JSON.stringify({ tool_name: 'edit', cwd, tool_input: { old_string: 'a', new_string: 'b' } });
      const r = copilotAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a create event with a path but no content fails CLOSED, never allow', () => {
    const cwd = repoFixture();
    try {
      const raw = JSON.stringify({ tool_name: 'create', cwd, tool_input: { path: join(cwd, 'src', 'x.ts') } });
      const r = copilotAdapter.decide(raw, 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a recognized shell (bash) event with no command fails CLOSED, never allow', () => {
    const cwd = repoFixture();
    try {
      for (const ti of [{}, { command: '' }, { argv: [] }]) {
        const r = copilotAdapter.decide(JSON.stringify({ tool_name: 'bash', cwd, tool_input: ti }), 'pre-action', cwd);
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
      expect(result.wire).toBeTruthy();
      expect(result.decision?.verdict).toBe('deny');
      expect(result.decision?.findings[0].rule).toBe('tamperward-unavailable');
      const wire = JSON.parse(result.wire as string);
      expect(wire.permissionDecision).toBe('deny');
    }
  });
});

describe('CopilotRuntimeAdapter — post-action is observation-only', () => {
  it('decide(..., post-action) returns unsupported, no wire, no decision', () => {
    const cwd = repoFixture();
    try {
      const raw = JSON.stringify({ tool_name: 'bash', tool_input: { command: 'rm src/a.spec.ts' }, cwd });
      const r = copilotAdapter.decide(raw, 'post-action', cwd);
      expect(r.outcome).toBe('unsupported');
      expect(r.wire).toBeUndefined();
      expect(r.decision).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('copilotDenyWire — the documented Copilot deny envelope', () => {
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
    const j = JSON.parse(copilotWire('because', 'pre-action'));
    expect(j.permissionDecisionReason).toBe('because');
  });

  it('rejects observation-only post-action instead of producing a veto wire', () => {
    expect(() => copilotWire('because', 'post-action' as never)).toThrow(/unsupported Copilot wire phase/);
    expect(() => copilotDenyWire(findings, 'post-action' as never)).toThrow(/unsupported Copilot wire phase/);
  });

  it('rejects post-action at the adapter deny boundary', () => {
    expect(() => copilotAdapter.denyPayload(findings, 'post-action')).toThrow(
      /observation-only and cannot produce a deny wire/,
    );
    expect(() => copilotAdapter.failClosed('transport-failure', 'broken hook', 'post-action')).toThrow(
      /observation-only and cannot produce a deny wire/,
    );
  });
});
