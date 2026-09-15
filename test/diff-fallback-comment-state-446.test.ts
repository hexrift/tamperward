// #446 — diff-only fallback comment/string state.
//
// The line matchers for ts-any-cast and test-skip run on added lines with no parser
// state, so a literal `as any` or a `.skip`/`.only` inside a `//` comment, inside a
// `/* … */` block comment (whose opener is on an earlier added line), or inside a
// string literal read the same as real code and fire. Each fixture here is a false
// positive that must go silent on the diff-only fallback, and the real detections
// beside it must still fire.

import { describe, expect, it } from 'vitest';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy } from '../src/policy';
import { tsAnyCast } from '../src/detectors/ts-any-cast';
import { testSkip } from '../src/detectors/test-skip';
import type { Change, Finding } from '../src/types';

const P = defaultPolicy();

const added = (path: string, ...lines: string[]): Change[] =>
  parseDiff(`diff --git a/${path} b/${path}
index 1..2 100644
--- a/${path}
+++ b/${path}
@@ -1,0 +1,${lines.length} @@
${lines.map((l) => `+${l}`).join('\n')}`);

// A single hunk mixing context (` `), additions (`+`) and deletions (`-`), so state that
// carries from an unchanged context line can be exercised.
type HunkLine = ['ctx' | 'add' | 'del', string];
const hunk = (path: string, ...ls: HunkLine[]): Change[] => {
  const oldN = ls.filter(([t]) => t !== 'add').length;
  const newN = ls.filter(([t]) => t !== 'del').length;
  const body = ls.map(([t, s]) => (t === 'ctx' ? ' ' : t === 'add' ? '+' : '-') + s).join('\n');
  return parseDiff(`diff --git a/${path} b/${path}
index 1..2 100644
--- a/${path}
+++ b/${path}
@@ -1,${oldN} +1,${newN} @@
${body}`);
};

const anyFindings = (c: Change[]): Finding[] => tsAnyCast.run(c, P);
const anyBlockC = (c: Change[]): Finding[] => anyFindings(c).filter((f) => f.rule === 'ts-any-cast' && f.severity === 'block');
const anyWarnC = (c: Change[]): Finding[] => anyFindings(c).filter((f) => f.rule === 'ts-any-launder' && f.severity === 'warn');
const anyBlock = (path: string, ...lines: string[]): Finding[] => anyBlockC(added(path, ...lines));
const skipRulesC = (c: Change[]): string[] => testSkip.run(c, P).map((f) => f.rule);
const skipRules = (path: string, ...lines: string[]): string[] => skipRulesC(added(path, ...lines));

describe('#446 · ts-any-cast diff-only fallback ignores comments and strings', () => {
  it.each([
    ['a // line comment', ['// cast it as any later']],
    ['a // comment after code', ['doThing(); // returns x as any here']],
    ['a block comment opened on an earlier added line', ['/*', 'x as any', '*/']],
    ['a block comment on one line', ['/* x as any */']],
    ['as any inside a double-quoted string', ['const s = "x as any";']],
    ['as any inside a single-quoted string', ["const s = 'x as any';"]],
    ['as any inside a template string', ['const t = `x as any`;']],
    ['an old-style <any> cast inside a comment', ['// old <any> cast']],
  ])('does not fire on %s', (_label, lines) => {
    expect(anyBlock('src/x.ts', ...lines)).toHaveLength(0);
  });

  it.each([
    ['a real as any cast', ['const v = x as any;']],
    ['a partial cast line', ['  x as any,']],
    ['real code after a closed block comment', ['/* note */ const v = x as any;']],
    ['a real old-style cast', ['const v = <any>x;']],
  ])('still fires on %s', (_label, lines) => {
    expect(anyBlock('src/x.ts', ...lines)).toHaveLength(1);
  });
});

describe('#446 · test-skip diff-only fallback ignores comments and strings', () => {
  it.each([
    ['a block comment opened on an earlier added line', ['/*', "it.skip('old')", '*/']],
    ['a block comment on one line', ["/* it.skip('old') */"]],
    ['a // line comment', ["// it.skip('old') was here"]],
    ['a // comment after code', ['run();  // switch to it.skip if flaky']],
    ['a marker inside a string', ['expect(label).toBe("it.only");']],
  ])('does not fire on %s', (_label, lines) => {
    expect(skipRules('test/x.test.ts', ...lines)).toEqual([]);
  });

  it.each([
    ['a real .skip marker', ["it.skip('x', () => {});"]],
    ['a real .only marker', ["describe.only('x', () => {});"]],
    ['a real marker after a closed block comment', ["/* note */ it.skip('x', () => {});"]],
  ])('still fires on %s', (_label, lines) => {
    expect(skipRules('test/x.test.ts', ...lines)).toEqual(['test-skip']);
  });
});

// #1 — a cast inside a `${…}` template substitution is real evaluated code, not literal
// template text: it must still be seen (the earlier masker blanked the whole template).
describe('#446(1) · ts-any-cast sees casts inside a ${…} template substitution', () => {
  it.each([
    ['as any', 'const r = `v=${value as any}`;'],
    ['as never', 'const r = `v=${value as never}`;'],
    ['double cast', 'const r = `v=${(value as unknown as T)}`;'],
    ['nested template substitution', 'const r = `a${`b${value as any}`}`;'],
  ])('blocks on %s', (_label, line) => {
    expect(anyBlock('src/x.ts', line)).toHaveLength(1);
  });

  it('a broad `: any` spelling inside a substitution warns (not blocks)', () => {
    const line = 'const r = `v=${((v: any) => v)(x)}`;';
    expect(anyBlock('src/x.ts', line)).toHaveLength(0);
    expect(anyWarnC(added('src/x.ts', line))).toHaveLength(1);
  });

  it('the template LITERAL text around the substitution is still inert', () => {
    expect(anyBlock('src/x.ts', 'const r = `x as any ${ok}`;')).toHaveLength(0);
  });
});

// #2 — string/template state carries across the change's lines, so the continuation line
// of a multi-line template is not misread as code.
describe('#446(2) · multi-line template state carries across added lines', () => {
  it('ts-any-cast: literal `as any` on a template continuation line is text', () => {
    expect(anyBlock('src/x.ts', 'const t = `', 'x as any', '`;')).toHaveLength(0);
  });

  it('ts-any-cast: a cast in a substitution that spans lines still fires', () => {
    expect(anyBlock('src/x.ts', 'const t = `v=${', 'value as any', '}`;')).toHaveLength(1);
  });

  it('test-skip: a marker on a template continuation line is text', () => {
    expect(skipRules('test/x.test.ts', 'const t = `', "it.skip('old')", '`;')).toEqual([]);
  });

  it('test-skip: a marker in a substitution that spans lines still fires', () => {
    expect(skipRules('test/x.test.ts', 'const t = `v=${', "cond ? it.skip('x', fn) : 0", '}`;')).toEqual(['test-skip']);
  });
});

// #3 — block-comment state must also come from unchanged context lines, not just additions,
// and must be conservative when the opener is outside the visible context.
describe('#446(3) · lexical state advances over unchanged hunk context', () => {
  it('ts-any-cast: an addition inside a block comment whose delimiters are context is text', () => {
    const c = hunk('src/x.ts', ['ctx', '/* explanation'], ['add', 'x as any'], ['ctx', '*/']);
    expect(anyBlockC(c)).toHaveLength(0);
  });

  it('test-skip: an addition inside a block comment whose delimiters are context is text', () => {
    const c = hunk('test/x.test.ts', ['ctx', '/* explanation'], ['add', "it.skip('old')"], ['ctx', '*/']);
    expect(skipRulesC(c)).toEqual([]);
  });

  it('deletion lines never advance the after-view lexer', () => {
    // The `/*` only ever existed on a deleted line, so the addition is real code.
    const c = hunk('src/x.ts', ['del', '/* was here'], ['add', 'const v = x as any;']);
    expect(anyBlockC(c)).toHaveLength(1);
  });

  it('conservative: a hunk that begins inside a comment whose opener is NOT in context is read as code', () => {
    // The opener lies before the hunk with no context carrying it, so the addition is
    // treated as code (the documented, no-worse-than-before boundary).
    const c = hunk('src/x.ts', ['add', 'x as any'], ['ctx', '*/']);
    expect(anyBlockC(c)).toHaveLength(1);
  });
});

// #4 — a JS regex literal containing a quote must not open a string that swallows a real
// cast/skip that follows (reuses the token-aware regex scanner from #439).
describe('#446(4) · a regex literal with a quote does not mask a following real cast/skip', () => {
  it('ts-any-cast still fires on a cast after `const re = /\'/;`', () => {
    expect(anyBlock('src/x.ts', "const re = /'/; const value = input as any;")).toHaveLength(1);
  });

  it('test-skip still fires on a marker after `const re = /\'/;`', () => {
    expect(skipRules('test/x.test.ts', "const re = /'/; it.skip('x', () => {});")).toEqual(['test-skip']);
  });

  it('control: a regex holding a quote, with no cast following, stays clean', () => {
    expect(anyBlock('src/x.ts', "const re = /['\"]/;")).toHaveLength(0);
    expect(skipRules('test/x.test.ts', "const re = /['\"]/; expect(1).toBe(1);")).toEqual([]);
  });
});
