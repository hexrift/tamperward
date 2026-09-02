// A protected file CREATED during the turn where git will not list it — ignored
// through the agent-writable `.git/info/exclude`, a `.gitignore` line, or the
// global excludes Claude Code itself installs for `.claude/settings.local.json` —
// was judged by nobody. `ls-files --others --exclude-standard` drops ignored files
// on purpose; the hidden-tracked probe lists tracked files only; and the effect
// layer, which did see the file in its snapshot, reported only changed/deleted
// drift and absorbed an ADDITION with `savePtree(current)`. The same file not
// ignored blocked the turn. A forged turn tree listing the new file at its hash
// was a second route to the same absorb.
//
// The invariant now: a protected addition the git view cannot see is JUDGED, never
// absorbed. Every case below runs end to end through the BUILT CLI — the hook
// payloads `tamperward hook claude` and `tamperward sweep claude` read on stdin —
// so the wire contract is what is asserted, not an internal function.

import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import { buildSync } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheck } from '../src/cli/check';
import { diffWorktreeWithUntracked, ignoredPaths } from '../src/git/build';
import { contentHash, driftBetween } from '../src/effect';
import { isProtected, defaultPolicy } from '../src/policy';

const ROOT = join(__dirname, '..');
let cliDir = '';
let CLI = '';
const dirs: string[] = [];

beforeAll(() => {
  // The CLI as `npm run build` ships it, bundled into a scratch directory that
  // borrows the repo's node_modules (the bundle keeps packages external).
  cliDir = mkdtempSync(join(tmpdir(), 'tw-cli-'));
  symlinkSync(join(ROOT, 'node_modules'), join(cliDir, 'node_modules'), 'dir');
  CLI = join(cliDir, 'index.js');
  buildSync({ entryPoints: [join(ROOT, 'src/cli/index.ts')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: CLI, logLevel: 'silent' });
}, 60_000);

afterAll(() => {
  if (cliDir) rmSync(cliDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const COLLECT_IGNORE = `collect_ignore = ["test_a.py"]\n`;
const HONEST_CONFTEST = `import pytest\n\n@pytest.fixture\ndef db():\n    return object()\n`;
const WIRED = JSON.stringify({
  hooks: {
    PreToolUse: [{ matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: 'npx --yes tamperward@2.5.0 hook claude' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'npx --yes tamperward@2.5.0 sweep claude' }] }],
  },
});

function repo(opts: { policy?: string } = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-ign-'));
  dirs.push(d);
  const g = (...a: string[]) => execFileSync('git', a, { cwd: d });
  g('init', '-q');
  g('config', 'user.email', 't@b');
  g('config', 'user.name', 'tb');
  mkdirSync(join(d, 'test'));
  mkdirSync(join(d, '.claude'));
  writeFileSync(join(d, 'test', 'test_a.py'), `def test_a():\n    assert 1 == 1\n`);
  writeFileSync(join(d, '.claude', 'settings.json'), WIRED);
  writeFileSync(join(d, '.gitignore'), `node_modules/\ndist/\n*.log\n`);
  if (opts.policy) writeFileSync(join(d, '.tamperward.yml'), opts.policy);
  g('add', '-A');
  g('commit', '-qm', 'base');
  return d;
}

/** `tamperward hook claude` over the wire: the payload on stdin, the verdict on stdout at exit 0. */
function pre(cwd: string, tool: string, input: Record<string, unknown>, sid = 's1'): { exit: number | null; out: string } {
  const r = spawnSync(process.execPath, [CLI, 'hook', 'claude'], {
    input: JSON.stringify({ session_id: sid, cwd, tool_name: tool, tool_input: input, hook_event_name: 'PreToolUse' }),
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`hook claude exited ${r.status}: ${r.stderr}`);
  return { exit: r.status, out: r.stdout };
}
function stop(cwd: string, sid = 's1'): { exit: number | null; out: string } {
  const r = spawnSync(process.execPath, [CLI, 'sweep', 'claude'], {
    input: JSON.stringify({ session_id: sid, cwd, hook_event_name: 'Stop', stop_hook_active: false }),
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`sweep claude exited ${r.status}: ${r.stderr}`);
  return { exit: r.status, out: r.stdout };
}
const bash = (cwd: string, sid = 's1') => pre(cwd, 'Bash', { command: 'echo ok' }, sid);
const denial = (r: { out: string }): string => (r.out ? JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason : '');
const decision = (r: { out: string }): string => (r.out ? JSON.parse(r.out).hookSpecificOutput.permissionDecision : 'allow');
const reason = (r: { out: string }): string => (r.out ? JSON.parse(r.out).reason : '');
const block = (r: { out: string }): string => (r.out ? JSON.parse(r.out).decision : 'allow');

/** A write the PreToolUse matcher never sees: the interpreter, not the Write tool. */
function writeViaInterpreter(cwd: string, rel: string, content: string): void {
  execFileSync('python3', ['-c', 'import sys; open(sys.argv[1], "w").write(sys.argv[2])', join(cwd, rel), content]);
}

describe('an ignored protected file created during the turn is judged (through the built CLI)', () => {
  it('excluded via .git/info/exclude: conftest.py with collect_ignore → PreToolUse DENY, Stop BLOCK', () => {
    const cwd = repo();
    expect(bash(cwd)).toEqual({ exit: 0, out: '' }); // the turn begins
    appendFileSync(join(cwd, '.git', 'info', 'exclude'), 'test/conftest.py\n');
    writeViaInterpreter(cwd, 'test/conftest.py', COLLECT_IGNORE);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })).toBe(''); // git's view: nothing happened

    const r = bash(cwd);
    expect(r.exit).toBe(0);
    expect(decision(r)).toBe('deny');
    expect(denial(r)).toContain('test-skip');
    expect(denial(r)).toContain('collect_ignore');
    expect(decision(bash(cwd))).toBe('deny'); // not absorbed: the deny repeats
    const s = stop(cwd);
    expect(s.exit).toBe(0);
    expect(block(s)).toBe('block');
    expect(reason(s)).toContain('test-skip');
    // Fixing the file clears it, ignored or not.
    writeViaInterpreter(cwd, 'test/conftest.py', HONEST_CONFTEST);
    expect(bash(cwd).out).toBe('');
    expect(stop(cwd).out).toBe('');
  });

  it('excluded via a .gitignore edit: the same file, the same verdicts', () => {
    const cwd = repo();
    expect(bash(cwd).out).toBe('');
    appendFileSync(join(cwd, '.gitignore'), 'test/conftest.py\n');
    writeViaInterpreter(cwd, 'test/conftest.py', COLLECT_IGNORE);
    expect(denial(bash(cwd))).toContain('test-skip');
    expect(reason(stop(cwd))).toContain('test-skip');
  });

  it('the Stop sweep alone catches it when no PreToolUse call ran after the write', () => {
    const cwd = repo();
    expect(bash(cwd).out).toBe('');
    appendFileSync(join(cwd, '.git', 'info', 'exclude'), 'test/conftest.py\n');
    writeViaInterpreter(cwd, 'test/conftest.py', COLLECT_IGNORE);
    expect(reason(stop(cwd))).toContain('test-skip');
  });

  it('without a session (no effect state at all) the sweep still judges an ignored protected file', () => {
    const cwd = repo();
    appendFileSync(join(cwd, '.git', 'info', 'exclude'), 'test/conftest.py\n');
    writeViaInterpreter(cwd, 'test/conftest.py', COLLECT_IGNORE);
    const r = spawnSync(process.execPath, [CLI, 'sweep', 'claude'], { input: JSON.stringify({ cwd, hook_event_name: 'Stop' }), encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(reason({ out: r.stdout })).toContain('test-skip');
  });

  it('control: the same file NOT ignored blocks exactly as before', () => {
    const cwd = repo();
    expect(bash(cwd).out).toBe('');
    writeViaInterpreter(cwd, 'test/conftest.py', COLLECT_IGNORE);
    expect(denial(bash(cwd))).toContain('test-skip');
    expect(reason(stop(cwd))).toContain('test-skip');
  });

  it('a gitignored .claude/settings.local.json written by an interpreter shadows the wiring → DENY / BLOCK', () => {
    const cwd = repo();
    // Claude Code adds `**/.claude/settings.local.json` to the user's global excludes.
    const excludes = join(cwd, '.git', 'global-excludes');
    writeFileSync(excludes, '**/.claude/settings.local.json\n');
    execFileSync('git', ['config', 'core.excludesFile', excludes], { cwd });
    expect(bash(cwd).out).toBe('');
    writeViaInterpreter(cwd, '.claude/settings.local.json', JSON.stringify({ hooks: { PreToolUse: [], Stop: [] } }));
    expect(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })).toBe('');
    const r = bash(cwd);
    expect(decision(r)).toBe('deny');
    expect(denial(r)).toContain('hook-tampering');
    expect(reason(stop(cwd))).toContain('hook-tampering');
  });
});

describe('an addition no git listing can see is reconstructed by the effect layer', () => {
  it('a conftest.py inside a nested repository the turn created (`git init` in a subdirectory)', () => {
    const cwd = repo();
    expect(bash(cwd).out).toBe('');
    // `ls-files --others` reports `sub/` as one opaque entry — untracked or ignored, it
    // never descends into another repository — while the runner reads the file.
    mkdirSync(join(cwd, 'sub', 'test'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: join(cwd, 'sub') });
    writeViaInterpreter(cwd, 'sub/test/conftest.py', COLLECT_IGNORE);
    expect(execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard'], { cwd, encoding: 'utf8' })).not.toContain('conftest');
    expect(execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf8' })).not.toContain('conftest');
    const r = bash(cwd);
    expect(decision(r)).toBe('deny');
    expect(denial(r)).toContain('test-skip');
    expect(reason(stop(cwd))).toContain('test-skip');
  });
});

describe('a forged turn tree cannot excuse an addition', () => {
  const stateDir = (cwd: string) => join(cwd, '.git', 'tamperward');
  const forgeTurnTree = (cwd: string, rel: string, sid = 's1'): void => {
    const p = join(stateDir(cwd), `turntree-${sid}.json`);
    const tree = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    const content = readFileSync(join(cwd, rel));
    tree[rel] = { hash: contentHash(content), mode: 0o100644, size: content.length, mtimeMs: 0 };
    writeFileSync(p, JSON.stringify(tree));
  };

  it('an untracked conftest listed in a forged turn tree at its hash is still judged', () => {
    const cwd = repo();
    expect(bash(cwd).out).toBe('');
    writeViaInterpreter(cwd, 'test/conftest.py', COLLECT_IGNORE);
    forgeTurnTree(cwd, 'test/conftest.py');
    expect(denial(bash(cwd))).toContain('test-skip');
    expect(reason(stop(cwd))).toContain('test-skip');
  });

  it('…and an IGNORED one too', () => {
    const cwd = repo();
    expect(bash(cwd).out).toBe('');
    appendFileSync(join(cwd, '.git', 'info', 'exclude'), 'test/conftest.py\n');
    writeViaInterpreter(cwd, 'test/conftest.py', COLLECT_IGNORE);
    forgeTurnTree(cwd, 'test/conftest.py');
    expect(denial(bash(cwd))).toContain('test-skip');
    expect(reason(stop(cwd))).toContain('test-skip');
  });

  it('…nor a REWRITE of a sanctioned untracked file: forged to the new hash, the file is still judged', () => {
    const cwd = repo();
    writeViaInterpreter(cwd, 'test/conftest.py', HONEST_CONFTEST); // the developer's own, present before the session
    expect(bash(cwd).out).toBe('');
    writeViaInterpreter(cwd, 'test/conftest.py', COLLECT_IGNORE);
    forgeTurnTree(cwd, 'test/conftest.py');
    expect(denial(bash(cwd))).toContain('test-skip');
    expect(reason(stop(cwd))).toContain('test-skip');
  });

  it('…and a rewrite of a sanctioned IGNORED file, which has no blob to diff against, is hidden-drift', () => {
    const cwd = repo();
    appendFileSync(join(cwd, '.git', 'info', 'exclude'), 'test/conftest.py\n');
    writeViaInterpreter(cwd, 'test/conftest.py', HONEST_CONFTEST);
    expect(bash(cwd).out).toBe('');
    writeViaInterpreter(cwd, 'test/conftest.py', COLLECT_IGNORE);
    forgeTurnTree(cwd, 'test/conftest.py');
    expect(denial(bash(cwd))).toContain('hidden-drift');
    expect(reason(stop(cwd))).toContain('hidden-drift');
  });

  it('removing the ptree so the next call re-snapshots forgets the turn tree with it: Stop still judges', () => {
    const cwd = repo();
    expect(bash(cwd).out).toBe('');
    writeViaInterpreter(cwd, 'test/conftest.py', COLLECT_IGNORE);
    forgeTurnTree(cwd, 'test/conftest.py');
    unlinkSync(join(stateDir(cwd), 'ptree-s1.json'));
    bash(cwd); // re-snapshots
    expect(reason(stop(cwd))).toContain('test-skip');
  });
});

describe('the other views', () => {
  it('check --worktree with untracked included lists an ignored protected add', () => {
    const cwd = repo();
    appendFileSync(join(cwd, '.git', 'info', 'exclude'), 'test/conftest.py\n');
    writeViaInterpreter(cwd, 'test/conftest.py', COLLECT_IGNORE);
    const w = process.stdout.write.bind(process.stdout);
    let printed = '';
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { printed += s; return true; };
    let code: number;
    try {
      code = runCheck({ worktree: true, cwd, includeUntracked: true, json: true });
    } finally {
      (process.stdout as unknown as { write: typeof w }).write = w;
    }
    expect(code).toBe(1);
    expect(printed).toContain('test-skip');
    expect(printed).toContain('test/conftest.py');
    // Without the untracked view (the local `tamperward check --worktree`) nothing changes: tracked only.
    (process.stdout as unknown as { write: (s: string) => boolean }).write = () => true;
    try {
      expect(runCheck({ worktree: true, cwd, json: true })).toBe(0);
    } finally {
      (process.stdout as unknown as { write: typeof w }).write = w;
    }
  });

  it("the envelope's untracked view carries ignored protected files and nothing else that is ignored", () => {
    const cwd = repo();
    const P = defaultPolicy();
    appendFileSync(join(cwd, '.git', 'info', 'exclude'), 'test/conftest.py\n');
    writeViaInterpreter(cwd, 'test/conftest.py', COLLECT_IGNORE);
    writeFileSync(join(cwd, 'scratch.log'), 'it.skip("would be a finding if scanned")\n');
    mkdirSync(join(cwd, 'dist'));
    writeFileSync(join(cwd, 'dist', 'out.js'), 'it.skip("build output")\n');
    mkdirSync(join(cwd, 'node_modules', 'pkg', 'test'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules', 'pkg', 'test', 'conftest.py'), COLLECT_IGNORE);
    writeFileSync(join(cwd, 'test', 'test_b.py'), `def test_b():\n    assert 2 == 2\n`); // untracked, not ignored
    const paths = diffWorktreeWithUntracked({ cwd }, (rel) => isProtected(rel, P))
      .filter((c) => c.kind === 'file')
      .map((c) => (c as { path: string }).path)
      .sort();
    expect(paths).toEqual(['test/conftest.py', 'test/test_b.py']);
    const add = diffWorktreeWithUntracked({ cwd }, (rel) => isProtected(rel, P)).find((c) => c.kind === 'file' && c.path === 'test/conftest.py');
    expect(add && add.kind === 'file' ? add.hunks.length : 0).toBe(1); // real hunks, so the hunk-based rules read it
    // Without a keep predicate the ignored set is not consulted at all (the plain untracked view).
    expect(diffWorktreeWithUntracked({ cwd }).map((c) => (c as { path: string }).path)).toEqual(['test/test_b.py']);
  });

  it('ignoredPaths: protected globs only, node_modules never walked, wholly-ignored directories expanded', () => {
    const cwd = repo();
    const P = defaultPolicy();
    mkdirSync(join(cwd, 'node_modules', 'pkg', 'test'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules', 'pkg', 'test', 'conftest.py'), COLLECT_IGNORE);
    mkdirSync(join(cwd, 'dist', 'nested'), { recursive: true });
    writeFileSync(join(cwd, 'dist', 'out.js'), 'x\n');
    writeFileSync(join(cwd, 'dist', 'nested', 'a.test.js'), 'it.skip("shipped spec")\n'); // protected glob, inside a collapsed dir
    writeFileSync(join(cwd, 'scratch.log'), 'x\n');
    mkdirSync(join(cwd, 'we[ird]'));
    writeFileSync(join(cwd, 'we[ird]', 'conftest.py'), COLLECT_IGNORE);
    appendFileSync(join(cwd, '.git', 'info', 'exclude'), 'we\\[ird\\]/\n');
    expect(ignoredPaths({ cwd }, (rel) => isProtected(rel, P)).sort()).toEqual(['dist/nested/a.test.js', 'we[ird]/conftest.py']);
    expect(ignoredPaths({ cwd }, () => true).some((p) => p.startsWith('node_modules'))).toBe(false);
  });
});

describe('controls', () => {
  it('an ignored ORDINARY file and a build output are not scanned', () => {
    const cwd = repo();
    expect(bash(cwd).out).toBe('');
    writeFileSync(join(cwd, 'scratch.log'), 'it.skip("not a protected path")\n');
    mkdirSync(join(cwd, 'dist'));
    writeFileSync(join(cwd, 'dist', 'out.js'), 'it.skip("build output")\n');
    expect(bash(cwd).out).toBe('');
    expect(stop(cwd).out).toBe('');
  });

  it('node_modules is not scanned, even when it holds a protected-looking file', () => {
    const cwd = repo();
    expect(bash(cwd).out).toBe('');
    mkdirSync(join(cwd, 'node_modules', 'pkg', 'test'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules', 'pkg', 'test', 'conftest.py'), COLLECT_IGNORE);
    writeFileSync(join(cwd, 'node_modules', 'pkg', 'a.test.js'), 'it.skip("vendored")\n');
    expect(bash(cwd).out).toBe('');
    expect(stop(cwd).out).toBe('');
  });

  it('an ignored protected file that PRE-DATES the session is not re-litigated', () => {
    const cwd = repo();
    appendFileSync(join(cwd, '.git', 'info', 'exclude'), 'test/conftest.py\n');
    writeViaInterpreter(cwd, 'test/conftest.py', `collect_ignore = ["test_slow.py"]\n`); // the developer's own
    expect(bash(cwd).out).toBe(''); // the session begins with it in place
    expect(bash(cwd).out).toBe('');
    expect(stop(cwd).out).toBe('');
    expect(bash(cwd).out).toBe(''); // next turn
    expect(stop(cwd).out).toBe('');
    // …but rewriting it is the turn's work: no blob to diff against, so hidden-drift names it.
    writeViaInterpreter(cwd, 'test/conftest.py', COLLECT_IGNORE);
    expect(denial(bash(cwd))).toContain('hidden-drift');
    expect(reason(stop(cwd))).toContain('hidden-drift');
  });

  it('an honest ignored addition is allowed and absorbed, then not re-judged next turn', () => {
    const cwd = repo();
    expect(bash(cwd).out).toBe('');
    appendFileSync(join(cwd, '.git', 'info', 'exclude'), 'test/conftest.py\n');
    writeViaInterpreter(cwd, 'test/conftest.py', HONEST_CONFTEST);
    expect(bash(cwd).out).toBe('');
    expect(stop(cwd).out).toBe('');
    expect(bash(cwd).out).toBe('');
    expect(stop(cwd).out).toBe('');
  });

  it('driftBetween reports additions', () => {
    const e = { hash: 'a', mode: 0o100644, size: 1, mtimeMs: 0 };
    expect(driftBetween({ 'x.test.ts': e }, { 'x.test.ts': e, 'test/conftest.py': e })).toEqual({ changed: [], deleted: [], added: ['test/conftest.py'] });
  });
});

describe('the guarded-rule pin reaches the command surface', () => {
  const LOWERED = `version: 1\nrules:\n  hook-tampering:\n    severity: warn\n`;

  it('hook-tampering lowered to warn: `rm .claude/settings.json` from Bash is still denied at the hook', () => {
    const cwd = repo({ policy: LOWERED });
    expect(bash(cwd).out).toBe('');
    for (const command of ['rm .claude/settings.json', 'rm -f ./.claude/settings.json', 'echo "{}" > .claude/settings.json', 'mv .claude/settings.json /tmp/x']) {
      const r = pre(cwd, 'Bash', { command });
      expect(decision(r), command).toBe('deny');
      expect(denial(r), command).toContain('hook-tampering');
    }
    const r = pre(cwd, 'Bash', { command: 'git update-index --skip-worktree .tamperward.yml' });
    expect(decision(r)).toBe('deny');
  });

  it('narrow: the pin covers the policy file and the baseline hooks, not a hook glob the user added', () => {
    const cwd = repo({ policy: `version: 1\nprotected:\n  hooks:\n    - scripts/gate.sh\nrules:\n  hook-tampering:\n    severity: warn\n` });
    mkdirSync(join(cwd, 'scripts'));
    writeFileSync(join(cwd, 'scripts', 'gate.sh'), '#!/bin/sh\nnpx tamperward check --staged\n');
    expect(bash(cwd).out).toBe('');
    expect(pre(cwd, 'Bash', { command: 'rm scripts/gate.sh' }).out).toBe(''); // the user's own severity governs
    expect(decision(pre(cwd, 'Bash', { command: 'rm .claude/settings.json' }))).toBe('deny');
  });
});
