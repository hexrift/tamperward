// #748: every registered RuntimeAdapter runs the SAME neutral fixtures that established the
// Claude semantics (#482), fed as that adapter's native payload. The engine findings must be
// identical across adapters, the deny wire must satisfy each adapter's own envelope contract
// and carry the shared denial text, every failure state must fail closed, and the end-of-turn
// sweep must catch a landed mutation whichever adapter asked. A new adapter registered without
// a payload builder here fails the suite.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_ADAPTERS } from '../src/adapters/registry';
import { RuntimeAdapter, SteeringPhase, SteeringResult } from '../src/adapters/contract';
import { formatDenial } from '../src/adapters/claude/deny';
import { Finding } from '../src/types';

function repoFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hf-parity-'));
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir });
  g(['init', '-q']);
  g(['config', 'user.email', 'h@x']);
  g(['config', 'user.name', 'h']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.spec.ts'), `it('one', () => {}); it('two', () => {});\n`);
  writeFileSync(
    join(dir, '.tamperward.yml'),
    "version: 1\nprotected:\n  tests: ['**/*.spec.ts']\n  ci: ['.github/workflows/**']\n  hooks: ['.claude/settings.json']\n",
  );
  writeFileSync(
    join(dir, '.github', 'workflows', 'ci.yml'),
    'name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
  );
  writeFileSync(
    join(dir, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'tamperward hook claude' }] }] } }),
  );
  g(['add', '-A']);
  g(['commit', '-qm', 'seed']);
  return dir;
}

// The neutral fixtures, described once, independently of any runtime's vocabulary.
type NeutralOperation =
  | { kind: 'shell'; command: string }
  | { kind: 'write'; path: string; content: string }
  | { kind: 'edit'; path: string; oldString: string; newString: string };

interface NeutralFixture {
  name: string;
  operation: NeutralOperation;
}

const SESSION = 'parity-session';

const DENY_FIXTURES: NeutralFixture[] = [
  { name: 'protected test deletion via shell', operation: { kind: 'shell', command: 'rm src/a.spec.ts' } },
  { name: 'test skip via write', operation: { kind: 'write', path: 'src/a.spec.ts', content: `it('one', () => {});\nit.skip('two', () => {});\n` } },
  {
    name: 'policy weakening via edit (added ignore glob)',
    operation: { kind: 'edit', path: '.tamperward.yml', oldString: 'version: 1', newString: "version: 1\nignore: ['**/*.spec.ts']" },
  },
  {
    name: 'CI weakening via write',
    operation: {
      kind: 'write',
      path: '.github/workflows/ci.yml',
      content: 'name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true" # skip\n',
    },
  },
  { name: 'hook wiring weakening via write', operation: { kind: 'write', path: '.claude/settings.json', content: JSON.stringify({ hooks: {} }) } },
  { name: 'no-verify shell commit', operation: { kind: 'shell', command: 'git commit --no-verify -m wip' } },
];

const ALLOW_FIXTURE: NeutralFixture = { name: 'benign feature write', operation: { kind: 'write', path: 'src/feature.ts', content: 'export const x = 1;\n' } };

// A neutral operation rendered as the bytes each runtime actually hands its adapter.
interface NativePayloads {
  preAction(cwd: string, op: NeutralOperation): string;
  endOfTurn(cwd: string): string;
  /** The agent-facing denial text inside this adapter's deny envelope, by phase. */
  reasonOf(wire: string, phase: 'pre-action' | 'end-of-turn'): string;
}

function editedContent(cwd: string, path: string, oldString: string, newString: string): string {
  const before = readFileSync(join(cwd, path), 'utf8');
  expect(before.includes(oldString), `${path} must contain the edit anchor`).toBe(true);
  return before.replace(oldString, newString);
}

const NATIVE: Record<string, NativePayloads> = {
  'claude-code': {
    preAction(cwd, op) {
      const base = { cwd, session_id: SESSION };
      if (op.kind === 'shell') return JSON.stringify({ ...base, tool_name: 'Bash', tool_input: { command: op.command } });
      if (op.kind === 'write') return JSON.stringify({ ...base, tool_name: 'Write', tool_input: { file_path: join(cwd, op.path), content: op.content } });
      return JSON.stringify({ ...base, tool_name: 'Edit', tool_input: { file_path: join(cwd, op.path), old_string: op.oldString, new_string: op.newString } });
    },
    endOfTurn: (cwd) => JSON.stringify({ cwd, session_id: SESSION }),
    reasonOf(wire, phase) {
      const j = JSON.parse(wire);
      if (phase === 'end-of-turn') {
        expect(j.decision).toBe('block');
        return j.reason;
      }
      expect(j.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(j.hookSpecificOutput.permissionDecision).toBe('deny');
      return j.hookSpecificOutput.permissionDecisionReason;
    },
  },
  codex: {
    preAction(cwd, op) {
      const base = { cwd, session_id: SESSION };
      if (op.kind === 'shell') return JSON.stringify({ ...base, tool_name: 'Bash', tool_input: { command: op.command } });
      if (op.kind === 'write') return JSON.stringify({ ...base, tool_name: 'Write', tool_input: { path: op.path, content: op.content } });
      return JSON.stringify({ ...base, tool_name: 'Edit', tool_input: { path: op.path, old_string: op.oldString, new_string: op.newString } });
    },
    endOfTurn: (cwd) => JSON.stringify({ cwd, session_id: SESSION }),
    reasonOf(wire, phase) {
      const j = JSON.parse(wire);
      expect(j.decision).toBe('block');
      if (phase === 'end-of-turn') return j.reason;
      expect(j.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(j.hookSpecificOutput.permissionDecisionReason).toBe(j.reason);
      return j.reason;
    },
  },
  'github-copilot-cli': {
    preAction(cwd, op) {
      const base = { cwd, sessionId: SESSION, timestamp: 0 };
      if (op.kind === 'shell') return JSON.stringify({ ...base, toolName: 'bash', toolArgs: JSON.stringify({ command: op.command }) });
      if (op.kind === 'write') return JSON.stringify({ ...base, toolName: 'create', toolArgs: JSON.stringify({ path: op.path, content: op.content }) });
      return JSON.stringify({ ...base, toolName: 'edit', toolArgs: JSON.stringify({ path: op.path, old_string: op.oldString, new_string: op.newString }) });
    },
    endOfTurn: (cwd) => JSON.stringify({ cwd, sessionId: SESSION, stopReason: 'end' }),
    reasonOf(wire, phase) {
      const j = JSON.parse(wire);
      if (phase === 'end-of-turn') {
        expect(j.decision).toBe('block');
        return j.reason;
      }
      expect(j.permissionDecision).toBe('deny');
      return j.permissionDecisionReason;
    },
  },
  'github-copilot-sdk-hosted': {
    preAction(cwd, op) {
      const base = { cwd, sessionId: SESSION, toolCallId: 't1' };
      if (op.kind === 'shell') return JSON.stringify({ ...base, kind: 'shell', toolName: 'shell', fullCommandText: op.command });
      const newFileContents = op.kind === 'write' ? op.content : editedContent(cwd, op.path, op.oldString, op.newString);
      return JSON.stringify({ ...base, kind: 'write', toolName: 'write', fileName: op.path, newFileContents });
    },
    endOfTurn: (cwd) => JSON.stringify({ cwd, sessionId: SESSION }),
    reasonOf(wire, phase) {
      const j = JSON.parse(wire);
      if (phase === 'end-of-turn') {
        expect(j.decision).toBe('block');
        return j.reason;
      }
      expect(j.kind).toBe('reject');
      return j.feedback;
    },
  },
};

type FailClosingAdapter = RuntimeAdapter & {
  failClosed(outcome: 'transport-failure' | 'not-invoked', detail: string, phase: SteeringPhase): SteeringResult;
};

const ADAPTER_NAMES = RUNTIME_ADAPTERS.map((a) => a.name);
const REFERENCE = RUNTIME_ADAPTERS[0];

function native(adapter: RuntimeAdapter): NativePayloads {
  const n = NATIVE[adapter.name];
  if (!n) throw new Error(`no native payload builder for registered adapter ${adapter.name}: add it to the parity suite`);
  return n;
}

function decideIn(adapter: RuntimeAdapter, cwd: string, fx: NeutralFixture): SteeringResult {
  return adapter.decide(native(adapter).preAction(cwd, fx.operation), 'pre-action', cwd);
}

function withRepo<T>(fn: (cwd: string) => T): T {
  const cwd = repoFixture();
  try {
    return fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('cross-adapter parity — registry coverage', () => {
  it('every registered adapter has a native payload builder, and no builder is orphaned', () => {
    expect([...ADAPTER_NAMES].sort()).toEqual(Object.keys(NATIVE).sort());
  });

  it('every registered adapter exposes a fail-closed seam for transport failure and a hook that never fired', () => {
    for (const adapter of RUNTIME_ADAPTERS) {
      expect(typeof (adapter as Partial<FailClosingAdapter>).failClosed, adapter.name).toBe('function');
    }
  });
});

describe.each(DENY_FIXTURES)('cross-adapter parity — $name', (fx) => {
  it('every adapter denies with the findings the reference adapter produces', () => {
    withRepo((cwd) => {
      const reference = decideIn(REFERENCE, cwd, fx);
      expect(reference.outcome).toBe('ok');
      expect(reference.decision?.verdict).toBe('deny');
      expect(reference.decision?.findings.length).toBeGreaterThan(0);
      for (const adapter of RUNTIME_ADAPTERS) {
        const r = decideIn(adapter, cwd, fx);
        expect(r.outcome, adapter.name).toBe('ok');
        expect(r.decision?.verdict, adapter.name).toBe('deny');
        expect(r.decision?.findings, adapter.name).toEqual(reference.decision?.findings);
      }
    });
  });

  it("every adapter's deny wire is its own native envelope carrying the shared denial text", () => {
    withRepo((cwd) => {
      for (const adapter of RUNTIME_ADAPTERS) {
        const r = decideIn(adapter, cwd, fx);
        const findings = r.decision?.findings as Finding[];
        expect(r.wire, adapter.name).toBe(adapter.denyPayload(findings, 'pre-action'));
        expect(r.wire?.endsWith('\n'), adapter.name).toBe(true);
        expect(native(adapter).reasonOf(r.wire as string, 'pre-action'), adapter.name).toBe(formatDenial(findings));
        expect(r.decision?.reason, adapter.name).toBe(r.wire);
      }
    });
  });
});

describe('cross-adapter parity — a benign write', () => {
  it('is allowed by every adapter with an empty wire and no findings', () => {
    withRepo((cwd) => {
      for (const adapter of RUNTIME_ADAPTERS) {
        const r = decideIn(adapter, cwd, ALLOW_FIXTURE);
        expect(r.outcome, adapter.name).toBe('ok');
        expect(r.decision?.verdict, adapter.name).toBe('allow');
        expect(r.decision?.findings, adapter.name).toEqual([]);
        expect(r.wire, adapter.name).toBe('');
      }
    });
  });
});

describe('cross-adapter parity — failure states fail closed, never allow', () => {
  it.each(['[1,2,3]', '{ "tool_name": "Bash", ', '"just a string"'])('an unparseable payload %j denies on every adapter', (raw) => {
    withRepo((cwd) => {
      for (const adapter of RUNTIME_ADAPTERS) {
        const r = adapter.decide(raw, 'pre-action', cwd);
        expect(r.outcome, adapter.name).toBe('parse-failure');
        expect(r.decision?.verdict, adapter.name).toBe('deny');
        expect(r.decision?.findings.map((f) => f.rule), adapter.name).toEqual(['tamperward-unavailable']);
        expect(native(adapter).reasonOf(r.wire as string, 'pre-action'), adapter.name).toContain('tamperward-unavailable');
      }
    });
  });

  it.each(['transport-failure', 'not-invoked'] as const)('a %s denies in every adapter’s native pre-action and end-of-turn envelope', (outcome) => {
    for (const adapter of RUNTIME_ADAPTERS as readonly FailClosingAdapter[]) {
      for (const phase of ['pre-action', 'end-of-turn'] as const) {
        const r = adapter.failClosed(outcome, 'seam failure', phase);
        expect(r.outcome, adapter.name).toBe(outcome);
        expect(r.decision?.verdict, adapter.name).toBe('deny');
        expect(r.decision?.findings.map((f) => f.rule), adapter.name).toEqual(['tamperward-unavailable']);
        expect(native(adapter).reasonOf(r.wire as string, phase), adapter.name).toBe(formatDenial(r.decision?.findings as Finding[]));
      }
    }
  });

  it('a cwd claim naming a different repository denies on identity in every adapter, before any content is judged', () => {
    withRepo((runner) => {
      withRepo((other) => {
        for (const adapter of RUNTIME_ADAPTERS) {
          const r = adapter.decide(native(adapter).preAction(other, ALLOW_FIXTURE.operation), 'pre-action', runner);
          expect(r.outcome, adapter.name).toBe('ok');
          expect(r.decision?.verdict, adapter.name).toBe('deny');
          expect(r.decision?.findings.map((f) => f.rule), adapter.name).toEqual(['tamperward-unavailable']);
          expect(r.detail, adapter.name).toMatch(/different repository|not the runner/i);
        }
      });
    });
  });

  it('post-action is unsupported on every adapter: no decision, no wire, never an allow', () => {
    for (const adapter of RUNTIME_ADAPTERS) {
      const r = adapter.decide('{}', 'post-action');
      expect(r.outcome, adapter.name).toBe('unsupported');
      expect(r.decision, adapter.name).toBeUndefined();
      expect(r.wire, adapter.name).toBeUndefined();
      expect(() => adapter.denyPayload([], 'post-action'), adapter.name).toThrow();
    }
  });
});

describe('cross-adapter parity — the end-of-turn sweep is the final authority whichever adapter asks', () => {
  it('a mutation that landed out of band is caught with identical findings by every adapter', () => {
    withRepo((cwd) => {
      for (const adapter of RUNTIME_ADAPTERS) {
        decideIn(adapter, cwd, { name: 'turn start', operation: { kind: 'shell', command: 'cat src/a.spec.ts' } });
      }
      writeFileSync(join(cwd, 'src', 'a.spec.ts'), `it('one', () => {});\n`);
      const reference = REFERENCE.decide(native(REFERENCE).endOfTurn(cwd), 'end-of-turn', cwd);
      expect(reference.decision?.verdict).toBe('deny');
      expect(reference.decision?.findings.map((f) => f.rule)).toContain('test-deletion');
      for (const adapter of RUNTIME_ADAPTERS) {
        const r = adapter.decide(native(adapter).endOfTurn(cwd), 'end-of-turn', cwd);
        expect(r.outcome, adapter.name).toBe('ok');
        expect(r.decision?.verdict, adapter.name).toBe('deny');
        expect(r.decision?.findings, adapter.name).toEqual(reference.decision?.findings);
        expect(r.wire, adapter.name).toBe(reference.wire);
        expect(native(adapter).reasonOf(r.wire as string, 'end-of-turn'), adapter.name).toBe(formatDenial(r.decision?.findings as Finding[]));
      }
    });
  });

  it('a clean tree lets every adapter stop with an empty wire', () => {
    withRepo((cwd) => {
      for (const adapter of RUNTIME_ADAPTERS) {
        const r = adapter.decide(native(adapter).endOfTurn(cwd), 'end-of-turn', cwd);
        expect(r.outcome, adapter.name).toBe('ok');
        expect(r.decision?.verdict, adapter.name).toBe('allow');
        expect(r.wire, adapter.name).toBe('');
      }
    });
  });
});
