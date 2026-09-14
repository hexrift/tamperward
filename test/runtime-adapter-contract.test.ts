// #482 Phase 1: the Claude RuntimeAdapter conforms to the neutral steering contract and
// is byte-identical to the legacy live hook path. The existing hook suite proves the
// verdicts themselves; this suite proves the NEUTRAL SEAM adds no divergence — the
// adapter's decisions and wire bytes equal `preToolUseFromRaw` / `stopFromRaw`, the
// capability declaration is correct, and every failure state fails closed.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAdapter, ClaudeRuntimeAdapter } from '../src/adapters/claude/adapter';
import { preToolUseFromRaw, stopFromRaw, denyWire } from '../src/cli/hook';
import { formatDenial } from '../src/adapters/claude/deny';
import { OPERATION_KINDS, failsClosed, steeringUnavailableFinding } from '../src/adapters/contract';
import { Finding } from '../src/types';

// A git repo with a protected spec, a policy, and a wired hook + CI, committed as the
// trusted base — the substrate the deletion/skip/policy/CI fixtures mutate.
function repoFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hf-radapter-'));
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

// The neutral fixtures the issue lists, expressed as a PreToolUse (pre-action) raw payload
// that TamperWard must DENY. Each is real tampering, not a benign edit.
function preActionDenyFixtures(cwd: string): { name: string; raw: string }[] {
  const specPath = join(cwd, 'src', 'a.spec.ts');
  return [
    {
      name: 'protected test deletion via shell',
      raw: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm src/a.spec.ts' }, cwd }),
    },
    {
      name: 'test skip via Write',
      raw: JSON.stringify({
        tool_name: 'Write',
        cwd,
        tool_input: { file_path: specPath, content: `it('one', () => {});\nit.skip('two', () => {});\n` },
      }),
    },
    {
      name: 'policy weakening via Edit (added ignore glob)',
      raw: JSON.stringify({
        tool_name: 'Edit',
        cwd,
        tool_input: {
          file_path: join(cwd, '.tamperward.yml'),
          old_string: 'version: 1',
          new_string: "version: 1\nignore: ['**/*.spec.ts']",
        },
      }),
    },
    {
      name: 'CI weakening via Write',
      raw: JSON.stringify({
        tool_name: 'Write',
        cwd,
        tool_input: {
          file_path: join(cwd, '.github', 'workflows', 'ci.yml'),
          content: 'name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true" # skip\n',
        },
      }),
    },
    {
      name: 'hook wiring weakening via Write',
      raw: JSON.stringify({
        tool_name: 'Write',
        cwd,
        tool_input: { file_path: join(cwd, '.claude', 'settings.json'), content: JSON.stringify({ hooks: {} }) },
      }),
    },
    {
      name: 'no-verify shell commit',
      raw: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m wip' }, cwd }),
    },
  ];
}

describe('ClaudeRuntimeAdapter — conformance to the neutral RuntimeAdapter contract', () => {
  it('exposes a stable name and a fresh instance is equivalent to the singleton', () => {
    expect(claudeAdapter.name).toBe('claude-code');
    expect(new ClaudeRuntimeAdapter().name).toBe('claude-code');
  });

  it('declares Claude = all-operation pre-deny + end-of-turn; post-observe empty; gaps explicit', () => {
    const caps = claudeAdapter.capabilities;
    // pre-deny covers EVERY operation kind (PreToolUse fires for all tools).
    expect([...caps.preDeny].sort()).toEqual([...OPERATION_KINDS].sort());
    expect(caps.endOfTurn).toBe(true);
    // No live per-tool post-action veto — the Stop sweep is the post-turn reconciliation.
    expect(caps.postObserve).toEqual([]);
    expect(caps.unsupported.length).toBeGreaterThan(0);
  });
});

describe('ClaudeRuntimeAdapter.decide — byte-identical to the legacy hook path', () => {
  it('pre-action decisions match preToolUseFromRaw over every neutral deny fixture', () => {
    const cwd = repoFixture();
    try {
      for (const fx of preActionDenyFixtures(cwd)) {
        const legacy = preToolUseFromRaw(fx.raw);
        const result = claudeAdapter.decide(fx.raw, 'pre-action');
        // The fixture is real tampering: the legacy path must deny it...
        expect(legacy.stdout.length, `${fx.name}: legacy should deny`).toBeGreaterThan(0);
        expect(legacy.exitCode).toBe(0);
        // ...and the adapter is byte-identical, with a matching classified decision.
        expect(result.wire, `${fx.name}: wire bytes`).toBe(legacy.stdout);
        expect(result.outcome).toBe('ok');
        expect(result.decision?.verdict).toBe('deny');
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('an allowed pre-action matches too (empty wire = allow)', () => {
    const cwd = repoFixture();
    try {
      const raw = JSON.stringify({
        tool_name: 'Write',
        cwd,
        tool_input: { file_path: join(cwd, 'src', 'feature.ts'), content: 'export const x = 1;\n' },
      });
      const legacy = preToolUseFromRaw(raw);
      const result = claudeAdapter.decide(raw, 'pre-action');
      expect(legacy.stdout).toBe('');
      expect(result.wire).toBe('');
      expect(result.outcome).toBe('ok');
      expect(result.decision?.verdict).toBe('allow');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('empty stdin is a well-formed absence → allow (matches legacy)', () => {
    const legacy = preToolUseFromRaw('');
    const result = claudeAdapter.decide('', 'pre-action');
    expect(legacy.stdout).toBe('');
    expect(result.outcome).toBe('ok');
    expect(result.decision?.verdict).toBe('allow');
    expect(result.wire).toBe('');
  });

  it('end-of-turn sweep decision matches stopFromRaw over a landed shell mutation', () => {
    const cwd = repoFixture();
    try {
      // A protected block stripped on disk AFTER the base — the pre-action layer never saw it.
      writeFileSync(join(cwd, 'src', 'a.spec.ts'), `it('one', () => {});\n`);
      const raw = JSON.stringify({ cwd });
      const legacy = stopFromRaw(raw);
      const result = claudeAdapter.decide(raw, 'end-of-turn');
      expect(legacy.stdout.length).toBeGreaterThan(0);
      expect(legacy.stdout).toContain('test-deletion');
      expect(result.wire).toBe(legacy.stdout);
      expect(result.outcome).toBe('ok');
      expect(result.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('ClaudeRuntimeAdapter.denyPayload — byte-matches the live verdict() wire', () => {
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

  it('pre-action wire equals PreToolUse verdict serialisation', () => {
    expect(claudeAdapter.denyPayload(findings, 'pre-action')).toBe(denyWire(formatDenial(findings), 'PreToolUse'));
  });

  it('end-of-turn wire equals Stop verdict serialisation', () => {
    expect(claudeAdapter.denyPayload(findings, 'end-of-turn')).toBe(denyWire(formatDenial(findings), 'Stop'));
  });

  it('the wire is the exact documented shape (PreToolUse deny at exit 0)', () => {
    const wire = claudeAdapter.denyPayload(findings, 'pre-action');
    const j = JSON.parse(wire);
    expect(j.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(j.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(typeof j.hookSpecificOutput.permissionDecisionReason).toBe('string');
    expect(wire.endsWith('\n')).toBe(true);
  });
});

describe('ClaudeRuntimeAdapter — failure states fail closed (deny)', () => {
  it('a parse-failure is classified as parse-failure and the wire is a fail-closed deny', () => {
    // A JSON array is a valid-JSON payload of the wrong shape → HookInputError → failClosed.
    const raw = '[1,2,3]';
    const parsed = claudeAdapter.parseEvent(raw, 'pre-action');
    expect('failure' in parsed && parsed.failure).toBe('parse-failure');
    const result = claudeAdapter.decide(raw, 'pre-action');
    expect(result.outcome).toBe('parse-failure');
    expect(result.decision?.verdict).toBe('deny');
    expect(result.wire && result.wire.length).toBeGreaterThan(0);
    // Byte-identical to the live fail-closed path.
    expect(result.wire).toBe(preToolUseFromRaw(raw).stdout);
    const j = JSON.parse(result.wire as string);
    expect(j.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('a truncated / non-JSON payload also fails closed', () => {
    const raw = '{ "tool_name": "Bash", ';
    const result = claudeAdapter.decide(raw, 'pre-action');
    expect(result.outcome).toBe('parse-failure');
    expect(result.decision?.verdict).toBe('deny');
    expect(result.wire).toBe(preToolUseFromRaw(raw).stdout);
  });

  it('a transport-failure maps to a fail-closed deny at the seam', () => {
    const result = claudeAdapter.failClosed('transport-failure', 'hook service unreachable', 'pre-action');
    expect(result.outcome).toBe('transport-failure');
    expect(result.decision?.verdict).toBe('deny');
    const j = JSON.parse(result.wire as string);
    expect(j.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.decision?.findings[0].rule).toBe('tamperward-unavailable');
  });

  it('a required not-invoked hook maps to a fail-closed deny', () => {
    const result = claudeAdapter.failClosed('not-invoked', 'PreToolUse hook did not fire', 'pre-action');
    expect(result.outcome).toBe('not-invoked');
    expect(result.decision?.verdict).toBe('deny');
  });

  it('failsClosed() marks exactly the deny-mapping outcomes', () => {
    expect(failsClosed('parse-failure')).toBe(true);
    expect(failsClosed('transport-failure')).toBe(true);
    expect(failsClosed('not-invoked')).toBe(true);
    expect(failsClosed('ok')).toBe(false);
    expect(failsClosed('unsupported')).toBe(false);
    expect(steeringUnavailableFinding('x').severity).toBe('block');
  });
});

describe('ClaudeRuntimeAdapter.validateIdentity — runtime cwd is a claim, not authority', () => {
  it('derives the trusted root INDEPENDENTLY from a valid repo cwd', () => {
    const cwd = repoFixture();
    try {
      const v = claudeAdapter.validateIdentity({ claimedCwd: cwd });
      expect(v.ok).toBe(true);
      // The trusted root is git's canonical toplevel, derived without trusting the claim.
      expect(v.trustedRoot && v.trustedRoot.length).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a subdirectory claim still resolves to the repository ROOT (#412 boundary preserved)', () => {
    const cwd = repoFixture();
    try {
      const root = claudeAdapter.validateIdentity({ claimedCwd: cwd }).trustedRoot;
      const sub = claudeAdapter.validateIdentity({ claimedCwd: join(cwd, 'src') }).trustedRoot;
      expect(sub).toBe(root);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a malformed (empty) cwd claim', () => {
    const v = claudeAdapter.validateIdentity({ claimedCwd: '   ' });
    expect(v.ok).toBe(false);
    expect(v.rejected).toMatch(/malformed/);
  });

  it('rejects a claim that resolves to no repository', () => {
    const v = claudeAdapter.validateIdentity({ claimedCwd: join(tmpdir(), 'hf-not-a-repo-xyz-482') });
    expect(v.ok).toBe(false);
    expect(v.rejected).toMatch(/no repository/);
  });
});
