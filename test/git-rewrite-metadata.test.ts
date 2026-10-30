import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';

// Run the real production module in a child: a FIFO regression cannot hang Vitest.
const temp = mkdtempSync(join(tmpdir(), 'tw-rewrite-test-'));
const modulePath = join(temp, 'trusted.mjs');
beforeAll(() => {
  const compiled = buildSync({ entryPoints: [join(__dirname, '../src/git/trusted.ts')],
    bundle: true, platform: 'node', format: 'esm', write: false });
  writeFileSync(modulePath, compiled.outputFiles[0].contents);
});
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function repo(): string {
  const cwd = mkdtempSync(join(temp, 'repo-'));
  execFileSync('git', ['init', '-q'], { cwd });
  return cwd;
}
function state(cwd: string): string {
  return execFileSync(process.execPath,
    ['--input-type=module', '-e', `import {objectRewriteState} from ${JSON.stringify('file://' + modulePath)}; try { process.stdout.write(objectRewriteState(process.argv[1])); } catch(e) { process.stderr.write(e.message); process.exit(2); }`, cwd],
    { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('bounded Git rewrite metadata (#798)', () => {
  it('keeps absent and regular metadata digest semantics', () => {
    const cwd = repo(); const before = state(cwd);
    mkdirSync(join(cwd, '.git/info'), { recursive: true });
    writeFileSync(join(cwd, '.git/info/grafts'), 'abc\n');
    expect(state(cwd)).not.toBe(before);
  });

  it('fingerprints a valid shallow boundary without treating it as unreadable', () => {
    const cwd = repo();
    execFileSync('git', ['-c', 'user.name=h', '-c', 'user.email=h@x', 'commit', '--allow-empty', '-qm', 'base'], { cwd });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    const before = state(cwd);
    writeFileSync(join(cwd, '.git/shallow'), head + '\n');
    expect(state(cwd)).toMatch(/^[a-f0-9]{64}$/);
    expect(state(cwd)).not.toBe(before);
  });

  it.each(['fifo', 'symlink', 'oversize', 'directory'])('refuses %s without hanging', kind => {
    const cwd = repo(); const path = join(cwd, '.git/shallow');
    if (kind === 'fifo') execFileSync('mkfifo', [path]);
    if (kind === 'symlink') symlinkSync('/dev/zero', path);
    if (kind === 'oversize') writeFileSync(path, 'x'.repeat(65 * 1024 * 1024));
    if (kind === 'directory') mkdirSync(path);
    expect(() => state(cwd)).toThrow(/cannot inspect Git rewrite metadata/);
  });

  it('inspects the common directory in a linked worktree', () => {
    const cwd = repo();
    execFileSync('git', ['-c', 'user.name=h', '-c', 'user.email=h@x', 'commit', '--allow-empty', '-qm', 'base'], { cwd });
    const linked = join(temp, 'linked-' + Math.random().toString(36).slice(2));
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'linked', linked], { cwd });
    const before = state(linked);
    writeFileSync(join(cwd, '.git/info/grafts'), 'abc\n');
    expect(state(linked)).not.toBe(before);
  });
});
