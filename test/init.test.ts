// tamperward init: the contract under test is idempotent and non-destructive. Running
// twice is a no-op; nothing a user wrote is ever overwritten; shared files are merged;
// an unparseable shared file aborts that item instead of clobbering it.

import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planInit, runInit } from '../src/cli/init';
import { HOOK_CMD, SWEEP_CMD } from '../src/wiring';

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

const captureInit = (cwd: string, dryRun = false): { code: number; output: string } => {
  const original = process.stdout.write;
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = runInit({ cwd, dryRun });
    return { code, output: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
};

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
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe(HOOK_CMD);
    expect(s.hooks.Stop[0].hooks[0].command).toBe(SWEEP_CMD);
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
        PreToolUse: [{ matcher: 'Bash, Edit, Write, MultiEdit, NotebookEdit', hooks: [{ type: 'command', command: HOOK_CMD }] }],
        Stop: [{ hooks: [{ type: 'command', command: SWEEP_CMD }] }],
      },
      disableAllHooks: false,
    }));
    expect(statuses(d).agent).toBe('ok');
    // a comma list missing a tool is widened by appending the missing one
    writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash, Edit, Write, MultiEdit', hooks: [{ type: 'command', command: HOOK_CMD }] }],
        Stop: [{ hooks: [{ type: 'command', command: SWEEP_CMD }] }],
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
        PreToolUse: [{ matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: HOOK_CMD }] }],
        Stop: [{ hooks: [{ type: 'command', command: SWEEP_CMD }] }],
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

describe('dependency-tree repository hygiene', () => {
  it('adds node_modules/ to .gitignore when installed dependencies are present but unignored', () => {
    const d = repo();
    mkdirSync(join(d, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(d, 'node_modules', 'dep', 'index.js'), '// eslint-disable-next-line no-new\n');

    const action = planInit(d).find((a) => a.item === 'gitignore')!;
    expect(action.status).toBe('create');
    expect(action.detail).toMatch(/exclude installed Node dependencies/);
    action.apply?.();

    expect(readFileSync(join(d, '.gitignore'), 'utf8')).toBe('node_modules/\n');
    expect(statuses(d).gitignore).toBe('ok');
  });

  it('appends without clobbering an existing .gitignore', () => {
    const d = repo();
    mkdirSync(join(d, 'node_modules'), { recursive: true });
    writeFileSync(join(d, '.gitignore'), 'dist/\n# keep this comment\n');

    const action = planInit(d).find((a) => a.item === 'gitignore')!;
    expect(action.status).toBe('update');
    action.apply?.();
    expect(readFileSync(join(d, '.gitignore'), 'utf8')).toBe('dist/\n# keep this comment\nnode_modules/\n');
  });

  it('does not hide node_modules once the repository has chosen to track it', () => {
    const d = repo();
    execFileSync('git', ['init', '-q'], { cwd: d });
    mkdirSync(join(d, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(d, 'node_modules', 'dep', 'index.js'), 'tracked\n');
    execFileSync('git', ['add', 'node_modules/dep/index.js'], { cwd: d });

    const action = planInit(d).find((a) => a.item === 'gitignore')!;
    expect(action.status).toBe('skip');
    expect(action.detail).toMatch(/already tracked\/staged/);
    expect(action.apply).toBeUndefined();
    expect(existsSync(join(d, '.gitignore'))).toBe(false);
  });

  it('respects an explicit node_modules negation instead of overriding repository intent', () => {
    const d = repo();
    mkdirSync(join(d, 'node_modules'), { recursive: true });
    writeFileSync(join(d, '.gitignore'), 'node_modules/*\n!node_modules/vendor-patch/\n');

    const before = readFileSync(join(d, '.gitignore'), 'utf8');
    const action = planInit(d).find((a) => a.item === 'gitignore')!;
    expect(action.status).toBe('skip');
    expect(action.detail).toMatch(/explicit node_modules negation/);
    action.apply?.();
    expect(readFileSync(join(d, '.gitignore'), 'utf8')).toBe(before);
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

describe('verifier setup posture (#320)', () => {
  it('makes an unconfigured fresh install unmistakably incomplete and suggests one high-confidence suite', () => {
    const d = repo();
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'vitest run' } }),
    );

    const r = captureInit(d, true);
    expect(r.code).toBe(0);
    expect(r.output).toContain('INCOMPLETE: verification not configured');
    expect(r.output).toContain('CI will fail closed');
    expect(r.output).toContain('Suggested verifier command: npm test');
    expect(r.output).toContain('verify:\n  command: "npm test"');
    expect(existsSync(join(d, '.tamperward.yml'))).toBe(false); // dry-run is still non-mutating
  });

  it('real init suggests but never writes an inferred verifier command into the trust anchor', () => {
    const d = repo();
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'vitest run' } }),
    );

    const r = captureInit(d, false);
    expect(r.code).toBe(0);
    expect(r.output).toContain('INCOMPLETE: verification not configured');
    expect(r.output).toContain('Suggested verifier command: npm test');

    const written = readFileSync(join(d, '.tamperward.yml'), 'utf8');
    expect(written).not.toMatch(/^\s*verify\s*:/m);
    expect(written).not.toContain('command: "npm test"');
  });

  it('does not call empty/malformed Cargo or Go markers high-confidence verifier suites', () => {
    const d = repo();

    writeFileSync(join(d, 'Cargo.toml'), '');
    writeFileSync(join(d, 'go.mod'), '');
    let r = captureInit(d, true);
    expect(r.output).not.toContain('cargo test');
    expect(r.output).not.toContain('go test ./...');

    rmSync(join(d, 'Cargo.toml'));
    rmSync(join(d, 'go.mod'));
    mkdirSync(join(d, 'Cargo.toml'));
    mkdirSync(join(d, 'go.mod'));
    r = captureInit(d, true);
    expect(r.output).not.toContain('cargo test');
    expect(r.output).not.toContain('go test ./...');
  });

  it('recognises structurally valid Cargo package/workspace and Go module files', () => {
    const cargo = repo();
    writeFileSync(join(cargo, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.1.0"\n');
    expect(captureInit(cargo, true).output).toContain('Suggested verifier command: cargo test');

    const workspace = repo();
    writeFileSync(join(workspace, 'Cargo.toml'), '[workspace]\nmembers = ["crates/*"]\n');
    expect(captureInit(workspace, true).output).toContain('Suggested verifier command: cargo test');

    const go = repo();
    writeFileSync(join(go, 'go.mod'), 'module example.com/demo\n\ngo 1.24\n');
    expect(captureInit(go, true).output).toContain('Suggested verifier command: go test ./...');
  });

  it('reports verification configured when the real policy names a suite command', () => {
    const d = repo();
    writeFileSync(
      join(d, '.tamperward.yml'),
      ['version: 1', 'verify:', '  command: npm test', '  budget: 300', ''].join('\n'),
    );

    const r = captureInit(d, true);
    expect(r.code).toBe(0);
    expect(r.output).toContain('verification configured — npm test');
    expect(r.output).not.toContain('INCOMPLETE: verification not configured');
  });

  it('does not silently choose when multiple high-confidence verifier commands exist', () => {
    const d = repo();
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({ name: 'polyglot', version: '1.0.0', scripts: { test: 'vitest run' } }),
    );
    writeFileSync(join(d, 'Cargo.toml'), '[package]\nname="polyglot"\nversion="0.1.0"\n');

    const r = captureInit(d, true);
    expect(r.output).toContain('INCOMPLETE: verification not configured');
    expect(r.output).toContain('Detected verifier candidates: npm test, cargo test');
    expect(r.output).not.toContain('Suggested verifier command:');
  });

  it('still reports verifier incompleteness when the policy itself needs repair', () => {
    const d = repo();
    writeFileSync(join(d, '.tamperward.yml'), 'version: [broken\n');

    const r = captureInit(d, true);
    expect(r.code).toBe(2);
    expect(r.output).toContain('policy');
    expect(r.output).toContain('INCOMPLETE: verification not configured');
    expect(r.output).toContain('CI will fail closed until the policy is fixed');
  });

  it('ignores npm default placeholder test scripts as non-runnable suggestions', () => {
    const d = repo();
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }),
    );

    const r = captureInit(d, true);
    expect(r.output).toContain('INCOMPLETE: verification not configured');
    expect(r.output).not.toContain('Suggested verifier command: npm test');
  });
});

describe('generated workflow timeout migration (#331)', () => {
  const hash16 = (body: string) => createHash('sha256').update(body).digest('hex').slice(0, 16);

  it('migrates an untouched stamped 10-minute template to the current outer timeout', () => {
    const d = repo();
    apply(d);
    const path = join(d, '.github/workflows/tamperward.yml');
    const current = readFileSync(path, 'utf8');
    const body = current.replace(/^# tamperward:generated[^\n]*\n/, '');
    const oldBody = body.replace('timeout-minutes: 360', 'timeout-minutes: 10');
    const old = `# tamperward:generated v2.11.3 sha256:${hash16(oldBody)}\n${oldBody}`;
    writeFileSync(path, old);

    const ci = planInit(d).find((a) => a.item === 'ci')!;
    expect(ci.status).toBe('update');
    expect(ci.detail).toMatch(/unmodified.*migrating/);
    ci.apply?.();

    const migrated = readFileSync(path, 'utf8');
    expect(migrated).toContain('timeout-minutes: 360');
    expect(migrated).not.toContain('timeout-minutes: 10');
  });

  it('does not overwrite an operator-edited stamped workflow', () => {
    const d = repo();
    apply(d);
    const path = join(d, '.github/workflows/tamperward.yml');
    const edited = readFileSync(path, 'utf8').replace(
      'timeout-minutes: 360',
      'timeout-minutes: 10\n    # operator customisation',
    );
    writeFileSync(path, edited);

    const ci = planInit(d).find((a) => a.item === 'ci')!;
    expect(ci.status).toBe('skip');
    expect(ci.detail).toMatch(/edited since tamperward/);
    ci.apply?.();
    expect(readFileSync(path, 'utf8')).toBe(edited);
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

    // #331: verify.budget applies independently to visible + pristine. The
    // generated authority must outlive both stages plus materialisation,
    // hashing, cleanup and reporting, rather than GitHub killing the job first.
    expect(wf.jobs.tamperward['timeout-minutes']).toBe(360);
  });
});

describe('foreign fields on existing Claude hook objects survive a TamperWard rewrite (#383)', () => {
  it('keeps unknown matcher and entry properties structure-equivalent while adding our two hooks', () => {
    const d = repo();
    mkdirSync(join(d, '.claude'), { recursive: true });
    const theirs = {
      permissions: { allow: ['Bash(npm test)'] },
      hooks: {
        PreToolUse: [{
          matcher: 'Bash',
          description: 'keep me',
          hooks: [{ type: 'command', command: './my-hook', timeout: 30, env: { KEEP: '1' } }],
        }],
        PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: './after', async: true }] }],
      },
    };
    writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify(theirs, null, 2) + '\n');
    apply(d);
    const after = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
    // everything they wrote is still there, structure-equivalent
    expect(after.permissions).toEqual(theirs.permissions);
    expect(after.hooks.PreToolUse[0]).toEqual(theirs.hooks.PreToolUse[0]);
    expect(after.hooks.PostToolUse).toEqual(theirs.hooks.PostToolUse);
    // and ours were merged in beside it
    const commands = (after.hooks.PreToolUse as Array<{ hooks: Array<{ command: string }> }>).flatMap((m) => m.hooks.map((h) => h.command));
    expect(commands).toContain(HOOK_CMD);
    expect((after.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>).flatMap((m) => m.hooks.map((h) => h.command))).toContain(SWEEP_CMD);
    expect(after.disableAllHooks).toBe(false);
  });
});
