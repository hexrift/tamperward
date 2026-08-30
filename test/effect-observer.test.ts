// The effect layer, tested as the incidents that motivated it:
//  - 07-fastify (Phase 3): a protected mutation whose tool call the gate never
//    judged must be denied at the NEXT call from its filesystem effect.
//  - applyEdit fail-open: an Edit whose old_string cannot be located must be
//    judged from its incoming content, never silently allowed.
//  - A.1 probes: chmod-only and modify+restore must be OBSERVED by the watcher
//    and judged by the transient rule, the two documented observer misses.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preToolUseVerdict, stopVerdict } from '../src/cli/hook';
import { defaultPolicy } from '../src/policy';
import { startWatcher } from '../src/cli/watch';
import { readEvents, transientFindings } from '../src/detectors/fs-events';
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

describe('watcher + transient rule (the A.1 probes)', () => {
  it('observes modify+restore and chmod-only, and the rule fires on the churn', async () => {
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
    }
    const { events } = readEvents(log, 0);
    expect(events.length).toBeGreaterThanOrEqual(2);

    const finalHash = () => 'final-equals-baseline';
    const findings = transientFindings(events, new Set(), defaultPolicy(), finalHash);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].rule).toBe('transient-protected-mutation');
    expect(findings[0].severity).toBe('warn');
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
