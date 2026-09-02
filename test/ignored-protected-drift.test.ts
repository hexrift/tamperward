// Regression pin for issue #202. Content drift of an ALREADY-PRESENT ignored
// protected file is caught: the ptree sanctions it at first sight, `driftBetween`
// reports it changed, and `uncoveredDrift` finds no git blob to reconstruct its
// sanctioned content from (the path is untracked and ignored), so the only safe
// verdict is a `hidden-drift` block naming the file. #202 reported this as a gap;
// the report was wrong — the original probe grepped the hook's output for "block"
// and "hook-tampering" while the finding is named `hidden-drift`, so a real block
// read as silence. These cases pin the behaviour at both layers.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { buildSync } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TW_VERSION } from '../src/wiring';

vi.setConfig({ testTimeout: 60_000 });

// The CI test job runs `npm test` without `npm run build`, so `dist/` may not
// exist: build the CLI here, in the package layout it ships in, as the other
// end-to-end suites do.
const ROOT = join(__dirname, '..');
let cliDir = '';
let CLI = '';
const hook = (cwd: string, payload: unknown): string =>
  spawnSync(process.execPath, [CLI, 'hook', 'claude'], {
    cwd, input: JSON.stringify(payload), encoding: 'utf8', timeout: 50_000,
  }).stdout ?? '';

describe('ignored protected file, content drift mid-turn (#202)', () => {
  let dir: string;

  beforeAll(() => {
    cliDir = mkdtempSync(join(tmpdir(), 'tw-202-cli-'));
    symlinkSync(join(ROOT, 'node_modules'), join(cliDir, 'node_modules'), 'dir');
    writeFileSync(join(cliDir, 'package.json'), JSON.stringify({ name: 'tamperward', version: TW_VERSION, type: 'module' }));
    mkdirSync(join(cliDir, 'dist', 'cli'), { recursive: true });
    CLI = join(cliDir, 'dist', 'cli', 'index.js');
    buildSync({ entryPoints: [join(ROOT, 'src/cli/index.ts')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: CLI, logLevel: 'silent' });
  }, 120_000);
  afterAll(() => { if (cliDir) rmSync(cliDir, { recursive: true, force: true }); });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tw-202-'));
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'test/a.test.js'), 'ok\n');
    writeFileSync(join(dir, 'package.json'), '{"name":"d","version":"1.0.0"}\n');
    // a protected path (.husky/**) that git ignores
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    writeFileSync(join(dir, '.husky/_/.gitignore'), '*\n');
    writeFileSync(join(dir, '.husky/_/h'), 'orig\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const sanction = (sid: string) =>
    hook(dir, { session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'true' } });

  it('is blocked at the next PreToolUse as hidden-drift', () => {
    sanction('s1');
    writeFileSync(join(dir, '.husky/_/h'), 'GUTTED\n');
    const out = hook(dir, { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'true' } });
    expect(out).toContain('hidden-drift');
    expect(out).toContain('.husky/_/h');
  });

  it('is blocked at the Stop sweep', () => {
    sanction('s2');
    writeFileSync(join(dir, '.husky/_/h'), 'GUTTED\n');
    const out = hook(dir, { session_id: 's2', hook_event_name: 'Stop', stop_hook_active: false });
    expect(out).toContain('hidden-drift');
  });

  it('an untouched ignored protected file is not a finding', () => {
    sanction('s3');
    const out = hook(dir, { session_id: 's3', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'true' } });
    expect(out).toBe('');
  });
});
