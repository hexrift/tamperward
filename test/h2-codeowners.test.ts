// H2: a pull request can neuter the workflow that judges it.
//
// Confirmed on this project's own CI — the `gate` job reported success in three
// seconds, having run `true`, over a pull request that lowered a mechanical rule
// from block to warn. No detector can close that, because the detector is
// defined by the candidate. The only thing that can is a human requirement on
// the paths that constitute the gate, so `init` now writes one.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planInit } from '../src/cli/init';
import { defaultPolicy, isProtected } from '../src/policy';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(remote: string | null = 'https://github.com/acme/widgets.git'): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-h2-'));
  dirs.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: d });
  return d;
}
const co = (cwd: string) => planInit(cwd).find((a) => a.item === 'codeowners')!;
const GATE_PATHS = ['/.github/workflows/', '/.tamperward.yml', '/.github/CODEOWNERS'];

describe('init requires a human on the paths that decide whether the gate runs', () => {
  it('creates CODEOWNERS covering every gate-critical path, owned by the inferred owner', () => {
    const cwd = repo();
    const a = co(cwd);
    expect(a.status).toBe('create');
    a.apply!();
    const src = readFileSync(join(cwd, '.github/CODEOWNERS'), 'utf8');
    for (const p of GATE_PATHS) expect(src).toContain(p);
    expect(src).toContain('@acme');
    expect(co(cwd).status).toBe('ok'); // idempotent
  });

  it('infers the owner from an ssh remote too', () => {
    const cwd = repo('git@github.com:acme/widgets.git');
    co(cwd).apply!();
    expect(readFileSync(join(cwd, '.github/CODEOWNERS'), 'utf8')).toContain('@acme');
  });

  it('when the owner cannot be inferred, says so instead of writing a rule that binds nobody', () => {
    // An unresolvable owner is protection that is silently absent — the exact
    // failure class this project keeps re-learning. It has to be visible.
    const cwd = repo(null);
    const a = co(cwd);
    expect(a.detail).toMatch(/OWNER UNKNOWN/);
    a.apply!();
    const src = readFileSync(join(cwd, '.github/CODEOWNERS'), 'utf8');
    expect(src).toContain('@OWNER');
    expect(src).toMatch(/REPLACE @OWNER/);
  });

  it('extends an existing CODEOWNERS at the END and keeps what was there', () => {
    // Last match wins in CODEOWNERS, so appending is what makes our rules
    // survive a broader earlier pattern rather than be shadowed by one.
    const cwd = repo();
    writeFileSync(join(cwd, 'CODEOWNERS'), '/src/ @someone\n');
    const a = co(cwd);
    expect(a.status).toBe('update');
    expect(a.path).toBe('CODEOWNERS');
    a.apply!();
    const src = readFileSync(join(cwd, 'CODEOWNERS'), 'utf8');
    expect(src).toContain('/src/ @someone');
    expect(src.indexOf('/src/ @someone')).toBeLessThan(src.indexOf('/.github/workflows/'));
    // and no second file, which GitHub would ignore
    expect(() => readFileSync(join(cwd, '.github/CODEOWNERS'), 'utf8')).toThrow();
  });

  it('a catch-all rule already requires an owner on every path, so nothing is added', () => {
    // `* @team` is weak, but it does put a human in front of the workflow —
    // which is the property being asked for. Adding to it would be noise.
    const cwd = repo();
    writeFileSync(join(cwd, 'CODEOWNERS'), '* @team\n');
    expect(co(cwd).status).toBe('ok');
  });

  it('adds only the rules that are missing', () => {
    const cwd = repo();
    mkdirSync(join(cwd, '.github'), { recursive: true });
    writeFileSync(join(cwd, '.github/CODEOWNERS'), '/.github/workflows/ @acme\n');
    const a = co(cwd);
    expect(a.detail).toContain('/.tamperward.yml');
    expect(a.detail).not.toContain('/.github/workflows/,');
  });

  it('treats a directory rule as covering what is under it', () => {
    // This project's own CODEOWNERS writes `/.github/ @hexrift`, which already
    // requires an owner on the workflow. Appending `/.github/workflows/` there
    // would be noise in the one file people must be able to read at a glance.
    const cwd = repo();
    mkdirSync(join(cwd, '.github'), { recursive: true });
    writeFileSync(join(cwd, '.github/CODEOWNERS'), '/.github/        @acme\n/.tamperward.yml @acme\n');
    expect(co(cwd).status).toBe('ok');
  });

  it('a pattern with no owner requires nobody, so it does not count as coverage', () => {
    const cwd = repo();
    mkdirSync(join(cwd, '.github'), { recursive: true });
    writeFileSync(join(cwd, '.github/CODEOWNERS'), '/.github/\n/.tamperward.yml\n');
    expect(co(cwd).status).toBe('update');
  });

  it('leaves a CODEOWNERS that already covers the gate paths alone', () => {
    const cwd = repo();
    mkdirSync(join(cwd, '.github'), { recursive: true });
    writeFileSync(join(cwd, '.github/CODEOWNERS'), GATE_PATHS.map((p) => `${p} @acme`).join('\n') + '\n');
    const a = co(cwd);
    expect(a.status).toBe('ok');
    expect(a.apply).toBeUndefined();
  });
});

describe('CODEOWNERS is enforcement wiring, not documentation', () => {
  it.each(['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'])(
    '%s is a protected hooks asset, so removing it is a finding',
    (p) => {
      expect(isProtected(p, defaultPolicy(), 'hooks')).toBe(true);
    },
  );
});
