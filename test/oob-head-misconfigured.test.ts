// A TAMPERWARD_OOB_HEAD that is set but is not a full object id is a misconfiguration,
// not an omitted head (#709). The CI gate honors an out-of-band approval only when it
// is bound to the head under adjudication; an older workflow that never names its head
// keeps the unbound legacy behaviour. A malformed head used to be read as that omitted
// head — a branch name, an abbreviated sha or a typo in a hand-edited workflow silently
// re-enabled unbound and unchecked legacy approvals in `check --diff`, `verify` and
// `receipt reconcile`, while compact tokens (which need a valid head to be recomputed)
// stayed refused. Now no approval of any form clears anything under such a head, and
// the gate says so once on stderr when one was offered.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOobSignoffs, compactOobToken, oobHeadFromEnv, oobHeadProblem, oobToken } from '../src/signoff';
import { runCheck } from '../src/cli/check';
import { runVerify } from '../src/cli/verify';
import { runReceiptReconcile } from '../src/cli/receipt';
import type { Finding } from '../src/types';

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
/** Values a hand-edited workflow can put in the variable: a ref name, a branch name, an
 *  abbreviated sha in either case, an id one character short or long, a non-hex typo. */
const MALFORMED = ['refs/heads/feature', 'feature', 'abc', 'ABC', HEAD.slice(0, 7), HEAD.slice(0, 12), HEAD.slice(0, 39), `${HEAD}0`, `${HEAD.slice(0, 39)}g`];
const ABSENT: Array<string | undefined> = [undefined, '', '   '];
const PROBLEM = /^TAMPERWARD_OOB_HEAD is set to ".+", which is not the full 40- or 64-character object id of the head under adjudication; no out-of-band approval is honored against a head the gate cannot identify$/;

const finding = (): Finding => ({
  rule: 'test-deletion',
  severity: 'block',
  file: 'test/a.test.js',
  message: 'm',
  evidence: 'e',
  remediation: 'r',
  signoff: { required: true, command: 'tamperward allow test-deletion --file test/a.test.js --reason "..."' },
});

describe('a set-but-malformed TAMPERWARD_OOB_HEAD binds nothing (#709)', () => {
  it.each(MALFORMED)('refuses every token form under the head %j', (head) => {
    expect(oobToken('test-deletion', ['test-deletion'], head)).toBeNull();
    expect(oobToken('test-deletion', [`test-deletion@${head}`], head)).toBeNull();
    expect(oobToken('test-deletion', [`test-deletion@${HEAD}`], head)).toBeNull();
    expect(oobToken('test-deletion', [compactOobToken('test-deletion', HEAD)!], head)).toBeNull();
    expect(oobToken('verify', ['verify', `verify@${head}`, `verify@${HEAD}`], head)).toBeNull();
  });

  it.each(MALFORMED)('reads %j from the environment as a supplied head, never as an omitted one', (head) => {
    const seen = oobHeadFromEnv({ TAMPERWARD_OOB_HEAD: head });
    expect(seen).toBeDefined();
    expect(applyOobSignoffs([finding()], ['test-deletion'], seen).cleared).toHaveLength(0);
    expect(applyOobSignoffs([finding()], [`test-deletion@${head}`], seen).cleared).toHaveLength(0);
    expect(applyOobSignoffs([finding()], [`test-deletion@${HEAD}`], seen).cleared).toHaveLength(0);
    expect(oobHeadProblem(seen)).toMatch(PROBLEM);
  });

  it.each(ABSENT)('an unset or empty head (%j) keeps the documented compatibility path', (head) => {
    const seen = oobHeadFromEnv(head === undefined ? {} : { TAMPERWARD_OOB_HEAD: head });
    expect(seen).toBeUndefined();
    expect(oobHeadProblem(seen)).toBeNull();
    // An older workflow that never names its head: an unbound legacy token still clears,
    // a compact token still never does.
    expect(applyOobSignoffs([finding()], ['test-deletion'], seen).cleared).toHaveLength(1);
    expect(applyOobSignoffs([finding()], [`test-deletion@${HEAD}`], seen).cleared).toHaveLength(1);
    expect(oobToken('test-deletion', [compactOobToken('test-deletion', HEAD)!], seen)).toBeNull();
  });

  it('a full object id binds exactly as before', () => {
    expect(oobHeadFromEnv({ TAMPERWARD_OOB_HEAD: ` ${HEAD.toUpperCase()} ` })).toBe(HEAD);
    expect(oobHeadProblem(HEAD)).toBeNull();
    expect(applyOobSignoffs([finding()], ['test-deletion'], HEAD).cleared).toHaveLength(0);
    expect(applyOobSignoffs([finding()], [`test-deletion@${HEAD.toUpperCase()}`], HEAD).cleared).toHaveLength(1);
    expect(applyOobSignoffs([finding()], [compactOobToken('test-deletion', HEAD)!], HEAD).cleared).toHaveLength(1);
    expect(applyOobSignoffs([finding()], [`test-deletion@${HEAD.slice(0, -1)}2`], HEAD).cleared).toHaveLength(0);
  });
});

// ── through the CLI entry points ─────────────────────────────────────────────

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const OOB = ['TAMPERWARD_OOB_SIGNOFF', 'TAMPERWARD_OOB_HEAD'] as const;
/** The two variables, set for `fn` alone and always restored. */
function withOob<T>(env: Partial<Record<(typeof OOB)[number], string>>, fn: () => T): T {
  const saved = OOB.map((k) => [k, process.env[k]] as const);
  try {
    for (const k of OOB) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
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
  try {
    return { code: fn(), out, err };
  } finally {
    vi.restoreAllMocks();
  }
}

function initRepo(prefix: string): string {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(cwd);
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.name', 't']);
  git(cwd, ['config', 'user.email', 't@b']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(cwd, 'test'));
  return cwd;
}

/** main holds a protected test; the branch `edit` deletes it — a blocking
 *  `test-deletion` in the range view. */
function deletionRepo(): { cwd: string; sha: string } {
  const cwd = initRepo('tw-oob-check-');
  writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
  writeFileSync(join(cwd, 'test', 'a.test.js'), "if (require('../src.js') !== 42) process.exit(1);\n");
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-qm', 'base']);
  git(cwd, ['checkout', '-q', '-b', 'edit']);
  unlinkSync(join(cwd, 'test', 'a.test.js'));
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-qm', 'delete the test']);
  return { cwd, sha: git(cwd, ['rev-parse', 'HEAD']) };
}

const check = (cwd: string) => capture(() => runCheck({ diff: 'main...HEAD', cwd, silent: true }));

describe.skipIf(process.platform === 'win32')('check --diff under a malformed head (#709)', () => {
  it('keeps the block and says why once; an omitted head and a valid head behave as before', () => {
    const { cwd, sha } = deletionRepo();
    expect(withOob({}, () => check(cwd)).code).toBe(1);
    // Omitted head (an older workflow): an unbound legacy token still clears.
    expect(withOob({ TAMPERWARD_OOB_SIGNOFF: 'test-deletion' }, () => check(cwd)).code).toBe(0);
    // Valid head: the bound token clears, the unbound one does not.
    expect(withOob({ TAMPERWARD_OOB_SIGNOFF: `test-deletion@${sha}`, TAMPERWARD_OOB_HEAD: sha }, () => check(cwd)).code).toBe(0);
    expect(withOob({ TAMPERWARD_OOB_SIGNOFF: 'test-deletion', TAMPERWARD_OOB_HEAD: sha }, () => check(cwd)).code).toBe(1);
    // Malformed head: nothing clears, whatever the token says, and stderr names the variable.
    for (const head of ['edit', sha.slice(0, 7)]) {
      for (const tokens of ['test-deletion', `test-deletion@${head}`, `test-deletion@${sha}`, `${compactOobToken('test-deletion', sha)},test-deletion`]) {
        const r = withOob({ TAMPERWARD_OOB_SIGNOFF: tokens, TAMPERWARD_OOB_HEAD: head }, () => check(cwd));
        expect(r.code, `${tokens} under ${head}`).toBe(1);
        expect(r.err, `${tokens} under ${head}`).toContain(`tamperward: TAMPERWARD_OOB_HEAD is set to "${head}"`);
        expect(r.err).not.toContain('cleared by out-of-band approval');
        expect(r.err.match(/TAMPERWARD_OOB_HEAD is set to/g)).toHaveLength(1);
      }
    }
    // No approval offered: nothing to refuse, so the line is not printed for this run.
    const quiet = withOob({ TAMPERWARD_OOB_HEAD: 'edit' }, () => check(cwd));
    expect(quiet.code).toBe(1);
    expect(quiet.err).not.toContain('TAMPERWARD_OOB_HEAD');
  });
});

/** The base suite fails against a real bug; the working tree rewrites the test to pass,
 *  so `verify` reports MASKED_FAILURE (the pristine run restores the original test). */
function maskedRepo(): string {
  const cwd = initRepo('tw-oob-verify-');
  writeFileSync(join(cwd, 'src.js'), 'module.exports = 41; // bug: should be 42\n');
  writeFileSync(join(cwd, 'test', 'check.test.js'), "const v = require('../src.js');\nif (v !== 42) { console.error('expected 42, got ' + v); process.exit(1); }\n");
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-qm', 'base: failing suite, real bug']);
  writeFileSync(join(cwd, 'test', 'check.test.js'), 'process.exit(0); // "fixed"\n');
  return cwd;
}

const verify = (cwd: string) => capture(() => runVerify({ cwd, cmd: 'node test/check.test.js', budget: 30, json: true }));
const verdictOf = (out: string): unknown => {
  const line = out.split('\n').map((l) => l.trim()).reverse().find((l) => l.startsWith('{'));
  return line ? (JSON.parse(line) as { verdict: unknown }).verdict : undefined;
};

describe.skipIf(process.platform === 'win32')('verify under a malformed head (#709)', () => {
  it('a MASKED_FAILURE stays exit 1 under a malformed head, with the same line; an omitted head keeps the compatibility path', () => {
    const cwd = maskedRepo();
    const compat = withOob({ TAMPERWARD_OOB_SIGNOFF: 'verify' }, () => verify(cwd));
    expect(compat.code).toBe(0);
    expect(verdictOf(compat.out)).toBe('MASKED_FAILURE');
    for (const tokens of ['verify', 'verify@feature']) {
      const r = withOob({ TAMPERWARD_OOB_SIGNOFF: tokens, TAMPERWARD_OOB_HEAD: 'feature' }, () => verify(cwd));
      expect(r.code, tokens).toBe(1);
      expect(verdictOf(r.out)).toBe('MASKED_FAILURE');
      expect(r.err).toContain('tamperward: TAMPERWARD_OOB_HEAD is set to "feature"');
    }
  }, 60_000);
});

/** A MASKED_FAILURE `verify --json` document for `receipt reconcile --ci-result`, the
 *  shape the receipt tests build (no `adjudicated_tree`: applicability is not the point,
 *  the exit code is, and it never depends on the receipt). */
function maskedCiResult(cwd: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-oob-ci-'));
  dirs.push(dir);
  const doc = {
    schema_version: 1,
    verdict: 'MASKED_FAILURE',
    base: git(cwd, ['rev-parse', 'HEAD']),
    command: 'node test/check.test.js',
    budget_secs: 4,
    visible: { exit: 1, secs: 0 },
    pristine: { exit: 1, secs: 0 },
  };
  const p = join(dir, 'ci-verify.json');
  writeFileSync(p, JSON.stringify(doc));
  return p;
}

const reconcile = (cwd: string, ciResult: string) =>
  capture(() => runReceiptReconcile({ cwd, base: 'HEAD', cmd: 'node test/check.test.js', budget: 4, ciResult, json: true }));

describe.skipIf(process.platform === 'win32')('receipt reconcile --ci-result under a malformed head (#709)', () => {
  it('recomputes the same refusal as verify: exit 1 and the same line', () => {
    const cwd = initRepo('tw-oob-reconcile-');
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
    writeFileSync(join(cwd, 'test', 'check.test.js'), "if (require('../src.js') !== 42) process.exit(1);\n");
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-qm', 'base']);
    const ciResult = maskedCiResult(cwd);
    // Omitted head: the unbound `verify` token still signs the masked failure off.
    const compat = withOob({ TAMPERWARD_OOB_SIGNOFF: 'verify' }, () => reconcile(cwd, ciResult));
    expect(compat.code).toBe(0);
    expect(JSON.parse(compat.out).result).toBe('MASKED_FAILURE');
    // Malformed head: nothing signs it off, and stderr names the variable.
    const r = withOob({ TAMPERWARD_OOB_SIGNOFF: 'verify,verify@feature', TAMPERWARD_OOB_HEAD: 'feature' }, () => reconcile(cwd, ciResult));
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).result).toBe('MASKED_FAILURE');
    expect(r.err).toContain('tamperward: TAMPERWARD_OOB_HEAD is set to "feature"');
  }, 60_000);
});
