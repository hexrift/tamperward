// #517: PreToolUse reconstructed an incoming Write/Edit with an unbounded synchronous
// `git diff --no-index`, so a 20k-line high-churn write stalled the gate 30+ seconds.
// The reconstruction is bounded now: a strict git-diff timeout + bounded buffer, a
// linear fallback that never reads a truncated diff, and a hard content ceiling that
// FAILS CLOSED past the operator-owned budget. These tests exercise the fallback and
// the bounds directly — no wall-clock assertion, no full detector suite over huge input.

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linearFallbackHunks, synthFileChange } from '../src/adapters/claude/changes';
import { preToolUseVerdict } from '../src/cli/hook';
import { evaluate } from '../src/engine';
import { defaultPolicy } from '../src/policy';
import type { FileChange } from '../src/types';

const DIST = join(__dirname, '..', 'dist', 'cli', 'index.js');
// A spec-shaped line, ~76 bytes; the churn edit rewrites a word on every line.
const specLine = (i: number): string => `test("case ${i} does the thing number ${i}", () => { expect(1).toBe(1); });`;
const churn = (n: number): { before: string; after: string } => {
  let before = '';
  for (let i = 0; i < n; i++) before += specLine(i) + '\n';
  const after = before.replace(/does the thing/g, 'does the  thing') + 'test.skip("the failing one", () => {});\n';
  return { before, after };
};

const P = defaultPolicy();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function gitRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-517-'));
  dirs.push(d);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  return d;
}

// added-line content of a change, in order — what the hunk-based detectors read.
const added = (c: FileChange): string[] =>
  c.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'add').map((l) => l.content));
const removed = (c: FileChange): string[] =>
  c.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'del').map((l) => l.content));

describe('linearFallbackHunks (#517)', () => {
  it('modify: trims the common prefix/suffix and emits the changed middle as del then add', () => {
    const before = 'a\nb\nc\nd\n';
    const after = 'a\nB\nc\nd\n';
    const [h] = linearFallbackHunks(before, after);
    expect(h.lines.filter((l) => l.type === 'del').map((l) => l.content)).toEqual(['b']);
    expect(h.lines.filter((l) => l.type === 'add').map((l) => l.content)).toEqual(['B']);
    // deterministic line numbers: the change is at line 2 on both sides.
    expect(h.oldStart).toBe(2);
    expect(h.newStart).toBe(2);
    expect(h.lines.find((l) => l.type === 'del')?.oldLine).toBe(2);
    expect(h.lines.find((l) => l.type === 'add')?.newLine).toBe(2);
  });

  it('add: a null before makes every line an addition', () => {
    const [h] = linearFallbackHunks(null, 'x\ny\n');
    expect(h.lines.every((l) => l.type === 'add')).toBe(true);
    expect(h.lines.map((l) => l.content)).toEqual(['x', 'y', '']);
    expect(h.lines.map((l) => l.newLine)).toEqual([1, 2, 3]);
  });

  it('delete: a null after makes every line a deletion', () => {
    const [h] = linearFallbackHunks('x\ny\n', null);
    expect(h.lines.every((l) => l.type === 'del')).toBe(true);
    expect(h.lines.map((l) => l.content)).toEqual(['x', 'y', '']);
  });

  it('no net change yields no hunk', () => {
    expect(linearFallbackHunks('a\nb\n', 'a\nb\n')).toEqual([]);
  });

  it('an appended line is a single trailing addition (a late test.skip is exposed)', () => {
    const before = 'test("a", () => {});\n';
    const after = before + 'test.skip("b", () => {});\n';
    const adds = linearFallbackHunks(before, after).flatMap((h) => h.lines.filter((l) => l.type === 'add').map((l) => l.content));
    expect(adds).toContain('test.skip("b", () => {});');
  });

  it('preserves NUL bytes and multi-byte content verbatim in the changed middle', () => {
    const before = 'keep\nはい\nx\0y\ntail\n';
    const after = 'keep\nいいえ\nx\0z\ntail\n';
    const [h] = linearFallbackHunks(before, after);
    expect(h.lines.filter((l) => l.type === 'del').map((l) => l.content)).toEqual(['はい', 'x\0y']);
    expect(h.lines.filter((l) => l.type === 'add').map((l) => l.content)).toEqual(['いいえ', 'x\0z']);
  });
});

describe('synthFileChange bounds (#517)', () => {
  it('fails closed past the byte budget', () => {
    const big = 'x'.repeat(1024 * 1024 + 1);
    expect(() => synthFileChange('big.txt', null, big)).toThrow(/within the hook budget/);
  });

  it('fails closed past the line budget', () => {
    const many = Array.from({ length: 12001 }, (_, i) => `line ${i}`).join('\n');
    expect(() => synthFileChange('many.txt', null, many)).toThrow(/within the hook budget/);
  });

  it('reconstructs an ordinary small edit through git with exact hunks (no fallback)', () => {
    const before = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
    const after = 'const a = 1;\nconst b = 22;\nconst c = 3;\n';
    const [c] = synthFileChange('src/x.ts', before, after);
    expect(c.op).toBe('modify');
    expect(removed(c)).toContain('const b = 2;');
    expect(added(c)).toContain('const b = 22;');
  });
});

describe('a fallback-built change is still judged by the hunk detectors (#517)', () => {
  it('an appended test.skip in a fallback hunk blocks under test-skip', () => {
    const before = 'test("a", () => { expect(1).toBe(1); });\n';
    const after = before + 'test.skip("b", () => {});\n';
    const c: FileChange = {
      kind: 'file',
      path: 'a.test.js',
      oldPath: null,
      op: 'modify',
      before,
      after,
      binary: false,
      hunks: linearFallbackHunks(before, after),
    };
    const findings = evaluate([c], P, undefined, 'tool-call');
    expect(findings.some((f) => f.rule === 'test-skip' && f.severity === 'block')).toBe(true);
  });
});

describe('the public hook: within budget is judged in full, past budget fails closed (#517)', () => {
  function initRepo(): string {
    const cwd = gitRepo();
    writeFileSync(join(cwd, '.tamperward.yml'), 'version: 1\n');
    execFileSync('git', ['add', '-A'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd, stdio: 'pipe' });
    return cwd;
  }

  // Point 1 of the review contract: a WORST-CASE input within the ceiling is judged END TO
  // END through the real hook — every detector runs and the appended test.skip is caught by
  // test-skip, not sidestepped by a ceiling deny. The before file is SEEDED AND COMMITTED so
  // the hook reconstructs a real 3900-line before→after MODIFY (op: 'modify'), exercising
  // test-content-removal — the profiled dominant cost — and real git reconstruction, not a
  // null-before add that skips that detector. Sized just under the 4000-line / 384 KiB budget;
  // the worst such input evaluates in ~2.9 s (measured on the modify path), so the 15 s cap is
  // a MEANINGFUL process maximum — a regression toward the 30+ s stall trips it — with a ~5x
  // margin for CI slowness. The assertion is detector visibility on the costly path.
  it('a worst-case UNDER-ceiling high-churn MODIFY is judged in full — test-skip blocks the appended skip', () => {
    const cwd = initRepo();
    const { before, after } = churn(3900); // ~291 KiB per side, under the 384 KiB / 4000-line budget
    const target = join(cwd, 'big.test.js');
    writeFileSync(target, before);
    execFileSync('git', ['add', '-A'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['commit', '-qm', 'seed the churn base'], { cwd, stdio: 'pipe' });
    const r = preToolUseVerdict({ tool_name: 'Write', tool_input: { file_path: target, content: after }, cwd });
    expect(r.stdout).toContain('"deny"');
    expect(r.stdout).toContain('test-skip');
  }, 15_000);

  it('a Write PAST the reconstruction budget fails closed (deny, never a partial allow)', () => {
    const cwd = initRepo();
    const { after } = churn(20000);
    const r = preToolUseVerdict({ tool_name: 'Write', tool_input: { file_path: join(cwd, 'big.test.js'), content: after }, cwd });
    expect(r.stdout).toContain('"deny"');
    expect(r.stdout).toContain('hook budget');
  });
});

// Point 3 of the review contract: an OUTER-PROCESS, independently killable smoke test —
// not an in-process synchronous call — proving the public hook PROCESS returns a deny and
// respects a maximum. Gated on a built CLI (dist), like the repo's other built-CLI E2Es.
describe.skipIf(!existsSync(DIST) || process.platform === 'win32')('the built hook process respects a maximum (#517)', () => {
  it('a Write past the budget denies and the process exits well within a hard kill timeout', () => {
    const cwd = gitRepo();
    writeFileSync(join(cwd, '.tamperward.yml'), 'version: 1\n');
    execFileSync('git', ['add', '-A'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd, stdio: 'pipe' });

    const { after } = churn(20000);
    const input = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(cwd, 'big.test.js'), content: after }, cwd });
    // A real, killable process with a hard SIGKILL timeout. The unbounded path took 30+s;
    // a deny returned with the process exiting (status !== null, not signalled) proves it.
    const r = spawnSync('node', [DIST, 'hook', 'claude'], { input, cwd, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
    expect(r.signal).toBeNull(); // not killed by the timeout — it returned on its own
    expect(r.stdout).toContain('"deny"');
    expect(r.stdout).toContain('hook budget');
  }, 20_000);
});
