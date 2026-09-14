// #444 — a content-triggered detector crash failed OPEN at the two agent-facing
// layers. `evaluate` emitted the fail-closed `detector-error` block only for the
// staged / worktree / range views; the Stop sweep runs the `turn` view and
// PreToolUse the `tool-call` view, so a rule that threw on repository content was
// silently dropped exactly where the agent meets the gate. A spec beginning with
// `const deep = [[[…30 000 deep…]]];` made `test-skip`, `test-deletion` and
// `test-content-removal` throw `RangeError` — 0 findings, allow — while the same
// content was `block:detector-error` at pre-commit.
//
// Two fixes, both here:
//   1. every view fails closed on a thrown detector — `turn`, `tool-call`, and a
//      caller that names no view — and the hook's deny channel carries the block;
//   2. every `ts.createSourceFile` goes through one guarded helper with a size and
//      a nesting ceiling that DECLINES (null) instead of throwing, so the rule's
//      regex fallback still judges the content: the fixture is blocked by
//      `test-skip`, not by `detector-error`, at PreToolUse, at Stop and at `staged`.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate } from '../src/engine';
import { allDetectors } from '../src/detectors';
import { preToolUseVerdict, stopVerdict, HookResult } from '../src/cli/hook';
import { runCheck } from '../src/cli/check';
import { diffStaged } from '../src/git/build';
import { defaultPolicy } from '../src/policy';
import type { Detector, FileChange } from '../src/types';

const P = defaultPolicy();
const DEPTH = 30_000;
const DEEP = 'const deep = ' + '['.repeat(DEPTH) + ']'.repeat(DEPTH) + ';\n';
const SPEC = `it('one', () => { expect(1).toBe(1); });\nit('two', () => { expect(2).toBe(2); });\n`;
const TAMPERED = DEEP + SPEC + `it.skip('three', () => { expect(3).toBe(3); });\n`;
const POLICY = "version: 1\nprotected:\n  tests: ['test/**/*.test.ts']\n";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-444-'));
  dirs.push(d);
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 't@b');
  git(d, 'config', 'user.name', 'tb');
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'test', 'a.test.ts'), SPEC);
  writeFileSync(join(d, '.tamperward.yml'), POLICY);
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'seed');
  return d;
}
function silenced<T>(fn: () => T): T {
  const w = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  (process.stdout as any).write = () => true;
  (process.stderr as any).write = () => true;
  try {
    return fn();
  } finally {
    (process.stdout as any).write = w;
    (process.stderr as any).write = e;
  }
}
const modified = (path: string, before: string, after: string): FileChange => ({
  kind: 'file', path, oldPath: null, op: 'modify', before, after, binary: false, hunks: [],
});
const denial = (r: HookResult): string => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason : '');
const stopReason = (r: HookResult): string => (r.stdout ? JSON.parse(r.stdout).reason : '');

/** Make one shipped detector throw for the duration of `fn`, the way repository
 *  content can make one throw, so the ADAPTER path is exercised end to end. */
function withThrowing<T>(id: string, fn: () => T): T {
  const d: Detector | undefined = allDetectors.find((x) => x.id === id);
  if (!d) throw new Error(`no detector ${id}`);
  const run = d.run;
  d.run = () => {
    throw new Error('content-triggered crash');
  };
  try {
    return silenced(fn);
  } finally {
    d.run = run;
  }
}

// ── 1 · no view silently drops a rule ────────────────────────────────────────
describe('1 · a thrown detector fails CLOSED at every view', () => {
  const boom: Detector = { id: 'boom', surface: ['file'], certainty: 'mechanical', run: () => { throw new Error('x'); } };
  it.each([['turn'], ['tool-call'], ['staged'], ['worktree'], ['range']] as const)('view %s → block:detector-error', (view) => {
    const f = silenced(() => evaluate([modified('src/x.ts', 'a', 'b')], P, [boom], view));
    expect(f.map((x) => `${x.severity}:${x.rule}`)).toEqual(['block:detector-error']);
    expect(f[0].message).toContain('"boom"');
  });
  it('a caller that names no view fails closed too', () => {
    const f = silenced(() => evaluate([modified('src/x.ts', 'a', 'b')], P, [boom]));
    expect(f.map((x) => x.rule)).toEqual(['detector-error']);
  });

  it('PreToolUse: a detector that throws on the payload is a DENY, never a silent allow', () => {
    const cwd = repo();
    const r = withThrowing('no-verify', () =>
      preToolUseVerdict({ tool_name: 'Bash', cwd, session_id: 's1', tool_input: { command: 'echo ok' } }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('"deny"');
    expect(denial(r)).toContain('detector-error');
    expect(denial(r)).toContain('no-verify');
  });

  it('Stop: a detector that throws on the turn is a BLOCK carried on the deny channel', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'test', 'a.test.ts'), SPEC + `it('three', () => { expect(3).toBe(3); });\n`);
    const r = withThrowing('test-skip', () => stopVerdict({ cwd, session_id: 's1' }));
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).decision).toBe('block');
    expect(stopReason(r)).toContain('detector-error');
    expect(stopReason(r)).toContain('test-skip');
  });
});

// ── 2 · the parser guard: a ceiling that declines instead of throwing ─────────
type Guard = {
  parseSource: (fileName: string, src: string) => { statements: unknown[] } | null;
  MAX_PARSE_BYTES: number;
  MAX_PARSE_DEPTH: number;
};
function isGuard(m: unknown): m is Guard {
  return (
    typeof m === 'object' && m !== null &&
    typeof Reflect.get(m, 'parseSource') === 'function' &&
    typeof Reflect.get(m, 'MAX_PARSE_BYTES') === 'number' &&
    typeof Reflect.get(m, 'MAX_PARSE_DEPTH') === 'number'
  );
}
async function guard(): Promise<Guard> {
  const m: unknown = await import('../src/ts-lazy');
  if (!isGuard(m)) throw new Error('src/ts-lazy exports no parseSource / MAX_PARSE_BYTES / MAX_PARSE_DEPTH');
  return m;
}

describe('2 · parseSource: one guarded entry to ts.createSourceFile', () => {
  it('parses ordinary source', async () => {
    const g = await guard();
    const sf = g.parseSource('a.spec.ts', SPEC);
    expect(sf).not.toBeNull();
    expect(sf?.statements.length).toBe(2);
  });

  it('nesting AT the ceiling parses; one level past it declines', async () => {
    const g = await guard();
    const nest = (n: number): string => 'const deep = ' + '['.repeat(n) + ']'.repeat(n) + ';\n';
    expect(g.parseSource('a.spec.ts', nest(g.MAX_PARSE_DEPTH))).not.toBeNull();
    expect(g.parseSource('a.spec.ts', nest(g.MAX_PARSE_DEPTH + 1))).toBeNull();
  });

  it('the 30 000-deep fixture declines (null) and does NOT throw', async () => {
    const g = await guard();
    expect(() => g.parseSource('a.spec.ts', TAMPERED)).not.toThrow();
    expect(g.parseSource('a.spec.ts', TAMPERED)).toBeNull();
  });

  it('size AT the ceiling parses; one byte past it declines', async () => {
    const g = await guard();
    const line = '// x\n';
    let atCeiling = line.repeat(Math.floor(g.MAX_PARSE_BYTES / line.length));
    atCeiling += ' '.repeat(g.MAX_PARSE_BYTES - Buffer.byteLength(atCeiling));
    expect(Buffer.byteLength(atCeiling)).toBe(g.MAX_PARSE_BYTES);
    expect(g.parseSource('a.spec.ts', atCeiling)).not.toBeNull();
    expect(g.parseSource('a.spec.ts', atCeiling + ' ')).toBeNull();
  });

  it('the ceiling counts bytes, not code units', async () => {
    const g = await guard();
    const s = '// ' + 'é'.repeat(g.MAX_PARSE_BYTES / 2); // 2 bytes each: past the ceiling in bytes, under it in length
    expect(s.length).toBeLessThan(g.MAX_PARSE_BYTES);
    expect(g.parseSource('a.spec.ts', s)).toBeNull();
  });
});

// ── 3 · the fixture is blocked by the REGEX path at all three views ───────────
describe('3 · 30 000-deep array + it.skip: blocked by test-skip, not by detector-error', () => {
  const rulesOf = (reason: string): string[] => ['test-skip', 'detector-error', 'tamperward-unavailable'].filter((r) => reason.includes(r));

  it('PreToolUse Write → deny naming test-skip', () => {
    const cwd = repo();
    const r = silenced(() =>
      preToolUseVerdict({ tool_name: 'Write', cwd, session_id: 's1', tool_input: { file_path: join(cwd, 'test', 'a.test.ts'), content: TAMPERED } }),
    );
    expect(r.stdout).toContain('"deny"');
    expect(rulesOf(denial(r))).toEqual(['test-skip']);
  });

  it('PreToolUse Edit → deny naming test-skip', () => {
    const cwd = repo();
    const r = silenced(() =>
      preToolUseVerdict({
        tool_name: 'Edit', cwd, session_id: 's1',
        tool_input: { file_path: join(cwd, 'test', 'a.test.ts'), old_string: "it('one'", new_string: DEEP + "it.skip('zero', () => {});\nit('one'" },
      }),
    );
    expect(r.stdout).toContain('"deny"');
    expect(rulesOf(denial(r))).toEqual(['test-skip']);
  });

  it('Stop → block naming test-skip', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'test', 'a.test.ts'), TAMPERED);
    const r = silenced(() => stopVerdict({ cwd, session_id: 's1' }));
    expect(JSON.parse(r.stdout).decision).toBe('block');
    expect(rulesOf(stopReason(r))).toEqual(['test-skip']);
  });

  it('staged → test-skip, and `check --staged` exits 1', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'test', 'a.test.ts'), TAMPERED);
    git(cwd, 'add', '-A');
    const f = silenced(() => evaluate(diffStaged({ cwd }), P, undefined, 'staged', { cwd }));
    const rules = f.map((x) => x.rule);
    expect(rules).toContain('test-skip');
    expect(rules).not.toContain('detector-error');
    expect(silenced(() => runCheck({ staged: true, cwd }))).toBe(1);
  });

  it('the honest neighbour: the same deep literal with no skip is clean at every view', () => {
    const cwd = repo();
    const honest = DEEP + SPEC;
    const r = silenced(() =>
      preToolUseVerdict({ tool_name: 'Write', cwd, session_id: 's1', tool_input: { file_path: join(cwd, 'test', 'a.test.ts'), content: honest } }),
    );
    expect(r).toEqual({ exitCode: 0, stdout: '' });
    writeFileSync(join(cwd, 'test', 'a.test.ts'), honest);
    expect(silenced(() => stopVerdict({ cwd, session_id: 's1' }))).toEqual({ exitCode: 0, stdout: '' });
    git(cwd, 'add', '-A');
    expect(silenced(() => evaluate(diffStaged({ cwd }), P, undefined, 'staged', { cwd })).filter((x) => x.severity === 'block')).toEqual([]);
  });
});
