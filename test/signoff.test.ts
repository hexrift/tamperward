import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyLocalSignoffs,
  applyOobSignoffs,
  appendEntry,
  makeEntry,
  fingerprintOf,
} from '../src/signoff';
import { changesFromClaudeHook } from '../src/adapters/claude/changes';
import { preToolUseVerdict } from '../src/cli/hook';
import { evaluate } from '../src/engine';
import { defaultPolicy } from '../src/policy';
import type { Finding } from '../src/types';

const P = defaultPolicy();
const blockFinding = (over: Partial<Finding> = {}): Finding => ({
  rule: 'test-deletion',
  severity: 'block',
  file: 'src/a.test.ts',
  message: 'm',
  evidence: 'rm src/a.test.ts',
  remediation: 'r',
  signoff: { required: true, command: '' },
  ...over,
});

describe('sign-off — fingerprint binds to the specific tamper', () => {
  it('same rule+file+evidence → same fingerprint; any of them differ → different', () => {
    const a = fingerprintOf(blockFinding());
    expect(fingerprintOf(blockFinding())).toBe(a);
    expect(fingerprintOf(blockFinding({ file: 'src/b.test.ts' }))).not.toBe(a);
    expect(fingerprintOf(blockFinding({ evidence: 'rm src/a.test.ts # different' }))).not.toBe(a);
    expect(fingerprintOf(blockFinding({ rule: 'test-skip' }))).not.toBe(a);
  });
});

describe('LOCAL layer — honors a fingerprint-bound, unexpired human entry', () => {
  const withLedger = (entries: Parameters<typeof appendEntry>[2][], fn: (cwd: string) => void) => {
    const d = mkdtempSync(join(tmpdir(), 'hf-so-'));
    try {
      for (const e of entries) appendEntry(d, P, e);
      fn(d);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };

  it('clears the matching block finding', () => {
    const f = blockFinding();
    withLedger([makeEntry(f, 'reviewed', Date.now())], (cwd) => {
      const r = applyLocalSignoffs([f], cwd, P);
      expect(r.cleared).toHaveLength(1);
      expect(r.findings).toHaveLength(0);
    });
  });

  it('does NOT clear an expired entry', () => {
    const f = blockFinding();
    withLedger([makeEntry(f, 'old', Date.now() - 1000, 100 /*ttl*/)], (cwd) => {
      const r = applyLocalSignoffs([f], cwd, P, Date.now()); // now >> expiry
      expect(r.cleared).toHaveLength(0);
      expect(r.findings).toHaveLength(1);
    });
  });

  it('does NOT clear a DIFFERENT tamper of the same rule+file (no standing license)', () => {
    const signed = blockFinding({ evidence: 'rm src/a.test.ts' });
    const other = blockFinding({ evidence: 'rm src/a.test.ts && echo done' }); // different tamper
    withLedger([makeEntry(signed, 'reviewed', Date.now())], (cwd) => {
      const r = applyLocalSignoffs([other], cwd, P);
      expect(r.cleared).toHaveLength(0);
    });
  });
});

describe('CI layer — honors ONLY out-of-band, never the committed ledger', () => {
  it('clears by rule and by rule:file from the OOB signal', () => {
    const f = blockFinding();
    expect(applyOobSignoffs([f], ['test-deletion']).cleared).toHaveLength(1);
    expect(applyOobSignoffs([f], [`test-deletion:${f.file}`]).cleared).toHaveLength(1);
    expect(applyOobSignoffs([f], []).cleared).toHaveLength(0);
    expect(applyOobSignoffs([f], ['some-other-rule']).cleared).toHaveLength(0);
  });
});

describe('AGENT layer — refuses a sign-off it could have authored (the guarantee)', () => {
  it('denies a cast EVEN WITH a matching ledger entry the agent wrote; LOCAL would honor the same entry', () => {
    const d = mkdtempSync(join(tmpdir(), 'hf-agent-'));
    try {
      const input = { cwd: d, tool_name: 'Write', tool_input: { file_path: join(d, 'src/x.ts'), content: 'export const v = JSON.parse("{}") as any;\n' } };
      // the finding the gate would raise:
      const f = evaluate(changesFromClaudeHook(input, d), P).find((x) => x.severity === 'block')!;
      expect(f).toBeTruthy();
      // the agent "signs off" its own block by writing the ledger:
      appendEntry(d, P, makeEntry(f, 'agent: prioritizing speed', Date.now()));

      // AGENT layer: still DENIES (ignores the ledger entirely)
      const v = preToolUseVerdict(input);
      expect(v.exitCode).toBe(0);
      expect(v.stdout).toContain('"permissionDecision":"deny"');

      // LOCAL layer: the SAME entry clears the SAME finding — the asymmetry is structural
      expect(applyLocalSignoffs([f], d, P).cleared).toHaveLength(1);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
