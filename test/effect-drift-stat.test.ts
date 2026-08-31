// P1-8 (external review): effect.ts reused the previous snapshot entry when
// mtime + size + mode all matched, skipping the hash. Every one of those three
// is writable by the agent being watched — so the layer built to catch "the
// mutation the matcher didn't see" was itself keyed on data the mutation's
// author controls. Reproduced before the fix; the fast path is gone.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driftBetween, snapshotProtected } from '../src/effect';
import { loadPolicy } from '../src/policy-load';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-drift-'));
  dirs.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, '.tamperward.yml'), 'version: 1\n');
  return d;
}

const BEFORE = "it('alpha_padding_here', () => { expect(1).toBe(1); });\n";
const AFTER = "it.skip('alpha_padding', () => { expect(1).toBe(1); });\n";

describe('P1-8: the stat triple is not a content proxy', () => {
  it('same-size edit with a restored mtime is still detected as drift', () => {
    expect(AFTER.length).toBe(BEFORE.length); // the exploit's whole premise
    const cwd = repo();
    const file = join(cwd, 'test', 'a.test.js');
    writeFileSync(file, BEFORE);
    const policy = loadPolicy(cwd);
    const baseline = snapshotProtected(cwd, policy);
    const ref = join(cwd, 'ref');
    writeFileSync(ref, '');
    execFileSync('cp', ['-p', file, ref]); // reference carrying the original mtime
    const before = statSync(file);

    writeFileSync(file, AFTER);
    // Real `touch -r`, not utimesSync(Date): Node's Date-based utimes truncates
    // to millisecond precision, so mtimeMs no longer matched byte-for-byte and
    // the fast path never engaged — the first version of this test passed with
    // the fix REVERTED, i.e. proved nothing. `touch -r` preserves nanoseconds.
    execFileSync('touch', ['-r', ref, file]);

    const st = statSync(file);
    expect(st.size).toBe(BEFORE.length); // size preserved
    expect(st.mtimeMs).toBe(before.mtimeMs); // mtime preserved EXACTLY

    const current = snapshotProtected(cwd, policy, baseline);
    expect(driftBetween(baseline, current).changed).toContain('test/a.test.js');
  });

  it('an untouched tree still reports no drift (always-hashing adds no false positives)', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'test', 'a.test.js'), BEFORE);
    const policy = loadPolicy(cwd);
    const baseline = snapshotProtected(cwd, policy);
    const d = driftBetween(baseline, snapshotProtected(cwd, policy, baseline));
    expect(d.changed).toEqual([]);
    expect(d.deleted).toEqual([]);
  });
});
