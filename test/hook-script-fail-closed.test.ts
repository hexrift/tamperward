// A hand-written protected hook script is held BYTE-EQUAL to its before, modulo a
// pin raise; every other edit is hook-tampering and needs a sign-off. The verdict
// of the third adversarial pass over the liveness model: with the model rebuilt
// after pass two, thirteen more shapes ran a failing gate to exit 0 under a real
// `sh -e` and a real direct exec while the model read the gate as live — inner
// groups, multi-line groups, `exit 0` inside a brace, a trap by function name,
// a `PATH=` line, `--diff HEAD...HEAD`, `[ -d . ]` in an `if`, a multi-line
// string, `& wait`. A line-by-line reading of a shell script cannot be sound, so
// it is no longer the verdict. It stays as EVIDENCE: when it names a mechanism,
// the finding carries it, so the human signing off sees what changed.
//
//   1  every evasion of the pass-3b e-table blocks (detector); the model's
//      reading of the cheap, clear ones was fixed (T5 T6 T7 T11 T14)
//   2  every honest shape of the h-table blocks too, with the "changed; sign
//      off" reason — and clears with the out-of-band sign-off
//   3  the two clean edits: a pin raise, a trailing newline
//   4  a new script must run the gate live; a deleted one stays the removal
//   5  lefthook / pre-commit: mode flag, `env`, `args`, `^1` by the comparator
//   6  the init shape: a double trailing newline is a single one
//   7  end to end through the BUILT CLI on a scratch repository
//   8  the "Held" list of the report, re-run

import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from 'vitest';
import { buildSync } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookTampering } from '../src/detectors/hook-tampering';
import { checkIdentity, gateOf, invocations, lefthookWeakening, parseDoc, pinRaiseOnly, preCommitWeakening, scriptWeakening } from '../src/detectors/hook-wiring';
import { synthFileChange } from '../src/adapters/claude/changes';
import { defaultPolicy } from '../src/policy';
import { parsePolicy } from '../src/policy-load';
import { oobFromEnv } from '../src/signoff';
import { MARKER, TW_VERSION, initScriptPin } from '../src/wiring';
import type { Change, FileChange, Finding } from '../src/types';

// Section 7 spawns the built CLI many times over fresh repositories.
vi.setConfig({ testTimeout: 30_000 });

const P = defaultPolicy();
const V = TW_VERSION;
const G = 'npx tamperward check --staged';
const HAND = `#!/bin/sh\n${G}\n`;
const sh = (body: string): string => `#!/bin/sh\n${body}\n`;
const edit = (path: string, before: string, after: string): Change[] => synthFileChange(path, before, after);
const file = (path: string, before: string | null, after: string | null, op: FileChange['op']): FileChange => ({
  kind: 'file', path, oldPath: null, op, before, after, binary: false, hunks: [],
});
const run = (c: Change[]) => hookTampering.run(c, P);
const msgs = (c: Change[]) => run(c).map((f) => f.message);
const CHANGED = /the gate script changed; sign off/;
const husky = { errexit: true };

/** The pass-3b e-table, verbatim: each ran a failing gate to exit 0 under husky's
 *  `sh -e` and/or git's direct exec while the 2.7.0 model read it as live. The
 *  mechanism regex is what the model reads NOW, where it reads anything. */
const EVASIONS: Array<[string, string, RegExp | null]> = [
  ['e30 ( G || true )', sh(`( ${G} || true )`), null],
  ['e31 { G || true; }', sh(`{ ${G} || true; }`), null],
  ['e33 multi-line { } || true', sh(`{\n  ${G}\n} || true`), null],
  ['e34 multi-line ( ) || true', sh(`(\n  ${G}\n) || true`), null],
  ['e35 multi-line { } | tee', sh(`{\n  ${G}\n} | tee /dev/null`), null],
  ['e27 || { echo; exit 0; } before', sh(`command -v nope >/dev/null 2>&1 || { echo skip; exit 0; }\n${G}`), null],
  ['e28 || exec true before', sh(`command -v nope >/dev/null 2>&1 || exec true\n${G}`), null],
  ['e29 { exit 0; } before', sh(`{ exit 0; }\n${G}`), null],
  ['e44 [ -z "$CI" ] && { exit 0; }', sh(`[ -z "$CI" ] && { exit 0; }\n${G}`), null],
  ['e09 trap by function name', sh(`done_ok() { exit 0; }\ntrap done_ok EXIT\n${G}`), null],
  ['e10 trap \'exit $OK\' with OK=0', sh(`OK=0\ntrap 'exit $OK' EXIT\n${G}`), null],
  ['e22 command() { :; }', sh(`command() { :; }\ncommand ${G}`), /`command` is redefined/],
  ['e23 env() { :; }', sh(`env() { :; }\nenv ${G}`), /`env` is redefined/],
  ['e24 alias command=:', sh(`alias command=:\ncommand ${G}`), /`command` is redefined/],
  ['e26 PATH= line', sh(`PATH="$(dirname "$0")/bin:$PATH"\n${G}`), /runtime redirected/],
  ['e51 PATH= prefix', sh(`PATH=/tmp/bin:$PATH ${G}`), /runtime redirected — `PATH=`/],
  ['e52 PATH= then export', sh(`PATH="$(dirname "$0")/bin:$PATH"\nexport PATH\n${G}`), /runtime redirected/],
  ['e42 NODE_OPTIONS= prefix', sh(`NODE_OPTIONS="--require $PWD/ok.js" ${G}`), /runtime redirected — `NODE_OPTIONS=`/],
  ['e39 --diff HEAD...HEAD', sh('npx tamperward check --diff HEAD...HEAD'), /replaced by `tamperward check --diff HEAD\.\.\.HEAD`/],
  ['e53 --worktree', sh('npx tamperward check --worktree'), /replaced by `tamperward check --worktree`/],
  ['e14 else after [ -d . ]', sh(`if [ -d . ]; then true; else ${G}; fi`), null],
  ['e15 else after true && true', sh(`if true && true; then :; else ${G}; fi`), null],
  ['e16 until [ -d . ]', sh(`until [ -d . ]; do ${G}; done`), null],
  ['e17 while [ ! -d . ]', sh(`while [ ! -d . ]; do ${G}; break; done`), null],
  ['e18 for over an empty variable', sh(`NOTHING=\nfor f in $NOTHING; do ${G}; done`), null],
  ['e19 for over "$@"', sh(`for f in "$@"; do ${G}; done`), null],
  ['e20 [ $# -eq 0 ] ||', sh(`[ $# -eq 0 ] || ${G}`), null],
  ['e36 multi-line string', sh(`MSG="usage:\n${G}\n"\necho "$MSG" >/dev/null`), null],
  ["e37 : '…' block", sh(`: '\n${G}\n'`), null],
  ['e38 || exit "$rc" with rc=0', sh(`rc=0\n[ -n "$CI" ] || exit "$rc"\n${G}`), null],
  ['e50 G & wait', sh(`${G} & wait`), /run in the background — a `wait` without its pid/],
  ['e21 two heredocs on one line', sh(`cat <<A <<B\nA\n${G}\nB`), null],
  ['e12 case "" in ?)', sh(`case "" in ?) ${G};; esac`), null],
  ['e13 case a in [b])', sh(`case a in [b]) ${G};; esac`), null],
  ['e32 ( G; true )', sh(`( ${G}; true )`), null],
  ['e05 ( G ) then true', sh(`( ${G} )\ntrue`), null],
  ['e41 function defined after the call', sh(`run\nrun() { ${G}; }`), null],
];

/** The h-table: honest shapes the 2.7.0 model read live (or, for the FP rows,
 *  wrongly neutered). Each is now a sign-off — the rule is byte-equal. */
const HONEST: Array<[string, string]> = [
  ['h09 if ! G; then exit 1; fi', sh(`if ! ${G}; then exit 1; fi`)],
  ['h35 if G; then :; else exit 1; fi', sh(`if ${G}; then :; else exit 1; fi`)],
  ['h28 || rc=$? then exit $rc', sh(`rc=0\n${G} || rc=$?\nexit $rc`)],
  ['h29 || fail=1 then [ -z "$fail" ] || exit 1', sh(`npm test || fail=1\n${G} || fail=1\n[ -z "$fail" ] || exit 1`)],
  ["h05 trap 'true' EXIT", sh(`trap 'true' EXIT\n${G}`)],
  ["h06 trap 'exit' EXIT", sh(`trap 'exit' EXIT\n${G}`)],
  ['h10 G & then wait $!', sh(`${G} &\nwait $!`)],
  ['h43 ( cd bin && true ) before', sh(`( cd bin && true )\n${G}`)],
  ['h22 --cwd "$(git rev-parse --show-toplevel)"', sh(`${G} --cwd "$(git rev-parse --show-toplevel)"`)],
  ['h19 node node_modules/tamperward/dist/cli/index.js', sh('node node_modules/tamperward/dist/cli/index.js check --staged')],
  ['h21 ./node_modules/.bin/tamperward', sh('./node_modules/.bin/tamperward check --staged')],
  ['h40 run() ( G ) then run', sh(`run() ( ${G} )\nrun`)],
  ['h02 rc=$? capture', sh(`${G}; rc=$?; [ $rc -eq 0 ] || exit $rc`)],
  ['h01 || { echo; exit 1; }', sh(`${G} || { echo failed; exit 1; }`)],
  ['h03 set -e then true after', sh(`set -e\n${G}\ntrue`)],
  ['h16 pnpm dlx with a pin', sh(`pnpm dlx tamperward@${V} check --staged`)],
  ['h20 bare tamperward', sh('tamperward check --staged')],
  ['h24 cd toplevel && G', sh(`cd "$(git rev-parse --show-toplevel)" && ${G}`)],
  ['h36 CI=1 prefix', sh(`CI=1 ${G}`)],
  ['h42 exec G', sh(`exec ${G}`)],
  ['h46 a function that calls the gate', sh(`run_checks() {\n  ${G}\n}\nrun_checks`)],
  ['h47 a linter after the gate', sh(`${G}\nnpx lint-staged`)],
  ['a comment line added', sh(`# the gate\n${G}`)],
  ['npx → pnpm exec', sh('pnpm exec tamperward check --staged')],
  ['CRLF line endings', HAND.replace(/\n/g, '\r\n')],
  ['a doubled space', sh('npx tamperward check  --staged')],
];

// ── 1 · the e-table blocks, and the model names what it can ──────────────────
describe('1 · every evasion of the report blocks, on a husky script and on a git-exec\'ed one', () => {
  const own = parsePolicy({ protected: { hooks: ['.githooks/**'] } });
  it.each(EVASIONS)('%s', (_n, after, mechanism) => {
    for (const [path, policy] of [['.husky/pre-commit', P], ['.githooks/pre-commit', own]] as const) {
      const f = hookTampering.run(edit(path, HAND, after), policy);
      expect(f.length, path).toBe(1);
      expect(f[0].severity).toBe('block');
      expect(f[0].evidence).toMatch(CHANGED);
      expect(f[0].message).toMatch(/hand-written protected hook script was changed/);
      if (mechanism) expect(f[0].message, path).toMatch(mechanism);
    }
  });

  it('T5 · the wrapper words in front of the command are tested against the script\'s own functions and aliases', () => {
    for (const w of ['command', 'env', 'exec', 'nice', 'time']) {
      expect(scriptWeakening([G], [`${w}() { :; }`, `${w} ${G}`], husky)[0]?.reason, w).toMatch(new RegExp(`\`${w}\` is redefined`));
      expect(scriptWeakening([G], [`alias ${w}=:`, `${w} ${G}`], husky)[0]?.reason, w).toMatch(/redefined/);
    }
    // a function of the same name that is never in front of the gate is not shadowing it
    expect(scriptWeakening([G], ['command() { :; }', G], husky)).toEqual([]);
  });

  it('T6 · an assignment to PATH, NODE_OPTIONS, NODE_PATH, npm_config_*, HOME, LD_PRELOAD or BASH_ENV before or on the gate redirects its runtime', () => {
    for (const name of ['PATH', 'NODE_OPTIONS', 'NODE_PATH', 'npm_config_registry', 'NPM_CONFIG_PREFIX', 'HOME', 'LD_PRELOAD', 'BASH_ENV']) {
      expect(scriptWeakening([G], [`${name}=/tmp/x ${G}`], husky)[0]?.reason, `${name} prefix`).toMatch(/runtime redirected/);
      expect(scriptWeakening([G], [`${name}=/tmp/x`, G], husky)[0]?.reason, `${name} line`).toMatch(/runtime redirected/);
      expect(scriptWeakening([G], [`export ${name}=/tmp/x`, G], husky)[0]?.reason, `export ${name}`).toMatch(/runtime redirected/);
    }
    expect(scriptWeakening([G], [`env PATH=/tmp/x ${G}`], husky)[0]?.reason).toMatch(/runtime redirected/);
    expect(scriptWeakening([G], ['setup() { PATH=/tmp/x:$PATH; }', 'setup', G], husky)[0]?.reason).toMatch(/runtime redirected/);
    // an assignment the gate does not resolve through, or one inside a quoted value, is not
    expect(scriptWeakening([G], [`CI=1 ${G}`], husky)).toEqual([]);
    expect(scriptWeakening([G], ['FORCE_COLOR=1', G], husky)).toEqual([]);
    expect(scriptWeakening([G], [`MSG="PATH=x" ${G}`], husky)).toEqual([]);
  });

  it('T7 · the mode flag is identity: a `--staged` → `--diff` / `--worktree` swap is a replacement', () => {
    expect(checkIdentity(G)).toBe('tamperward check --staged');
    expect(checkIdentity('npx tamperward check --diff HEAD...HEAD')).toBe('tamperward check --diff HEAD...HEAD');
    expect(checkIdentity('npx tamperward check --diff=origin/main...HEAD')).toBe('tamperward check --diff origin/main...HEAD');
    expect(checkIdentity('npx tamperward check --worktree')).toBe('tamperward check --worktree');
    expect(checkIdentity('npx tamperward check')).toBe('tamperward check');
    expect(checkIdentity(`${G} --cwd /tmp`)).toBe('tamperward check --staged --cwd /tmp');
    expect(checkIdentity(`{ ${G}; }`)).toBe('tamperward check --staged');
    expect(checkIdentity(`OUT=$(${G})`)).toBe('tamperward check --staged');
    // the repository root spelled as a substitution is where the gate runs anyway
    expect(checkIdentity(`${G} --cwd "$(git rev-parse --show-toplevel)"`)).toBe('tamperward check --staged');
    expect(scriptWeakening([G], ['npx tamperward check --diff HEAD...HEAD'], husky)[0].reason).toMatch(/replaced by `tamperward check --diff HEAD\.\.\.HEAD`/);
    expect(scriptWeakening([G], ['npx tamperward check --worktree'], husky)[0].reason).toMatch(/replaced by `tamperward check --worktree`/);
    expect(scriptWeakening([G], [`${G} --cwd "$(git rev-parse --show-toplevel)"`], husky)).toEqual([]);
  });

  it('T11 · a single `&` is an operator: `& wait` returns 0, `& wait $!` returns the gate\'s status', () => {
    expect(scriptWeakening([G], [`${G} & wait`], husky)[0].reason).toMatch(/a `wait` without its pid/);
    expect(scriptWeakening([G], [`${G} & wait; echo done`], husky)[0].reason).toMatch(/background/);
    expect(scriptWeakening([G], [`${G} &`, 'wait'], husky)[0].reason).toMatch(/background/);
    expect(scriptWeakening([G], [`${G} & wait $!`], husky)).toEqual([]);
    expect(scriptWeakening([G], [`${G} & wait "$!"`], husky)).toEqual([]);
    expect(scriptWeakening([G], [`${G} &`, 'wait $!'], husky)).toEqual([]);
    expect(scriptWeakening([G], [`${G} &`, 'wait $!'], {})).toEqual([]); // direct exec: `wait $!` is the last status
    // the `&` of a redirection is not an operator
    expect(invocations([`${G} 2>&1`], husky)[0].state).toBe('live');
    expect(invocations([`${G} >/dev/null 2>&1`], husky)[0].state).toBe('live');
    expect(invocations([`${G} &>/dev/null`], husky)[0].state).toBe('live');
    expect(invocations([`echo x 2>&1 && ${G}`], husky)[0].state).toBe('live');
  });

  it('T14 · a pin that is no longer a plain version after a plain-pinned before is a lowering', () => {
    const pinned = 'npx --yes tamperward@2.5.0 check --staged';
    for (const pin of ['^1', '~2', 'latest', 'next', '2.5.0-rc.1', '>=1', '1.x']) {
      const r = scriptWeakening([pinned], [`npx --yes tamperward@${pin} check --staged`], husky);
      expect(r.length, pin).toBe(1);
      expect(r[0].reason).toMatch(/not a plain version/);
    }
    expect(scriptWeakening([pinned], ['npx --yes tamperward@2.1.0 check --staged'], husky)[0].reason).toMatch(/lowered from 2\.5\.0 to 2\.1\.0/);
    expect(scriptWeakening([pinned], ['npx --yes tamperward@2.6.0 check --staged'], husky)).toEqual([]);
    // an unpinned before sets no floor
    expect(scriptWeakening([G], ['npx --yes tamperward@^1 check --staged'], husky)).toEqual([]);
  });
});

// ── 2 · honest shapes block with the sign-off reason ─────────────────────────
describe('2 · every honest shape of the report is a sign-off now, with the reason saying so', () => {
  it.each(HONEST)('%s', (_n, after) => {
    const f = run(edit('.husky/pre-commit', HAND, after));
    expect(f.length).toBe(1);
    expect(f[0].severity).toBe('block');
    expect(f[0].evidence).toMatch(CHANGED);
    expect(f[0].evidence).toContain('tamperward allow hook-tampering --file .husky/pre-commit');
    expect(f[0].evidence).toContain('tamperward:allow:hook-tampering@<head-sha>');
    expect(f[0].signoff.required).toBe(true);
  });

  it('the model\'s reading is the detail, not the verdict: honest shapes it reads live say so, and silence is not clearance', () => {
    // read live by the model: the message carries no mechanism, only the rule
    const live = msgs(edit('.husky/pre-commit', HAND, sh(`${G}\nnpx lint-staged`)));
    expect(live[0]).toMatch(/changed: an edit other than a pin raise\./);
    // read neutered by the model (a false reading — h28 is honest): the mechanism rides along for the human
    const read = msgs(edit('.husky/pre-commit', HAND, sh(`rc=0\n${G} || rc=$?\nexit $rc`)));
    expect(read[0]).toMatch(/changed: the check invocation `tamperward check --staged` was neutralised in place/);
  });
});

// ── 3 · the two clean edits ──────────────────────────────────────────────────
describe('3 · a pin raise and a trailing newline are the only edits that pass', () => {
  const pinned = (v: string) => sh(`npx --yes tamperward@${v} check --staged`);

  it.each([
    ['the pin raised to the judging gate', pinned('2.1.0'), pinned(V)],
    ['the pin raised below the judging gate', pinned('2.1.0'), pinned('2.2.0')],
    ['an unpinned invocation pinned', HAND, sh(`npx tamperward@${V} check --staged`)],
    ['the trailing newline dropped', HAND, HAND.trimEnd()],
    ['a second trailing newline', HAND, HAND + '\n'],
    ['a pin raise and a trailing newline', pinned('2.1.0'), pinned(V).trimEnd()],
    ['two invocations, both raised', sh(`${pinned('2.1.0').trim().split('\n')[1]}\n${pinned('2.1.0').trim().split('\n')[1]}`), sh(`${pinned(V).trim().split('\n')[1]}\n${pinned(V).trim().split('\n')[1]}`)],
  ])('clean · %s', (_n, before, after) => {
    expect(pinRaiseOnly(before, after)).toBe(true);
    expect(msgs(edit('.husky/pre-commit', before, after))).toEqual([]);
  });

  it.each([
    ['the pin lowered', pinned('2.5.0'), pinned('2.1.0'), /lowered/],
    ['the pin raised above the judging gate', pinned('2.1.0'), pinned('99.0.0'), /pin raise/],
    ['the pin removed', pinned('2.5.0'), HAND, /pin raise/],
    ['a range', pinned('2.5.0'), pinned('^1'), /not a plain version/],
    ['a tag', pinned('2.5.0'), pinned('latest'), /not a plain version/],
    ['a pre-release', pinned('2.5.0'), pinned(`${V}-rc.1`), /not a plain version/],
    ['one of two invocations lowered', sh(`npx tamperward@2.5.0 check --staged\nnpx tamperward@2.5.0 check --staged`), sh(`npx tamperward@${V} check --staged\nnpx tamperward@2.1.0 check --staged`), /lowered/],
    ['CRLF with the pin raised', pinned('2.1.0'), pinned(V).replace(/\n/g, '\r\n'), /pin raise/],
    ['the pin raised and a comment added', pinned('2.1.0'), `#!/bin/sh\n# gate\nnpx --yes tamperward@${V} check --staged\n`, /pin raise/],
  ])('sign-off · %s', (_n, before, after, re) => {
    expect(pinRaiseOnly(before, after)).toBe(false);
    const f = run(edit('.husky/pre-commit', before, after));
    expect(f.length).toBe(1);
    expect(f[0].evidence).toMatch(CHANGED);
    expect(f[0].message).toMatch(re);
  });

  it('a hunk-only view (no full content) is held to the same rule over its removed and added lines', () => {
    const d = (minus: string, plus: string): Change[] => [{
      kind: 'file', path: '.husky/pre-commit', oldPath: null, op: 'modify', before: null, after: null, binary: false,
      hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: [{ type: 'del', content: minus, oldLine: 2, newLine: null }, { type: 'add', content: plus, oldLine: null, newLine: 2 }] }],
    } as unknown as FileChange];
    expect(msgs(d('npx tamperward@2.1.0 check --staged', `npx tamperward@${V} check --staged`))).toEqual([]);
    expect(run(d(G, `${G} || true`))[0].evidence).toMatch(CHANGED);
    // a mode-only change carries no hunks and is not an edit
    expect(run([{ ...file('.husky/pre-commit', null, null, 'modify'), oldMode: '100755', newMode: '100755' }])).toEqual([]);
  });
});

// ── 4 · a new script, a deleted script ───────────────────────────────────────
describe('4 · a new hand-written script must run the gate live; a deleted one stays the removal', () => {
  it.each([
    ['the gate alone', HAND],
    ['the gate with a linter', sh(`npx lint-staged\n${G}`)],
    ['the init shape', `#!/bin/sh\n${MARKER}\nnpx --yes tamperward@${V} check --staged\n`],
    ['the gate in a function that is called', sh(`run() {\n  ${G}\n}\nrun`)],
    ['the gate under pnpm', sh('pnpm exec tamperward check --staged')],
  ])('clean · a new script with %s', (_n, after) => {
    expect(msgs([file('.husky/pre-commit', null, after, 'add')])).toEqual([]);
  });

  it.each([
    ['no gate at all', sh('npx lint-staged'), /runs no `tamperward check`/],
    ['the gate || true', sh(`${G} || true`), /neutered/],
    ['the gate in a function nobody calls', sh(`run() { ${G}; }`), /unreachable/],
    ['the gate commented out', sh(`# ${G}`), /comment/],
    ['the gate behind a PATH= line', sh(`PATH=/tmp/x:$PATH\n${G}`), /runtime redirected/],
    ['an exit 0 before the gate', sh(`exit 0\n${G}`), /unreachable/],
  ])('sign-off · a new script with %s', (_n, after, re) => {
    const f = run([file('.husky/pre-commit', null, after, 'add')]);
    expect(f.length).toBe(1);
    expect(f[0].message).toMatch(/hook script was added that does not run the gate live/);
    expect(f[0].evidence).toMatch(/a hook script was added; sign off/);
    expect(f[0].message).toMatch(re);
  });

  it('a new script in --diff mode is live (the gate runs) — the mode is the author\'s choice on a NEW hook', () => {
    // `--diff` in a pre-push hook is the right mode; a new script carries no before to compare it to
    expect(msgs([file('.husky/pre-push', null, sh('npx tamperward check --diff origin/main...HEAD'), 'add')])).toEqual([]);
  });

  it('a new git-exec\'ed script keeps the interpreter check', () => {
    const own = parsePolicy({ protected: { hooks: ['.githooks/**'] } });
    const f = hookTampering.run([file('.githooks/pre-commit', null, `#!/bin/echo\n${G}\n`, 'add')], own);
    expect(f.length).toBe(1);
    expect(f[0].message).toMatch(/the shebang runs/);
  });

  it('a deleted protected script is the removal finding it was', () => {
    const f = run([file('.husky/pre-commit', HAND, null, 'delete')]);
    expect(f.length).toBe(1);
    expect(f[0].message).toMatch(/was deleted/);
  });
});

// ── 5 · lefthook / pre-commit / package.json identity ────────────────────────
describe('5 · lefthook and pre-commit entries: the mode flag, `env`, `args` and the pin are the command\'s identity', () => {
  const LH = (run: string, extra = ''): string => `pre-commit:\n  commands:\n    tamperward:\n      run: ${run}\n${extra}    lint:\n      run: npx eslint .\n`;
  const PC = (entry: string, extra = ''): string => `repos:\n  - repo: local\n    hooks:\n      - id: tamperward\n        name: tamperward\n        entry: ${entry}\n        language: system\n        pass_filenames: false\n${extra}`;
  const PINNED = 'npx --yes tamperward@2.5.0 check --staged';
  const lh = (before: string, after: string) => lefthookWeakening(parseDoc(before)!, parseDoc(after)!);
  const pc = (before: string, after: string) => preCommitWeakening(parseDoc(before)!, parseDoc(after)!);

  it('gateOf reads identity and pin from a command string', () => {
    expect(gateOf(PINNED)).toEqual({ identity: 'tamperward check --staged', pin: '2.5.0' });
    expect(gateOf('npx tamperward check --diff HEAD...HEAD')).toEqual({ identity: 'tamperward check --diff HEAD...HEAD', pin: '' });
    expect(gateOf(`${G} || true`)).toBeNull();
    expect(gateOf('npx tamperward --version')).toBeNull();
  });

  it.each([
    ['run: … --diff HEAD...HEAD', LH('npx --yes tamperward@2.5.0 check --diff HEAD...HEAD'), /now runs `tamperward check --diff HEAD\.\.\.HEAD` instead of `tamperward check --staged`/],
    ['run: … --worktree', LH('npx --yes tamperward@2.5.0 check --worktree'), /instead of `tamperward check --staged`/],
    ['run: … --cwd /tmp', LH(`${PINNED} --cwd /tmp`), /--cwd \/tmp/],
    ['env: NODE_OPTIONS', LH(PINNED, '      env:\n        NODE_OPTIONS: --require /tmp/ok.js\n'), /sets NODE_OPTIONS in its `env`/],
    ['env: PATH', LH(PINNED, '      env:\n        PATH: /tmp/bin\n'), /sets PATH/],
    ['env: npm_config_registry', LH(PINNED, '      env:\n        npm_config_registry: http://evil.invalid\n'), /npm_config_registry/],
    ['the pin to ^1', LH('npx --yes tamperward@^1 check --staged'), /not a plain version \(was 2\.5\.0\)/],
    ['the pin to latest', LH('npx --yes tamperward@latest check --staged'), /not a plain version/],
    ['the pin lowered', LH('npx --yes tamperward@2.1.0 check --staged'), /lowered the gate's pin from 2\.5\.0 to 2\.1\.0/],
    ['a PATH= prefix in run', LH(`PATH=/tmp/bin:$PATH ${PINNED}`), /no longer runs `tamperward check` live/],
  ])('lefthook: %s', (_n, after, re) => {
    const r = lh(LH(PINNED), after);
    expect(r.length, r.join()).toBeGreaterThan(0);
    expect(r.join(' ')).toMatch(re);
    expect(msgs(edit('lefthook.yml', LH(PINNED), after)).join(' ')).toMatch(re);
  });

  it.each([
    ['env: CI', LH(PINNED, '      env:\n        CI: "1"\n')],
    ['the pin raised', LH('npx --yes tamperward@2.6.0 check --staged')],
    ['an env that was there before, unchanged', LH(PINNED, '      env:\n        FORCE_COLOR: "1"\n')],
    ['an output redirection', LH(`${PINNED} >/dev/null`)],
  ])('control · lefthook: %s is kept', (_n, after) => {
    expect(lh(LH(PINNED), after)).toEqual([]);
  });

  it('lefthook: an `env` the gate resolves through that was already there is not this edit\'s doing', () => {
    const withEnv = LH(PINNED, '      env:\n        PATH: /tmp/bin\n');
    expect(lh(withEnv, withEnv.replace('npx eslint .', 'npx eslint src'))).toEqual([]);
    expect(lh(withEnv, withEnv.replace('/tmp/bin', '/tmp/other')).join(' ')).toMatch(/sets PATH/);
  });

  it.each([
    ['entry: … --diff', PC('npx --yes tamperward@2.5.0 check --diff HEAD...HEAD'), /instead of `tamperward check --staged`/],
    ['entry: … --diff (no range)', PC('npx --yes tamperward@2.5.0 check --diff'), /instead of `tamperward check --staged`/],
    ['args: [--cwd, /tmp]', PC(PINNED, '        args: [--cwd, /tmp]\n'), /--cwd \/tmp/],
    ['args: [--diff, HEAD...HEAD] on a bare check', PC('npx --yes tamperward@2.5.0 check', '        args: [--diff, HEAD...HEAD]\n'), /now runs `tamperward check --diff HEAD\.\.\.HEAD` instead of `tamperward check --staged`/],
    ['env: NODE_OPTIONS', PC(PINNED, '        env:\n          NODE_OPTIONS: --require /tmp/ok.js\n'), /sets NODE_OPTIONS/],
    ['additional_dependencies added', PC(PINNED, '        additional_dependencies: ["tamperward@0.1.0"]\n'), /additional_dependencies/],
    ['the pin to ^1', PC('npx --yes tamperward@^1 check --staged'), /not a plain version/],
    ['the pin lowered', PC('npx --yes tamperward@2.1.0 check --staged'), /lowered/],
    ['an env prefix in entry', PC(`env NODE_OPTIONS=--require=/tmp/ok.js ${PINNED}`), /no longer runs `tamperward check` live/],
  ])('pre-commit: %s', (_n, after, re) => {
    const r = pc(PC(PINNED), after);
    expect(r.length, r.join()).toBeGreaterThan(0);
    expect(r.join(' ')).toMatch(re);
    expect(msgs(edit('.pre-commit-config.yaml', PC(PINNED), after)).join(' ')).toMatch(re);
  });

  it.each([
    ['always_run added', PC(PINNED, '        always_run: true\n')],
    ['the pin raised', PC('npx --yes tamperward@2.6.0 check --staged')],
    ['verbose', PC(PINNED, '        verbose: true\n')],
  ])('control · pre-commit: %s is kept', (_n, after) => {
    expect(pc(PC(PINNED), after)).toEqual([]);
  });
});

// ── 6 · the init shape ───────────────────────────────────────────────────────
describe('6 · the init-written script: byte-equal modulo the pin, trailing newlines not counted', () => {
  const INIT = `#!/bin/sh\n${MARKER}\nnpx --yes tamperward@${V} check --staged\n`;
  it('a double trailing newline is the same script as a single one, or none', () => {
    expect(initScriptPin(INIT + '\n')).toBe(V);
    expect(initScriptPin(INIT.trimEnd())).toBe(V);
    expect(msgs(edit('.husky/pre-commit', INIT, INIT + '\n'))).toEqual([]);
    expect(msgs(edit('.husky/pre-commit', INIT, INIT.trimEnd()))).toEqual([]);
    expect(msgs(edit('.husky/pre-commit', INIT.replace(`@${V}`, '@2.1.0'), INIT + '\n'))).toEqual([]);
  });
  it('anything else in the init shape stays the shape finding', () => {
    for (const after of [INIT.replace('\n', '\r\n'), INIT + '# note\n', INIT.replace(`@${V}`, '@^1'), INIT.replace('--staged', '--diff HEAD...HEAD'), INIT.replace('check --staged', 'check  --staged')]) {
      const f = run(edit('.husky/pre-commit', INIT, after));
      expect(f.length, after).toBe(1);
      expect(f[0].evidence).toBe('the gate script no longer matches the shape init wrote; re-run init or sign off');
    }
  });
});

// ── 7 · end to end through the built CLI ─────────────────────────────────────
describe('7 · through the built CLI: `check --staged` blocks, the out-of-band sign-off clears in CI', () => {
  const ROOT = join(__dirname, '..');
  let cliDir = '';
  let CLI = '';
  const dirs: string[] = [];

  beforeAll(() => {
    // The CLI as `npm run build` ships it, in the package layout it ships in:
    // `dist/cli/index.js` beside a package.json, so the built gate knows its own
    // version (TW_VERSION) the way an installed one does — the pin ceiling depends on it.
    cliDir = mkdtempSync(join(tmpdir(), 'tw-fc-cli-'));
    symlinkSync(join(ROOT, 'node_modules'), join(cliDir, 'node_modules'), 'dir');
    writeFileSync(join(cliDir, 'package.json'), JSON.stringify({ name: 'tamperward', version: V, type: 'module' }));
    mkdirSync(join(cliDir, 'dist', 'cli'), { recursive: true });
    CLI = join(cliDir, 'dist', 'cli', 'index.js');
    buildSync({ entryPoints: [join(ROOT, 'src/cli/index.ts')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: CLI, logLevel: 'silent' });
  }, 60_000);
  afterAll(() => { if (cliDir) rmSync(cliDir, { recursive: true, force: true }); });
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();
  const LH = 'pre-commit:\n  commands:\n    tamperward:\n      run: npx --yes tamperward@2.5.0 check --staged\n';
  const PC = 'repos:\n  - repo: local\n    hooks:\n      - id: tamperward\n        name: tamperward\n        entry: npx --yes tamperward@2.5.0 check --staged\n        language: system\n        pass_filenames: false\n';

  /** A repository with hand-written hooks in `.husky/` (baseline) and `.githooks/`
   *  (`protected.hooks`), plus lefthook and pre-commit configs carrying the gate. */
  function repo(): string {
    const d = mkdtempSync(join(tmpdir(), 'tw-fc-'));
    dirs.push(d);
    git(d, 'init', '-q', '-b', 'main');
    git(d, 'config', 'user.email', 't@b');
    git(d, 'config', 'user.name', 'tb');
    mkdirSync(join(d, '.husky'));
    mkdirSync(join(d, '.githooks'));
    writeFileSync(join(d, '.husky', 'pre-commit'), HAND);
    writeFileSync(join(d, '.githooks', 'pre-commit'), HAND);
    chmodSync(join(d, '.husky', 'pre-commit'), 0o755);
    chmodSync(join(d, '.githooks', 'pre-commit'), 0o755);
    writeFileSync(join(d, '.tamperward.yml'), "version: 1\nprotected:\n  hooks: ['.githooks/**']\n");
    writeFileSync(join(d, 'lefthook.yml'), LH);
    writeFileSync(join(d, '.pre-commit-config.yaml'), PC);
    writeFileSync(join(d, 'README.md'), 'x\n');
    git(d, 'add', '-A');
    git(d, 'commit', '-qm', 'base');
    return d;
  }
  function cli(cwd: string, args: string[], env: Record<string, string> = {}): { code: number; findings: Finding[] } {
    const r = spawnSync('node', [CLI, ...args, '--json'], { cwd, encoding: 'utf8', env: { ...process.env, TAMPERWARD_OOB_SIGNOFF: '', TAMPERWARD_OOB_HEAD: '', ...env } });
    let findings: Finding[] = [];
    try { findings = (JSON.parse(r.stdout) as { findings: Finding[] }).findings ?? []; } catch { /* no JSON: the exit code says it */ }
    return { code: r.status ?? -1, findings };
  }
  /** Stage `content` at `path`, run `check --staged`, restore. */
  function staged(d: string, path: string, content: string): { code: number; findings: Finding[] } {
    writeFileSync(join(d, path), content);
    git(d, 'add', '-A');
    const r = cli(d, ['check', '--staged']);
    git(d, 'reset', '-q', '--hard', 'HEAD');
    return r;
  }
  /** Commit `content` at `path` on a branch and run `check --diff main...HEAD` under `env`. */
  function ci(d: string, path: string, content: string, env: Record<string, string> = {}): { code: number; findings: Finding[]; sha: string } {
    git(d, 'checkout', '-q', '-B', 'edit', 'main');
    writeFileSync(join(d, path), content);
    git(d, 'add', '-A');
    git(d, 'commit', '-qm', 'edit');
    const sha = git(d, 'rev-parse', 'HEAD');
    const r = cli(d, ['check', '--diff', 'main...HEAD'], Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace('<sha>', sha)])));
    git(d, 'checkout', '-q', 'main');
    return { ...r, sha };
  }
  const ht = (f: Finding[]) => f.filter((x) => x.rule === 'hook-tampering' && x.severity === 'block');

  it.each(EVASIONS.filter(([n]) => /^e(?:30|27|09|22|26|42|39|14|36|50)\b/.test(n)))('%s blocks `check --staged` on .husky/pre-commit and .githooks/pre-commit', (_n, after) => {
    const d = repo();
    for (const path of ['.husky/pre-commit', '.githooks/pre-commit']) {
      const r = staged(d, path, after);
      expect(r.code, path).toBe(1);
      expect(ht(r.findings).length, path).toBe(1);
      expect(ht(r.findings)[0].file).toBe(path);
      expect(ht(r.findings)[0].evidence).toMatch(CHANGED);
    }
  });

  it.each(HONEST.filter(([n]) => /^h(?:09|28|05|22|47)\b/.test(n)))('%s blocks `check --staged`, and clears in CI with the out-of-band sign-off bound to the head', (_n, after) => {
    const d = repo();
    const s = staged(d, '.husky/pre-commit', after);
    expect(s.code).toBe(1);
    expect(ht(s.findings)[0].evidence).toMatch(CHANGED);
    // CI: the same edit, blocked without the label…
    const blocked = ci(d, '.husky/pre-commit', after);
    expect(blocked.code).toBe(1);
    expect(ht(blocked.findings).length).toBe(1);
    // …cleared by the approval the workflow resolves from the label, in either spelling
    expect(ci(d, '.husky/pre-commit', after, { TAMPERWARD_OOB_SIGNOFF: 'hook-tampering@<sha>', TAMPERWARD_OOB_HEAD: '<sha>' }).code).toBe(0);
    expect(ci(d, '.husky/pre-commit', after, { TAMPERWARD_OOB_SIGNOFF: 'tamperward:allow:hook-tampering@<sha>', TAMPERWARD_OOB_HEAD: '<sha>' }).code).toBe(0);
    // …and not by an approval for another commit, or an unbound one once a head is known
    expect(ci(d, '.husky/pre-commit', after, { TAMPERWARD_OOB_SIGNOFF: 'hook-tampering@0000000deadbeef', TAMPERWARD_OOB_HEAD: '<sha>' }).code).toBe(1);
    expect(ci(d, '.husky/pre-commit', after, { TAMPERWARD_OOB_SIGNOFF: 'hook-tampering', TAMPERWARD_OOB_HEAD: '<sha>' }).code).toBe(1);
  });

  it('the pin raise and the trailing newline pass `check --staged`; a pin above the gate does not', () => {
    const d = repo();
    writeFileSync(join(d, '.githooks', 'pre-commit'), sh('npx --yes tamperward@2.1.0 check --staged'));
    git(d, 'add', '-A');
    git(d, 'commit', '-qm', 'pin');
    expect(staged(d, '.githooks/pre-commit', sh(`npx --yes tamperward@${V} check --staged`)).code).toBe(0);
    expect(staged(d, '.githooks/pre-commit', sh(`npx --yes tamperward@${V} check --staged`).trimEnd()).code).toBe(0);
    expect(staged(d, '.husky/pre-commit', HAND + '\n').code).toBe(0);
    expect(staged(d, '.githooks/pre-commit', sh('npx --yes tamperward@99.0.0 check --staged')).code).toBe(1);
    expect(staged(d, '.githooks/pre-commit', sh('npx --yes tamperward@2.0.0 check --staged')).code).toBe(1);
  });

  it.each([
    ['lefthook run: … --diff HEAD...HEAD', 'lefthook.yml', LH.replace('--staged', '--diff HEAD...HEAD'), /instead of `tamperward check --staged`/],
    ['lefthook env: NODE_OPTIONS', 'lefthook.yml', LH + '      env:\n        NODE_OPTIONS: --require /tmp/ok.js\n', /NODE_OPTIONS/],
    ['lefthook the pin to ^1', 'lefthook.yml', LH.replace('@2.5.0', '@^1'), /not a plain version/],
    ['pre-commit entry: … --diff', '.pre-commit-config.yaml', PC.replace('--staged', '--diff HEAD...HEAD'), /instead of `tamperward check --staged`/],
    ['pre-commit args: [--cwd, /tmp]', '.pre-commit-config.yaml', PC + '        args: [--cwd, /tmp]\n', /--cwd \/tmp/],
    ['pre-commit env: PATH', '.pre-commit-config.yaml', PC + '        env:\n          PATH: /tmp/bin\n', /sets PATH/],
  ])('%s blocks `check --staged`', (_n, path, after, re) => {
    const r = staged(repo(), path, after);
    expect(r.code).toBe(1);
    expect(ht(r.findings).map((f) => f.message).join(' ')).toMatch(re);
  });

  it('a new hook script without a live gate blocks; one with it passes', () => {
    const d = repo();
    expect(staged(d, '.githooks/pre-push', sh('npm test')).code).toBe(1);
    expect(staged(d, '.githooks/pre-push', sh(`${G} || true`)).code).toBe(1);
    expect(staged(d, '.githooks/pre-push', sh('npx tamperward check --diff origin/main...HEAD')).code).toBe(0);
  });
});

// ── 8 · the report's Held list, re-run ───────────────────────────────────────
describe('8 · what held in the report still holds in the model', () => {
  it.each([
    ['e01 echo "$(G)"', [`echo "$(${G})"`], /removed/],
    ['e02 backticks', [`echo \`${G}\``], /removed/],
    ['e03 { G; } || true', [`{ ${G}; } || true`], /ends in success/],
    ['e04 ( G ) || true', [`( ${G} ) || true`], /ends in success/],
    ['e07 || { echo; }', [`${G} || { echo failed; }`], /ends in success/],
    ['e49 || { :; }', [`${G} || { :; }`], /ends in success/],
    ['e48 || return 0', [`${G} || return 0`], /ends in success/],
    ["e08 trap 'exit 0' EXIT", ["trap 'exit 0' EXIT", G], /trap/],
    ['e11 exec true', ['exec true', G], /unreachable/],
    ['e06 G & then wait', [`${G} &`, 'wait'], /background/],
    ['e43 gate as an if condition', [`if ${G}; then :; else :; fi`], /condition/],
    ['e46 dead literal case', [`case x in y) ${G} ;; esac`], /unreachable/],
    ['e45 ( set +e; G; true )', ['set -e', `( set +e; ${G}; true )`], /removed|neutralised/],
    ['e47 eval of a reassigned variable', [`CMD="${G}"`, 'CMD=true', 'eval "$CMD"'], /removed/],
  ])('flagged · %s', (_n, after, re) => {
    const r = scriptWeakening([G], after, husky);
    expect(r.length, _n).toBe(1);
    expect(r[0].reason).toMatch(re);
  });

  it.each([
    ['h36 CI=1 G', [`CI=1 ${G}`]],
    ['h42 exec G', [`exec ${G}`]],
    ['h30 OUT=$(G)', [`OUT=$(${G})`]],
    ['h16 pnpm dlx', ['pnpm dlx tamperward check --staged']],
    ['h17 bunx', ['bunx tamperward check --staged']],
    ['h18 yarn dlx', ['yarn dlx tamperward check --staged']],
    ['h20 bare', ['tamperward check --staged']],
    ['h39 npm exec --', ['npm exec -- tamperward check --staged']],
    ['h34 --no-install', ['npx --no-install tamperward check --staged']],
    ['h13 quoted heredoc before', ["cat <<'EOF' >/dev/null", 'running $gate', 'EOF', G]],
    ['h14 heredoc in a function', ['usage() {', '  cat <<EOF', 'usage: $0', 'EOF', '}', G]],
    ['h12 while read </dev/null', ['while read -r f; do :; done < /dev/null', G]],
    ['h03 set -e then true', ['set -e', G, 'true']],
    ["h04 trap 'rc=$?; exit $rc'", ["trap 'rc=$?; exit $rc' EXIT", G]],
    ['h08 exec >/dev/null', ['exec >/dev/null 2>&1', G]],
    ['h11 multi-line elif with $CI', ['if [ -n "$CI" ]; then', '  echo ci', 'elif [ -z "$SKIP" ]; then', `  ${G}`, 'else', '  echo skip', 'fi']],
    ['h25 no trailing newline', [G]],
    ['h26 two gates, one neutered', [`${G} || true`, G]],
    ['h46 multi-line function call', ['run_checks() {', `  ${G}`, '}', 'run_checks']],
    ['h10 G & then wait $! (fixed)', [`${G} &`, 'wait $!']],
    ['h22 --cwd toplevel (fixed)', [`${G} --cwd "$(git rev-parse --show-toplevel)"`]],
  ])('read live · %s', (_n, after) => {
    expect(scriptWeakening([G], after, husky)).toEqual([]);
  });

  it('oobFromEnv accepts the label spelling and the workflow\'s stripped spelling alike', () => {
    expect(oobFromEnv({ TAMPERWARD_OOB_SIGNOFF: 'hook-tampering@abc1234, tamperward:allow:verify@abc1234' })).toEqual(['hook-tampering@abc1234', 'verify@abc1234']);
    expect(oobFromEnv({ TAMPERWARD_OOB_SIGNOFF: '' })).toEqual([]);
  });
});
