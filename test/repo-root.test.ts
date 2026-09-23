// #412: every worktree-reading path resolved `.tamperward.yml` and on-disk content
// against cwd while git reports root-relative paths. From a subdirectory of the
// repository the after-content of every changed file pointed at a path that does
// not exist, the content/AST detectors went blind, and the root policy was
// silently replaced by the baseline — `check --worktree` and the Stop sweep failed
// OPEN, PreToolUse enforced the wrong policy, and `init` wired the wrong directory.
//
// The contract: a verdict, a plan and a policy are properties of the REPOSITORY,
// so every command produces the same result from `r1/pkg` as from `r1`.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCheck } from '../src/cli/check';
import { preToolUseVerdict, stopVerdict } from '../src/cli/hook';
import { runAllow } from '../src/cli/allow';
import { diagnose } from '../src/cli/doctor';
import { planInit, runInit } from '../src/cli/init';
import { loadPolicy } from '../src/policy-load';
import { repoContext } from '../src/repo-context';
import { readServiceState, startHookService } from '../src/cli/hook-service';
import { requestVerdict } from '../src/cli/hook-client';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const THREE = [
  `import { it, expect } from 'vitest';`,
  `it('a', () => { expect(1).toBe(1); });`,
  `it('b', () => { expect(2).toBe(2); });`,
  `it('c', () => { expect(3).toBe(3); });`,
  '',
].join('\n');
const ONE = [`import { it, expect } from 'vitest';`, `it('a', () => { expect(1).toBe(1); });`, ''].join('\n');

/** `r1` with a committed three-test spec and a `pkg/` subdirectory. */
function repo(): { root: string; pkg: string } {
  const root = mkdtempSync(join(tmpdir(), 'tw-root-412-'));
  dirs.push(root);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  mkdirSync(join(root, 'tests'));
  mkdirSync(join(root, 'pkg'));
  writeFileSync(join(root, 'tests', 'foo.test.ts'), THREE);
  writeFileSync(join(root, 'pkg', 'index.ts'), 'export const one = 1;\n');
  writeFileSync(join(root, 'package.json'), '{"name":"r1","scripts":{"test":"vitest run"}}\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { root, pkg: join(root, 'pkg') };
}

function gut(root: string): void {
  writeFileSync(join(root, 'tests', 'foo.test.ts'), ONE);
}

function capture<T>(fn: () => T): { result: T; out: string } {
  const original = process.stdout.write;
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { result: fn(), out: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

const edit = (cwd: string, root: string, sid: string) => ({
  tool_name: 'Edit',
  session_id: sid,
  cwd,
  tool_input: {
    file_path: join(root, 'tests', 'foo.test.ts'),
    old_string: `it('b', () => { expect(2).toBe(2); });\nit('c', () => { expect(3).toBe(3); });\n`,
    new_string: '',
  },
});

const decision = (r: { stdout: string }): unknown => (r.stdout ? JSON.parse(r.stdout) : null);

describe('repoContext', () => {
  it('resolves the root and the git dir from a subdirectory', () => {
    const { root, pkg } = repo();
    const fromRoot = repoContext(root);
    const fromPkg = repoContext(pkg);
    expect(fromRoot).not.toBeNull();
    expect(fromPkg).toEqual(fromRoot);
    expect(existsSync(join(fromPkg?.gitDir ?? '', 'HEAD'))).toBe(true);
  });

  it('is null outside a repository', () => {
    const d = mkdtempSync(join(tmpdir(), 'tw-norepo-412-'));
    dirs.push(d);
    expect(repoContext(d)).toBeNull();
  });
});

describe('#412 verdicts are repository properties, not cwd properties', () => {
  it('check --worktree from r1/pkg blocks the same test-deletion as from r1', () => {
    const { root, pkg } = repo();
    gut(root);
    const fromRoot = capture(() => runCheck({ worktree: true, json: true, cwd: root }));
    const fromPkg = capture(() => runCheck({ worktree: true, json: true, cwd: pkg }));
    expect(fromRoot.result).toBe(1);
    expect(fromRoot.out).toContain('test-deletion');
    expect(fromRoot.out).toContain('tests/foo.test.ts');
    expect(fromPkg.result).toBe(fromRoot.result);
    expect(JSON.parse(fromPkg.out)).toEqual(JSON.parse(fromRoot.out));
  });

  it('check --staged from r1/pkg equals the verdict from r1', () => {
    const { root, pkg } = repo();
    gut(root);
    execFileSync('git', ['add', '-A'], { cwd: root });
    const fromRoot = capture(() => runCheck({ staged: true, json: true, cwd: root }));
    const fromPkg = capture(() => runCheck({ staged: true, json: true, cwd: pkg }));
    expect(fromRoot.result).toBe(1);
    expect(fromPkg.result).toBe(1);
    expect(JSON.parse(fromPkg.out)).toEqual(JSON.parse(fromRoot.out));
  });

  it('sweep claude (Stop) from r1/pkg blocks the same turn as from r1', () => {
    const { root, pkg } = repo();
    gut(root);
    const fromRoot = stopVerdict({ session_id: 's-root', cwd: root });
    const fromPkg = stopVerdict({ session_id: 's-pkg', cwd: pkg });
    expect(fromRoot.exitCode).toBe(0);
    expect(fromRoot.stdout).toContain('test-deletion');
    expect(decision(fromPkg)).toEqual(decision(fromRoot));
  });

  it('hook claude (PreToolUse) denies the same Edit payload from r1/pkg as from r1', () => {
    const { root, pkg } = repo();
    const fromRoot = preToolUseVerdict(edit(root, root, 's-root'));
    const fromPkg = preToolUseVerdict(edit(pkg, root, 's-pkg'));
    expect(fromRoot.stdout).toContain('test-deletion');
    expect(fromRoot.stdout).toContain('tests/foo.test.ts');
    expect(decision(fromPkg)).toEqual(decision(fromRoot));
  });

  it('a relative Edit path in the payload still resolves against the session cwd', () => {
    const { root, pkg } = repo();
    const payload = edit(pkg, root, 's-rel');
    payload.tool_input.file_path = join('..', 'tests', 'foo.test.ts');
    const r = preToolUseVerdict(payload);
    expect(r.stdout).toContain('test-deletion');
    expect(r.stdout).toContain('tests/foo.test.ts');
    expect(r.stdout).not.toContain('../tests');
  });

  it('allow accepts a root-relative ./file spelling', () => {
    const a = repo();
    gut(a.root);
    const stderr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const r = capture(() => runAllow({
        rule: 'test-deletion',
        file: './tests/foo.test.ts',
        reason: 'reviewed',
        cwd: a.root,
      }));
      expect(r.result).toBe(0);
      expect(r.out).toContain('(./tests/foo.test.ts)');
    } finally {
      process.stderr.write = stderr;
    }
  });

  it('allow from r1/pkg records the same sign-off, in the root ledger, as from r1', () => {
    const a = repo();
    const b = repo();
    gut(a.root);
    gut(b.root);
    const stderr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    let fromRoot: { result: number; out: string };
    let fromPkg: { result: number; out: string };
    try {
      fromRoot = capture(() => runAllow({ rule: 'test-deletion', reason: 'reviewed', cwd: a.root }));
      fromPkg = capture(() => runAllow({ rule: 'test-deletion', reason: 'reviewed', cwd: b.pkg }));
    } finally {
      process.stderr.write = stderr;
    }
    expect(fromRoot.result).toBe(0);
    expect(fromPkg.result).toBe(fromRoot.result);
    expect(fromPkg.out).toBe(fromRoot.out);
    const ledger = loadPolicy(a.root).signoff.ledger;
    expect(existsSync(join(b.root, ledger))).toBe(true);
    expect(existsSync(join(b.pkg, ledger))).toBe(false);
    // The sign-off it recorded is honored by the pre-commit view from either cwd.
    execFileSync('git', ['add', '-A'], { cwd: b.root });
    expect(capture(() => runCheck({ staged: true, json: true, cwd: b.pkg })).result).toBe(0);
    expect(capture(() => runCheck({ staged: true, json: true, cwd: b.root })).result).toBe(0);
  });

  it('doctor from r1/pkg reaches the same outcome as from r1', () => {
    const { root, pkg } = repo();
    writeFileSync(join(root, '.tamperward.yml'), 'version: 1\nverify:\n  command: npm test\n  budget: 300\n');
    for (const a of planInit(root)) a.apply?.();
    const fromRoot = diagnose({ cwd: root });
    const fromPkg = diagnose({ cwd: pkg });
    expect(fromRoot.failure?.id).not.toBe('verifier'); // the root policy names a verifier
    expect(fromPkg).toEqual(fromRoot);
  });

  it('init --dry-run from r1/pkg plans the same files at the same places as from r1', () => {
    const { root, pkg } = repo();
    const stderr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    let fromRoot: { result: number; out: string };
    let fromPkg: { result: number; out: string };
    try {
      fromRoot = capture(() => runInit({ cwd: root, dryRun: true }));
      fromPkg = capture(() => runInit({ cwd: pkg, dryRun: true }));
    } finally {
      process.stderr.write = stderr;
    }
    expect(fromRoot.result).toBe(0);
    expect(fromPkg.result).toBe(fromRoot.result);
    expect(fromPkg.out).toBe(fromRoot.out);
    expect(existsSync(join(pkg, '.tamperward.yml'))).toBe(false);
  });

  it('init from r1/pkg writes to the repository root, never into pkg/', () => {
    const { root, pkg } = repo();
    const stderr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(runInit({ cwd: pkg, quiet: true })).toBe(0);
    } finally {
      process.stderr.write = stderr;
    }
    for (const rel of ['.tamperward.yml', '.claude/settings.json', '.github/workflows/tamperward.yml', '.github/CODEOWNERS']) {
      expect(existsSync(join(root, rel)), rel).toBe(true);
      expect(existsSync(join(pkg, rel)), rel).toBe(false);
    }
    expect(existsSync(join(root, '.git', 'hooks', 'pre-commit'))).toBe(true);
  });
});

describe('#412 the root policy governs from a subdirectory', () => {
  it('a root .tamperward.yml lowering test-deletion to warn applies to an Edit from r1/pkg', () => {
    const { root, pkg } = repo();
    writeFileSync(join(root, '.tamperward.yml'), 'version: 1\nrules:\n  test-deletion: { severity: warn }\n  test-content-removal: { severity: warn }\n');
    const fromRoot = preToolUseVerdict(edit(root, root, 's-root'));
    const fromPkg = preToolUseVerdict(edit(pkg, root, 's-pkg'));
    expect(fromRoot.stdout).toBe('');
    expect(fromPkg.stdout).toBe('');
  });

  it('loadPolicy from r1/pkg is the root policy', () => {
    const { root, pkg } = repo();
    writeFileSync(join(root, '.tamperward.yml'), 'version: 1\nrules:\n  test-deletion: { severity: warn }\n');
    expect(loadPolicy(pkg)).toEqual(loadPolicy(root));
    expect(loadPolicy(pkg).rules['test-deletion']?.severity).toBe('warn');
  });

  it('a .tamperward.yml planted in the subdirectory does not govern', () => {
    const { root, pkg } = repo();
    writeFileSync(join(pkg, '.tamperward.yml'), 'version: 1\nrules:\n  test-deletion: { severity: warn }\n  test-content-removal: { severity: warn }\n');
    const r = preToolUseVerdict(edit(pkg, root, 's-pkg'));
    expect(r.stdout).toContain('test-deletion');
  });
});

describe('#412 a cwd outside any repository keeps its behaviour', () => {
  it('check refuses with the not-inside-a-repository message', () => {
    const d = mkdtempSync(join(tmpdir(), 'tw-norepo-412-'));
    dirs.push(d);
    const stderr = process.stderr.write;
    const errs: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      errs.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(runCheck({ worktree: true, cwd: d })).toBe(2);
    } finally {
      process.stderr.write = stderr;
    }
    expect(errs.join('')).toContain('not inside a git repository');
  });

  it('loadPolicy still reads the policy file beside a non-repository cwd', () => {
    const d = mkdtempSync(join(tmpdir(), 'tw-norepo-412-'));
    dirs.push(d);
    writeFileSync(join(d, '.tamperward.yml'), 'version: 1\nrules:\n  test-deletion: { severity: warn }\n');
    expect(loadPolicy(d).rules['test-deletion']?.severity).toBe('warn');
    expect(readFileSync(join(d, '.tamperward.yml'), 'utf8')).toContain('warn');
  });

  it('the Stop sweep outside a repository allows, as before', () => {
    const d = mkdtempSync(join(tmpdir(), 'tw-norepo-412-'));
    dirs.push(d);
    expect(stopVerdict({ session_id: 's', cwd: d })).toEqual({ exitCode: 0, stdout: '' });
  });
});

describe.skipIf(process.platform === 'win32')('#412 the hook service binds the repository, not the directory it started in', () => {
  it('started from r1/pkg it serves for r1 and answers the root verdict', async () => {
    const { root, pkg } = repo();
    const dir = join(mkdtempSync(join(tmpdir(), 'tw-rt-412-')), 'svc');
    dirs.push(dirname(dir));
    mkdirSync(dir, { mode: 0o700 });
    const paths = { dir, socket: join(dir, 'hook.sock'), state: join(dir, 'hook-service.json') };
    const svc = await startHookService({ root: pkg, paths });
    try {
      expect(svc.root).toBe(realpathSync(root));
      expect(readServiceState(paths)?.root).toBe(realpathSync(root));
      const raw = JSON.stringify(edit(pkg, root, 's-svc'));
      const served = await requestVerdict('PreToolUse', raw, { paths, cwd: pkg });
      expect(served).not.toBeNull();
      expect(served?.stdout).toContain('test-deletion');
      expect(decision({ stdout: served?.stdout ?? '' })).toEqual(decision(preToolUseVerdict(edit(root, root, 's-root'))));
    } finally {
      await svc.close();
    }
  });
});
