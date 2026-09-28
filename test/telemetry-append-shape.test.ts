// #718: the loop layer's own records — the deny log (TAMPERWARD_DENYLOG), the audit
// log (TAMPERWARD_AUDIT_LOG), the watcher's event log and its health record — were
// written with appendFileSync / writeFileSync, which open the path as the OS finds
// it: a link is followed and a FIFO holds the open until a reader appears. In the
// hook both appends run BEFORE the deny is returned, so a FIFO at either path held
// the deny itself until the runtime's hook timeout let the tool call through — a
// stall that fires only when there is something to deny — and a link carried the
// gate's own lines wherever the candidate pointed it: aimed at the turn-baseline
// marker, one deny left text the next call re-established at HEAD, forgetting the
// mid-turn commit #716 refused to forget. Every such write now goes through
// src/disk.ts appendRegular (an lstat, an open that follows no link and never
// waits, an fstat after the open) or a rename that replaces without following. A
// refused entry drops the line, as any write failure already did; the verdict
// neither changes nor waits.

import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { appendRegular, StateFileError } from '../src/disk';
import { preToolUseVerdict, stopVerdict, type HookResult } from '../src/cli/hook';
import { readWatcherHealth, startWatcher, watcherHealthPath } from '../src/cli/watch';
import { defaultPolicy } from '../src/policy';
import { TW_VERSION } from '../src/wiring';

vi.setConfig({ testTimeout: 30_000 });

const ROOT = join(__dirname, '..');
const posix = process.platform !== 'win32';
const SID = 's1';

// The CLI is bundled here, not read from dist/: CI's test job never builds dist/.
let cliDir = '';
let CLI = '';
beforeAll(() => {
  cliDir = mkdtempSync(join(tmpdir(), 'tw-append-cli-'));
  symlinkSync(join(ROOT, 'node_modules'), join(cliDir, 'node_modules'), 'dir');
  CLI = join(cliDir, 'index.js');
  buildSync({ entryPoints: [join(ROOT, 'src/cli/index.ts')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: CLI, logLevel: 'silent' });
}, 60_000);
afterAll(() => {
  if (cliDir) rmSync(cliDir, { recursive: true, force: true });
});

const dirs: string[] = [];
const children: ChildProcess[] = [];
const ENV = ['TAMPERWARD_DENYLOG', 'TAMPERWARD_AUDIT_LOG', 'TAMPERWARD_WATCH_NO_RECURSIVE'] as const;
const saved: Array<[string, string | undefined]> = ENV.map((k) => [k, process.env[k]]);
afterEach(() => {
  for (const c of children.splice(0)) {
    try { c.kill('SIGKILL'); } catch { /* already gone */ }
  }
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix = 'tw-append-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, stdio: 'pipe' });

/** A repository with one committed test and the wiring `init` writes, so a Write to
 *  `.claude/settings.json` is a deny (`hook-tampering`) at PreToolUse. */
function repo(): string {
  const d = tmp();
  git(d, 'init', '-q', '-b', 'main');
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'test', 'a.test.js'), 'it("a", () => {});\n');
  writeFileSync(join(d, '.tamperward.yml'), 'version: 1\n');
  mkdirSync(join(d, '.claude'));
  writeFileSync(
    join(d, '.claude', 'settings.json'),
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
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'init');
  mkdirSync(join(d, '.git', 'tamperward'), { recursive: true });
  return d;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const marker = (cwd: string) => join(cwd, '.git', 'tamperward', `session-${SID}`);
const head = (cwd: string) => git(cwd, 'rev-parse', 'HEAD').toString().trim();
const allow = (cwd: string) => preToolUseVerdict({ session_id: SID, cwd, tool_name: 'Bash', tool_input: { command: 'echo ok' } });
const denyWrite = (cwd: string) =>
  preToolUseVerdict({ session_id: SID, cwd, tool_name: 'Write', tool_input: { file_path: join(cwd, '.claude', 'settings.json'), content: '{}' } });
const denied = (r: HookResult): boolean => r.exitCode === 0 && r.stdout.includes('"deny"') && r.stdout.includes('hook-tampering');
const denyPayload = (cwd: string) =>
  JSON.stringify({ session_id: SID, cwd, tool_name: 'Write', tool_input: { file_path: join(cwd, '.claude', 'settings.json'), content: '{}' } });

describe.skipIf(!posix)('#718 appendRegular', () => {
  it('creates an absent file and appends to a regular one', () => {
    const d = tmp();
    const p = join(d, 'log');
    appendRegular(p, 'a\n');
    appendRegular(p, 'b\n');
    expect(readFileSync(p, 'utf8')).toBe('a\nb\n');
    expect(lstatSync(p).isFile()).toBe(true);
  });

  it('refuses a link, naming its target, and leaves the target untouched', () => {
    const d = tmp();
    writeFileSync(join(d, 'target'), 'keep\n');
    symlinkSync(join(d, 'target'), join(d, 'link'));
    expect(() => appendRegular(join(d, 'link'), 'x\n')).toThrow(StateFileError);
    expect(() => appendRegular(join(d, 'link'), 'x\n')).toThrow(/is a symbolic link to .*target; the gate appends its records only to a regular file/);
    expect(readFileSync(join(d, 'target'), 'utf8')).toBe('keep\n');
    // A dangling link is the classic case: appendFileSync CREATED the target through it.
    symlinkSync(join(d, 'would-be-created'), join(d, 'dangling'));
    expect(() => appendRegular(join(d, 'dangling'), 'x\n')).toThrow(/is a symbolic link to/);
    expect(existsSync(join(d, 'would-be-created'))).toBe(false);
    // A link to a device is refused by name, never opened.
    symlinkSync('/dev/null', join(d, 'dev'));
    expect(() => appendRegular(join(d, 'dev'), 'x\n')).toThrow(/is a symbolic link to \/dev\/null/);
  });

  it('refuses a directory', () => {
    const d = tmp();
    mkdirSync(join(d, 'dir'));
    expect(() => appendRegular(join(d, 'dir'), 'x\n')).toThrow(/is a directory/);
  });

  it.skipIf(!hasMkfifo())('refuses a FIFO at once instead of waiting for a reader', () => {
    const d = tmp();
    fifoAt(join(d, 'fifo'));
    const t0 = Date.now();
    expect(() => appendRegular(join(d, 'fifo'), 'x\n')).toThrow(/is a fifo/);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe.skipIf(!posix)("#718 the hook's deny log and audit log", () => {
  it('control: a regular deny log and audit log receive the deny', () => {
    const cwd = repo();
    process.env.TAMPERWARD_DENYLOG = join(cwd, 'deny.log');
    process.env.TAMPERWARD_AUDIT_LOG = join(cwd, 'audit.jsonl');
    expect(denied(denyWrite(cwd))).toBe(true);
    expect(readFileSync(join(cwd, 'deny.log'), 'utf8')).toContain('hook-tampering');
    expect(readFileSync(join(cwd, 'audit.jsonl'), 'utf8')).toContain('"rule":"hook-tampering"');
  });

  it('a deny log linked to the session marker: the deny is unchanged, the marker is intact and the next turn keeps its baseline', () => {
    const cwd = repo();
    expect(allow(cwd).stdout).toBe('');
    const sha0 = head(cwd);
    expect(readFileSync(marker(cwd), 'utf8').trim()).toBe(sha0);
    // A mid-turn commit: the baseline must still be sha0 afterwards, or the sweep judges from HEAD.
    writeFileSync(join(cwd, 'note.txt'), 'later\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'mid-turn');
    expect(head(cwd)).not.toBe(sha0);
    symlinkSync(marker(cwd), join(cwd, 'deny.log'));
    process.env.TAMPERWARD_DENYLOG = join(cwd, 'deny.log');
    const r = denyWrite(cwd);
    expect(denied(r)).toBe(true);
    expect(readFileSync(marker(cwd), 'utf8').trim()).toBe(sha0);
    delete process.env.TAMPERWARD_DENYLOG;
    expect(allow(cwd).stdout).toBe('');
    expect(readFileSync(marker(cwd), 'utf8').trim()).toBe(sha0);
  });

  it('the audit log under `auto` linked to the session marker: the same', () => {
    const cwd = repo();
    expect(allow(cwd).stdout).toBe('');
    const sha0 = head(cwd);
    symlinkSync(marker(cwd), join(cwd, '.git', 'tamperward', 'audit.jsonl'));
    process.env.TAMPERWARD_AUDIT_LOG = 'auto';
    expect(denied(denyWrite(cwd))).toBe(true);
    expect(readFileSync(marker(cwd), 'utf8').trim()).toBe(sha0);
    expect(lstatSync(join(cwd, '.git', 'tamperward', 'audit.jsonl')).isSymbolicLink()).toBe(true);
  });

  it('a dangling link at the deny log creates nothing at its target', () => {
    const cwd = repo();
    symlinkSync(join(cwd, 'nowhere'), join(cwd, 'deny.log'));
    process.env.TAMPERWARD_DENYLOG = join(cwd, 'deny.log');
    expect(denied(denyWrite(cwd))).toBe(true);
    expect(existsSync(join(cwd, 'nowhere'))).toBe(false);
  });

  // The FIFO cases run the bundled CLI under a timeout: in-process, the old append
  // blocked the worker itself.
  const hook = (cwd: string, kind: 'hook' | 'sweep', input: string, env: Record<string, string>) => {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [CLI, kind, 'claude'], { cwd, input, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10_000 });
    return { ...r, ms: Date.now() - t0 };
  };

  it.skipIf(!hasMkfifo())('a FIFO at the deny log: the deny returns at once', () => {
    const cwd = repo();
    fifoAt(join(cwd, 'deny.fifo'));
    const r = hook(cwd, 'hook', denyPayload(cwd), { TAMPERWARD_DENYLOG: join(cwd, 'deny.fifo') });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"deny"');
    expect(r.stdout).toContain('hook-tampering');
    expect(r.ms).toBeLessThan(10_000);
  });

  it.skipIf(!hasMkfifo())('a FIFO at the audit log under `auto`: the deny returns at once', () => {
    const cwd = repo();
    fifoAt(join(cwd, '.git', 'tamperward', 'audit.jsonl'));
    const r = hook(cwd, 'hook', denyPayload(cwd), { TAMPERWARD_AUDIT_LOG: 'auto' });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"deny"');
    expect(r.stdout).toContain('hook-tampering');
  });

  it.skipIf(!hasMkfifo())('a FIFO at the deny log when the Stop sweep blocks: the block returns at once', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'test', 'a.test.js'), 'it.skip("a", () => {});\n');
    expect(stopVerdict({ session_id: SID, cwd, stop_hook_active: false }).stdout).toContain('"block"');
    fifoAt(join(cwd, 'deny.fifo'));
    const r = hook(cwd, 'sweep', JSON.stringify({ session_id: SID, cwd, stop_hook_active: false }), { TAMPERWARD_DENYLOG: join(cwd, 'deny.fifo') });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"block"');
  });
});

describe.skipIf(!posix)("#718 the watcher's event log and health record", () => {
  async function until(pred: () => boolean, ms = 5_000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return true;
      await sleep(50);
    }
    return pred();
  }

  it('an event log linked to a file: the event is refused, the target untouched, the observer degraded naming the link', async () => {
    process.env.TAMPERWARD_WATCH_NO_RECURSIVE = '1';
    const cwd = repo();
    writeFileSync(join(cwd, 'target'), 'keep\n');
    const log = join(cwd, 'events.jsonl');
    symlinkSync(join(cwd, 'target'), log);
    const w = startWatcher(cwd, log, defaultPolicy());
    try {
      await sleep(100);
      writeFileSync(join(cwd, 'test', 'a.test.js'), 'it.skip("a", () => {});\n');
      expect(await until(() => readWatcherHealth(log)?.state === 'degraded')).toBe(true);
      expect(readWatcherHealth(log)?.last_error).toMatch(/events\.jsonl is a symbolic link to .*target/);
    } finally {
      w.close();
    }
    expect(readFileSync(join(cwd, 'target'), 'utf8')).toBe('keep\n');
  });

  it('a link at the health record: the record replaces the link, the target untouched', () => {
    process.env.TAMPERWARD_WATCH_NO_RECURSIVE = '1';
    const cwd = repo();
    writeFileSync(join(cwd, 'target'), 'keep\n');
    const log = join(cwd, 'events.jsonl');
    symlinkSync(join(cwd, 'target'), watcherHealthPath(log));
    const w = startWatcher(cwd, log, defaultPolicy());
    try {
      expect(lstatSync(watcherHealthPath(log)).isSymbolicLink()).toBe(false);
      expect(readWatcherHealth(log)?.state).toBe('healthy');
    } finally {
      w.close();
    }
    expect(readFileSync(join(cwd, 'target'), 'utf8')).toBe('keep\n');
  });

  const daemon = (cwd: string, log: string): ChildProcess => {
    const c = spawn(process.execPath, [CLI, 'watch', '--dir', cwd, '--log', log], {
      cwd,
      env: { ...process.env, TAMPERWARD_WATCH_NO_RECURSIVE: '1' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    children.push(c);
    return c;
  };

  it.skipIf(!hasMkfifo())('a FIFO at the event log: the daemon does not block; the observer degrades naming the FIFO', async () => {
    const cwd = repo();
    const log = join(cwd, 'events.jsonl');
    fifoAt(log);
    daemon(cwd, log);
    // The first record is written before the per-directory watchers exist: wait for
    // the backend to be up, then let it settle, before touching a protected file.
    const up = () => {
      const h = readWatcherHealth(log);
      return h?.state === 'healthy' && h.backend === 'fallback';
    };
    expect(await until(up), JSON.stringify(readWatcherHealth(log))).toBe(true);
    await sleep(200);
    writeFileSync(join(cwd, 'test', 'a.test.js'), 'it.skip("a", () => {});\n');
    expect(await until(() => readWatcherHealth(log)?.state === 'degraded'), JSON.stringify(readWatcherHealth(log))).toBe(true);
    expect(readWatcherHealth(log)?.last_error).toMatch(/events\.jsonl is a fifo/);
    expect(readWatcherHealth(log)?.event_count).toBe(0);
  });

  it.skipIf(!hasMkfifo())('a FIFO at the health record: the daemon starts and its record replaces the FIFO', async () => {
    const cwd = repo();
    const log = join(cwd, 'events.jsonl');
    fifoAt(watcherHealthPath(log));
    daemon(cwd, log);
    expect(await until(() => lstatSync(watcherHealthPath(log)).isFile() && readWatcherHealth(log)?.state === 'healthy'), String(lstatSync(watcherHealthPath(log)).mode.toString(8))).toBe(true);
  });
});
