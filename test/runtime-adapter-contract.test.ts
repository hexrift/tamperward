// #482 Phase 1: the Claude RuntimeAdapter conforms to the neutral steering contract and
// is byte-identical to the legacy live hook path. The existing hook suite proves the
// verdicts themselves; this suite proves the NEUTRAL SEAM adds no divergence — the
// adapter's decisions and wire bytes equal `preToolUseFromRaw` / `stopFromRaw`, the
// capability declaration is correct, and every failure state fails closed.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAdapter, ClaudeRuntimeAdapter } from '../src/adapters/claude/adapter';
import { preToolUseFromRaw, stopFromRaw, denyWire, preToolUseVerdict, stopVerdict } from '../src/cli/hook';
import { repoContext, validateClaimAgainstRoot } from '../src/repo-context';
import { formatDenial } from '../src/adapters/claude/deny';
import { OPERATION_KINDS, failsClosed, steeringUnavailableFinding, CONTRACT_TO_RESEARCH_LAYER } from '../src/adapters/contract';
import { ADAPTER_LAYERS } from '../src/research/adapter';
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

  it('declares only reconstructable Claude pre-deny operations and names the MCP gap', () => {
    const caps = claudeAdapter.capabilities;
    expect([...caps.preDeny].sort()).toEqual(
      [...OPERATION_KINDS.filter((kind) => kind !== 'mcp' && kind !== 'other')].sort(),
    );
    expect(caps.endOfTurn).toBe(true);
    expect(caps.postObserve).toEqual([]);
    expect(caps.unsupported.join('\n')).toMatch(/MCP pre-deny is not declared/i);
    expect(caps.unsupported.join('\n')).toMatch(/other-tool pre-deny is not declared/i);
  });
});

describe('ClaudeRuntimeAdapter.decide — byte-identical to the legacy hook path', () => {
  it('pre-action decisions match preToolUseFromRaw over every neutral deny fixture', () => {
    const cwd = repoFixture();
    try {
      for (const fx of preActionDenyFixtures(cwd)) {
        const legacy = preToolUseFromRaw(fx.raw);
        const result = claudeAdapter.decide(fx.raw, 'pre-action', cwd);
        // The fixture is real tampering: the legacy path must deny it...
        expect(legacy.stdout.length, `${fx.name}: legacy should deny`).toBeGreaterThan(0);
        expect(legacy.exitCode).toBe(0);
        // ...and the adapter is byte-identical, with a matching classified decision.
        expect(result.wire, `${fx.name}: wire bytes`).toBe(legacy.stdout);
        expect(result.outcome).toBe('ok');
        expect(result.decision?.verdict).toBe('deny');
        expect(result.decision?.findings).toEqual(legacy.findings);
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
      const result = claudeAdapter.decide(raw, 'pre-action', cwd);
      expect(legacy.stdout).toBe('');
      expect(result.wire).toBe('');
      expect(result.outcome).toBe('ok');
      expect(result.decision?.verdict).toBe('allow');
      expect(result.decision?.findings).toEqual([]);
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
      const result = claudeAdapter.decide(raw, 'end-of-turn', cwd);
      expect(legacy.stdout.length).toBeGreaterThan(0);
      expect(legacy.stdout).toContain('test-deletion');
      expect(result.wire).toBe(legacy.stdout);
      expect(result.outcome).toBe('ok');
      expect(result.decision?.verdict).toBe('deny');
      expect(result.decision?.findings).toEqual(legacy.findings);
      expect(result.decision?.findings[0]?.rule).toBe('test-deletion');
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
    const live = preToolUseFromRaw(raw);
    expect(result.decision?.findings).toEqual(live.findings);
    expect(result.decision?.findings[0]?.rule).toBe('tamperward-unavailable');
    // Byte-identical to the live fail-closed path.
    expect(result.wire).toBe(live.stdout);
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
  it('accepts a claim that matches the runner trusted root, derived INDEPENDENTLY of the claim', () => {
    const cwd = repoFixture();
    try {
      // Runner (defaultCwd) IS the repo; the claim names the same repo → accepted.
      const v = claudeAdapter.validateIdentity({ claimedCwd: cwd }, cwd);
      expect(v.ok).toBe(true);
      // The trusted root is git's canonical toplevel — realpath of the fixture dir.
      expect(v.trustedRoot).toBe(realpathSync(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a subdirectory claim still resolves to the repository ROOT (#412 boundary preserved)', () => {
    const cwd = repoFixture();
    try {
      const root = claudeAdapter.validateIdentity({ claimedCwd: cwd }, cwd).trustedRoot;
      const sub = claudeAdapter.validateIdentity({ claimedCwd: join(cwd, 'src') }, cwd).trustedRoot;
      expect(sub).toBe(root);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a malformed (empty) cwd claim', () => {
    const cwd = repoFixture();
    try {
      const v = claudeAdapter.validateIdentity({ claimedCwd: '   ' }, cwd);
      expect(v.ok).toBe(false);
      expect(v.rejected).toMatch(/malformed/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a claim that resolves to no repository (a real directory that is not a repo)', () => {
    const cwd = repoFixture();
    const notRepo = mkdtempSync(join(tmpdir(), 'hf-norepo-claim-'));
    try {
      const v = claudeAdapter.validateIdentity({ claimedCwd: notRepo }, cwd);
      expect(v.ok).toBe(false);
      expect(v.rejected).toMatch(/no repository/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it('rejects a claim whose path cannot be resolved (non-existent / broken)', () => {
    const cwd = repoFixture();
    try {
      const v = claudeAdapter.validateIdentity({ claimedCwd: join(tmpdir(), 'hf-nonexistent-xyz-482') }, cwd);
      expect(v.ok).toBe(false);
      expect(v.rejected).toMatch(/cannot be resolved/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a claim that resolves to a DIFFERENT repository than the runner (cross-repo)', () => {
    const runner = repoFixture(); // repo A
    const other = repoFixture(); // repo B
    try {
      const v = claudeAdapter.validateIdentity({ claimedCwd: other }, runner);
      expect(v.ok).toBe(false);
      expect(v.rejected).toMatch(/different repository/);
    } finally {
      rmSync(runner, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('rejects a symlink claim that escapes into another repository', () => {
    const runner = repoFixture(); // repo A
    const other = repoFixture(); // repo B
    const link = join(runner, 'escape'); // lives in A, points into B
    try {
      symlinkSync(other, link);
      const v = claudeAdapter.validateIdentity({ claimedCwd: link }, runner);
      expect(v.ok).toBe(false);
      expect(v.rejected).toMatch(/different repository/);
    } finally {
      rmSync(runner, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('rejects when the runner cwd itself is not in a repository (no trusted root)', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'hf-runner-norepo-'));
    try {
      const v = claudeAdapter.validateIdentity({ claimedCwd: notRepo }, notRepo);
      expect(v.ok).toBe(false);
      expect(v.rejected).toMatch(/not in a repository/);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });
});

describe('BLOCKER 1 — decide() ENFORCES identity validation and fails closed on a bad claim', () => {
  // The tampering payload is real (a shell test-deletion): if decide evaluated it in the
  // CLAIMED repo it would deny on test-deletion; if it ignored identity it would evaluate
  // the wrong repo. We assert it denies on IDENTITY, before any content evaluation.
  function tamperRawInRepo(repo: string): string {
    return JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm src/a.spec.ts' }, cwd: repo });
  }

  it('runner in repo A + claimed cwd in a DIFFERENT repo B → decide denies on identity', () => {
    const A = repoFixture();
    const B = repoFixture();
    try {
      const result = claudeAdapter.decide(tamperRawInRepo(B), 'pre-action', A);
      expect(result.decision?.verdict).toBe('deny');
      expect(result.wire && result.wire.length).toBeGreaterThan(0);
      // The deny is the identity rejection, NOT a content finding evaluated in B.
      expect(result.detail).toMatch(/different repository/);
      const j = JSON.parse(result.wire as string);
      expect(j.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(j.hookSpecificOutput.permissionDecisionReason).toMatch(/identity claim rejected/i);
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });

  it('non-repo claim → decide fails closed to deny', () => {
    const A = repoFixture();
    const nonRepo = mkdtempSync(join(tmpdir(), 'hf-nonrepo-claim-'));
    try {
      const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm x' }, cwd: nonRepo });
      const result = claudeAdapter.decide(raw, 'pre-action', A);
      expect(result.decision?.verdict).toBe('deny');
      expect(result.detail).toMatch(/no repository/);
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it('malformed claim → decide fails closed to deny', () => {
    const A = repoFixture();
    try {
      const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm x' }, cwd: '   ' });
      const result = claudeAdapter.decide(raw, 'pre-action', A);
      expect(result.decision?.verdict).toBe('deny');
      expect(result.detail).toMatch(/malformed/);
    } finally {
      rmSync(A, { recursive: true, force: true });
    }
  });

  it('symlink-escape claim → decide fails closed to deny', () => {
    const A = repoFixture();
    const B = repoFixture();
    const link = join(A, 'escape');
    try {
      symlinkSync(B, link);
      const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm x' }, cwd: link });
      const result = claudeAdapter.decide(raw, 'pre-action', A);
      expect(result.decision?.verdict).toBe('deny');
      expect(result.detail).toMatch(/different repository/);
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });

  it('the SAME-repo claim is unaffected: decide evaluates and denies on CONTENT, not identity', () => {
    const A = repoFixture();
    try {
      const result = claudeAdapter.decide(tamperRawInRepo(A), 'pre-action', A);
      expect(result.decision?.verdict).toBe('deny');
      // This deny is the content finding — byte-identical to the plain legacy path.
      expect(result.wire).toBe(preToolUseFromRaw(tamperRawInRepo(A)).stdout);
      expect(result.wire).toContain('test-deletion');
    } finally {
      rmSync(A, { recursive: true, force: true });
    }
  });
});

describe('BLOCKER (cache staleness) — a primed-then-retargeted symlink claim is rejected', () => {
  it('link primed at repo A, retargeted to repo B, now rejects on validateIdentity/decide/live path', () => {
    const A = repoFixture();
    const B = repoFixture();
    const linkDir = mkdtempSync(join(tmpdir(), 'hf-link-'));
    const link = join(linkDir, 'claim'); // an out-of-repo path that points INTO a repo
    try {
      const rootA = repoContext(A)!.root;
      // Prime: point the link at A and validate, so any unresolved-path cache caches A.
      symlinkSync(A, link);
      const primed = validateClaimAgainstRoot(link, rootA, A);
      expect(primed.ok).toBe(true);
      // Also prime the adapter/live paths against the link->A target.
      expect(claudeAdapter.validateIdentity({ claimedCwd: link }, A).ok).toBe(true);

      // Retarget the SAME link to a different repository.
      rmSync(link);
      symlinkSync(B, link);

      // The check must decide on the link's CURRENT real target (B), not the cached A.
      const after = validateClaimAgainstRoot(link, rootA, A);
      expect(after.ok).toBe(false);
      if (!after.ok) expect(after.rejected).toMatch(/different repository/);

      // decide() fails closed to deny...
      const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm x' }, cwd: link });
      const d = claudeAdapter.decide(raw, 'pre-action', A);
      expect(d.decision?.verdict).toBe('deny');
      expect(d.detail).toMatch(/different repository/);
      // ...and so does the live path with the trusted root supplied.
      expect(preToolUseVerdict({ tool_name: 'Bash', tool_input: { command: 'rm x' }, cwd: link }, A, rootA).stdout).toMatch(/identity claim rejected/i);
      expect(stopVerdict({ cwd: link }, A, rootA).stdout).toMatch(/identity claim rejected/i);
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
      rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it('positive: a symlink genuinely inside the trusted root still validates ok', () => {
    const A = repoFixture();
    const link = join(A, 'srclink'); // lives in A, points inside A
    try {
      const rootA = repoContext(A)!.root;
      symlinkSync(join(A, 'src'), link);
      const v = validateClaimAgainstRoot(link, rootA, A);
      expect(v.ok).toBe(true);
      expect(v.ok && v.trustedRoot).toBe(realpathSync(A));
    } finally {
      rmSync(A, { recursive: true, force: true });
    }
  });
});

describe('BLOCKER 1 — the LIVE verdict functions enforce a supplied trusted root (shared helper)', () => {
  it('preToolUseVerdict fails closed when input.cwd is a different repo than trustedRoot', () => {
    const A = repoFixture();
    const B = repoFixture();
    try {
      const rootA = repoContext(A)!.root;
      const input = { tool_name: 'Bash', tool_input: { command: 'rm src/a.spec.ts' }, cwd: B };
      // With the trusted root supplied, a cross-repo claim fails closed...
      const guarded = preToolUseVerdict(input, A, rootA);
      expect(guarded.stdout.length).toBeGreaterThan(0);
      expect(guarded.stdout).toMatch(/identity claim rejected/i);
      // ...and WITHOUT a trusted root, behaviour is exactly as before (dormant), so it
      // evaluates repo B normally (here: denies on B's own test-deletion).
      const dormant = preToolUseVerdict(input, A);
      expect(dormant.stdout).toContain('test-deletion');
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });

  it('stopVerdict fails closed on a cross-repo trusted-root mismatch, and is byte-identical when the claim matches', () => {
    const A = repoFixture();
    const B = repoFixture();
    try {
      const rootA = repoContext(A)!.root;
      // cross-repo claim → deny
      expect(stopVerdict({ cwd: B }, A, rootA).stdout).toMatch(/identity claim rejected/i);
      // same-repo claim → identical to the un-guarded call (both allow a clean tree)
      expect(stopVerdict({ cwd: A }, A, repoContext(A)!.root)).toEqual(stopVerdict({ cwd: A }, A));
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });
});

describe('BLOCKER 2 — post-action is observation-only and can NEVER produce a deny wire', () => {
  it('decide(..., post-action) returns unsupported, no wire, no decision, for Claude', () => {
    const cwd = repoFixture();
    try {
      // A payload that WOULD be denied at pre-action must not be denied via post-action.
      const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm src/a.spec.ts' }, cwd });
      const result = claudeAdapter.decide(raw, 'post-action', cwd);
      expect(result.outcome).toBe('unsupported');
      expect(result.wire).toBeUndefined();
      expect(result.decision).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('Claude declares no post-observe capability, so post-action carries no veto', () => {
    expect(claudeAdapter.capabilities.postObserve).toEqual([]);
  });
});

describe('COMPLETENESS — neutral contract maps onto the research adapter layers', () => {
  it('maps pre-action↔pre-tool-use, end-of-turn↔stop-sweep, post-exit-envelope↔envelope', () => {
    const byLayer = Object.fromEntries(CONTRACT_TO_RESEARCH_LAYER.map((m) => [m.source, m.layer]));
    expect(byLayer['pre-action']).toBe('pre-tool-use');
    expect(byLayer['end-of-turn']).toBe('stop-sweep');
    expect(byLayer['post-exit-envelope']).toBe('envelope');
  });

  it('every mapped layer is a real research ADAPTER_LAYERS value (cannot drift)', () => {
    for (const m of CONTRACT_TO_RESEARCH_LAYER) {
      expect(ADAPTER_LAYERS).toContain(m.layer);
    }
  });
});
