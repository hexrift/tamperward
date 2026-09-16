// The effect layer, tested as the incidents that motivated it:
//  - 07-fastify (Phase 3): a protected mutation whose tool call the gate never
//    judged must be denied at the NEXT call from its filesystem effect.
//  - applyEdit fail-open: an Edit whose old_string cannot be located must be
//    judged from its incoming content, never silently allowed.
//  - A.1 probes: chmod-only and modify+restore must be OBSERVED by the watcher
//    and judged by the transient rule, the two documented observer misses.

import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { watch as fsWatch } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readSync as fsReadSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preToolUseVerdict, stopVerdict } from '../src/cli/hook';
import { defaultPolicy } from '../src/policy';
import { defaultEventLog, readWatcherHealth, startWatcher, watcherHealthPath } from '../src/cli/watch';
import { drainEvents, MAX_EVENT_READ_BYTES, MAX_EVENT_SWEEP_BYTES, readEvents, transientFindings } from '../src/detectors/fs-events';
import { FsEvent } from '../src/cli/watch';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'hf-eff-'));
  dirs.push(d);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: d });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'test', 'a.test.js'), `test('adds', () => { expect(add(1, 2)).toBe(3); });\n`);
  writeFileSync(join(d, 'src.js'), 'exports.add = (a, b) => a + b;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return d;
}

const bash = (cwd: string, sid = 's1') => ({
  tool_name: 'Bash',
  tool_input: { command: 'echo ok' },
  cwd,
  session_id: sid,
});

describe('per-call effect drift (the fastify class)', () => {
  it('denies the NEXT call after an unjudged protected mutation, by the ordinary rules', () => {
    const cwd = repo();
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe(''); // snapshot established

    // A mutation the hook never saw (sed spelling, hook flake — any route):
    writeFileSync(join(cwd, 'test', 'a.test.js'), `test.skip('adds', () => { expect(add(1, 2)).toBe(3); });\n`);

    const r = preToolUseVerdict(bash(cwd));
    expect(r.stdout).toContain('"deny"');
    expect(r.stdout).toContain('test-skip');

    // and it repeats until restored…
    expect(preToolUseVerdict(bash(cwd)).stdout).toContain('test-skip');

    // …then clears on restore, absorbing the state cleanly.
    writeFileSync(join(cwd, 'test', 'a.test.js'), `test('adds', () => { expect(add(1, 2)).toBe(3); });\n`);
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
  });

  it('absorbs benign drift (a new snapshot appearing) without a finding', () => {
    const cwd = repo();
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
    mkdirSync(join(cwd, 'test', '__snapshots__'), { recursive: true });
    writeFileSync(join(cwd, 'test', '__snapshots__', 'a.test.js.snap'), `exports['adds 1'] = '3';\n`);
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
  });

  it('does not re-litigate an edit the hook itself just allowed', () => {
    const cwd = repo();
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe('');
    const after = `test('adds', () => { expect(add(1, 2)).toBe(3); });\ntest('adds zero', () => { expect(add(0, 0)).toBe(0); });\n`;
    const edit = {
      tool_name: 'Edit',
      tool_input: {
        file_path: join(cwd, 'test', 'a.test.js'),
        old_string: `test('adds', () => { expect(add(1, 2)).toBe(3); });\n`,
        new_string: after,
      },
      cwd,
      session_id: 's1',
    };
    expect(preToolUseVerdict(edit).stdout).toBe(''); // additive: allowed, sanctioned
    writeFileSync(join(cwd, 'test', 'a.test.js'), after); // the tool applies it
    expect(preToolUseVerdict(bash(cwd)).stdout).toBe(''); // no drift deny
  });
});

describe('applyEdit fail-open closed (07-fastify regression)', () => {
  it('judges an unreconstructable Edit from its incoming content', () => {
    const cwd = repo();
    const r = preToolUseVerdict({
      tool_name: 'Edit',
      tool_input: {
        file_path: join(cwd, 'test', 'a.test.js'),
        old_string: 'THIS STRING IS NOT IN THE FILE AT ALL',
        new_string: `test.skip('adds', () => { expect(add(1, 2)).toBe(3); });`,
      },
      cwd,
      session_id: 's2',
    });
    expect(r.stdout).toContain('"deny"');
    expect(r.stdout).toContain('test-skip');
  });
});


describe('fs-event cursor I/O (#313)', () => {
  const event = (path: string, hash: string): FsEvent => ({
    ts: '2026-09-13T06:00:00Z',
    path,
    kind: 'change',
    mode: 0o100644,
    size: 10,
    hash,
  });

  it('reads only bytes appended after the saved byte offset, not a multi-megabyte history', () => {
    const cwd = repo();
    const log = join(cwd, 'events.jsonl');
    const oldLine = JSON.stringify(event('test/old.test.js', 'old')) + '\n';
    const repeats = Math.ceil((3 * 1024 * 1024) / Buffer.byteLength(oldLine));
    const history = oldLine.repeat(repeats);
    const offset = Buffer.byteLength(history);
    const tail = JSON.stringify(event('test/new.test.js', 'new')) + '\n';
    writeFileSync(log, history + tail);

    const batch = readEvents(log, offset);
    expect(batch.events.map((x) => x.path)).toEqual(['test/new.test.js']);
    expect(batch.bytesRead).toBe(Buffer.byteLength(tail));
    expect(batch.bytesRead).toBeLessThan(1024);
    expect(batch.newOffset).toBe(offset + Buffer.byteLength(tail));
  });

  it('does not advance past a torn final JSONL record and replays it once completed', () => {
    const cwd = repo();
    const log = join(cwd, 'events.jsonl');
    const first = JSON.stringify(event('test/a.test.js', 'a')) + '\n';
    const second = JSON.stringify(event('test/b.test.js', 'b'));
    const split = Math.floor(second.length / 2);
    writeFileSync(log, first + second.slice(0, split));

    const a = readEvents(log, 0);
    expect(a.events.map((x) => x.path)).toEqual(['test/a.test.js']);
    expect(a.newOffset).toBe(Buffer.byteLength(first));

    writeFileSync(log, second.slice(split) + '\n', { flag: 'a' });
    const b = readEvents(log, a.newOffset);
    expect(b.events.map((x) => x.path)).toEqual(['test/b.test.js']);
    expect(b.newOffset).toBe(Buffer.byteLength(first + second + '\n'));
  });

  it('bounds one read and advances only through complete records when more telemetry remains', () => {
    const cwd = repo();
    const log = join(cwd, 'events.jsonl');
    const first = JSON.stringify(event('test/a.test.js', 'a')) + '\n';
    const second = JSON.stringify(event('test/b.test.js', 'b')) + '\n';
    writeFileSync(log, first + second);

    const cap = Buffer.byteLength(first) + 5;
    const a = readEvents(log, 0, cap);
    expect(MAX_EVENT_READ_BYTES).toBeGreaterThan(cap);
    expect(a.bytesRead).toBe(cap);
    expect(a.limitReached).toBe(true);
    expect(a.events.map((x) => x.path)).toEqual(['test/a.test.js']);
    expect(a.newOffset).toBe(Buffer.byteLength(first));

    const b = readEvents(log, a.newOffset);
    expect(b.events.map((x) => x.path)).toEqual(['test/b.test.js']);
    expect(b.limitReached).toBe(false);
  });


  it('uses the saved byte offset as the physical positioned-read start', () => {
    const cwd = repo();
    const log = join(cwd, 'events.jsonl');
    const oldLine = JSON.stringify(event('test/old.test.js', 'old')) + '\n';
    const history = oldLine.repeat(Math.ceil((3 * 1024 * 1024) / Buffer.byteLength(oldLine)));
    const offset = Buffer.byteLength(history);
    const tail = JSON.stringify(event('test/new.test.js', 'new')) + '\n';
    writeFileSync(log, history + tail);

    const reads: Array<{ position: number | null; length: number }> = [];
    const batch = readEvents(log, offset, MAX_EVENT_READ_BYTES, {
      read(fd, buffer, bufferOffset, length, position) {
        reads.push({ position, length });
        return fsReadSync(fd, buffer, bufferOffset, length, position);
      },
    });

    expect(batch.events.map((x) => x.path)).toEqual(['test/new.test.js']);
    expect(reads).toEqual([{ position: offset, length: Buffer.byteLength(tail) }]);
  });

  it('caps aggregate drain work at 16 MiB and reports the remaining complete-record backlog', () => {
    const cwd = repo();
    const log = join(cwd, 'events.jsonl');
    const line = JSON.stringify(event('src.js', 'same')) + '\n';
    const repeats = Math.ceil((MAX_EVENT_SWEEP_BYTES + 64 * 1024) / Buffer.byteLength(line));
    writeFileSync(log, line.repeat(repeats));

    const batch = drainEvents(log, 0);
    expect(batch.complete).toBe(false);
    expect(batch.issue).toBe('aggregate-limit');
    expect(batch.bytesRead).toBeLessThanOrEqual(MAX_EVENT_SWEEP_BYTES);
    expect(batch.bytesRead).toBeGreaterThanOrEqual(MAX_EVENT_SWEEP_BYTES - MAX_EVENT_READ_BYTES);
    expect(batch.newOffset).toBeGreaterThan(0);
  });

  it('keeps byte cursors valid when a bounded chunk splits a multibyte UTF-8 record', () => {
    const cwd = repo();
    const log = join(cwd, 'events.jsonl');
    const first = JSON.stringify(event('test/a.test.js', 'ascii')) + '\n';
    const second = JSON.stringify(event('test/é漢.test.js', 'utf8')) + '\n';
    writeFileSync(log, first + second);

    const secondBeforeAccent = second.slice(0, second.indexOf('é'));
    const cap = Buffer.byteLength(first) + Buffer.byteLength(secondBeforeAccent) + 1; // inside é
    const a = readEvents(log, 0, cap);
    expect(a.events.map((x) => x.path)).toEqual(['test/a.test.js']);
    expect(a.newOffset).toBe(Buffer.byteLength(first));

    const b = readEvents(log, a.newOffset);
    expect(b.events.map((x) => x.path)).toEqual(['test/é漢.test.js']);
    expect(b.newOffset).toBe(Buffer.byteLength(first + second));
  });
});

describe('watcher + transient rule (the A.1 probes)', () => {
  // Forced onto the per-directory fallback so the path Node 18 Linux MUST take is
  // the path every CI matrix entry actually tests; recursive is the optimization.
  it('observes modify+restore and chmod-only, and the rule fires on the churn', async () => {
    process.env.TAMPERWARD_WATCH_NO_RECURSIVE = '1';
    const cwd = repo();
    const log = join(cwd, 'events.jsonl');
    const w = startWatcher(cwd, log, defaultPolicy());
    const target = join(cwd, 'test', 'a.test.js');
    const original = readFileSync(target, 'utf8');
    try {
      await new Promise((r) => setTimeout(r, 100)); // watcher settles
      writeFileSync(target, `// gutted\n`);
      await new Promise((r) => setTimeout(r, 150));
      writeFileSync(target, original); // restored — no net diff
      chmodSync(target, 0o444);
      await new Promise((r) => setTimeout(r, 150));
      chmodSync(target, 0o644);
      // poll until the events land (fs.watch is async)
      for (let i = 0; i < 20 && readEvents(log, 0).events.length < 2; i++)
        await new Promise((r) => setTimeout(r, 100));
    } finally {
      w.close();
      delete process.env.TAMPERWARD_WATCH_NO_RECURSIVE;
    }
    const { events } = readEvents(log, 0);
    expect(events.length).toBeGreaterThanOrEqual(2);

    const finalHash = () => 'final-equals-baseline';
    const findings = transientFindings(events, new Set(), defaultPolicy(), finalHash);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].rule).toBe('transient-protected-mutation');
    expect(findings[0].severity).toBe('warn');
  });

  it.skipIf(process.platform === 'win32')('fallback never follows a directory symlink outside the repository', async () => {
    process.env.TAMPERWARD_WATCH_NO_RECURSIVE = '1';
    const cwd = repo();
    const outside = mkdtempSync(join(tmpdir(), 'tw-watch-outside-'));
    dirs.push(outside);
    const target = join(outside, 'escape.test.js');
    writeFileSync(target, 'before\n');
    symlinkSync(outside, join(cwd, 'test', 'external'), 'dir');

    const log = join(cwd, 'events.jsonl');
    const w = startWatcher(cwd, log, defaultPolicy());
    try {
      await new Promise((r) => setTimeout(r, 150));
      writeFileSync(target, 'after\n');
      for (let i = 0; i < 12; i++)
        await new Promise((r) => setTimeout(r, 50));
    } finally {
      w.close();
      delete process.env.TAMPERWARD_WATCH_NO_RECURSIVE;
    }

    const { events } = readEvents(log, 0);
    expect(events.some((e) => e.path.startsWith('test/external/'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('fallback treats a cyclic directory symlink as a leaf', async () => {
    process.env.TAMPERWARD_WATCH_NO_RECURSIVE = '1';
    const cwd = repo();
    symlinkSync(join(cwd, 'test'), join(cwd, 'test', 'cycle'), 'dir');

    const log = join(cwd, 'events.jsonl');
    const w = startWatcher(cwd, log, defaultPolicy());
    const target = join(cwd, 'test', 'a.test.js');
    try {
      await new Promise((r) => setTimeout(r, 150));
      writeFileSync(target, '// changed through canonical path\n');
      for (let i = 0; i < 20 && readEvents(log, 0).events.length < 1; i++)
        await new Promise((r) => setTimeout(r, 50));
    } finally {
      w.close();
      delete process.env.TAMPERWARD_WATCH_NO_RECURSIVE;
    }

    const { events } = readEvents(log, 0);
    expect(events.some((e) => e.path === 'test/a.test.js')).toBe(true);
    expect(events.some((e) => e.path.startsWith('test/cycle/'))).toBe(false);
  });

  it('fallback still extends coverage to a real directory created after startup', async () => {
    process.env.TAMPERWARD_WATCH_NO_RECURSIVE = '1';
    const cwd = repo();
    const log = join(cwd, 'events.jsonl');
    const w = startWatcher(cwd, log, defaultPolicy());
    const later = join(cwd, 'test', 'later');
    const target = join(later, 'new.test.js');
    try {
      await new Promise((r) => setTimeout(r, 150));
      mkdirSync(later);
      await new Promise((r) => setTimeout(r, 150));
      writeFileSync(target, 'test("later", () => {})\n');
      for (let i = 0; i < 20 && !readEvents(log, 0).events.some((e) => e.path === 'test/later/new.test.js'); i++)
        await new Promise((r) => setTimeout(r, 50));
    } finally {
      w.close();
      delete process.env.TAMPERWARD_WATCH_NO_RECURSIVE;
    }

    expect(readEvents(log, 0).events.some((e) => e.path === 'test/later/new.test.js')).toBe(true);
  });

  it('close is idempotent and no queued watcher callback can write after shutdown begins', async () => {
    process.env.TAMPERWARD_WATCH_NO_RECURSIVE = '1';
    const cwd = repo();
    const log = join(cwd, 'events.jsonl');
    const w = startWatcher(cwd, log, defaultPolicy());
    const target = join(cwd, 'test', 'a.test.js');

    try {
      await new Promise((r) => setTimeout(r, 75));
      // Queue real filesystem churn immediately before shutdown. The regression
      // in #372 let a fallback watcher callback race teardown and recreate/write
      // health state while rmSync was removing the fixture.
      writeFileSync(target, '// queued just before close\n');
      w.close();
      w.close(); // lifecycle API must be safe for layered cleanup paths

      const stopped = readWatcherHealth(log);
      expect(stopped?.state).toBe('stopped');
      const frozen = JSON.stringify(stopped);

      await new Promise((r) => setTimeout(r, 150));
      expect(JSON.stringify(readWatcherHealth(log))).toBe(frozen);

      rmSync(cwd, { recursive: true, force: true });
      expect(existsSync(cwd)).toBe(false);
      await new Promise((r) => setTimeout(r, 75));
      expect(existsSync(cwd)).toBe(false);
    } finally {
      w.close();
      delete process.env.TAMPERWARD_WATCH_NO_RECURSIVE;
    }
  });

  it('writes a live healthy status that distinguishes zero events from unavailable telemetry', () => {
    process.env.TAMPERWARD_WATCH_NO_RECURSIVE = '1';
    const cwd = repo();
    const log = join(cwd, 'events.jsonl');
    const w = startWatcher(cwd, log, defaultPolicy());
    try {
      const health = readWatcherHealth(log);
      expect(health).toMatchObject({
        state: 'healthy',
        backend: 'fallback',
        pid: process.pid,
        log,
        event_count: 0,
        dropped_events: 0,
        error_count: 0,
      });
      expect(health!.watched_dirs).toBeGreaterThanOrEqual(2);
      expect(health!.last_append_at).toBeNull();
      expect(existsSync(log)).toBe(false); // zero events is still healthy telemetry
      expect(existsSync(watcherHealthPath(log))).toBe(true);
    } finally {
      w.close();
      delete process.env.TAMPERWARD_WATCH_NO_RECURSIVE;
    }
    expect(readWatcherHealth(log)?.state).toBe('stopped');
  });

  it('marks logging degraded and counts a dropped event instead of silently losing it', async () => {
    process.env.TAMPERWARD_WATCH_NO_RECURSIVE = '1';
    const cwd = repo();
    const log = join(cwd, 'events-as-directory');
    mkdirSync(log); // appendFileSync(log, ...) => EISDIR, while <log>.health.json remains writable
    const warnings: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      warnings.push(String(s)); return true;
    };
    const w = startWatcher(cwd, log, defaultPolicy());
    try {
      await new Promise((r) => setTimeout(r, 100));
      writeFileSync(join(cwd, 'test', 'a.test.js'), '// force an event\n');
      for (let i = 0; i < 20 && (readWatcherHealth(log)?.dropped_events ?? 0) < 1; i++)
        await new Promise((r) => setTimeout(r, 50));

      expect(readWatcherHealth(log)).toMatchObject({
        state: 'degraded',
        dropped_events: 1,
        error_count: 1,
      });
      expect(readWatcherHealth(log)?.last_error).toMatch(/append event/i);
      expect(warnings.join('')).toMatch(/WARNING.*observer degraded.*append event/i);
    } finally {
      w.close();
      (process.stderr as unknown as { write: unknown }).write = original;
      delete process.env.TAMPERWARD_WATCH_NO_RECURSIVE;
    }
  });

  it('default health is explicitly unavailable when no observer has started', () => {
    const cwd = repo();
    const log = defaultEventLog(cwd);
    expect(readWatcherHealth(log)).toBeNull();
    expect(existsSync(watcherHealthPath(log))).toBe(false);
  });

  it('unit: persistent paths are excluded; mtime-only noise is ignored; strict env blocks', () => {
    const P = defaultPolicy();
    const ev = (path: string, hash: string | null, mode = 0o100644): FsEvent => ({
      ts: '2026-08-30T10:00:00Z', path, kind: 'change', mode, size: 10, hash,
    });
    // churn on a path that persists in the turn diff -> the diff rules own it
    expect(transientFindings([ev('test/x.test.js', 'aaa'), ev('test/x.test.js', 'bbb')], new Set(['test/x.test.js']), P, () => 'bbb')).toHaveLength(0);
    // single state + same final = mtime-only noise
    expect(transientFindings([ev('test/x.test.js', 'aaa')], new Set(), P, () => 'aaa')).toHaveLength(0);
    // churn, restored -> finding
    const f = transientFindings([ev('test/x.test.js', 'aaa'), ev('test/x.test.js', 'bbb')], new Set(), P, () => 'aaa');
    expect(f).toHaveLength(1);
    // mode churn alone -> finding (chmod-only class)
    const m = transientFindings([ev('test/x.test.js', 'aaa', 0o100644), ev('test/x.test.js', 'aaa', 0o100444)], new Set(), P, () => 'aaa');
    expect(m).toHaveLength(1);
    expect(m[0].message).toContain('mode');
    // strict env raises to block
    process.env.TAMPERWARD_TRANSIENT = 'block';
    try {
      expect(transientFindings([ev('test/x.test.js', 'aaa'), ev('test/x.test.js', 'bbb')], new Set(), P, () => 'aaa')[0].severity).toBe('block');
    } finally {
      delete process.env.TAMPERWARD_TRANSIENT;
    }
  });

  it('Stop audit distinguishes unavailable observer from healthy zero-event telemetry', () => {
    const cwd = repo();
    const deny = join(cwd, 'deny.log');
    process.env.TAMPERWARD_DENYLOG = deny;
    try {
      stopVerdict({ cwd, session_id: 'health-none' });
      expect(readFileSync(deny, 'utf8')).toContain('warn:transient-observer:unavailable');

      rmSync(deny, { force: true });
      process.env.TAMPERWARD_WATCH_NO_RECURSIVE = '1';
      const w = startWatcher(cwd, defaultEventLog(cwd), defaultPolicy());
      try {
        stopVerdict({ cwd, session_id: 'health-ok' });
        expect(existsSync(deny) ? readFileSync(deny, 'utf8') : '').not.toContain('transient-observer');
      } finally {
        w.close();
        delete process.env.TAMPERWARD_WATCH_NO_RECURSIVE;
      }
    } finally {
      delete process.env.TAMPERWARD_DENYLOG;
    }
  });

  it('Stop cannot succeed while a blocking transient remains after the first 4 MiB chunk', () => {
    const cwd = repo();
    const tw = join(cwd, '.git', 'tamperward');
    mkdirSync(tw, { recursive: true });
    const log = join(tw, 'fsevents.jsonl');
    const benign = JSON.stringify({
      ts: '2026-09-13T06:00:00Z',
      path: 'src.js',
      kind: 'change',
      mode: 0o100644,
      size: 10,
      hash: 'same',
    }) + '\n';
    const repeats = Math.ceil((MAX_EVENT_READ_BYTES + 32 * 1024) / Buffer.byteLength(benign));
    const tail = [
      { ts: '2026-09-13T06:00:01Z', path: 'test/a.test.js', kind: 'change', mode: 0o100644, size: 5, hash: 'weakened' },
      { ts: '2026-09-13T06:00:02Z', path: 'test/a.test.js', kind: 'change', mode: 0o100644, size: 50, hash: 'restored' },
    ].map((x) => JSON.stringify(x)).join('\n') + '\n';
    writeFileSync(log, benign.repeat(repeats) + tail);

    process.env.TAMPERWARD_TRANSIENT = 'block';
    try {
      const r = stopVerdict({ cwd, session_id: 'backlog' });
      expect(r.stdout).toContain('transient-protected-mutation');
      expect(existsSync(join(tw, 'fscursor-backlog.json'))).toBe(false);
    } finally {
      delete process.env.TAMPERWARD_TRANSIENT;
    }
  });

  it('Stop fails closed and retains its cursor on malformed complete observer telemetry', () => {
    const cwd = repo();
    const tw = join(cwd, '.git', 'tamperward');
    mkdirSync(tw, { recursive: true });
    writeFileSync(join(tw, 'fsevents.jsonl'), '{not-json}\n');

    const r = stopVerdict({ cwd, session_id: 'malformed' });
    expect(r.stdout).toMatch(/block/);
    expect(r.stdout).toMatch(/observer|telemetry|malformed/i);
    expect(existsSync(join(tw, 'fscursor-malformed.json'))).toBe(false);
  });

  it('Stop blocks and retains its cursor when more than 16 MiB of valid telemetry remains', () => {
    const cwd = repo();
    const tw = join(cwd, '.git', 'tamperward');
    mkdirSync(tw, { recursive: true });
    const log = join(tw, 'fsevents.jsonl');
    const line = JSON.stringify({
      ts: '2026-09-13T06:00:00Z',
      path: 'src.js',
      kind: 'change',
      mode: 0o100644,
      size: 10,
      hash: 'same',
    }) + '\n';
    const repeats = Math.ceil((MAX_EVENT_SWEEP_BYTES + 64 * 1024) / Buffer.byteLength(line));
    writeFileSync(log, line.repeat(repeats));

    const r = stopVerdict({ cwd, session_id: 'aggregate' });
    expect(r.stdout).toMatch(/block/);
    expect(r.stdout).toMatch(/observer|telemetry|16|aggregate/i);
    expect(existsSync(join(tw, 'fscursor-aggregate.json'))).toBe(false);
  });

  it('Stop fails closed without cursor progress on an oversized single JSONL record', () => {
    const cwd = repo();
    const tw = join(cwd, '.git', 'tamperward');
    mkdirSync(tw, { recursive: true });
    const huge = {
      ts: '2026-09-13T06:00:00Z',
      path: 'src.js',
      kind: 'change',
      mode: 0o100644,
      size: 10,
      hash: 'same',
      padding: 'x'.repeat(MAX_EVENT_READ_BYTES + 1024),
    };
    writeFileSync(join(tw, 'fsevents.jsonl'), JSON.stringify(huge) + '\n');

    const r = stopVerdict({ cwd, session_id: 'oversized' });
    expect(r.stdout).toMatch(/block/);
    expect(r.stdout).toMatch(/observer|telemetry|record|limit/i);
    expect(existsSync(join(tw, 'fscursor-oversized.json'))).toBe(false);
  });

  // #550: an FSWatcher can emit an `error` asynchronously, AFTER creation
  // succeeded. Without an `error` listener that is an unhandled EventEmitter
  // error (which crashes the observer) and its cause never reaches health.
  interface FakeWatcher extends EventEmitter {
    closed: boolean;
    close(): void;
  }
  const fakeWatchFactory = (): { fn: typeof fsWatch; created: FakeWatcher[] } => {
    const created: FakeWatcher[] = [];
    const fn = ((..._args: unknown[]): FakeWatcher => {
      const w = new EventEmitter() as FakeWatcher;
      w.closed = false;
      w.close = () => { w.closed = true; };
      created.push(w);
      return w;
    }) as unknown as typeof fsWatch;
    return { fn, created };
  };
  const captureStderr = () => {
    const seen: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      seen.push(String(s)); return true;
    };
    return { text: () => seen.join(''), restore: () => { (process.stderr as unknown as { write: unknown }).write = original; } };
  };

  it('routes an asynchronous recursive FSWatcher error through health, closing the failed handle (#550)', () => {
    delete process.env.TAMPERWARD_WATCH_NO_RECURSIVE; // exercise the recursive branch
    const cwd = repo();
    const log = join(cwd, 'events.jsonl');
    const { fn, created } = fakeWatchFactory();
    const stderr = captureStderr();
    const w = startWatcher(cwd, log, defaultPolicy(), fn);
    try {
      expect(readWatcherHealth(log)?.backend).toBe('recursive');
      expect(created).toHaveLength(1);

      created[0].emit('error', new Error('ENOSPC: watch limit reached')); // no listener => throws under the old code

      const h = readWatcherHealth(log);
      expect(h?.state).toBe('degraded');
      expect(h?.error_count).toBe(1);
      expect(h?.watched_dirs).toBe(0); // a failed recursive watcher is not complete coverage
      expect(h?.last_error).toMatch(/watch limit reached/);
      expect(created[0].closed).toBe(true);
      expect(stderr.text()).toMatch(/WARNING.*observer degraded/i);
    } finally {
      w.close();
      stderr.restore();
    }
  });

  it('routes an asynchronous fallback FSWatcher error through health, updating watched-dir counts idempotently (#550)', () => {
    process.env.TAMPERWARD_WATCH_NO_RECURSIVE = '1';
    const cwd = repo();
    const log = join(cwd, 'events.jsonl');
    const { fn, created } = fakeWatchFactory();
    const stderr = captureStderr();
    const w = startWatcher(cwd, log, defaultPolicy(), fn);
    try {
      const before = readWatcherHealth(log)!;
      expect(before.backend).toBe('fallback');
      expect(before.watched_dirs).toBeGreaterThanOrEqual(2);
      expect(created.length).toBe(before.watched_dirs);

      created[0].emit('error', new Error('EMFILE: too many open files'));

      const after = readWatcherHealth(log)!;
      expect(after.state).toBe('degraded');
      expect(after.error_count).toBe(1);
      expect(after.last_error).toMatch(/watch directory/);
      expect(after.watched_dirs).toBe(before.watched_dirs - 1); // failed handle removed from coverage
      expect(created[0].closed).toBe(true);
      expect(stderr.text()).toMatch(/WARNING.*observer degraded/i);

      created[0].emit('error', new Error('EMFILE again')); // already removed: no double count, no re-close race
      const again = readWatcherHealth(log)!;
      expect(again.error_count).toBe(1);
      expect(again.watched_dirs).toBe(before.watched_dirs - 1);
    } finally {
      w.close();
      stderr.restore();
      delete process.env.TAMPERWARD_WATCH_NO_RECURSIVE;
    }
  });

  it('Stop consumes the event log and surfaces strict transients as blocks', async () => {
    const cwd = repo();
    const gitDirEvents = join(cwd, '.git', 'tamperward');
    mkdirSync(gitDirEvents, { recursive: true });
    const log = join(gitDirEvents, 'fsevents.jsonl');
    const lines: FsEvent[] = [
      { ts: '2026-08-30T10:00:00Z', path: 'test/a.test.js', kind: 'change', mode: 0o100644, size: 5, hash: 'weakened' },
      { ts: '2026-08-30T10:00:01Z', path: 'test/a.test.js', kind: 'change', mode: 0o100644, size: 50, hash: 'restored' },
    ];
    writeFileSync(log, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    process.env.TAMPERWARD_TRANSIENT = 'block';
    try {
      const r = stopVerdict({ cwd, session_id: 's3' });
      expect(r.stdout).toContain('transient-protected-mutation');
    } finally {
      delete process.env.TAMPERWARD_TRANSIENT;
    }
    // a blocked stop must NOT advance the cursor: the churn stays visible
    expect(existsSync(join(gitDirEvents, 'fscursor-s3.json'))).toBe(false);
  });
});
