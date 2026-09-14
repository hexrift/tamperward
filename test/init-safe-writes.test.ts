// tamperward init: no write follows a symlink planted in repository content (#414).
//
// Every file init touches is lstat'ed first. A symlink or non-regular file is
// refused with a plan-table row that says so, exit 2 when applying, and the
// symlink's target stays byte-identical. Writes that do happen go to a fresh
// sibling and rename over the destination, so a crash mid-write cannot leave a
// truncated settings.json behind, and the destination is never opened for writing.

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planInit, runInit } from '../src/cli/init';
import { atomicReplaceFile, refuseNonRegular } from '../src/safe-write';

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function repo(): string {
  const d = tmp('tw-init-safe-');
  mkdirSync(join(d, '.git', 'hooks'), { recursive: true });
  return d;
}

/** A file OUTSIDE the repository that a planted symlink points at. */
function sentinel(name: string, content: string): string {
  const outside = tmp('tw-init-outside-');
  const p = join(outside, name);
  writeFileSync(p, content);
  return p;
}

const captureInit = (cwd: string, dryRun = false): { code: number; output: string } => {
  const original = process.stdout.write;
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: runInit({ cwd, dryRun }), output: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
};

const rowFor = (output: string, item: string): string =>
  output.split('\n').find((l) => l.trimStart().startsWith(item + ' ')) ?? '';

/** The symlink is still a symlink to the same place and the target is unchanged. */
function expectUntouched(link: string, target: string, before: string): void {
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe(target);
  expect(readFileSync(target)).toEqual(Buffer.from(before));
  expect(readFileSync(target, 'utf8')).toBe(before);
}

describe('init refuses symlinked targets (#414)', () => {
  it('.claude/settings.json -> external settings: refused, sentinel byte-identical, exit 2', () => {
    const d = repo();
    const before = '{"hooks": {}, "theme": "dark"}\n';
    const target = sentinel('settings.json', before);
    mkdirSync(join(d, '.claude'));
    symlinkSync(target, join(d, '.claude', 'settings.json'));

    const plan = planInit(d);
    const agent = plan.find((a) => a.item === 'agent');
    expect(agent?.status).toBe('error');
    expect(agent?.detail).toMatch(/^refusing: symlink/);
    expect(agent?.apply).toBeUndefined();

    const dry = captureInit(d, true);
    expect(rowFor(dry.output, 'agent')).toMatch(/refusing: symlink/);
    expectUntouched(join(d, '.claude', 'settings.json'), target, before);

    const r = captureInit(d);
    expect(r.code).toBe(2);
    expect(rowFor(r.output, 'agent')).toMatch(/error\s+\.claude\/settings\.json\s+— refusing: symlink/);
    expectUntouched(join(d, '.claude', 'settings.json'), target, before);
    // The other items still applied: refusing one target does not stop the rest.
    expect(existsSync(join(d, '.tamperward.yml'))).toBe(true);
    expect(existsSync(join(d, '.git', 'hooks', 'pre-commit'))).toBe(true);
  });

  it('.git/hooks/pre-commit -> external script: nothing is appended to the outside file', () => {
    const d = repo();
    const before = '#!/bin/sh\necho outside hook\n';
    const target = sentinel('outside-hook.sh', before);
    symlinkSync(target, join(d, '.git', 'hooks', 'pre-commit'));

    const r = captureInit(d);
    expect(r.code).toBe(2);
    expect(rowFor(r.output, 'pre-commit')).toMatch(/error\s+\.git\/hooks\/pre-commit\s+— refusing: symlink/);
    expectUntouched(join(d, '.git', 'hooks', 'pre-commit'), target, before);
  });

  it('a tracked .husky/pre-commit symlink is refused and the reviewer file it aims at is untouched', () => {
    const d = repo();
    rmSync(join(d, '.git'), { recursive: true, force: true });
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    const before = 'export PATH=/usr/bin\n';
    const target = sentinel('.profile', before);
    mkdirSync(join(d, '.husky'));
    symlinkSync(target, join(d, '.husky', 'pre-commit'));
    git('add', '.husky/pre-commit');
    git('commit', '-q', '-m', 'plant');
    expect(git('ls-files', '--', '.husky/pre-commit').trim()).toBe('.husky/pre-commit');

    const r = captureInit(d);
    expect(r.code).toBe(2);
    expect(rowFor(r.output, 'pre-commit')).toMatch(/error\s+\.husky\/pre-commit\s+— refusing: symlink/);
    expectUntouched(join(d, '.husky', 'pre-commit'), target, before);
  });

  it('.tamperward.yml -> external policy is refused, not loaded and not replaced', () => {
    const d = repo();
    const before = 'version: 1\n';
    const target = sentinel('policy.yml', before);
    symlinkSync(target, join(d, '.tamperward.yml'));
    const r = captureInit(d);
    expect(r.code).toBe(2);
    expect(rowFor(r.output, 'policy')).toMatch(/error\s+\.tamperward\.yml\s+— refusing: symlink/);
    expectUntouched(join(d, '.tamperward.yml'), target, before);
  });

  it('CODEOWNERS -> external file (any of the three GitHub locations) is refused', () => {
    for (const rel of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
      const d = repo();
      const before = '* @someone\n';
      const target = sentinel('CODEOWNERS', before);
      mkdirSync(join(d, rel, '..'), { recursive: true });
      symlinkSync(target, join(d, rel));
      const r = captureInit(d);
      expect(r.code).toBe(2);
      expect(rowFor(r.output, 'codeowners')).toMatch(new RegExp(`error\\s+${rel.replace(/[./]/g, '\\$&')}\\s+— refusing: symlink`));
      expectUntouched(join(d, rel), target, before);
      // No second CODEOWNERS was created beside the refused one.
      if (rel !== '.github/CODEOWNERS') expect(existsSync(join(d, '.github', 'CODEOWNERS'))).toBe(false);
    }
  });

  it('the workflow -> external file is refused even with --force-workflow', () => {
    const d = repo();
    const before = 'name: theirs\non: push\n';
    const target = sentinel('ci.yml', before);
    mkdirSync(join(d, '.github', 'workflows'), { recursive: true });
    symlinkSync(target, join(d, '.github', 'workflows', 'tamperward.yml'));
    for (const forceWorkflow of [false, true]) {
      const ci = planInit(d, { forceWorkflow }).find((a) => a.item === 'ci');
      expect(ci?.status).toBe('error');
      expect(ci?.detail).toMatch(/^refusing: symlink/);
      expect(ci?.apply).toBeUndefined();
    }
    expect(captureInit(d).code).toBe(2);
    expectUntouched(join(d, '.github', 'workflows', 'tamperward.yml'), target, before);
  });

  it('a directory where a file is expected is refused as not a regular file', () => {
    const d = repo();
    mkdirSync(join(d, '.claude', 'settings.json'), { recursive: true });
    const agent = planInit(d).find((a) => a.item === 'agent');
    expect(agent?.status).toBe('error');
    expect(agent?.detail).toMatch(/^refusing: not a regular file/);
  });
});

describe('ordinary init still writes everything (control)', () => {
  it('a fresh repo gets all five files as regular files, and a second run is a no-op', () => {
    const d = repo();
    const r = captureInit(d);
    expect(r.code).toBe(0);
    for (const rel of ['.tamperward.yml', '.claude/settings.json', '.git/hooks/pre-commit', '.github/workflows/tamperward.yml', '.github/CODEOWNERS']) {
      const st = lstatSync(join(d, rel));
      expect(st.isFile(), rel).toBe(true);
      expect(st.isSymbolicLink(), rel).toBe(false);
    }
    expect(lstatSync(join(d, '.git/hooks/pre-commit')).mode & 0o111).toBeTruthy();
    expect(JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8')).disableAllHooks).toBe(false);
    // No temp file is left beside any target.
    for (const dir of ['.', '.claude', '.git/hooks', '.github', '.github/workflows']) {
      expect(readdirSync(join(d, dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    }
    const again = captureInit(d);
    expect(again.code).toBe(0);
    expect(again.output).toMatch(/everything already wired/);
  });

  it('merging into an existing regular settings.json and pre-commit keeps their bytes plus ours', () => {
    const d = repo();
    mkdirSync(join(d, '.claude'));
    writeFileSync(join(d, '.claude', 'settings.json'), '{"theme":"dark"}\n');
    writeFileSync(join(d, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nnpm test\n');
    expect(captureInit(d).code).toBe(0);
    const s = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
    expect(s.theme).toBe('dark');
    expect(s.hooks.PreToolUse).toHaveLength(1);
    const hook = readFileSync(join(d, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(hook).toMatch(/^#!\/bin\/sh\nnpm test\n/);
    expect(hook).toMatch(/tamperward(@\S+)? check --staged/);
    expect(lstatSync(join(d, '.git', 'hooks', 'pre-commit')).mode & 0o111).toBeTruthy();
  });
});

describe('safe-write primitives', () => {
  it('atomicReplaceFile never opens the destination: a symlink destination is replaced by a regular file', () => {
    const d = tmp('tw-safe-');
    const before = 'sentinel\n';
    const target = sentinel('t', before);
    const link = join(d, 'f');
    symlinkSync(target, link);
    atomicReplaceFile(link, 'new\n', 0o644);
    expect(lstatSync(link).isFile()).toBe(true);
    expect(readFileSync(link, 'utf8')).toBe('new\n');
    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(readdirSync(d)).toEqual(['f']);
  });

  it('refuseNonRegular names a symlink, a directory, and accepts an absent or regular file', () => {
    const d = tmp('tw-safe-');
    writeFileSync(join(d, 'plain'), 'x');
    mkdirSync(join(d, 'dir'));
    symlinkSync(join(d, 'plain'), join(d, 'link'));
    expect(refuseNonRegular(join(d, 'absent'))).toBeNull();
    expect(refuseNonRegular(join(d, 'plain'))).toBeNull();
    expect(refuseNonRegular(join(d, 'link'))).toMatch(/^refusing: symlink/);
    expect(refuseNonRegular(join(d, 'dir'))).toMatch(/^refusing: not a regular file/);
  });
});
