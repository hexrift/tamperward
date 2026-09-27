import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyLocalSignoffs,
  applyOobSignoffs,
  compactOobToken,
  honoredAt,
  LEDGER_TTL_MS,
  oobToken,
  appendEntry,
  makeEntry,
  fingerprintOf,
  readLedger,
} from '../src/signoff';
import { PolicyError } from '../src/policy-load';
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

describe('oobToken — the one matcher behind check --diff and verify', () => {
  const HEAD = '1234567890abcdef1234567890abcdef12345678';
  it('returns the covering token, bound to the head', () => {
    expect(oobToken('verify', ['test-deletion@1234567', `verify@${HEAD}`], HEAD)).toBe(`verify@${HEAD}`);
  });
  it('refuses an unbound token once a head is known, honours it when none is', () => {
    expect(oobToken('verify', ['verify'], HEAD)).toBeNull();
    expect(oobToken('verify', ['verify'])).toBe('verify');
  });
  it('refuses an abbreviated, malformed, or foreign sha', () => {
    expect(oobToken('verify', ['verify@123456'], HEAD)).toBeNull(); // < 7 chars
    expect(oobToken('verify', ['verify@1234567'], HEAD)).toBeNull();
    expect(oobToken('verify', [`verify@${HEAD.toUpperCase()}`], HEAD)).toBe(`verify@${HEAD.toUpperCase()}`);
    expect(oobToken('verify', ['verify@deadbeef0'], HEAD)).toBeNull();
  });
  it('never matches a different name, whatever the sha', () => {
    expect(oobToken('verify', ['verify:x@1234567', 'test-skip@1234567'], HEAD)).toBeNull();
  });
  it('accepts a compact token only for the exact rule, file, and full head', () => {
    const want = 'test-deletion:src/a.test.ts';
    const token = compactOobToken(want, HEAD)!;
    expect(token).toMatch(/^tw1:[A-Za-z0-9_-]{43}$/);
    expect(token.length).toBeLessThanOrEqual(50);
    expect(oobToken(want, [token], HEAD)).toBe(token);
    expect(oobToken('test-deletion', [token], HEAD)).toBeNull();
    expect(oobToken('test-deletion:src/b.test.ts', [token], HEAD)).toBeNull();
    expect(oobToken(want, [token], `${HEAD.slice(0, -1)}9`)).toBeNull();
    expect(oobToken(want, [token])).toBeNull();
  });
  it('rejects malformed compact tokens and abbreviated heads', () => {
    expect(compactOobToken('verify', '1234567')).toBeNull();
    expect(oobToken('verify', ['tw1:not-a-digest'], HEAD)).toBeNull();
  });
});

// #699: the LOCAL layer trusts the ledger as "a one-time human judgment on one tamper, not a
// standing license", and the loader refuses a `signoff.ledger` that NAMES a location outside
// the repository. The reader used to hold neither half: `existsSync` + `readFileSync` followed
// a symbolic link to a file no git view shows, and any `expiresAt` a line claimed was honored.
describe('#699 — the LOCAL layer honors only a ledger `allow` could have written', () => {
  const f = blockFinding();
  const onPosix = process.platform !== 'win32'; // symlink creation needs a privilege on Windows
  const YEARS_10 = 10 * 365 * 24 * 3600 * 1000;
  const twoDirs = (fn: (repo: string, outside: string) => void) => {
    const repo = mkdtempSync(join(tmpdir(), 'hf-699-repo-'));
    const outside = mkdtempSync(join(tmpdir(), 'hf-699-outside-'));
    try {
      fn(repo, outside);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  };

  it('a real ledger with a fresh `allow` entry still clears the finding; an absent one is simply no sign-off', () => {
    twoDirs((repo) => {
      expect(readLedger(repo, P)).toEqual([]); // no .tamperward/ at all
      expect(applyLocalSignoffs([f], repo, P).cleared).toHaveLength(0);
      mkdirSync(join(repo, '.tamperward'));
      expect(readLedger(repo, P)).toEqual([]); // the directory, no file
      appendEntry(repo, P, makeEntry(f, 'reviewed', Date.now()));
      expect(readLedger(repo, P)).toHaveLength(1);
      expect(applyLocalSignoffs([f], repo, P).cleared).toHaveLength(1);
    });
  });

  it.skipIf(!onPosix)('refuses a ledger FILE that is a symbolic link to a file outside the repository (RED: it was honored)', () => {
    twoDirs((repo, outside) => {
      writeFileSync(join(outside, 'shared.jsonl'), JSON.stringify(makeEntry(f, 'planted', Date.now())) + '\n');
      mkdirSync(join(repo, '.tamperward'));
      symlinkSync(join(outside, 'shared.jsonl'), join(repo, '.tamperward', 'ledger.jsonl'));
      expect(() => applyLocalSignoffs([f], repo, P)).toThrow(PolicyError);
      expect(() => readLedger(repo, P)).toThrow(/\.tamperward\/ledger\.jsonl is a symbolic link/);
    });
  });

  it.skipIf(!onPosix)('refuses a `.tamperward` DIRECTORY that is a symbolic link (RED: the file behind it was honored)', () => {
    twoDirs((repo, outside) => {
      writeFileSync(join(outside, 'ledger.jsonl'), JSON.stringify(makeEntry(f, 'planted', Date.now())) + '\n');
      symlinkSync(outside, join(repo, '.tamperward'));
      expect(() => applyLocalSignoffs([f], repo, P)).toThrow(/\.tamperward is a symbolic link/);
    });
  });

  it('refuses a ledger path that is not a regular file', () => {
    twoDirs((repo) => {
      mkdirSync(join(repo, '.tamperward', 'ledger.jsonl'), { recursive: true }); // a directory where the file goes
      expect(() => readLedger(repo, P)).toThrow(/ledger\.jsonl is a directory/);
      expect(() => appendEntry(repo, P, makeEntry(f, 'r', Date.now()))).toThrow(PolicyError);
    });
  });

  it.skipIf(!onPosix)('`allow` never writes through a link: appendEntry refuses and the file outside stays untouched', () => {
    twoDirs((repo, outside) => {
      writeFileSync(join(outside, 'shared.jsonl'), '');
      mkdirSync(join(repo, '.tamperward'));
      symlinkSync(join(outside, 'shared.jsonl'), join(repo, '.tamperward', 'ledger.jsonl'));
      expect(() => appendEntry(repo, P, makeEntry(f, 'r', Date.now()))).toThrow(PolicyError);
      expect(readFileSync(join(outside, 'shared.jsonl'), 'utf8')).toBe('');
    });
  });

  it('honoredAt: inside the window `allow` writes and nowhere else', () => {
    const now = Date.now();
    const e = makeEntry(f, 'reviewed', now);
    expect(honoredAt(e, now)).toBe(true);
    expect(honoredAt(e, now + LEDGER_TTL_MS - 1)).toBe(true); // the last moment of its 30 days
    expect(honoredAt(e, now + LEDGER_TTL_MS)).toBe(false); // expired
    expect(honoredAt({ ...e, expiresAt: 9e15 }, now + YEARS_10)).toBe(false); // a hand-written standing license
    expect(honoredAt({ ...e, expiresAt: e.recordedAt + LEDGER_TTL_MS + 1 }, now)).toBe(false); // one ms longer than allow grants
    expect(honoredAt({ ...e, expiresAt: e.recordedAt + LEDGER_TTL_MS }, now)).toBe(true); // exactly what allow grants
    expect(honoredAt(makeEntry(f, 'later', now + 5 * 365 * 24 * 3600 * 1000), now)).toBe(false); // recorded in the future
    expect(honoredAt(makeEntry(f, 'earlier', now - LEDGER_TTL_MS + 1000), now)).toBe(true); // 30 days minus a second old
    expect(honoredAt({ ...e, expiresAt: Number.NaN }, now)).toBe(false);
    expect(honoredAt({ ...e, recordedAt: Number.NaN }, now)).toBe(false);
  });

  it('end to end: a planted standing license or a future entry clears nothing; a fresh entry still does (RED: all three cleared)', () => {
    twoDirs((repo) => {
      const now = Date.now();
      appendEntry(repo, P, { ...makeEntry(f, 'standing license', now), expiresAt: 9e15 });
      expect(applyLocalSignoffs([f], repo, P, now + YEARS_10).cleared).toHaveLength(0);
      expect(applyLocalSignoffs([f], repo, P, now).cleared).toHaveLength(0); // its lifetime is not one allow grants, even today
      appendEntry(repo, P, makeEntry(f, 'from the future', now + YEARS_10));
      expect(applyLocalSignoffs([f], repo, P, now).cleared).toHaveLength(0);
      appendEntry(repo, P, makeEntry(f, 'reviewed', now));
      const r = applyLocalSignoffs([f], repo, P, now);
      expect(r.cleared).toHaveLength(1);
      expect(r.findings).toHaveLength(0);
    });
  });
});
