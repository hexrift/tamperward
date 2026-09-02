// tamperward init: the contract under test is idempotent and non-destructive. Running
// twice is a no-op; nothing a user wrote is ever overwritten; shared files are merged;
// an unparseable shared file aborts that item instead of clobbering it.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planInit } from '../src/cli/init';
import { TW_VERSION } from '../src/wiring';

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function repo(withGit = true): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-init-'));
  dirs.push(d);
  if (withGit) mkdirSync(join(d, '.git', 'hooks'), { recursive: true });
  return d;
}

const apply = (d: string) => { for (const a of planInit(d)) a.apply?.(); };
const statuses = (d: string) => Object.fromEntries(planInit(d).map((a) => [a.item, a.status]));

describe('fresh repo', () => {
  it('creates all five enforcement points', () => {
    // Five, not four, since H2: a CI gate whose workflow the candidate can
    // rewrite is not an enforcement point, so the code-owner requirement on the
    // paths that constitute the gate is part of the wiring, not advice.
    const d = repo();
    expect(statuses(d)).toEqual({
      policy: 'create', agent: 'create', 'pre-commit': 'create', ci: 'create', codeowners: 'create',
    });
    apply(d);
    expect(existsSync(join(d, '.tamperward.yml'))).toBe(true);
    expect(existsSync(join(d, '.claude/settings.json'))).toBe(true);
    expect(existsSync(join(d, '.git/hooks/pre-commit'))).toBe(true);
    expect(existsSync(join(d, '.github/workflows/tamperward.yml'))).toBe(true);
    expect(existsSync(join(d, '.github/CODEOWNERS'))).toBe(true);
  });

  it('is a complete no-op on the second run', () => {
    const d = repo();
    apply(d);
    const before = readFileSync(join(d, '.claude/settings.json'), 'utf8');
    expect(statuses(d)).toEqual({ policy: 'ok', agent: 'ok', 'pre-commit': 'ok', ci: 'ok', codeowners: 'ok' });
    apply(d);
    expect(readFileSync(join(d, '.claude/settings.json'), 'utf8')).toBe(before);
  });

  it('the created pre-commit is executable and the settings wire both hooks', () => {
    const d = repo();
    apply(d);
    expect(statSync(join(d, '.git/hooks/pre-commit')).mode & 0o111).toBeTruthy();
    const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
    // Pinned to the shipped version since 1.14.7 (the exact string is init-pin.test.ts's).
    expect(JSON.stringify(s.hooks.PreToolUse)).toMatch(/npx --yes tamperward@\S+ hook claude/);
    expect(JSON.stringify(s.hooks.Stop)).toMatch(/npx --yes tamperward@\S+ sweep claude/);
    // NotebookEdit joined the matcher in 1.14.0: the adapter always modelled it,
    // but the installed wiring never fired it, so that branch was unreachable.
    expect(s.hooks.PreToolUse[0].matcher).toBe('Bash|Edit|Write|MultiEdit|NotebookEdit');
    // Declared since 2.9.0: the project value overrides the user file's, so a
    // `true` written to ~/.claude/settings.json cannot switch the gate off.
    expect(s.disableAllHooks).toBe(false);
  });

  it('a comma-separated matcher is the list the runtime reads, not a matcher to widen', () => {
    const d = repo();
    mkdirSync(join(d, '.claude'), { recursive: true });
    writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash, Edit, Write, MultiEdit, NotebookEdit', hooks: [{ type: 'command', command: `npx --yes tamperward@${TW_VERSION} hook claude` }] }],
        Stop: [{ hooks: [{ type: 'command', command: `npx --yes tamperward@${TW_VERSION} sweep claude` }] }],
      },
      disableAllHooks: false,
    }));
    expect(statuses(d).agent).toBe('ok');
    // a comma list missing a tool is widened by appending the missing one
    writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash, Edit, Write, MultiEdit', hooks: [{ type: 'command', command: `npx --yes tamperward@${TW_VERSION} hook claude` }] }],
        Stop: [{ hooks: [{ type: 'command', command: `npx --yes tamperward@${TW_VERSION} sweep claude` }] }],
      },
      disableAllHooks: false,
    }));
    const agent = planInit(d).find((a) => a.item === 'agent')!;
    expect(agent.status).toBe('update');
    expect(agent.detail).toContain('widen the PreToolUse matcher to cover NotebookEdit');
  });

  it('declares `disableAllHooks: false` in an already-wired file, and holds a `true` to false', () => {
    const d = repo();
    mkdirSync(join(d, '.claude'), { recursive: true });
    const wired = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: `npx --yes tamperward@${TW_VERSION} hook claude` }] }],
        Stop: [{ hooks: [{ type: 'command', command: `npx --yes tamperward@${TW_VERSION} sweep claude` }] }],
      },
    };
    writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(wired));
    let agent = planInit(d).find((a) => a.item === 'agent')!;
    expect(agent.status).toBe('update');
    expect(agent.detail).toBe('declare disableAllHooks: false so the user settings file cannot switch the hooks off');
    writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ ...wired, disableAllHooks: true }));
    agent = planInit(d).find((a) => a.item === 'agent')!;
    expect(agent.detail).toBe('set disableAllHooks: false (was true)');
    agent.apply?.();
    expect(JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8')).disableAllHooks).toBe(false);
    expect(statuses(d).agent).toBe('ok');
  });
});

describe('merging, never clobbering', () => {
  it('preserves existing settings.json content and hooks', () => {
    const d = repo();
    mkdirSync(join(d, '.claude'), { recursive: true });
    writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({
      permissions: { allow: ['Bash(npm test)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter' }] }] },
    }));
    apply(d);
    const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
    expect(s.permissions.allow).toEqual(['Bash(npm test)']);
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('my-linter');
  });

  it('refuses to touch an unparseable settings.json and reports error', () => {
    const d = repo();
    mkdirSync(join(d, '.claude'), { recursive: true });
    writeFileSync(join(d, '.claude/settings.json'), '{ not json');
    const agent = planInit(d).find((a) => a.item === 'agent')!;
    expect(agent.status).toBe('error');
    expect(agent.apply).toBeUndefined();
    expect(readFileSync(join(d, '.claude/settings.json'), 'utf8')).toBe('{ not json');
  });

  it('appends to an existing pre-commit script, once, keeping its content', () => {
    const d = repo();
    writeFileSync(join(d, '.git/hooks/pre-commit'), '#!/bin/sh\nmy-existing-check\n');
    apply(d);
    apply(d);
    const hook = readFileSync(join(d, '.git/hooks/pre-commit'), 'utf8');
    expect(hook).toContain('my-existing-check');
    expect(hook.match(/tamperward@\S+ check --staged/g)).toHaveLength(1);
  });

  it('prefers husky when .husky/ exists', () => {
    const d = repo();
    mkdirSync(join(d, '.husky'));
    apply(d);
    expect(existsSync(join(d, '.husky/pre-commit'))).toBe(true);
    expect(existsSync(join(d, '.git/hooks/pre-commit'))).toBe(false);
  });

  it('never overwrites an existing policy or workflow', () => {
    const d = repo();
    writeFileSync(join(d, '.tamperward.yml'), 'version: 1\nignore: ["docs/**"]\n');
    mkdirSync(join(d, '.github/workflows'), { recursive: true });
    writeFileSync(join(d, '.github/workflows/tamperward.yml'), 'name: custom\n');
    apply(d);
    expect(readFileSync(join(d, '.tamperward.yml'), 'utf8')).toContain('docs/**');
    expect(readFileSync(join(d, '.github/workflows/tamperward.yml'), 'utf8')).toBe('name: custom\n');
  });

  it('skips pre-commit gracefully outside a git repo', () => {
    const d = repo(false);
    expect(statuses(d)['pre-commit']).toBe('skip');
  });
});

describe('generated artifacts are valid', () => {
  it('the policy parses under the real loader', async () => {
    const d = repo();
    apply(d);
    const { loadPolicy } = await import('../src/policy-load');
    const p = loadPolicy(d);
    expect(p.version).toBe(1);
  });

  it('the workflow is valid YAML with the labeled/unlabeled triggers and the oob step', async () => {
    const d = repo();
    apply(d);
    const { parse } = await import('yaml');
    const wf = parse(readFileSync(join(d, '.github/workflows/tamperward.yml'), 'utf8'));
    const trig = wf.on ?? (wf as Record<string, unknown>)['true'];
    expect(trig.pull_request.types).toEqual(['opened', 'synchronize', 'reopened', 'labeled', 'unlabeled']);
    const steps = wf.jobs.tamperward.steps;
    expect(JSON.stringify(steps)).toContain('TAMPERWARD_OOB_SIGNOFF');
    expect(wf.permissions).toEqual({ contents: 'read' });
  });
});
