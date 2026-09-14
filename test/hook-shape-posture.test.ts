// init and doctor certify the wiring by the same canonical-shape comparison the
// hook-tampering detector applies (#413). A Claude hook entry the runtime would
// not run the gate through — `async`, a `timeout` that cuts it off,
// `disableAllHooks` — and a pre-commit gate line commented out with `#` used to
// read as OK from `init --dry-run` and `doctor` (and therefore from onboard's
// posture summary) while `check --staged` blocked the same file.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planInit, runInit } from '../src/cli/init';
import { collectLocalPosture, runDoctor } from '../src/cli/doctor';
import { runOnboard } from '../src/cli/onboard';
import { loadPolicy } from '../src/policy-load';

vi.setConfig({ testTimeout: 60_000 });

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A repository `tamperward init` has fully wired. */
function wiredRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-hook-shape-'));
  dirs.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'acme');
  git('remote', 'add', 'origin', 'https://github.com/acme/project.git');
  writeFileSync(join(cwd, '.tamperward.yml'), 'version: 1\nverify:\n  command: npm test\n  budget: 300\n');
  git('add', '.tamperward.yml');
  git('commit', '-qm', 'trusted policy');
  expect(runInit({ cwd })).toBe(0);
  return cwd;
}

function capture(fn: () => number): { code: number; out: string } {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string | Uint8Array) => { out += String(s); return true; }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
  const code = fn();
  vi.restoreAllMocks();
  return { code, out };
}

const settingsPath = (cwd: string): string => join(cwd, '.claude', 'settings.json');
const readSettings = (cwd: string): Record<string, unknown> => JSON.parse(readFileSync(settingsPath(cwd), 'utf8'));
const writeSettings = (cwd: string, s: unknown): void => writeFileSync(settingsPath(cwd), JSON.stringify(s, null, 2) + '\n');

/** Fixture 1 from the issue: the exact command init wrote, plus `async: true`
 *  and `timeout: 1` on the PreToolUse entry. */
function neutraliseHookEntry(cwd: string, extra: Record<string, unknown>): void {
  const s = readSettings(cwd);
  const hooks = s.hooks as { PreToolUse: Array<{ hooks: Array<Record<string, unknown>> }> };
  Object.assign(hooks.PreToolUse[0].hooks[0], extra);
  writeSettings(cwd, s);
}

const agentRow = (out: string): string => out.split('\n').find((l) => /^\s*agent\s/.test(l)) ?? '';
const preCommitRow = (out: string): string => out.split('\n').find((l) => /^\s*pre-commit\s/.test(l)) ?? '';
const doctorLine = (out: string, id: string): string => out.split('\n').find((l) => l.includes(`] ${id} `)) ?? '';

describe('control: a correctly wired repository stays OK (#413)', () => {
  it('init --dry-run and doctor both certify the wiring init itself wrote', () => {
    const cwd = wiredRepo();
    const byItem = Object.fromEntries(planInit(cwd).map((a) => [a.item, a]));
    expect(byItem.agent.status).toBe('ok');
    expect(byItem['pre-commit'].status).toBe('ok');
    const dry = capture(() => runInit({ cwd, dryRun: true }));
    expect(dry.code).toBe(0);
    expect(agentRow(dry.out)).toMatch(/\bok\b.*already wired/);
    expect(preCommitRow(dry.out)).toMatch(/\bok\b.*already runs the staged check/);
    const checks = collectLocalPosture(cwd, loadPolicy(cwd));
    const byId = Object.fromEntries(checks.map((x) => [x.id, x]));
    expect(byId['claude-hooks'].state).toBe('OK');
    expect(byId['pre-commit'].state).toBe('OK');
    // A `timeout` at or above the detector's floor is the canonical shape too.
    neutraliseHookEntry(cwd, { timeout: 600 });
    expect(Object.fromEntries(planInit(cwd).map((a) => [a.item, a.status])).agent).toBe('ok');
  });
});

describe('a neutralised Claude hook entry (#413, fixture 1)', () => {
  it('init --dry-run reports the entry as not wired, with the detector\'s reason', () => {
    const cwd = wiredRepo();
    neutraliseHookEntry(cwd, { async: true, timeout: 1 });
    const byItem = Object.fromEntries(planInit(cwd).map((a) => [a.item, a]));
    expect(byItem.agent.status).not.toBe('ok');
    expect(['update', 'error']).toContain(byItem.agent.status);
    expect(byItem.agent.detail).toMatch(/`async`/);
    expect(byItem.agent.detail).toMatch(/`timeout` 1/);
    const dry = capture(() => runInit({ cwd, dryRun: true }));
    expect(agentRow(dry.out)).not.toMatch(/already wired/);
    expect(agentRow(dry.out)).toMatch(/`async`/);
    expect(dry.code === 2 || /change\(s\) planned/.test(dry.out)).toBe(true);
  });

  it('doctor reports claude-hooks BROKEN with the detector\'s reason', () => {
    const cwd = wiredRepo();
    neutraliseHookEntry(cwd, { async: true, timeout: 1 });
    const checks = collectLocalPosture(cwd, loadPolicy(cwd));
    const byId = Object.fromEntries(checks.map((x) => [x.id, x]));
    expect(byId['claude-hooks'].state).toBe('BROKEN');
    expect(byId['claude-hooks'].detail).toMatch(/`async`/);
    expect(byId['claude-hooks'].detail).toMatch(/`timeout` 1/);
    const r = capture(() => runDoctor({ cwd, base: 'HEAD' }));
    expect(doctorLine(r.out, 'claude-hooks')).toMatch(/\[BROKEN\] claude-hooks/);
    expect(doctorLine(r.out, 'claude-hooks')).toMatch(/`async`/);
  });

  it.each([
    ['async alone', { async: true }, /`async`/],
    ['timeout below the floor', { timeout: 30 }, /`timeout` 30/],
    ['an `if` condition', { if: 'Bash(never)' }, /`if`/],
  ])('%s is a neutralised entry to init and doctor alike', (_name, extra, reason) => {
    const cwd = wiredRepo();
    neutraliseHookEntry(cwd, extra);
    const byItem = Object.fromEntries(planInit(cwd).map((a) => [a.item, a]));
    expect(byItem.agent.status).not.toBe('ok');
    expect(byItem.agent.detail).toMatch(reason);
    const byId = Object.fromEntries(collectLocalPosture(cwd, loadPolicy(cwd)).map((x) => [x.id, x]));
    expect(byId['claude-hooks'].state).toBe('BROKEN');
    expect(byId['claude-hooks'].detail).toMatch(reason);
  });

  it('a neutralised Stop sweep entry is not wired either', () => {
    const cwd = wiredRepo();
    const s = readSettings(cwd);
    const hooks = s.hooks as { Stop: Array<{ hooks: Array<Record<string, unknown>> }> };
    hooks.Stop[0].hooks[0].async = true;
    writeSettings(cwd, s);
    const byItem = Object.fromEntries(planInit(cwd).map((a) => [a.item, a]));
    expect(byItem.agent.status).not.toBe('ok');
    expect(byItem.agent.detail).toMatch(/Stop.*`async`/);
    const byId = Object.fromEntries(collectLocalPosture(cwd, loadPolicy(cwd)).map((x) => [x.id, x]));
    expect(byId['claude-hooks'].state).toBe('BROKEN');
  });

  it('disableAllHooks: true is BROKEN from doctor and not wired from init', () => {
    const cwd = wiredRepo();
    writeSettings(cwd, { ...readSettings(cwd), disableAllHooks: true });
    const byItem = Object.fromEntries(planInit(cwd).map((a) => [a.item, a]));
    expect(byItem.agent.status).not.toBe('ok');
    expect(byItem.agent.detail).toMatch(/disableAllHooks/);
    const byId = Object.fromEntries(collectLocalPosture(cwd, loadPolicy(cwd)).map((x) => [x.id, x]));
    expect(byId['claude-hooks'].state).toBe('BROKEN');
    expect(byId['claude-hooks'].detail).toMatch(/disableAllHooks/);
  });

  it('re-running init restores the canonical entry, after which doctor is OK again', () => {
    const cwd = wiredRepo();
    neutraliseHookEntry(cwd, { async: true, timeout: 1 });
    runInit({ cwd });
    const byId = Object.fromEntries(collectLocalPosture(cwd, loadPolicy(cwd)).map((x) => [x.id, x]));
    expect(byId['claude-hooks'].state).toBe('OK');
    expect(Object.fromEntries(planInit(cwd).map((a) => [a.item, a.status])).agent).toBe('ok');
  });

  it('onboard\'s posture summary inherits the verdict', async () => {
    const cwd = wiredRepo();
    neutraliseHookEntry(cwd, { async: true, timeout: 1 });
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string | Uint8Array) => { out += String(s); return true; }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
    const code = await runOnboard({ cwd, skipDemo: true, noGithub: true }, { interactive: true, ask: async () => 'n' });
    vi.restoreAllMocks();
    expect(out).toMatch(/BLOCKED\s+Fix the broken item/);
    expect(out).toMatch(/claude-hooks/);
    expect(code).toBe(1);
  });
});

describe('a commented-out pre-commit gate line (#413, fixture 2)', () => {
  const commentOut = (cwd: string): string => {
    const hook = join(cwd, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, readFileSync(hook, 'utf8').replace(/^npx /m, '# npx '));
    return hook;
  };

  it('init reads the gate as not wired', () => {
    const cwd = wiredRepo();
    commentOut(cwd);
    const byItem = Object.fromEntries(planInit(cwd).map((a) => [a.item, a]));
    expect(byItem['pre-commit'].status).not.toBe('ok');
    const dry = capture(() => runInit({ cwd, dryRun: true }));
    expect(preCommitRow(dry.out)).not.toMatch(/already runs the staged check/);
  });

  it('an indented `#` comment reads as not wired too', () => {
    const cwd = wiredRepo();
    const hook = join(cwd, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, readFileSync(hook, 'utf8').replace(/^npx /m, '   #npx '));
    expect(Object.fromEntries(planInit(cwd).map((a) => [a.item, a.status]))['pre-commit']).not.toBe('ok');
  });

  it('doctor reads the gate as not wired', () => {
    const cwd = wiredRepo();
    commentOut(cwd);
    const byId = Object.fromEntries(collectLocalPosture(cwd, loadPolicy(cwd)).map((x) => [x.id, x]));
    expect(byId['pre-commit'].state).not.toBe('OK');
    const r = capture(() => runDoctor({ cwd, base: 'HEAD' }));
    expect(doctorLine(r.out, 'pre-commit')).not.toMatch(/\[OK\]/);
  });

  it('re-running init wires a live gate line, after which init and doctor are OK', () => {
    const cwd = wiredRepo();
    const hook = commentOut(cwd);
    runInit({ cwd });
    expect(readFileSync(hook, 'utf8')).toMatch(/^npx .*check --staged/m);
    expect(Object.fromEntries(planInit(cwd).map((a) => [a.item, a.status]))['pre-commit']).toBe('ok');
    const byId = Object.fromEntries(collectLocalPosture(cwd, loadPolicy(cwd)).map((x) => [x.id, x]));
    expect(byId['pre-commit'].state).toBe('OK');
  });
});
