// #749 step 2: `init` writes the project hook wiring for a detected Codex or Copilot CLI
// runtime, labelled experimental, and `tamperward hook|sweep codex|copilot` run the
// matching adapter. The wiring is the one step-1 protects: a re-run of init that raises
// the pin is not a hook-tampering finding, a hand-written hooks block is never rewritten,
// and the generated file never makes detection see a runtime that is not there (#526).

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planInit } from '../src/cli/init';
import { RUNTIME_HOOK_AGENTS, runRuntimeHookFromRaw } from '../src/cli/runtime-hook';
import { codexHooksWeakening, copilotHooksWeakening } from '../src/detectors/hook-wiring';
import { detectRuntimes } from '../src/runtimes';
import { TW_VERSION } from '../src/wiring';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function repo(files: Record<string, string | null> = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-rt-wire-'));
  dirs.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(d, rel);
    if (content === null) mkdirSync(p, { recursive: true });
    else {
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, content);
    }
  }
  return d;
}
const row = (cwd: string, item: string) => planInit(cwd).find((a) => a.item === item);
const CODEX = '.codex/config.toml';
const COPILOT = '.github/hooks/tamperward.json';
const PIN = `tamperward@${TW_VERSION}`;

describe('init writes the Codex hook wiring for a detected Codex runtime', () => {
  it('no marker, no row: the plan is the five canonical items', () => {
    const d = repo();
    expect(planInit(d).map((a) => a.item)).not.toContain('codex-hooks');
    expect(planInit(d).map((a) => a.item)).not.toContain('copilot-hooks');
  });

  it('creates .codex/config.toml with the PreToolUse and Stop tables, labelled experimental, and is ok on a re-run', () => {
    const d = repo({ 'AGENTS.md': '# agents\n' });
    const a = row(d, 'codex-hooks');
    expect(a).toMatchObject({ item: 'codex-hooks', path: CODEX, status: 'create' });
    expect(a?.warning).toMatch(/EXPERIMENTAL/);
    expect(a?.warning).toMatch(/runtime verify --runtime codex/);
    a?.apply?.();
    const toml = readFileSync(join(d, CODEX), 'utf8');
    expect(toml).toMatch(/^\[hooks\]$/m);
    expect(toml).toMatch(/^\[\[hooks\.PreToolUse\]\]\nmatcher = "\*"\n\[\[hooks\.PreToolUse\.hooks\]\]\ntype = "command"\ncommand = ".*tamperward@\S+ hook codex/m);
    expect(toml).toMatch(/^\[\[hooks\.Stop\]\]\n\[\[hooks\.Stop\.hooks\]\]\ntype = "command"\ncommand = ".*tamperward@\S+ sweep codex/m);
    expect(toml).toContain(PIN);
    expect(toml).toMatch(/^# tamperward: experimental/m);
    expect(row(d, 'codex-hooks')).toMatchObject({ status: 'ok' });
  });

  it('appends the tables to an existing config that has none, keeping the rest of the file', () => {
    const d = repo({ 'AGENTS.md': '', [CODEX]: 'model = "gpt-5"\napproval_policy = "never"\n' });
    const a = row(d, 'codex-hooks');
    expect(a).toMatchObject({ status: 'update' });
    a?.apply?.();
    const toml = readFileSync(join(d, CODEX), 'utf8');
    expect(toml.startsWith('model = "gpt-5"\napproval_policy = "never"\n')).toBe(true);
    expect(toml).toContain(`${PIN} hook codex`);
    expect(row(d, 'codex-hooks')).toMatchObject({ status: 'ok' });
  });

  it('refuses to rewrite a hand-written hooks block', () => {
    const d = repo({ 'AGENTS.md': '', [CODEX]: '[hooks]\n[[hooks.PreToolUse]]\nmatcher = "*"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "./my-gate"\n' });
    const a = row(d, 'codex-hooks');
    expect(a).toMatchObject({ status: 'error' });
    expect(a?.detail).toMatch(/refusing to rewrite/);
    expect(a?.apply).toBeUndefined();
  });

  it('re-pins wiring init wrote for an older version, and the detector reads that as a pin raise, not a weakening', () => {
    const d = repo({ 'AGENTS.md': '' });
    row(d, 'codex-hooks')?.apply?.();
    const current = readFileSync(join(d, CODEX), 'utf8');
    const older = current.split(PIN).join('tamperward@2.0.0');
    writeFileSync(join(d, CODEX), older);
    const a = row(d, 'codex-hooks');
    expect(a).toMatchObject({ status: 'update' });
    expect(a?.detail).toMatch(/re-pin/);
    a?.apply?.();
    expect(readFileSync(join(d, CODEX), 'utf8')).toBe(current);
    expect(codexHooksWeakening(older, current)).toEqual([]);
    expect(codexHooksWeakening(current, older)).toEqual([expect.stringMatching(/pin/)]);
  });

  it('a config whose hooks tables init wrote does not by itself make detection see Codex (#526)', () => {
    const d = repo({ 'AGENTS.md': '' });
    row(d, 'codex-hooks')?.apply?.();
    rmSync(join(d, 'AGENTS.md'));
    expect(detectRuntimes(d).map((r) => r.id)).not.toContain('codex');
    writeFileSync(join(d, CODEX), readFileSync(join(d, CODEX), 'utf8') + 'model = "gpt-5"\n');
    expect(detectRuntimes(d).map((r) => r.id)).toContain('codex');
    const other = repo({ '.codex/prompts/review.md': '' });
    expect(detectRuntimes(other).map((r) => r.id)).toContain('codex');
  });
});

describe('init writes the Copilot CLI hook wiring for a detected Copilot runtime', () => {
  const read = (d: string) => JSON.parse(readFileSync(join(d, COPILOT), 'utf8'));

  it('creates .github/hooks/tamperward.json with preToolUse and agentStop command hooks, labelled experimental', () => {
    const d = repo({ '.github/copilot-instructions.md': '' });
    const a = row(d, 'copilot-hooks');
    expect(a).toMatchObject({ item: 'copilot-hooks', path: COPILOT, status: 'create' });
    expect(a?.warning).toMatch(/EXPERIMENTAL/);
    expect(a?.warning).toMatch(/runtime verify --runtime copilot/);
    a?.apply?.();
    const doc = read(d);
    expect(doc.version).toBe(1);
    expect(doc.hooks.preToolUse).toEqual([{ type: 'command', command: expect.stringContaining(`${PIN} hook copilot`), timeout: 60 }]);
    expect(doc.hooks.agentStop).toEqual([{ type: 'command', command: expect.stringContaining(`${PIN} sweep copilot`), timeout: 60 }]);
    expect(row(d, 'copilot-hooks')).toMatchObject({ status: 'ok' });
  });

  it('re-pins a file init wrote for an older version; the detector reads it as a pin raise', () => {
    const d = repo({ '.github/copilot-instructions.md': '' });
    row(d, 'copilot-hooks')?.apply?.();
    const current = readFileSync(join(d, COPILOT), 'utf8');
    const older = current.split(PIN).join('tamperward@2.0.0');
    writeFileSync(join(d, COPILOT), older);
    expect(row(d, 'copilot-hooks')).toMatchObject({ status: 'update' });
    row(d, 'copilot-hooks')?.apply?.();
    expect(readFileSync(join(d, COPILOT), 'utf8')).toBe(current);
    expect(copilotHooksWeakening(older, current)).toEqual([]);
    expect(copilotHooksWeakening(current, older)).toEqual([expect.stringMatching(/pin/)]);
  });

  it('refuses a file that is not valid JSON or carries hooks init did not write', () => {
    const bad = repo({ '.github/copilot-instructions.md': '', [COPILOT]: '{ not json' });
    expect(row(bad, 'copilot-hooks')).toMatchObject({ status: 'error' });
    const foreign = repo({ '.github/copilot-instructions.md': '', [COPILOT]: JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: 'command', command: './my-gate' }] } }) });
    const a = row(foreign, 'copilot-hooks');
    expect(a).toMatchObject({ status: 'error' });
    expect(a?.detail).toMatch(/refusing to rewrite/);
  });

  it('the generated file is not a Copilot marker: detection needs the instructions file or directory', () => {
    const d = repo({ '.github/copilot-instructions.md': '' });
    row(d, 'copilot-hooks')?.apply?.();
    rmSync(join(d, '.github', 'copilot-instructions.md'));
    expect(existsSync(join(d, COPILOT))).toBe(true);
    expect(detectRuntimes(d).map((r) => r.id)).not.toContain('copilot');
  });
});

describe('tamperward hook|sweep codex|copilot run the matching adapter', () => {
  function gated(): string {
    const d = repo({
      'src/a.spec.ts': `it('one', () => {}); it('two', () => {});\n`,
      '.tamperward.yml': "version: 1\nprotected:\n  tests: ['**/*.spec.ts']\n",
    });
    execFileSync('git', ['-c', 'user.email=h@x', '-c', 'user.name=h', 'add', '-A'], { cwd: d });
    execFileSync('git', ['-c', 'user.email=h@x', '-c', 'user.name=h', 'commit', '-qm', 'seed'], { cwd: d });
    return d;
  }

  it('lists exactly the two experimental agents beside claude', () => {
    expect([...RUNTIME_HOOK_AGENTS].sort()).toEqual(['codex', 'copilot']);
  });

  it('codex: a protected deletion is denied in the Codex PreToolUse envelope at exit 0, a benign call allows with an empty wire', () => {
    const d = gated();
    const deny = runRuntimeHookFromRaw('PreToolUse', 'codex', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm src/a.spec.ts' }, cwd: d, session_id: 's' }), d);
    expect(deny.exitCode).toBe(0);
    const j = JSON.parse(deny.stdout);
    expect(j.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(j.reason).toContain('test-deletion');
    const allow = runRuntimeHookFromRaw('PreToolUse', 'codex', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cat src/a.spec.ts' }, cwd: d, session_id: 's' }), d);
    expect(allow).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('copilot: the native camelCase payload is denied in the flat Copilot envelope, and the sweep blocks a landed mutation', () => {
    const d = gated();
    const deny = runRuntimeHookFromRaw('PreToolUse', 'copilot', JSON.stringify({ toolName: 'bash', toolArgs: JSON.stringify({ command: 'rm src/a.spec.ts' }), cwd: d, sessionId: 's' }), d);
    expect(deny.exitCode).toBe(0);
    expect(JSON.parse(deny.stdout)).toMatchObject({ permissionDecision: 'deny' });
    writeFileSync(join(d, 'src', 'a.spec.ts'), `it('one', () => {});\n`);
    const stop = runRuntimeHookFromRaw('Stop', 'copilot', JSON.stringify({ sessionId: 's', cwd: d, stopReason: 'end' }), d);
    expect(stop.exitCode).toBe(0);
    expect(JSON.parse(stop.stdout)).toMatchObject({ decision: 'block' });
  });

  it('an unparseable payload fails closed in the runtime envelope; an unknown agent is exit 2 with nothing on stdout', () => {
    const d = gated();
    const r = runRuntimeHookFromRaw('PreToolUse', 'codex', '[1,2,3]', d);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('tamperward-unavailable');
    const u = runRuntimeHookFromRaw('PreToolUse', 'cursor', '{}', d);
    expect(u).toMatchObject({ exitCode: 2, stdout: '' });
    expect(u.stderr).toMatch(/unsupported hook agent "cursor"/);
  });
});
