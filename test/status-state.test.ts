// First-class verification state and `tamperward status` (#600).
//
// A successful `verify` records enough identity to tell whether it still applies
// to the EXACT current state. These tests exercise the state machine end to end:
// CURRENT right after a green verify; STALE when each load-bearing input changes
// (tree, commit, policy, verifier config, protected surface, runtime wiring);
// UNVERIFIED with no verification and after a failed one; BROKEN when the recorded
// authority wiring can no longer be evaluated; and a malformed record failing safe
// to UNVERIFIED — never CURRENT. The `--json` document is the stable consumer
// contract, so it is validated against the published schema throughout.

import { afterEach, describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runVerify } from '../src/cli/verify';
import { runStatus } from '../src/cli/status';
import {
  evaluateVerificationState,
  readVerificationRecord,
  verificationRecordPath,
} from '../src/verification-state';
import { resetRepoContextCache } from '../src/repo-context';

const ROOT = resolve(__dirname, '..');
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  resetRepoContextCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd });
}

/** A repository with a passing suite and a local-backend verifier policy. */
function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-status-'));
  dirs.push(cwd);
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.name', 't']);
  git(cwd, ['config', 'user.email', 't@b']);
  writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
  mkdirSync(join(cwd, 'test'), { recursive: true });
  writeFileSync(
    join(cwd, 'test', 'check.test.js'),
    "const v=require('../src.js'); if(v!==42){console.error('bad');process.exit(1)}\n",
  );
  writeFileSync(
    join(cwd, '.tamperward.yml'),
    ['version: 1', 'verify:', '  command: node test/check.test.js', '  budget: 30', '  backend: local', ''].join('\n'),
  );
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-qm', 'base']);
  return cwd;
}

function capture(fn: () => number): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  const code = fn();
  vi.restoreAllMocks();
  return { code, out, err };
}

function verify(cwd: string): number {
  // Silence verify's own stdout; the record write is the side effect under test.
  return capture(() => runVerify({ cwd, silent: true })).code;
}

function statusJson(cwd: string): any {
  const r = capture(() => runStatus({ cwd, json: true }));
  expect(r.code).toBe(0);
  const doc = JSON.parse(r.out.trim());
  expect(validateStatus(doc), JSON.stringify(doc)).toEqual([]);
  return doc;
}

function validateStatus(doc: unknown): string[] {
  const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'status-v1.schema.json'), 'utf8'));
  const validator = new Ajv2020({ allErrors: true, strict: true });
  const validate = validator.compile(schema);
  return validate(doc) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

const skipUnlessPosix = process.platform === 'win32';

describe.skipIf(skipUnlessPosix)('verification state machine (#600)', () => {
  it('is UNVERIFIED before any verification, and does not write a record', () => {
    const cwd = repo();
    const doc = statusJson(cwd);
    expect(doc.verification.state).toBe('UNVERIFIED');
    expect(doc.command).toBe('status');
    expect(existsSync(verificationRecordPath(cwd)!)).toBe(false);
  });

  it('is CURRENT immediately after a successful verify and records the binding', () => {
    const cwd = repo();
    expect(verify(cwd)).toBe(0);
    const record = readVerificationRecord(cwd);
    expect(record?.verdict).toBe('VERIFIED');
    const doc = statusJson(cwd);
    expect(doc.verification.state).toBe('CURRENT');
    expect(doc.verification.verifier_command).toBe('node test/check.test.js');
    expect(doc.verification.binding.tree).toEqual(expect.any(String));
    // Three distinct lanes are always present and independently enumerated.
    expect(doc.authority.state).toEqual(expect.any(String));
    expect(doc.intervention.state).toEqual(expect.any(String));
  });

  it('flips to STALE on a worktree edit (candidate tree changed)', () => {
    const cwd = repo();
    verify(cwd);
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 42; // touched\n');
    const doc = statusJson(cwd);
    expect(doc.verification.state).toBe('STALE');
    expect(doc.verification.changed_input).toBe('tree');
    expect(doc.verification.reason).toMatch(/tree changed/);
  });

  it('flips to STALE on a new commit (HEAD/base changed) even with an unchanged tree', () => {
    const cwd = repo();
    verify(cwd);
    git(cwd, ['commit', '-q', '--allow-empty', '-m', 'advance']);
    resetRepoContextCache();
    const s = evaluateVerificationState(cwd);
    expect(s.state).toBe('STALE');
    expect(['head', 'base']).toContain(s.changed_input);
  });

  it('flips to STALE when the TamperWard policy changes', () => {
    const cwd = repo();
    verify(cwd);
    // An ignore glob is a policy change that is neither verifier nor surface.
    writeFileSync(
      join(cwd, '.tamperward.yml'),
      ['version: 1', 'ignore:', '  - docs/**', 'verify:', '  command: node test/check.test.js', '  budget: 30', '  backend: local', ''].join('\n'),
    );
    const doc = statusJson(cwd);
    expect(doc.verification.state).toBe('STALE');
    expect(doc.verification.changed_input).toBe('policy');
  });

  it('flips to STALE when the verifier configuration changes', () => {
    const cwd = repo();
    verify(cwd);
    writeFileSync(
      join(cwd, '.tamperward.yml'),
      ['version: 1', 'verify:', '  command: node test/check.test.js --extra', '  budget: 30', '  backend: local', ''].join('\n'),
    );
    const doc = statusJson(cwd);
    expect(doc.verification.state).toBe('STALE');
    expect(doc.verification.changed_input).toBe('verifier');
  });

  it('flips to STALE when the protected verification surface changes', () => {
    const cwd = repo();
    verify(cwd);
    // Newly protect an existing base file: the base-file protected set changes.
    writeFileSync(
      join(cwd, '.tamperward.yml'),
      ['version: 1', 'protected:', '  extra:', '    - "**/src.js"', 'verify:', '  command: node test/check.test.js', '  budget: 30', '  backend: local', ''].join('\n'),
    );
    const doc = statusJson(cwd);
    expect(doc.verification.state).toBe('STALE');
    expect(doc.verification.changed_input).toBe('surface');
  });

  it('flips to STALE when the runtime steering wiring changes', () => {
    const cwd = repo();
    verify(cwd);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [] } }));
    const doc = statusJson(cwd);
    expect(doc.verification.state).toBe('STALE');
    expect(doc.verification.changed_input).toBe('intervention');
  });

  it('is UNVERIFIED after a failed verification — a red suite records nothing', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 41;\n');
    const code = verify(cwd);
    expect(code).toBe(1); // SUITE_RED
    expect(existsSync(verificationRecordPath(cwd)!)).toBe(false);
    const doc = statusJson(cwd);
    expect(doc.verification.state).toBe('UNVERIFIED');
  });

  it('flips to STALE naming dependencies when the dependency environment changes with an unchanged tree (#600 finding 2)', () => {
    // node_modules is git-ignored, so it is never part of the `tree` fingerprint;
    // a dependency change would keep CURRENT unless it is a bound input of its own.
    const cwd = repo();
    writeFileSync(join(cwd, '.gitignore'), 'node_modules/\n');
    mkdirSync(join(cwd, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules', 'left-pad', 'package.json'), '{"version":"1.0.0"}\n');
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-qm', 'ignore node_modules']);

    expect(verify(cwd)).toBe(0);
    expect(statusJson(cwd).verification.state).toBe('CURRENT');

    // Same tree (node_modules is ignored), different installed dependency bytes.
    writeFileSync(join(cwd, 'node_modules', 'left-pad', 'package.json'), '{"version":"1.3.0"}\n');
    const doc = statusJson(cwd);
    expect(doc.verification.state).toBe('STALE');
    expect(doc.verification.changed_input).toBe('dependencies');
    expect(doc.verification.binding.dependencies).toEqual(expect.any(String));
  });

  it('a red verify at the SAME tree after a green one reports UNVERIFIED, not CURRENT (#600 finding 3)', () => {
    // The suite's outcome depends on an environment variable, so the tree, base,
    // policy, verifier, surface, wiring and dependencies are all identical between
    // the green run and the later red one — only the record must not survive it.
    const cwd = mkdtempSync(join(tmpdir(), 'tw-status-flaky-'));
    dirs.push(cwd);
    git(cwd, ['init', '-q']);
    git(cwd, ['config', 'user.name', 't']);
    git(cwd, ['config', 'user.email', 't@b']);
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(
      join(cwd, 'test', 'check.test.js'),
      "if(process.env.TW_FLAKY_FAIL==='1'){console.error('flaked');process.exit(1)}\nprocess.exit(0)\n",
    );
    writeFileSync(
      join(cwd, '.tamperward.yml'),
      ['version: 1', 'verify:', '  command: node test/check.test.js', '  budget: 30', '  backend: local', ''].join('\n'),
    );
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-qm', 'base']);

    // Green verify at tree T ⇒ CURRENT.
    expect(verify(cwd)).toBe(0);
    expect(statusJson(cwd).verification.state).toBe('CURRENT');
    expect(existsSync(verificationRecordPath(cwd)!)).toBe(true);

    // The identical tree now fails the suite (a flaky/environment-dependent red).
    try {
      process.env.TW_FLAKY_FAIL = '1';
      expect(verify(cwd)).toBe(1); // SUITE_RED at the same bound state
    } finally {
      delete process.env.TW_FLAKY_FAIL;
    }
    // The record the earlier green run wrote must not survive a red one at the same
    // state: status is UNVERIFIED, never a stale CURRENT.
    expect(existsSync(verificationRecordPath(cwd)!)).toBe(false);
    const doc = statusJson(cwd);
    expect(doc.verification.state).toBe('UNVERIFIED');
  });

  it('binds the EVALUATED user-level hook wiring, not just the repository file (#600 finding 4)', () => {
    // The runtime reads hooks from the user-level settings too; a hook removed
    // there is a real loss of steering. Reading only the repo file kept CURRENT.
    const home = mkdtempSync(join(tmpdir(), 'tw-status-home-'));
    dirs.push(home);
    const userSettings = join(home, 'settings.json');
    const wired = {
      disableAllHooks: false,
      hooks: {
        PreToolUse: [
          { matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: 'npx --yes tamperward hook claude' }] },
        ],
      },
    };
    writeFileSync(userSettings, JSON.stringify(wired));
    const cwd = repo();
    try {
      process.env.CLAUDE_CONFIG_DIR = home;
      // The user-level file is NOT in the repository tree, so nothing else moves.
      expect(verify(cwd)).toBe(0);
      expect(statusJson(cwd).verification.state).toBe('CURRENT');

      // Remove the user-level hook: effective steering changed.
      rmSync(userSettings, { force: true });
      const doc = statusJson(cwd);
      expect(doc.verification.state).toBe('STALE');
      expect(doc.verification.changed_input).toBe('intervention');
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it('names the runtime agent from the evaluated wiring, not the mere presence of a settings file (#600 finding 4)', () => {
    const cwd = repo();
    verify(cwd);
    // A settings file with no TamperWard PreToolUse hook steers nothing.
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
    const doc = statusJson(cwd);
    expect(doc.runtime.agent).toBe('none');
  });

  it('is BROKEN when the recorded authority wiring can no longer be evaluated', () => {
    const cwd = repo();
    verify(cwd);
    // A malformed policy makes recomputation of the identity impossible.
    writeFileSync(join(cwd, '.tamperward.yml'), 'verify: [not-a-mapping\n');
    const doc = statusJson(cwd);
    expect(doc.verification.state).toBe('BROKEN');
    expect(doc.verification.detail).toEqual(expect.any(String));
  });

  it('fails safe to UNVERIFIED — never CURRENT — on a corrupt state record', () => {
    const cwd = repo();
    verify(cwd);
    expect(statusJson(cwd).verification.state).toBe('CURRENT');
    writeFileSync(verificationRecordPath(cwd)!, '{ this is not json');
    expect(readVerificationRecord(cwd)).toBeNull();
    const doc = statusJson(cwd);
    expect(doc.verification.state).toBe('UNVERIFIED');

    // A structurally-valid record with a tampered verdict is also rejected.
    verify(cwd);
    const raw = JSON.parse(readFileSync(verificationRecordPath(cwd)!, 'utf8'));
    raw.verdict = 'MASKED_FAILURE';
    writeFileSync(verificationRecordPath(cwd)!, JSON.stringify(raw));
    expect(readVerificationRecord(cwd)).toBeNull();
    expect(statusJson(cwd).verification.state).toBe('UNVERIFIED');
  });

  it('survives an ordinary CLI restart: the record is read fresh from disk', () => {
    const cwd = repo();
    verify(cwd);
    // Drop every in-memory cache, as a fresh process would; state must persist.
    resetRepoContextCache();
    expect(evaluateVerificationState(cwd).state).toBe('CURRENT');
  });

  it('renders three distinct lanes in the human report', () => {
    const cwd = repo();
    verify(cwd);
    const r = capture(() => runStatus({ cwd }));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Authority/);
    expect(r.out).toMatch(/Intervention/);
    expect(r.out).toMatch(/Verification\s+CURRENT/);
  });
});

describe('status outside a repository', () => {
  it('fails closed with one line on stderr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-status-norepo-'));
    dirs.push(dir);
    const r = capture(() => runStatus({ cwd: dir }));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^tamperward: [^\n]+\n$/);
  });
});
