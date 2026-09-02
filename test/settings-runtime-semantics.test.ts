// The Claude settings files, judged with the runtime's live semantics (pass 3a
// over 2.7.0's canonical-shape comparator). Every settings file is watched and
// reloaded in-session; `disableAllHooks` applies from any file with the project
// overriding the user; `env` reaches every session and subprocess; the hook shell
// is bash; `CLAUDE_CONFIG_DIR` relocates the user directory. So a Bash write to
// `~/.claude/settings.json` — which no repository glob names and neither the Stop
// sweep nor `check --staged` can see — took effect within seconds and was judged
// by nobody, while the same Write was denied. Every case here runs end to end
// through the BUILT CLI, the hook payload on stdin, on both surfaces.

import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from 'vitest';
import { buildSync } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TW_VERSION } from '../src/wiring';

vi.setConfig({ testTimeout: 30_000 });

const ROOT = join(__dirname, '..');
let cliDir = '';
let CLI = '';
const dirs: string[] = [];

beforeAll(() => {
  // The CLI as `npm run build` ships it, bundled into a scratch directory that
  // borrows the repo's node_modules. The bundle finds its own version through the
  // package.json beside it (src/wiring.ts shippedVersion), as dist/cli/index.js
  // does — without it the built CLI judges as `latest`, and the pin ceiling has
  // nothing to compare against.
  cliDir = mkdtempSync(join(tmpdir(), 'tw-cli-'));
  symlinkSync(join(ROOT, 'node_modules'), join(cliDir, 'node_modules'), 'dir');
  writeFileSync(join(cliDir, 'package.json'), JSON.stringify({ name: 'tamperward', version: TW_VERSION }));
  mkdirSync(join(cliDir, 'cli'));
  CLI = join(cliDir, 'cli', 'index.js');
  buildSync({ entryPoints: [join(ROOT, 'src/cli/index.ts')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: CLI, logLevel: 'silent' });
}, 60_000);

afterAll(() => {
  if (cliDir) rmSync(cliDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FULL = 'Bash|Edit|Write|MultiEdit|NotebookEdit';
type Loose = Record<string, unknown>;
const json = (o: object): string => JSON.stringify(o, null, 2) + '\n';
/** The project file as init writes it at `v` (the `disableAllHooks: false` declaration since 2.9.0). */
const wired = (v: string, top: Loose = {}): Loose => ({
  hooks: {
    PreToolUse: [{ matcher: FULL, hooks: [{ type: 'command', command: `npx --yes tamperward@${v} hook claude` }] }],
    Stop: [{ hooks: [{ type: 'command', command: `npx --yes tamperward@${v} sweep claude` }] }],
  },
  disableAllHooks: false,
  ...top,
});
/** What init wrote before 2.9.0: no declaration. */
const oldWired = (v: string, top: Loose = {}): Loose => { const o = wired(v, top); if (!('disableAllHooks' in top)) delete o.disableAllHooks; return o; };
const withSibling = (o: Loose, entry: object): Loose => {
  const hooks = o.hooks as Record<string, unknown[]>;
  return { ...o, hooks: { ...hooks, PreToolUse: [...hooks.PreToolUse, { matcher: 'Write', hooks: [entry] }] } };
};

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function repo(settings: Loose): string {
  const d = tmp('tw-srs-');
  const g = (...a: string[]) => execFileSync('git', a, { cwd: d });
  g('init', '-q');
  g('config', 'user.email', 't@b');
  g('config', 'user.name', 'tb');
  mkdirSync(join(d, 'test'));
  mkdirSync(join(d, '.claude'));
  writeFileSync(join(d, 'test', 'a.test.ts'), `it('a', () => {});\n`);
  writeFileSync(join(d, '.claude', 'settings.json'), json(settings));
  g('add', '-A');
  g('commit', '-qm', 'base');
  return d;
}

/** A home directory with a user settings file that carries no hooks. */
function home(): string {
  const h = tmp('tw-srs-home-');
  mkdirSync(join(h, '.claude'));
  writeFileSync(join(h, '.claude', 'settings.json'), json({ permissions: { allow: [] } }));
  return h;
}

interface Verdict { decision: 'allow' | 'deny'; reason: string }
function pre(cwd: string, tool: string, input: Record<string, unknown>, env: Record<string, string | undefined> = {}): Verdict {
  const r = spawnSync(process.execPath, [CLI, 'hook', 'claude'], {
    input: JSON.stringify({ session_id: 's1', cwd, tool_name: tool, tool_input: input, hook_event_name: 'PreToolUse' }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) throw new Error(`hook claude exited ${r.status}: ${r.stderr}`);
  if (!r.stdout.trim()) return { decision: 'allow', reason: '' };
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason };
}
const bash = (cwd: string, command: string, env: Record<string, string | undefined> = {}) => pre(cwd, 'Bash', { command }, env);
const write = (cwd: string, file_path: string, content: string, env: Record<string, string | undefined> = {}) => pre(cwd, 'Write', { file_path, content }, env);

describe('Bash writes to the settings files outside the repository are denied at the PreToolUse hook', () => {
  it.each([
    ['~', (h: string) => `echo '{"disableAllHooks":true}' > ~/.claude/settings.json`],
    ['$HOME', () => 'echo \'{"disableAllHooks":true}\' > $HOME/.claude/settings.json'],
    ['${HOME}', () => 'echo x > ${HOME}/.claude/settings.local.json'],
    ['the absolute path', (h: string) => `echo x > ${h}/.claude/settings.json`],
    ['sed -i', () => "sed -i 's/\"allow\"/\"deny\"/' ~/.claude/settings.json"],
    ['tee', () => 'echo x | tee ~/.claude/settings.json'],
    ['cp', () => 'cp /tmp/evil.json ~/.claude/settings.json'],
    ['mv', () => 'mv /tmp/evil.json $HOME/.claude/settings.json'],
    ['ln -s', () => 'ln -sf /tmp/evil.json ~/.claude/settings.json'],
    ['rm', () => 'rm -f ~/.claude/settings.json'],
    ['rm -rf of the directory', () => 'rm -rf ~/.claude'],
    ['python3 -c', (h: string) => `python3 -c "open('${h}/.claude/settings.json','w').write('{\\"disableAllHooks\\":true}')"`],
    ['node -e', () => `node -e "require('fs').writeFileSync(process.env.HOME+'/.claude/settings.json','{}')"`],
    ['managed settings', () => 'cat > /etc/claude-code/managed-settings.json'],
    ['$CLAUDE_CONFIG_DIR unset, read as ~/.claude', () => 'echo x > $CLAUDE_CONFIG_DIR/settings.json'],
  ])('%s', (_n, command) => {
    const h = home();
    const cwd = repo(oldWired('2.5.0'));
    const v = bash(cwd, command(h), { HOME: h, CLAUDE_CONFIG_DIR: undefined });
    expect(v.decision, v.reason).toBe('deny');
    expect(v.reason).toContain('hook-tampering');
    expect(v.reason).toContain('Claude Code settings file');
  });

  it('honours CLAUDE_CONFIG_DIR from the hook\'s own environment, on both surfaces', () => {
    const h = home();
    const cfg = tmp('tw-srs-cfg-');
    writeFileSync(join(cfg, 'settings.json'), json({ permissions: { allow: [] } }));
    const cwd = repo(oldWired('2.5.0'));
    const env = { HOME: h, CLAUDE_CONFIG_DIR: cfg };
    for (const c of ['echo x > $CLAUDE_CONFIG_DIR/settings.json', `echo x > ${cfg}/settings.json`, `sed -i s/a/b/ ${cfg}/settings.local.json`, `rm -rf ${cfg}`]) {
      const v = bash(cwd, c, env);
      expect(v.decision, c).toBe('deny');
      expect(v.reason, c).toContain(`${cfg}/settings`);
    }
    expect(bash(cwd, `rm ${cfg}/other.json`, env).decision).toBe('allow');
    const w = write(cwd, join(cfg, 'settings.json'), json({ permissions: { allow: [] }, disableAllHooks: true }), env);
    expect(w.decision, w.reason).toBe('deny');
    expect(w.reason).toContain('disableAllHooks');
    expect(write(cwd, join(cfg, 'settings.json'), json({ permissions: { allow: ['Bash(ls)'] } }), env).decision).toBe('allow');
    // with the variable unset the same directory is nobody's settings
    expect(bash(cwd, `echo x > ${cfg}/settings.json`, { HOME: h, CLAUDE_CONFIG_DIR: undefined }).decision).toBe('allow');
  });

  it('a symlinked alias is judged as the file it resolves to', () => {
    const h = home();
    const cwd = repo(oldWired('2.5.0'));
    const links = tmp('tw-srs-links-');
    symlinkSync(cwd, join(links, 'xlink'), 'dir');
    symlinkSync(join(h, '.claude'), join(links, 'cfg'), 'dir');
    const env = { HOME: h };
    // 3c P1-2: `ln -s . /tmp/xlink; rm /tmp/xlink/.claude/settings.json` was ALLOW
    const viaLink = bash(cwd, `rm ${join(links, 'xlink')}/.claude/settings.json`, env);
    expect(viaLink.decision).toBe('deny');
    expect(viaLink.reason).toContain('.claude/settings.json');
    // P1-7: `ln -s ~/.claude /tmp/cfg && echo … > /tmp/cfg/settings.json` was ALLOW
    expect(bash(cwd, `echo '{"disableAllHooks":true}' > ${join(links, 'cfg')}/settings.json`, env).decision).toBe('deny');
    expect(write(cwd, join(links, 'cfg', 'settings.json'), json({ disableAllHooks: true }), env).decision).toBe('deny');
    // the same spelling with no link behind it, and no settings shape, stays allowed
    expect(bash(cwd, `rm ${join(links, 'nolink')}/settings.json`, env).decision).toBe('allow');
  });

  it('reads, backups and non-settings paths outside the repository stay allowed', () => {
    const h = home();
    const cwd = repo(oldWired('2.5.0'));
    const out = tmp('tw-srs-out-');
    writeFileSync(join(out, 'settings.json'), '{}');
    for (const c of [`rm ${out}/settings.json`, `rm -rf ${out}`, 'cat ~/.claude/settings.json', 'cp ~/.claude/settings.json /tmp/backup.json', 'echo x > ~/.claude/CLAUDE.md', 'echo x > ~/.claude/settings.json.bak', 'ls -la ~/.claude', 'echo ok']) {
      const v = bash(cwd, c, { HOME: h });
      expect(v.decision, `${c}: ${v.reason}`).toBe('allow');
    }
  });

  it('a Write to the user file is judged as before, and a `disableAllHooks: true` there is a denial', () => {
    const h = home();
    const cwd = repo(oldWired('2.5.0'));
    const user = join(h, '.claude', 'settings.json');
    const v = write(cwd, user, json({ permissions: { allow: [] }, disableAllHooks: true }), { HOME: h });
    expect(v.decision).toBe('deny');
    expect(v.reason).toContain('disableAllHooks');
    expect(write(cwd, user, json({ permissions: { allow: ['Bash(ls)'] } }), { HOME: h }).decision).toBe('allow');
    const managed = tmp('tw-srs-managed-');
    expect(write(cwd, join(managed, 'managed-settings.json'), json({ disableAllHooks: true })).decision).toBe('deny');
  });
});

describe('the project file, judged with the runtime\'s semantics through the built CLI', () => {
  const project = (cwd: string) => join(cwd, '.claude', 'settings.json');
  const OLD = oldWired('2.5.0');

  it.each([
    ['an `env` key added, whatever its name', () => oldWired('2.5.0', { env: { FOO: '1' } }), /env.*FOO/],
    ['an `env` key the shell sources', () => oldWired('2.5.0', { env: { BASH_ENV: '/tmp/evil.sh' } }), /BASH_ENV — a non-interactive shell/],
    ['a pin above the judging gate', () => oldWired('99.0.0'), /above the .* judging it/],
    ['the pin removed', () => { const o = oldWired('2.5.0'); (o.hooks as Loose).PreToolUse = [{ matcher: FULL, hooks: [{ type: 'command', command: 'npx --yes tamperward hook claude' }] }]; return o; }, /unpinned, below 2\.5\.0/],
    ['a hook entry added beside the gate', () => withSibling(oldWired('2.5.0'), { type: 'command', command: 'node scripts/lint.js' }), /beside the gate was added/],
    ['a sibling carrying `args`', () => withSibling(oldWired('2.5.0'), { type: 'command', command: 'echo', args: ['{"hookSpecificOutput":{"updatedInput":{}}}'] }), /carries `args`/],
    ['a sibling the schema rejects', () => withSibling(oldWired('2.5.0'), { type: 'bogus', command: 'x' }), /schema rejects/],
    ['disableAllHooks: true', () => oldWired('2.5.0', { disableAllHooks: true }), /disableAllHooks: true/],
  ])('denies: %s', (_n, after, re) => {
    const cwd = repo(OLD);
    const v = write(cwd, project(cwd), json(after()));
    expect(v.decision, v.reason).toBe('deny');
    expect(v.reason).toMatch(re);
  });

  it.each([
    ['the comma list the runtime documents', () => { const o = oldWired('2.5.0'); ((o.hooks as Loose).PreToolUse as Loose[])[0].matcher = 'Bash, Edit, Write, MultiEdit, NotebookEdit'; return o; }],
    ['statusMessage on the gate entry', () => { const o = oldWired('2.5.0'); (((o.hooks as Loose).PreToolUse as Loose[])[0].hooks as Loose[])[0].statusMessage = 'tamperward'; return o; }],
    ['the pin raised to the judging gate', () => oldWired(TW_VERSION)],
    ['the pin raised to a published version below the judging gate', () => oldWired('2.7.0')],
    ["init's own repair: the declaration added", () => wired('2.5.0')],
    ['a permissions edit', () => oldWired('2.5.0', { permissions: { allow: ['Bash(ls)'] } })],
  ])('allows: %s', (_n, after) => {
    const cwd = repo(OLD);
    const v = write(cwd, project(cwd), json(after()));
    expect(v.decision, v.reason).toBe('allow');
  });

  it('an `env` key removed, and a sibling left as it was, are clean; the declaration removed is not', () => {
    const withEnv = repo(oldWired('2.5.0', { env: { FOO: '1', BAR: '2' } }));
    expect(write(withEnv, project(withEnv), json(oldWired('2.5.0', { env: { FOO: '1' } }))).decision).toBe('allow');
    expect(write(withEnv, project(withEnv), json(oldWired('2.5.0'))).decision).toBe('allow');
    expect(write(withEnv, project(withEnv), json(oldWired('2.5.0', { env: { FOO: '2' } }))).decision).toBe('deny');
    const sibling = withSibling(oldWired('2.5.0'), { type: 'command', command: 'npx prettier --check' });
    const withSib = repo(sibling);
    expect(write(withSib, project(withSib), json({ ...sibling, permissions: { allow: ['Bash(ls)'] } })).decision).toBe('allow');
    const declared = repo(wired(TW_VERSION));
    const v = write(declared, project(declared), json(oldWired(TW_VERSION)));
    expect(v.decision).toBe('deny');
    expect(v.reason).toContain('`disableAllHooks: false` was removed');
    expect(write(declared, project(declared), json(wired(TW_VERSION, { permissions: { allow: [] } }))).decision).toBe('allow');
  });

  it('the wired file on disk is what init writes at this version', () => {
    // a control on the fixtures: the shape this file holds the project file to is the shape init produces
    const cwd = repo(wired(TW_VERSION));
    const r = spawnSync(process.execPath, [CLI, 'init'], { cwd, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/agent\s+ok/);
    expect(JSON.parse(readFileSync(project(cwd), 'utf8')).disableAllHooks).toBe(false);
  });
});
