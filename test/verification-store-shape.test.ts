// #720: the verification store under .git/tamperward/ — the VERIFIED record
// (verification-state.json), the in-progress marker (verifying.json), the
// transportable receipt (verification-receipt.json) and the runtime qualification
// store (runtime-qualification.json) — was written with writeFileSync and read with
// readFileSync, which open the path as the OS finds it. A link planted at a record's
// path carried verify's own record into whatever the link named, a hard link put it
// into that file's inode, and a FIFO held verify before it ran anything and held
// status, receipt export and the runtime commands on their read. Every writer now
// goes through a temp file and a rename (src/safe-write.ts atomicReplaceFile), which
// replaces whatever stands at the path without following it; every reader goes
// through the guarded state reader (src/disk.ts readStateFile), which reports
// anything but an absent or regular file by name instead of parsing it. status fails
// safe to UNVERIFIED with that reason, the runtime commands report the qualification
// as rejected, and neither verify nor status ever waits on a FIFO. The directory
// itself, .git/tamperward, is accepted only as a directory of its own (#721 review):
// a link there carried every record — the session marker, the effect trees, the
// audit and observer logs, the verification store — into whatever directory it
// named, since a recursive mkdir and a temp-file-and-rename both traverse it; every
// path under it is now refused by name.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { runVerify } from '../src/cli/verify';
import { runStatus } from '../src/cli/status';
import { preToolUseVerdict, stopVerdict } from '../src/cli/hook';
import { defaultEventLog } from '../src/cli/watch';
import { TW_VERSION } from '../src/wiring';
import {
  beginVerifying,
  endVerifying,
  invalidateVerificationRecordIfCurrent,
  readVerificationRecord,
  readVerifyingMarker,
  verificationRecordPath,
  verifyingMarkerPath,
} from '../src/verification-state';
import { receiptPath } from '../src/verification-receipt';
import { StateFileError } from '../src/disk';
import { resetRepoContextCache } from '../src/repo-context';

vi.setConfig({ testTimeout: 60_000 });

const ROOT = resolve(__dirname, '..');
const posix = process.platform !== 'win32';

// The CLI is bundled here, not read from dist/: CI's test job never builds dist/.
let cliDir = '';
let CLI = '';
beforeAll(() => {
  cliDir = mkdtempSync(join(tmpdir(), 'tw-vstore-cli-'));
  symlinkSync(join(ROOT, 'node_modules'), join(cliDir, 'node_modules'), 'dir');
  CLI = join(cliDir, 'index.js');
  buildSync({ entryPoints: [join(ROOT, 'src/cli/index.ts')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: CLI, logLevel: 'silent' });
}, 60_000);
afterAll(() => {
  if (cliDir) rmSync(cliDir, { recursive: true, force: true });
});

const dirs: string[] = [];
const savedAudit = process.env.TAMPERWARD_AUDIT_LOG;
afterEach(() => {
  vi.restoreAllMocks();
  resetRepoContextCache();
  if (savedAudit === undefined) delete process.env.TAMPERWARD_AUDIT_LOG;
  else process.env.TAMPERWARD_AUDIT_LOG = savedAudit;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, stdio: 'pipe' });

/** A repository with a passing suite and a local-backend verifier policy, and the
 *  store directory already present so an entry can be planted at a record's path. */
function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-vstore-'));
  dirs.push(cwd);
  git(cwd, 'init', '-q', '-b', 'main');
  writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, 'test', 'check.test.js'), "const v=require('../src.js'); if(v!==42){console.error('bad');process.exit(1)}\n");
  writeFileSync(join(cwd, '.tamperward.yml'), ['version: 1', 'verify:', '  command: node test/check.test.js', '  budget: 30', '  backend: local', ''].join('\n'));
  // The wiring `init` writes, so a Write to it is a deny (`hook-tampering`) at PreToolUse.
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(
    join(cwd, '.claude', 'settings.json'),
    JSON.stringify(
      {
        disableAllHooks: false,
        hooks: {
          PreToolUse: [{ matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: `npx --yes tamperward@${TW_VERSION} hook claude` }] }],
          Stop: [{ hooks: [{ type: 'command', command: `npx --yes tamperward@${TW_VERSION} sweep claude` }] }],
        },
      },
      null,
      2,
    ) + '\n',
  );
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'base');
  mkdirSync(join(cwd, '.git', 'tamperward'), { recursive: true });
  return cwd;
}

/** A bare repository for the runtime qualification store. */
function bare(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-vstore-rt-'));
  dirs.push(cwd);
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'commit', '--allow-empty', '-q', '-m', 'root');
  mkdirSync(join(cwd, '.git', 'tamperward'), { recursive: true });
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

/** `silent` skips the in-progress marker (the envelope owns it); pass false to write it. */
const verify = (cwd: string, silent = true): number => capture(() => runVerify({ cwd, silent })).code;

function validateStatus(doc: unknown): string[] {
  const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'status-v1.schema.json'), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  return validate(doc) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

function statusJson(cwd: string): any {
  const r = capture(() => runStatus({ cwd, json: true }));
  expect(r.code).toBe(0);
  const doc = JSON.parse(r.out.trim());
  expect(validateStatus(doc), JSON.stringify(doc)).toEqual([]);
  return doc;
}

function hasMkfifo(): boolean {
  try {
    execFileSync('mkfifo', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Put a FIFO at `p`, replacing whatever is there. */
function fifoAt(p: string): void {
  rmSync(p, { force: true });
  execFileSync('mkfifo', [p]);
}

/** A file whose bytes must survive everything the store does. */
function keep(cwd: string, name: string): string {
  const t = join(cwd, name);
  writeFileSync(t, 'keep\n');
  return t;
}

const record = (cwd: string) => verificationRecordPath(cwd)!;
const marker = (cwd: string) => verifyingMarkerPath(cwd)!;
const receipt = (cwd: string) => receiptPath(cwd)!;
const store = (cwd: string) => join(cwd, '.git', 'tamperward', 'runtime-qualification.json');

const cli = (cwd: string, args: string[], env: Record<string, string> = {}) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 45_000 });
  return { ...r, ms: Date.now() - t0 };
};
const RT = { TAMPERWARD_RUNTIME_VERSION: '1.0.0' };

describe.skipIf(!posix)('#720 the writers replace what stands at the path and never write through it', () => {
  it('the in-progress marker: a link at its path is replaced, the target untouched', () => {
    const cwd = repo();
    const t = keep(cwd, 'target');
    symlinkSync(t, marker(cwd));
    expect(beginVerifying(cwd)).toBe(true);
    expect(readFileSync(t, 'utf8')).toBe('keep\n');
    expect(lstatSync(marker(cwd)).isSymbolicLink()).toBe(false);
    expect(readVerifyingMarker(cwd)?.pid).toBe(process.pid);
    endVerifying(cwd);
    expect(existsSync(marker(cwd))).toBe(false);
  });

  it('the in-progress marker: a hard link at its path is replaced, the other name untouched', () => {
    const cwd = repo();
    const t = keep(cwd, 'target');
    linkSync(t, marker(cwd));
    expect(lstatSync(t).nlink).toBe(2);
    expect(beginVerifying(cwd)).toBe(true);
    expect(readFileSync(t, 'utf8')).toBe('keep\n');
    expect(lstatSync(t).nlink).toBe(1);
    expect(readVerifyingMarker(cwd)?.pid).toBe(process.pid);
    endVerifying(cwd);
  });

  it('a VERIFIED verify: a link at the record, a hard link at the receipt and a link at the marker are all replaced, the targets untouched, status CURRENT', () => {
    const cwd = repo();
    const t1 = keep(cwd, 't1');
    const t2 = keep(cwd, 't2');
    const t3 = keep(cwd, 't3');
    symlinkSync(t1, record(cwd));
    linkSync(t2, receipt(cwd));
    symlinkSync(t3, marker(cwd));
    expect(verify(cwd, false)).toBe(0);
    for (const t of [t1, t2, t3]) expect(readFileSync(t, 'utf8')).toBe('keep\n');
    expect(lstatSync(t2).nlink).toBe(1);
    expect(lstatSync(record(cwd)).isSymbolicLink()).toBe(false);
    expect(readVerificationRecord(cwd)?.verdict).toBe('VERIFIED');
    expect(JSON.parse(readFileSync(receipt(cwd), 'utf8')).verdict).toBe('VERIFIED');
    expect(existsSync(marker(cwd))).toBe(false);
    expect(statusJson(cwd).verification.state).toBe('CURRENT');
  });
});

describe.skipIf(!posix)('#720 the readers report what stands at the path instead of parsing it', () => {
  it('readVerificationRecord and readVerifyingMarker refuse a link and a directory, naming them', () => {
    const cwd = repo();
    symlinkSync('/dev/null', record(cwd));
    expect(() => readVerificationRecord(cwd)).toThrow(StateFileError);
    expect(() => readVerificationRecord(cwd)).toThrow(/verification-state\.json is a symbolic link to \/dev\/null/);
    mkdirSync(marker(cwd));
    expect(() => readVerifyingMarker(cwd)).toThrow(/verifying\.json is a directory/);
  });

  it('status: a link at the record path is UNVERIFIED with the entry named, never CURRENT, and the entry is left in place', () => {
    const cwd = repo();
    expect(verify(cwd)).toBe(0);
    expect(statusJson(cwd).verification.state).toBe('CURRENT');
    // The same CURRENT bytes, reached through a link: the entry is not a regular file.
    const aside = join(cwd, 'aside.json');
    writeFileSync(aside, readFileSync(record(cwd)));
    rmSync(record(cwd));
    symlinkSync(aside, record(cwd));
    const doc = statusJson(cwd);
    expect(doc.verification.state).toBe('UNVERIFIED');
    expect(doc.verification.reason).toMatch(/cannot be read/);
    expect(doc.verification.detail).toMatch(/verification-state\.json is a symbolic link to/);
    expect(lstatSync(record(cwd)).isSymbolicLink()).toBe(true);
    // The human rendering names the entry too, and says what to do about it.
    const human = capture(() => runStatus({ cwd }));
    expect(human.code).toBe(0);
    expect(human.out).toMatch(/Reason\s+.*verification-state\.json is a symbolic link to/);
    expect(human.out).toMatch(/Next\s+remove what stands at that path, then run `tamperward verify`/);
  });

  it('status: a link at the marker path is UNVERIFIED naming the marker, even over a CURRENT record', () => {
    const cwd = repo();
    expect(verify(cwd)).toBe(0);
    const t = keep(cwd, 'target');
    symlinkSync(t, marker(cwd));
    const doc = statusJson(cwd);
    expect(doc.verification.state).toBe('UNVERIFIED');
    expect(doc.verification.detail).toMatch(/verifying\.json is a symbolic link to/);
  });

  it('invalidateVerificationRecordIfCurrent leaves a non-regular entry alone', () => {
    const cwd = repo();
    const t = keep(cwd, 'target');
    symlinkSync(t, record(cwd));
    expect(invalidateVerificationRecordIfCurrent(cwd)).toBe(false);
    expect(lstatSync(record(cwd)).isSymbolicLink()).toBe(true);
    expect(readFileSync(t, 'utf8')).toBe('keep\n');
  });
});

// The FIFO cases run the bundled CLI under a timeout: in-process, the old open blocked
// the worker itself.
describe.skipIf(!posix || !hasMkfifo())('#720 a FIFO never holds verify or status', () => {
  it('verify with a FIFO at the marker path runs, replaces it and clears it', () => {
    const cwd = repo();
    fifoAt(marker(cwd));
    const r = cli(cwd, ['verify']);
    expect(r.error, r.stderr).toBeUndefined();
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(marker(cwd))).toBe(false);
    expect(readVerificationRecord(cwd)?.verdict).toBe('VERIFIED');
  });

  it('verify with a FIFO at the record path replaces it with the record', () => {
    const cwd = repo();
    fifoAt(record(cwd));
    const r = cli(cwd, ['verify']);
    expect(r.error, r.stderr).toBeUndefined();
    expect(r.status, r.stderr).toBe(0);
    expect(lstatSync(record(cwd)).isFile()).toBe(true);
    expect(readVerificationRecord(cwd)?.verdict).toBe('VERIFIED');
  });

  it('status with a FIFO at the record path returns at once: UNVERIFIED naming the FIFO', () => {
    const cwd = repo();
    fifoAt(record(cwd));
    const r = cli(cwd, ['status', '--json']);
    expect(r.error, r.stderr).toBeUndefined();
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout.trim());
    expect(validateStatus(doc), JSON.stringify(doc)).toEqual([]);
    expect(doc.verification.state).toBe('UNVERIFIED');
    expect(doc.verification.detail).toMatch(/verification-state\.json is a fifo/);
  });
});

describe.skipIf(!posix)('#720 the runtime qualification store', () => {
  it('runtime verify refuses a link at the store path by name, writes nothing through it, and keeps its recorded:false document', () => {
    const cwd = bare();
    const t = keep(cwd, 'target');
    symlinkSync(t, store(cwd));
    const r = cli(cwd, ['runtime', 'verify', '--runtime', 'claude-code', '--json'], RT);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/could not persist the qualification/);
    expect(r.stderr).toMatch(/runtime-qualification\.json is a symbolic link to/);
    const doc = JSON.parse(r.stdout.trim());
    expect(doc.recorded).toBe(false);
    expect(readFileSync(t, 'utf8')).toBe('keep\n');
    expect(lstatSync(store(cwd)).isSymbolicLink()).toBe(true);
  });

  it('runtime verify writes the store through a rename: a hard link at its path is replaced, the other name untouched', () => {
    const cwd = bare();
    const first = cli(cwd, ['runtime', 'verify', '--runtime', 'claude-code', '--json'], RT);
    expect(first.status, first.stderr).toBe(0);
    // A second name for the store's own inode: the store is a regular file, so the
    // read is accepted, and the write must still not land in the shared inode.
    const t = join(cwd, 'other-name');
    linkSync(store(cwd), t);
    const before = readFileSync(t, 'utf8');
    const second = cli(cwd, ['runtime', 'verify', '--runtime', 'claude-code', '--json'], RT);
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(t, 'utf8')).toBe(before);
    expect(lstatSync(t).nlink).toBe(1);
    expect(lstatSync(store(cwd)).nlink).toBe(1);
  });

  it('runtime status with a link at the store path reports the qualification as rejected, naming the entry', () => {
    const cwd = bare();
    const first = cli(cwd, ['runtime', 'verify', '--runtime', 'claude-code', '--json'], RT);
    expect(first.status, first.stderr).toBe(0);
    const aside = join(cwd, 'aside.json');
    writeFileSync(aside, readFileSync(store(cwd)));
    rmSync(store(cwd));
    symlinkSync(aside, store(cwd));
    const r = cli(cwd, ['runtime', 'status', '--runtime', 'claude-code', '--json'], RT);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout.trim());
    expect(doc.recorded).toBe(false);
    expect(doc.note).toMatch(/rejected \(.*runtime-qualification\.json is a symbolic link to/);
  });

  it.skipIf(!hasMkfifo())('runtime status with a FIFO at the store path returns at once, rejected naming the FIFO', () => {
    const cwd = bare();
    mkdirSync(dirname(store(cwd)), { recursive: true });
    fifoAt(store(cwd));
    const r = cli(cwd, ['runtime', 'status', '--runtime', 'claude-code', '--json'], RT);
    expect(r.error, r.stderr).toBeUndefined();
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout.trim());
    expect(doc.recorded).toBe(false);
    expect(doc.note).toMatch(/runtime-qualification\.json is a fifo/);
  });
});

describe.skipIf(!posix)('#721 review: the state directory itself is accepted only as a directory of its own', () => {
  const stateDirOf = (cwd: string) => join(cwd, '.git', 'tamperward');

  /** `.git/tamperward` replaced by a link to a writable directory outside the repository. */
  function linkedStateDir(cwd: string): string {
    const outside = mkdtempSync(join(tmpdir(), 'tw-vstore-outside-'));
    dirs.push(outside);
    rmSync(stateDirOf(cwd), { recursive: true, force: true });
    symlinkSync(outside, stateDirOf(cwd));
    return outside;
  }

  it('the writers record nothing through it: verify still adjudicates, the outside directory stays empty, the link stays', () => {
    const cwd = repo();
    const outside = linkedStateDir(cwd);
    expect(beginVerifying(cwd)).toBe(false);
    // The record is evidence, never the verdict: verify still reaches VERIFIED.
    expect(verify(cwd, false)).toBe(0);
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(stateDirOf(cwd)).isSymbolicLink()).toBe(true);
  });

  it('the readers refuse it by name: status is UNVERIFIED naming the link, and a record placed outside is never parsed', () => {
    const cwd = repo();
    const outside = linkedStateDir(cwd);
    writeFileSync(join(outside, 'verification-state.json'), '{}\n');
    expect(() => readVerificationRecord(cwd)).toThrow(StateFileError);
    expect(() => readVerificationRecord(cwd)).toThrow(/\.git\/tamperward is a symbolic link to/);
    expect(() => readVerifyingMarker(cwd)).toThrow(/\.git\/tamperward is a symbolic link to/);
    const doc = statusJson(cwd);
    expect(doc.verification.state).toBe('UNVERIFIED');
    expect(doc.verification.detail).toMatch(/\.git\/tamperward is a symbolic link to/);
    const human = capture(() => runStatus({ cwd }));
    expect(human.code).toBe(0);
    expect(human.out).toMatch(/Reason\s+.*\.git\/tamperward is a symbolic link to/);
  });

  it('a regular file where the directory should be is refused the same way, and left alone', () => {
    const cwd = repo();
    rmSync(stateDirOf(cwd), { recursive: true, force: true });
    writeFileSync(stateDirOf(cwd), 'not a directory\n');
    expect(beginVerifying(cwd)).toBe(false);
    expect(() => readVerificationRecord(cwd)).toThrow(/\.git\/tamperward is a regular file/);
    expect(statusJson(cwd).verification.detail).toMatch(/\.git\/tamperward is a regular file/);
    expect(readFileSync(stateDirOf(cwd), 'utf8')).toBe('not a directory\n');
  });

  it('the runtime store: verify refuses by name, status reports rejected, nothing lands outside', () => {
    const cwd = bare();
    const outside = linkedStateDir(cwd);
    const r = cli(cwd, ['runtime', 'verify', '--runtime', 'claude-code', '--json'], RT);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/could not persist the qualification/);
    expect(r.stderr).toMatch(/\.git\/tamperward is a symbolic link to/);
    expect(JSON.parse(r.stdout.trim()).recorded).toBe(false);
    const s = cli(cwd, ['runtime', 'status', '--runtime', 'claude-code', '--json'], RT);
    expect(s.status, s.stderr).toBe(0);
    const doc = JSON.parse(s.stdout.trim());
    expect(doc.recorded).toBe(false);
    expect(doc.note).toMatch(/rejected \(.*\.git\/tamperward is a symbolic link to/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('the hook fails closed on it, naming the link, at PreToolUse and at Stop', () => {
    const cwd = repo();
    const outside = linkedStateDir(cwd);
    const pre = preToolUseVerdict({ session_id: 's1', cwd, tool_name: 'Bash', tool_input: { command: 'echo ok' } });
    expect(pre.exitCode).toBe(0);
    expect(pre.stdout).toContain('"deny"');
    expect(pre.stdout).toMatch(/\.git\/tamperward is a symbolic link to/);
    const stop = stopVerdict({ session_id: 's1', cwd, stop_hook_active: false });
    expect(stop.stdout).toContain('"block"');
    expect(stop.stdout).toMatch(/\.git\/tamperward is a symbolic link to/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('the audit log under `auto` and the observer log never land outside it', () => {
    const cwd = repo();
    const outside = linkedStateDir(cwd);
    process.env.TAMPERWARD_AUDIT_LOG = 'auto';
    // Without a session id the hook keeps no marker, so the deny itself is reached —
    // and its audit event must not be written through the link.
    const r = preToolUseVerdict({ cwd, tool_name: 'Write', tool_input: { file_path: join(cwd, '.claude', 'settings.json'), content: '{}' } });
    expect(r.stdout).toContain('"deny"');
    expect(r.stdout).toContain('hook-tampering');
    expect(readdirSync(outside)).toEqual([]);
    expect(() => defaultEventLog(cwd)).toThrow(/\.git\/tamperward is a symbolic link to/);
  });
});
