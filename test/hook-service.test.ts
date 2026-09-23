// The opt-in persistent hook service (#322): a warm process that evaluates
// `hook claude` / `sweep claude` requests over a per-user unix socket and keeps
// the protected-tree snapshot cached in its own memory.
//
// The contract under test:
//   - the cache never believes an attacker-writable stat triple: a same-size
//     rewrite with a `touch -r`-restored mtime is still rehashed and reported as
//     drift, and an entry younger than the racy margin is never reused;
//   - the client refuses a socket (or its directory) that another uid owns, or
//     that is group/world accessible, or that is not a socket — and refuses is
//     "fall back to the in-process gate", never "allow";
//   - a dead service (stale socket, dead pid) is the same fallback;
//   - stopping the service leaves no socket and no state file behind;
//   - the verdict a payload gets through the service is byte-identical to the
//     verdict the in-process path gives it.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driftBetween, snapshotProtected } from '../src/effect';
import { SnapshotCache, RACY_MARGIN_NS } from '../src/ptree-cache';
import { loadPolicy } from '../src/policy-load';
import { preToolUseFromRaw, stopFromRaw } from '../src/cli/hook';
import { HOOK_SERVICE_PROTOCOL, requestVerdict, servicePaths, socketRefusal, type ServicePaths } from '../src/cli/hook-client';
import { readServiceState, startHookService, stopHookService, type RunningService } from '../src/cli/hook-service';
import { TW_VERSION } from '../src/wiring';
import { validateCliArgs } from '../src/cli/main';

const dirs: string[] = [];
const services: RunningService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function repo(): string {
  const d = tmp('tw-svc-');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: d });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  mkdirSync(join(d, 'test'));
  mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'test', 'a.test.js'), `it('one', () => { expect(1).toBe(1); });\nit('two', () => { expect(2).toBe(2); });\n`);
  writeFileSync(join(d, 'src', 'x.js'), 'export const x = 1;\n');
  writeFileSync(join(d, '.tamperward.yml'), 'version: 1\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return d;
}

/** A private runtime directory for one test's service, the way the real one is created. */
function privatePaths(): ServicePaths {
  const dir = join(tmp('tw-rt-'), 'svc');
  mkdirSync(dir, { mode: 0o700 });
  return { dir, socket: join(dir, 'hook.sock'), state: join(dir, 'hook-service.json') };
}

async function serve(root: string, paths = privatePaths()): Promise<RunningService> {
  const s = await startHookService({ root, paths });
  services.push(s);
  return s;
}

const NS = 1_000_000_000n;
const BEFORE = "it('alpha_padding_here', () => { expect(1).toBe(1); });\n";
const AFTER = "it.skip('alpha_padding', () => { expect(1).toBe(1); });\n";

describe('snapshot cache: trusted inputs only', () => {
  it('a same-size rewrite with a restored mtime is rehashed and reported as drift', () => {
    expect(AFTER.length).toBe(BEFORE.length);
    const cwd = repo();
    const file = join(cwd, 'test', 'a.test.js');
    writeFileSync(file, BEFORE);
    const policy = loadPolicy(cwd);
    // A clock far enough ahead that every entry is past the racy margin, so
    // the stat key alone decides whether the cache is consulted.
    const cache = new SnapshotCache({ now: () => BigInt(Date.now()) * 1_000_000n + 10n * NS });
    const baseline = snapshotProtected(cwd, policy, undefined, cache);
    const ref = join(cwd, 'ref');
    writeFileSync(ref, '');
    execFileSync('cp', ['-p', file, ref]);
    const before = statSync(file);

    writeFileSync(file, AFTER);
    execFileSync('touch', ['-r', ref, file]);
    const st = statSync(file);
    expect(st.size).toBe(BEFORE.length);
    expect(st.mtimeMs).toBe(before.mtimeMs);

    const current = snapshotProtected(cwd, policy, baseline, cache);
    expect(driftBetween(baseline, current).changed).toContain('test/a.test.js');
  });

  it('an unchanged, aged entry is served from the cache; a fresh one never is', () => {
    const cwd = repo();
    const policy = loadPolicy(cwd);
    // Real clock: the fixture file was written milliseconds ago, inside the
    // racy margin, so its hash is recomputed on every snapshot.
    const fresh = new SnapshotCache();
    snapshotProtected(cwd, policy, undefined, fresh);
    snapshotProtected(cwd, policy, undefined, fresh);
    expect(fresh.stats.hits).toBe(0);
    expect(fresh.stats.misses).toBeGreaterThanOrEqual(2);

    // The same tree seen by a clock past the margin: the second walk reuses the hash.
    const aged = new SnapshotCache({ now: () => BigInt(Date.now()) * 1_000_000n + RACY_MARGIN_NS + NS });
    const a = snapshotProtected(cwd, policy, undefined, aged);
    const b = snapshotProtected(cwd, policy, undefined, aged);
    expect(aged.stats.hits).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });

  it('periodic full revalidation forgets every entry', () => {
    const cwd = repo();
    const policy = loadPolicy(cwd);
    let t = BigInt(Date.now()) * 1_000_000n + RACY_MARGIN_NS + NS;
    const cache = new SnapshotCache({ now: () => t, fullRevalidateMs: 1000 });
    snapshotProtected(cwd, policy, undefined, cache);
    snapshotProtected(cwd, policy, undefined, cache);
    const hits = cache.stats.hits;
    expect(hits).toBeGreaterThan(0);
    t += 2n * NS;
    snapshotProtected(cwd, policy, undefined, cache);
    expect(cache.stats.hits).toBe(hits); // nothing reused after the interval
  });
});

describe('socket trust checks', () => {
  it('is off on Windows and off without the opt-in', () => {
    expect(servicePaths({ platform: 'win32', env: {}, uid: 1 })).toBeNull();
    expect(servicePaths({ platform: 'linux', env: {}, uid: 1000, tmp: '/tmp' })).toEqual({
      dir: '/tmp/tamperward-hook-1000',
      socket: '/tmp/tamperward-hook-1000/hook.sock',
      state: '/tmp/tamperward-hook-1000/hook-service.json',
    });
    expect(servicePaths({ platform: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/1000' }, uid: 1000, tmp: '/tmp' })?.dir).toBe(
      '/run/user/1000/tamperward-hook',
    );
  });

  it('refuses a directory or socket that is group/world accessible, another uid\'s, or not a socket', async () => {
    const root = repo();
    const paths = privatePaths();
    const s = await serve(root, paths);
    expect(socketRefusal(paths)).toBeNull();
    expect((statSync(paths.socket).mode & 0o777)).toBe(0o600);

    chmodSync(paths.socket, 0o666);
    expect(socketRefusal(paths)).toMatch(/socket .*mode/);
    chmodSync(paths.socket, 0o600);
    expect(socketRefusal(paths)).toBeNull();

    chmodSync(paths.dir, 0o755);
    expect(socketRefusal(paths)).toMatch(/directory .*mode/);
    chmodSync(paths.dir, 0o700);

    const uid = (process.getuid?.() ?? 0) + 1;
    expect(socketRefusal(paths, uid)).toMatch(/owned by uid/);

    await s.close();
    services.splice(services.indexOf(s), 1);
    const other = tmp('tw-link-');
    symlinkSync(join(other, 'nowhere'), paths.socket);
    expect(socketRefusal(paths)).toMatch(/not a socket/);
    expect(await requestVerdict('PreToolUse', '', { paths, cwd: root })).toBeNull();
  });
});

describe('fallback: absent, dead, stale or foreign service', () => {
  it('a stale socket file with no listener and a dead pid fall back to in-process', async () => {
    const root = repo();
    const paths = privatePaths();
    // A listener that accepts the connection and then becomes ambiguous. Once
    // the request is handed off, timeout is fail-closed: the client cannot prove
    // the peer did not receive/start it, so it must not evaluate a second time.
    const held = new Set<import('node:net').Socket>();
    const srv2 = createServer((c) => held.add(c));
    await new Promise<void>((r) => srv2.listen(paths.socket, r));
    chmodSync(paths.socket, 0o600);
    // A state file naming a pid that is not running.
    writeFileSync(paths.state, JSON.stringify({ pid: 2 ** 22 - 1, version: TW_VERSION, root, started_at: 'x' }), { mode: 0o600 });
    const viaService = await requestVerdict('PreToolUse', '{"tool_name":"Bash","tool_input":{"command":"git commit --no-verify -m x"}}', {
      paths,
      cwd: root,
      timeoutMs: 500,
    });
    // No explicit refusal came back, so this is NOT safe fallback.
    expect(viaService).not.toBeNull();
    expect(viaService?.stdout).toMatch(/permissionDecision":"deny"/);
    expect(viaService?.stdout).toMatch(/did not receive a verdict/);
    for (const c of held) c.destroy();
    await new Promise<void>((r) => srv2.close(() => r()));
    expect(await requestVerdict('PreToolUse', '', { paths, cwd: root })).toBeNull();
    expect((await stopHookService(paths)).outcome).toBe('not-running');
    expect(existsSync(paths.socket)).toBe(false);
    expect(existsSync(paths.state)).toBe(false);
  });

  it('an accepted request that times out fails closed instead of starting a second evaluation', async () => {
    const root = repo();
    const paths = privatePaths();
    const held = new Set<import('node:net').Socket>();
    const srv = createServer((c) => {
      held.add(c);
      c.once('data', () => {
        c.write(JSON.stringify({ v: HOOK_SERVICE_PROTOCOL, version: TW_VERSION, accepted: true }) + '\n');
        // Deliberately never send the final verdict: after acceptance, the
        // client must NOT return null (which the launcher interprets as
        // permission to evaluate the same request in-process).
      });
    });
    await new Promise<void>((r) => srv.listen(paths.socket, r));
    chmodSync(paths.socket, 0o600);
    const result = await requestVerdict('PreToolUse', '{"tool_name":"Bash","tool_input":{"command":"echo ok"}}', {
      paths,
      cwd: root,
      timeoutMs: 100,
    });
    expect(result).not.toBeNull();
    expect(result?.exitCode).toBe(0);
    expect(result?.stdout).toMatch(/permissionDecision":"deny"/);
    expect(result?.stdout).toMatch(/handed this hook evaluation.*did not receive a verdict/);
    for (const c of held) c.destroy();
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it('a version or protocol mismatch, or a cwd outside the bound root, is refused by the service', async () => {
    const root = repo();
    const s = await serve(root);
    expect(await requestVerdict('PreToolUse', '', { paths: s.paths, cwd: root, version: '0.0.1' })).toBeNull();
    const elsewhere = tmp('tw-elsewhere-');
    expect(await requestVerdict('PreToolUse', '', { paths: s.paths, cwd: elsewhere })).toBeNull();
    expect(s.served).toBe(0);
    expect(await requestVerdict('PreToolUse', '', { paths: s.paths, cwd: root })).toEqual({ exitCode: 0, stdout: '' });
    expect(s.served).toBe(1);
  });
});

describe('lifecycle', () => {
  it('start records pid/version/root at mode 0600 and stop leaves nothing behind', async () => {
    const root = repo();
    const paths = privatePaths();
    const s = await serve(root, paths);
    expect(readServiceState(paths)).toEqual({ pid: process.pid, version: TW_VERSION, root, started_at: expect.any(String) });
    expect(statSync(paths.state).mode & 0o777).toBe(0o600);
    expect(statSync(paths.socket).mode & 0o777).toBe(0o600);
    await s.close();
    services.splice(services.indexOf(s), 1);
    expect(existsSync(paths.socket)).toBe(false);
    expect(existsSync(paths.state)).toBe(false);
    expect(readServiceState(paths)).toBeNull();
  });

  it('never signals a stale reused pid unless the live service socket authenticates it', async () => {
    const root = repo();
    const paths = privatePaths();
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    expect(child.pid).toBeDefined();
    writeFileSync(
      paths.state,
      JSON.stringify({ pid: child.pid, version: TW_VERSION, root, started_at: 'stale' }) + '\n',
      { mode: 0o600 },
    );
    try {
      expect((await stopHookService(paths)).outcome).toBe('not-running');
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      expect(existsSync(paths.state)).toBe(false);
    } finally {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
  });

  it('a second start on the same socket is refused while the first is alive', async () => {
    const root = repo();
    const paths = privatePaths();
    await serve(root, paths);
    await expect(startHookService({ root, paths })).rejects.toThrow(/already running/);
  });

  it('the CLI grammar knows hook-service start|stop|status', () => {
    expect(validateCliArgs('hook-service', ['start'])).toBeUndefined();
    expect(validateCliArgs('hook-service', ['start', '--dir', '/x'])).toBeUndefined();
    expect(validateCliArgs('hook-service', ['stop'])).toBeUndefined();
    expect(validateCliArgs('hook-service', ['stop', '--dir', '/x'])).toBeUndefined();
    expect(validateCliArgs('hook-service', ['status'])).toBeUndefined();
    expect(validateCliArgs('hook-service', ['status', '--dir', '/x'])).toBeUndefined();
    expect(validateCliArgs('hook-service', [])).toMatch(/start|stop|status/);
    expect(validateCliArgs('hook-service', ['restart'])).toMatch(/start|stop|status/);
    expect(validateCliArgs('hook-service', ['stop', '--bogus'])).toMatch(/unknown option/);
  });
});

describe('bounded shutdown for open sockets (#551)', () => {
  it('a stalled pre-request connection does not prevent bounded shutdown', async () => {
    const root = repo();
    const paths = privatePaths();
    const s = await serve(root, paths);
    // A client that connects and holds the socket open without ever sending a
    // complete request line — the case that made server.close() wait forever.
    const stalled = createConnection(paths.socket);
    await new Promise<void>((resolve, reject) => {
      stalled.once('connect', () => resolve());
      stalled.once('error', reject);
    });
    stalled.write('{"v":1,"partial":'); // no newline: the request never completes

    const outcome = await Promise.race([
      s.close().then(() => 'closed' as const),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000)),
    ]);
    expect(outcome).toBe('closed');
    services.splice(services.indexOf(s), 1);
    expect(existsSync(paths.socket)).toBe(false);
    expect(existsSync(paths.state)).toBe(false);
    // A repeated close after a bounded one stays correct.
    await expect(s.close()).resolves.toBeUndefined();
    stalled.destroy();
  });

  it('an incomplete request is never evaluated and records no side effects', async () => {
    const root = repo();
    const paths = privatePaths();
    const s = await serve(root, paths);
    const partial = createConnection(paths.socket);
    await new Promise<void>((resolve, reject) => {
      partial.once('connect', () => resolve());
      partial.once('error', reject);
    });
    // A payload that would deny if evaluated, but with no terminating newline.
    partial.write(
      JSON.stringify({ v: HOOK_SERVICE_PROTOCOL, version: TW_VERSION, kind: 'PreToolUse', raw: '{}', cwd: root, env: {} }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(s.served).toBe(0);
    partial.destroy();
    // A well-formed request still works after the incomplete one is gone.
    expect(await requestVerdict('PreToolUse', '', { paths, cwd: root })).toEqual({ exitCode: 0, stdout: '' });
    expect(s.served).toBe(1);
  });
});

describe('stop never orphans a live listener (#416)', () => {
  it('a mismatched state file + a live listener → stop reports the mismatch and the pid, socket left intact', async () => {
    const root = repo();
    const paths = privatePaths();
    const s = await serve(root, paths);
    // Rewrite the state file to a mismatched version, exactly as the issue
    // describes: the listener is still alive with the real version, but the
    // (candidate-writable) state file now disagrees.
    writeFileSync(paths.state, JSON.stringify({ pid: process.pid, version: '9.9.9', root, started_at: 'tampered' }) + '\n', { mode: 0o600 });

    const res = await stopHookService(paths);
    // Never "not running" for a socket that answered, and never an unlink of it.
    expect(res.outcome).toBe('mismatch');
    expect(res.pid).toBe(process.pid); // the pid the live socket reports, not the state file's
    expect(res.detail).toMatch(/9\.9\.9/); // names the disagreement
    expect(existsSync(paths.socket)).toBe(true); // the answering socket is left intact
    expect(socketRefusal(paths)).toBeNull(); // still a healthy, connectable socket
    // The listener is still serving after the failed stop.
    expect(await requestVerdict('PreToolUse', '', { paths, cwd: root })).toEqual({ exitCode: 0, stdout: '' });
  });

  it('a wrong pid in the state file is a mismatch too, reported with the socket\'s own pid', async () => {
    const root = repo();
    const paths = privatePaths();
    await serve(root, paths);
    writeFileSync(paths.state, JSON.stringify({ pid: 2 ** 22 - 1, version: TW_VERSION, root, started_at: 'x' }) + '\n', { mode: 0o600 });

    const res = await stopHookService(paths);
    expect(res.outcome).toBe('mismatch');
    expect(res.pid).toBe(process.pid); // NOT the bogus pid in the state file
    expect(existsSync(paths.socket)).toBe(true);
  });
});

describe('concurrent requests are serialized safely (#416)', () => {
  it('a second request in flight is refused so the client falls back in-process, with no service side effects', async () => {
    const root = repo();
    const s = await serve(root);
    const raw = JSON.stringify({ tool_name: 'Bash', session_id: 'concurrent', cwd: root, tool_input: { command: 'git commit --no-verify -m wip' } });
    const line = JSON.stringify({ v: HOOK_SERVICE_PROTOCOL, version: TW_VERSION, kind: 'PreToolUse', raw, cwd: root, env: {} }) + '\n';

    const open = (): Promise<Socket> =>
      new Promise((resolve, reject) => {
        const sock = createConnection(s.paths.socket);
        sock.setEncoding('utf8');
        sock.once('error', reject);
        sock.once('connect', () => resolve(sock));
      });
    const readAll = (sock: Socket): Promise<Array<Record<string, unknown>>> =>
      new Promise((resolve) => {
        let buf = '';
        sock.on('data', (c: string) => { buf += c; });
        sock.on('close', () => resolve(buf.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)));
      });

    // Both connections fully established, then both requests written in one
    // synchronous burst so the service reads them in a single event-loop poll:
    // it takes the first as the sole owner (the evaluation is deferred to the
    // check phase, after both reads) and must refuse the second BEFORE any
    // acceptance, so that client falls back in-process.
    const [a, b] = await Promise.all([open(), open()]);
    const ra = readAll(a);
    const rb = readAll(b);
    await new Promise((r) => setTimeout(r, 25));
    a.write(line);
    b.write(line);
    const [la, lb] = await Promise.all([ra, rb]);

    const conversations = [la, lb];
    const servedConvos = conversations.filter((c) => c.some((m) => m.accepted === true) && c.some((m) => typeof m.exitCode === 'number'));
    const refusedConvos = conversations.filter((c) => c.some((m) => typeof m.refused === 'string' && /in flight/.test(String(m.refused))));
    // Exactly one served, exactly one refused (→ the client falls back in-process).
    expect(servedConvos.length).toBe(1);
    expect(refusedConvos.length).toBe(1);
    // The refused request applied NO side effects: only the served one counts.
    expect(s.served).toBe(1);
    // The refused conversation never carried an acceptance line.
    expect(refusedConvos[0].some((m) => m.accepted === true)).toBe(false);
  });
});

describe('verdict parity: service vs in-process', () => {
  it('every fixture payload gets the identical HookResult on both paths', async () => {
    const root = repo();
    const s = await serve(root);
    const spec = join(root, 'test', 'a.test.js');
    const pre = (sid: string): Array<[string, string]> => [
      ['allow: ordinary edit', JSON.stringify({ tool_name: 'Edit', session_id: sid, cwd: root, tool_input: { file_path: join(root, 'src/x.js'), old_string: 'x = 1', new_string: 'x = 2' } })],
      ['deny: test-deletion', JSON.stringify({ tool_name: 'Edit', session_id: sid, cwd: root, tool_input: { file_path: spec, old_string: `it('two', () => { expect(2).toBe(2); });\n`, new_string: '' } })],
      ['deny: no-verify', JSON.stringify({ tool_name: 'Bash', session_id: sid, cwd: root, tool_input: { command: 'git commit --no-verify -m wip' } })],
      ['deny: malformed payload', '{"tool_name": '],
      ['deny: payload is an array', '[]'],
      ['allow: empty stdin', ''],
    ];
    // The IPC contract carries the ENFORCEMENT verdict (exitCode + stdout); the in-process HookResult
    // also carries a structured `findings` extension for direct programmatic callers (#616), which the
    // service/client deliberately do not forward. Parity is therefore over the enforcement fields.
    const enforcement = (r: { exitCode: number; stdout: string } | null) => (r ? { exitCode: r.exitCode, stdout: r.stdout } : r);
    for (const [label, raw] of pre('sid-inproc')) {
      const direct = preToolUseFromRaw(raw, root);
      const remote = await requestVerdict('PreToolUse', raw.replace('sid-inproc', 'sid-service'), { paths: s.paths, cwd: root });
      expect(enforcement(remote), label).toEqual(enforcement(direct));
    }
    // Stop, over a tree the turn weakened from the shell.
    writeFileSync(spec, `it.skip('one', () => { expect(1).toBe(1); });\nit('two', () => { expect(2).toBe(2); });\n`);
    const stop = (sid: string) => JSON.stringify({ session_id: sid, cwd: root, stop_hook_active: false });
    const direct = stopFromRaw(stop('sid-inproc'), root);
    expect(direct.stdout).toMatch(/test-skip/);
    expect(enforcement(await requestVerdict('Stop', stop('sid-service'), { paths: s.paths, cwd: root }))).toEqual(enforcement(direct));
    expect(s.served).toBe(7);
  });

  it('uses the client Claude config/home environment rather than the service startup environment', async () => {
    const root = repo();
    const s = await serve(root);
    const config = tmp('tw-claude-config-');
    const settings = join(config, 'settings.json');
    const raw = JSON.stringify({
      tool_name: 'Bash',
      session_id: 'env-parity',
      cwd: root,
      // This command is classified only if the evaluator expands the CLIENT'S
      // relocated Claude config root. The service was started without it.
      tool_input: { command: 'rm $CLAUDE_CONFIG_DIR/settings.json' },
    });

    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    let direct: ReturnType<typeof preToolUseFromRaw>;
    try {
      direct = preToolUseFromRaw(raw, root);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
    expect(direct.stdout).toMatch(/hook-tampering/);

    // The service was started with the restored ambient environment; only the
    // request carries this Claude config root. The verdict must still match. Parity is over the
    // enforcement fields (exitCode + stdout); the in-process `findings` extension is not forwarded (#616).
    const remote = await requestVerdict('PreToolUse', raw, {
      paths: s.paths,
      cwd: root,
      env: { ...process.env, CLAUDE_CONFIG_DIR: config },
    });
    expect({ exitCode: remote?.exitCode, stdout: remote?.stdout }).toEqual({ exitCode: direct.exitCode, stdout: direct.stdout });
  });
});

const DIST = join(__dirname, '..', 'dist', 'cli', 'index.js');

// The full test matrix deliberately does not own dist/: other parallel tests may
// create/remove build output transiently. Run this only from the CI build job,
 // after that job has built the exact CLI it owns.
describe.skipIf(process.env.TAMPERWARD_BUILT_CLI_E2E !== '1' || !existsSync(DIST) || process.platform === 'win32')('built CLI end to end', () => {
  it('the thin client uses the service only under TAMPERWARD_HOOK_SERVICE=1 and falls back when it is gone', async () => {
    const root = repo();
    const rt = join(tmp('tw-e2e-'), 'rt');
    const env = { ...process.env, TAMPERWARD_HOOK_SERVICE: '1', TAMPERWARD_HOOK_SERVICE_DIR: rt };
    const child = spawn('node', [DIST, 'hook-service', 'start', '--dir', root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => { out += String(b); });
    child.stderr.on('data', (b) => { out += String(b); });
    const started = Date.now();
    while (!out.includes('listening') && Date.now() - started < 15000) await new Promise((r) => setTimeout(r, 50));
    expect(out).toMatch(/listening/);
    try {
      const raw = JSON.stringify({ tool_name: 'Bash', session_id: 'e2e', cwd: root, tool_input: { command: 'git commit --no-verify -m wip' } });
      const viaService = spawnSync('node', [DIST, 'hook', 'claude'], { input: raw, cwd: root, env, encoding: 'utf8' });
      const direct = spawnSync('node', [DIST, 'hook', 'claude'], { input: raw, cwd: root, env: { ...process.env, TAMPERWARD_HOOK_SERVICE_DIR: rt }, encoding: 'utf8' });
      expect(viaService.status).toBe(0);
      expect(viaService.stdout).toMatch(/no-verify/);
      expect(viaService.stdout).toBe(direct.stdout);
      const status = spawnSync('node', [DIST, 'hook-service', 'status'], { env, encoding: 'utf8' });
      expect(status.status).toBe(0);
      expect(status.stdout).toMatch(/running/);
      expect(status.stdout).toMatch(/served: 1\b/);
      const stop = spawnSync('node', [DIST, 'hook-service', 'stop'], { env, encoding: 'utf8' });
      expect(stop.stderr).toBe('');
      expect(stop.status).toBe(0);
      await new Promise<void>((r) => child.on('exit', () => r()));
      expect(existsSync(join(rt, 'hook.sock'))).toBe(false);
      expect(existsSync(join(rt, 'hook-service.json'))).toBe(false);
      const fallback = spawnSync('node', [DIST, 'hook', 'claude'], { input: raw, cwd: root, env, encoding: 'utf8' });
      expect(fallback.status).toBe(0);
      expect(fallback.stdout).toBe(direct.stdout);
      const again = spawnSync('node', [DIST, 'hook-service', 'status'], { env, encoding: 'utf8' });
      expect(again.stdout).toMatch(/not running/);
    } finally {
      child.kill('SIGTERM');
    }
  }, 60000);

  // #551: shutdown during an ACCEPTED request. The service runs in a separate,
  // killable process, so an evaluation that stalled could never hang this runner —
  // the outer wall-clock bound is enforced by SIGKILL'ing that process. A trusted
  // in-test proxy relays the real client <-> real service byte stream and, the
  // instant it observes the service's acceptance frame, initiates shutdown of the
  // service and stops relaying the service side — reproducing the race where an
  // accepted request is lost to shutdown exactly at handoff. The client must fail
  // closed (a deny), never fall back to a SECOND in-process evaluation.
  it('shutdown during an accepted request never triggers a second evaluation and the client fails closed (#551)', async () => {
    const root = repo();
    const rt = join(tmp('tw-shutdown-e2e-'), 'rt');
    const env = { ...process.env, TAMPERWARD_HOOK_SERVICE: '1', TAMPERWARD_HOOK_SERVICE_DIR: rt };
    const child = spawn('node', [DIST, 'hook-service', 'start', '--dir', root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => { out += String(b); });
    child.stderr.on('data', (b) => { out += String(b); });
    const started = Date.now();
    while (!out.includes('listening') && Date.now() - started < 15000) await new Promise((r) => setTimeout(r, 50));
    expect(out).toMatch(/listening/);
    const realSock = join(rt, 'hook.sock');

    // A proxy the real client trusts (our uid, 0600). It watches the service→client
    // direction for the acceptance frame; on seeing it, it triggers shutdown and drops
    // the rest, so the accepted verdict is lost to the shutdown.
    const proxyDir = join(tmp('tw-proxy-'), 'svc');
    mkdirSync(proxyDir, { mode: 0o700 });
    const proxyPaths = { dir: proxyDir, socket: join(proxyDir, 'hook.sock'), state: join(proxyDir, 'hook-service.json') };
    let acceptedFrames = 0;
    const proxy = createServer((clientSide) => {
      const up = createConnection(realSock);
      up.setEncoding('utf8');
      clientSide.on('data', (d) => up.write(d));
      let handedOff = false;
      let ubuf = '';
      up.on('data', (d: string) => {
        if (handedOff) return; // after handoff the verdict is lost to the shutdown
        ubuf += d;
        let nl: number;
        while ((nl = ubuf.indexOf('\n')) >= 0) {
          const frame = ubuf.slice(0, nl);
          ubuf = ubuf.slice(nl + 1);
          clientSide.write(frame + '\n');
          if (/"accepted"\s*:\s*true/.test(frame)) {
            handedOff = true;
            acceptedFrames++;
            child.kill('SIGTERM'); // shutdown during accepted work
            break;
          }
        }
      });
      const bail = (): void => { up.destroy(); clientSide.destroy(); };
      up.on('error', bail);
      clientSide.on('error', bail);
      up.on('close', () => clientSide.end());
    });
    await new Promise<void>((r) => proxy.listen(proxyPaths.socket, r));
    chmodSync(proxyPaths.socket, 0o600);

    try {
      const raw = JSON.stringify({ tool_name: 'Bash', session_id: 'shutdown-e2e', cwd: root, tool_input: { command: 'git commit --no-verify -m wip' } });
      const result = await requestVerdict('PreToolUse', raw, { paths: proxyPaths, cwd: root, timeoutMs: 1500 });
      // Exactly one acceptance handoff was observed, and the client, having seen it,
      // did NOT fall back (which would be a second evaluation): it fails closed with a
      // deny. This is the #551 at-most-once guarantee under shutdown.
      expect(acceptedFrames).toBe(1);
      expect(result).not.toBeNull();
      expect(result?.exitCode).toBe(0);
      expect(result?.stdout).toMatch(/permissionDecision":"deny"/);
      expect(result?.stdout).toMatch(/handed this hook evaluation.*did not receive a verdict/);

      // Outer wall-clock bound: the separately-killable service must exit promptly once
      // shutdown starts; if it overruns the drain window it is SIGKILL'd so a stall can
      // never hang the runner.
      const exited = await Promise.race([
        new Promise<'exited'>((r) => child.once('exit', () => r('exited'))),
        new Promise<'stall'>((r) => setTimeout(() => r('stall'), 15000)),
      ]);
      if (exited === 'stall') child.kill('SIGKILL');
      expect(exited).toBe('exited');
      expect(existsSync(realSock)).toBe(false);
      expect(existsSync(join(rt, 'hook-service.json'))).toBe(false);
    } finally {
      child.kill('SIGKILL');
      await new Promise<void>((r) => proxy.close(() => r()));
    }
  }, 60000);
});
