// #722: `tamperward stats` checked its log with existsSync and opened it with
// openSync, which take the path as the OS resolves it. A link at
// .git/tamperward/audit.jsonl was followed and whatever it named was summarised as
// the gate's own record — a path the writer has refused since #718, so nothing the
// gate recorded can stand behind it — a dangling link read as "no events", a FIFO
// held stats until a writer appeared, and a directory was refused by errno alone.
// The log is now opened through src/disk.ts openRegular (an lstat, an open that
// follows no link and never waits, a check on the open descriptor) and streamed
// from that descriptor: nothing at the path stays the empty summary (or, for an
// explicit --file, not found), and anything else standing there is a
// StateFileError naming it — one line and exit 2 through the CLI guard.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { forEachAuditLine, recordAuditFindings, runStats, summarizeAudit, type AuditEventV1, type StatsOpts } from '../src/cli/audit';
import { StateFileError, openRegular } from '../src/disk';
import { resetRepoContextCache } from '../src/repo-context';
import type { Finding } from '../src/types';

vi.setConfig({ testTimeout: 60_000 });

const ROOT = resolve(__dirname, '..');
const posix = process.platform !== 'win32';

function hasMkfifo(): boolean {
  if (!posix) return false;
  const probe = spawnSync('mkfifo', ['--version'], { encoding: 'utf8' });
  return !probe.error;
}

// The CLI is bundled here, not read from dist/: CI's test job never builds dist/.
let cliDir = '';
let CLI = '';
beforeAll(() => {
  cliDir = mkdtempSync(join(tmpdir(), 'tw-stats-cli-'));
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

/** A repository with the state directory present, so an entry can be planted at the log's path. */
function repo(): { cwd: string; log: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-stats-'));
  dirs.push(cwd);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd, stdio: 'pipe' });
  mkdirSync(join(cwd, '.git', 'tamperward'));
  return { cwd, log: join(cwd, '.git', 'tamperward', 'audit.jsonl') };
}

/** A directory outside any repository, for link targets and explicit files. */
function outside(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-stats-outside-'));
  dirs.push(d);
  return d;
}

function event(n: number): AuditEventV1 {
  return {
    schema_version: 1,
    id: 'sha256:' + n.toString(16).padStart(32, '0'),
    timestamp: `2026-09-28T07:${String(n % 60).padStart(2, '0')}:00.000Z`,
    surface: 'pretooluse',
    agent: 'claude-code',
    rule: 'test-deletion',
    severity: 'block',
    decision: 'deny',
  };
}
const lines = (events: AuditEventV1[]): string => events.map((e) => JSON.stringify(e) + '\n').join('');

const finding: Finding = {
  rule: 'test-deletion',
  severity: 'block',
  file: 'x.test.ts',
  message: '',
  evidence: '',
  remediation: '',
  signoff: { required: true, command: '' },
};

function capture(run: () => number): { code: number; stdout: string } {
  let stdout = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  try {
    return { code: run(), stdout };
  } finally {
    spy.mockRestore();
  }
}

/** `stats --json` in the repository, its summary parsed. */
function stats(cwd: string, extra: Partial<StatsOpts> = {}): { code: number; summary: ReturnType<typeof summarizeAudit> } {
  const { code, stdout } = capture(() => runStats({ cwd, json: true, ...extra }));
  return { code, summary: JSON.parse(stdout) as ReturnType<typeof summarizeAudit> };
}

/** The bundled CLI's `stats`, on the default path, under a timeout: a stall is a failure, not a hang. */
function cli(cwd: string, ...args: string[]) {
  const env = { ...process.env };
  delete env.TAMPERWARD_AUDIT_LOG;
  return spawnSync(process.execPath, [CLI, 'stats', ...args], { cwd, encoding: 'utf8', timeout: 45_000, env });
}

describe.skipIf(!posix)('#722 openRegular: a descriptor for a regular file, null for nothing, a refusal by name for anything else', () => {
  it('returns null when nothing stands at the path, a parent included', () => {
    const d = outside();
    expect(openRegular(join(d, 'absent.jsonl'), '; x')).toBeNull();
    expect(openRegular(join(d, 'absent-parent', 'absent.jsonl'), '; x')).toBeNull();
    writeFileSync(join(d, 'regular.jsonl'), 'a\n');
    expect(openRegular(join(d, 'regular.jsonl', 'under.jsonl'), '; x')).toBeNull();
  });

  it('opens a regular file, a file with more than one name included', () => {
    const d = outside();
    writeFileSync(join(d, 'regular.jsonl'), 'a\n');
    const fd = openRegular(join(d, 'regular.jsonl'), '; x');
    expect(fd).not.toBeNull();
    closeSync(fd as number);
    linkSync(join(d, 'regular.jsonl'), join(d, 'other-name.jsonl'));
    expect(lstatSync(join(d, 'regular.jsonl')).nlink).toBe(2);
    const linked = openRegular(join(d, 'regular.jsonl'), '; x');
    expect(linked).not.toBeNull();
    closeSync(linked as number);
  });

  it('refuses a link wherever it points, a dangling one included, and a directory, each by name with the caller\'s suffix', () => {
    const d = outside();
    writeFileSync(join(d, 'regular.jsonl'), 'a\n');
    symlinkSync(join(d, 'regular.jsonl'), join(d, 'link.jsonl'));
    expect(() => openRegular(join(d, 'link.jsonl'), '; x')).toThrow(StateFileError);
    expect(() => openRegular(join(d, 'link.jsonl'), '; x')).toThrow(/link\.jsonl is a symbolic link to .*regular\.jsonl; x$/);
    symlinkSync(join(d, 'missing.jsonl'), join(d, 'dangling.jsonl'));
    expect(() => openRegular(join(d, 'dangling.jsonl'), '; x')).toThrow(/dangling\.jsonl is a symbolic link to .*missing\.jsonl; x$/);
    mkdirSync(join(d, 'dir.jsonl'));
    expect(() => openRegular(join(d, 'dir.jsonl'), '; x')).toThrow(/dir\.jsonl is a directory; x$/);
    expect(() => openRegular(join(d, 'dir.jsonl'), '; x')).toThrow(StateFileError);
  });

  it.skipIf(!hasMkfifo())('refuses a FIFO by name at once, never waiting for a writer', () => {
    const d = outside();
    const fifo = join(d, 'fifo.jsonl');
    execFileSync('mkfifo', [fifo]);
    const started = Date.now();
    expect(() => openRegular(fifo, '; x')).toThrow(/fifo\.jsonl is a fifo; x$/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe.skipIf(!posix)('#722 stats reads the audit log only as a regular file', () => {
  it('nothing at the log stays the empty summary, and a regular log is summarised', () => {
    const { cwd, log } = repo();
    expect(stats(cwd)).toEqual({ code: 0, summary: summarizeAudit([]) });
    writeFileSync(log, lines([event(1), event(2), event(3)]));
    expect(stats(cwd)).toEqual({ code: 0, summary: summarizeAudit([event(1), event(2), event(3)]) });
  });

  it('a link at the log is refused by name: the events behind it are never summarised, the target is untouched', () => {
    const { cwd, log } = repo();
    const target = join(outside(), 'events.jsonl');
    writeFileSync(target, lines([event(1), event(2)]));
    symlinkSync(target, log);
    const before = readFileSync(target, 'utf8');
    expect(() => stats(cwd)).toThrow(StateFileError);
    expect(() => stats(cwd)).toThrow(/audit\.jsonl is a symbolic link to .*events\.jsonl; stats reads the audit log only as a regular file — remove what stands there so the log can be read$/);
    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(lstatSync(log).isSymbolicLink()).toBe(true);
  });

  it('a dangling link at the log is refused by name, never taken for "no events"', () => {
    const { cwd, log } = repo();
    symlinkSync(join(outside(), 'missing.jsonl'), log);
    expect(() => stats(cwd)).toThrow(/audit\.jsonl is a symbolic link to .*missing\.jsonl; stats reads the audit log/);
  });

  it('a directory at the log is refused by name', () => {
    const { cwd, log } = repo();
    mkdirSync(log);
    expect(() => stats(cwd)).toThrow(/audit\.jsonl is a directory; stats reads the audit log only as a regular file/);
  });

  it('a log with more than one name is read: a read has nothing to redirect through a hard link', () => {
    const { cwd, log } = repo();
    const other = join(outside(), 'other.jsonl');
    writeFileSync(other, lines([event(7)]));
    linkSync(other, log);
    expect(lstatSync(log).nlink).toBe(2);
    expect(stats(cwd)).toEqual({ code: 0, summary: summarizeAudit([event(7)]) });
  });

  it('the writer and the reader agree on a link at the log: the append is dropped, the read is refused, the target is untouched', () => {
    const { cwd, log } = repo();
    const target = join(outside(), 'events.jsonl');
    writeFileSync(target, '');
    symlinkSync(target, log);
    process.env.TAMPERWARD_AUDIT_LOG = 'auto';
    recordAuditFindings([finding], { cwd, surface: 'pretooluse' });
    expect(readFileSync(target, 'utf8')).toBe('');
    expect(() => stats(cwd)).toThrow(/audit\.jsonl is a symbolic link to .*events\.jsonl/);
  });

  it('an explicit --file is read under the same discipline: a link is refused by name, nothing there is not found', () => {
    const d = outside();
    const target = join(d, 'events.jsonl');
    writeFileSync(target, lines([event(1)]));
    symlinkSync(target, join(d, 'link.jsonl'));
    expect(() => runStats({ cwd: d, file: 'link.jsonl', json: true })).toThrow(/link\.jsonl is a symbolic link to .*events\.jsonl; stats reads the audit log/);
    expect(() => runStats({ cwd: d, file: 'absent.jsonl', json: true })).toThrow(/^audit file not found: .*absent\.jsonl$/);
    const { code, stdout } = capture(() => runStats({ cwd: d, file: target, json: true }));
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(summarizeAudit([event(1)]));
  });

  it('forEachAuditLine reports whether a file was read', () => {
    const d = outside();
    expect(
      forEachAuditLine(join(d, 'absent.jsonl'), () => {
        throw new Error('never called for an absent file');
      }),
    ).toBe(false);
    writeFileSync(join(d, 'events.jsonl'), lines([event(1), event(2)]));
    const seen: number[] = [];
    expect(forEachAuditLine(join(d, 'events.jsonl'), (_line, n) => { seen.push(n); })).toBe(true);
    expect(seen).toEqual([1, 2]);
  });

  it('the state directory itself as a link is refused before the log is looked for (#721)', () => {
    const { cwd } = repo();
    rmSync(join(cwd, '.git', 'tamperward'), { recursive: true });
    const d = outside();
    writeFileSync(join(d, 'audit.jsonl'), lines([event(1)]));
    symlinkSync(d, join(cwd, '.git', 'tamperward'), 'dir');
    expect(() => stats(cwd)).toThrow(/tamperward is a symbolic link to .*; the gate keeps its state only in a directory of its own/);
  });
});

describe.skipIf(!posix)('#722 the bundled CLI: one line naming the entry, exit 2, never a wait', () => {
  it.skipIf(!hasMkfifo())('a FIFO at the log is refused at once', () => {
    const { cwd, log } = repo();
    execFileSync('mkfifo', [log]);
    const r = cli(cwd, '--json');
    expect(r.error, String(r.error)).toBeUndefined();
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim()).toMatch(/^tamperward: .*audit\.jsonl is a fifo; stats reads the audit log only as a regular file — remove what stands there so the log can be read$/);
  });

  it('a link at the log is refused by name, and a regular log in its place is summarised', () => {
    const { cwd, log } = repo();
    const target = join(outside(), 'events.jsonl');
    writeFileSync(target, lines([event(1)]));
    symlinkSync(target, log);
    const refused = cli(cwd, '--json');
    expect(refused.error, String(refused.error)).toBeUndefined();
    expect(refused.status).toBe(2);
    expect(refused.stdout).toBe('');
    expect(refused.stderr.trim()).toMatch(/^tamperward: .*audit\.jsonl is a symbolic link to .*events\.jsonl; stats reads the audit log only as a regular file/);
    rmSync(log);
    writeFileSync(log, lines([event(1)]));
    const ok = cli(cwd, '--json');
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual(summarizeAudit([event(1)]));
  });
});
