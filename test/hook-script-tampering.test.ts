// Regressions from the detector audit of the SHELL hook-script path and the command
// surface, each beside the legitimate edit it must not catch. All reproduced against
// the built CLI on a .husky/pre-commit-style script before the fix.
//
//   1  the gate neutralised in place: `|| true`, `--version`, `echo "…"`, `if false`,
//      `exit 0  # done`, `exit 0;`, bare `exit`, `[ -n "$X" ] || exit 0`
//   2  command surface: chmod 0 / 00644 / --reference, perl -pi, awk -i inplace,
//      sponge, ln -sf, git checkout <rev> -- / git restore --source
//   3  lefthook skip/glob, pre-commit stages/exclude, package.json prepare
//   4  FP: chmod +x blocked
//   5  FP: read-only commands naming a hook blocked
//   6  FP: CODEOWNERS token scan, lefthook.yml → .yaml rename, npx → pnpm exec

import { describe, it, expect } from 'vitest';
import { hookTampering } from '../src/detectors/hook-tampering';
import {
  alwaysFalse, checkIdentity, chmodDropsExec, codeownersWeakening, hookIdentity, insertsDeadGuard,
  insertsPassingExit, invocations, lefthookWeakening, packageJsonWeakening, parseDoc, preCommitWeakening,
  scriptWeakening, shellWritesHook,
} from '../src/detectors/hook-wiring';
import { evaluate } from '../src/engine';
import { defaultPolicy } from '../src/policy';
import { parseDiff } from '../src/diff/parse';
import { synthFileChange } from '../src/adapters/claude/changes';
import { tokens, unquote } from '../src/detectors/command';
import type { Change, CommandChange, FileChange } from '../src/types';

const P = defaultPolicy();
const cmd = (raw: string): CommandChange => ({ kind: 'command', raw, argv: raw.split(/\s+/) });
const file = (path: string, before: string | null, after: string | null, op: FileChange['op'] = 'modify', oldPath: string | null = null): FileChange => ({
  kind: 'file', path, oldPath, op, before, after, binary: false, hunks: [],
});
/** A hook edit with real hunks AND full content — the shape every git view produces. */
const edit = (path: string, before: string, after: string): Change[] => synthFileChange(path, before, after);
const run = (c: Change[]) => hookTampering.run(c, P);
const msgs = (c: Change[]) => run(c).map((f) => f.message);

const GATE = 'npx tamperward check --staged';
const HOOK = `#!/bin/sh\n${GATE}\n`;

// ── 1 · the gate neutralised in place ─────────────────────────────────────────
describe('1 · a hook script is compared by the checks it actually RUNS', () => {
  it.each([
    ['|| true', `#!/bin/sh\n${GATE} || true\n`],
    ['|| :', `#!/bin/sh\n${GATE} || :\n`],
    ['|| echo skipped', `#!/bin/sh\n${GATE} || echo "gate skipped"\n`],
    ['|| exit 0', `#!/bin/sh\n${GATE} || exit 0\n`],
    ['; true', `#!/bin/sh\n${GATE}; true\n`],
    ['piped into tee (no pipefail)', `#!/bin/sh\n${GATE} | tee /tmp/gate.log\n`],
    ['--version instead of check', `#!/bin/sh\nnpx tamperward --version\n`],
    ['echo of the command', `#!/bin/sh\necho "${GATE}"\n`],
    ['echo in single quotes', `#!/bin/sh\necho '${GATE}'\n`],
    ['if false; then', `#!/bin/sh\nif false; then\n  ${GATE}\nfi\n`],
    ['if [ 0 -eq 1 ]', `#!/bin/sh\nif [ 0 -eq 1 ]; then\n  ${GATE}\nfi\n`],
    ['if [ "a" = "b" ]', `#!/bin/sh\nif [ "a" = "b" ]\nthen\n  ${GATE}\nfi\n`],
    ['if [ -n "" ]', `#!/bin/sh\nif [ -n "" ]; then\n  ${GATE}\nfi\n`],
    ['if test 1 -eq 0', `#!/bin/sh\nif test 1 -eq 0; then\n  ${GATE}\nfi\n`],
    ['false && gate', `#!/bin/sh\nfalse && ${GATE}\n`],
    ['true || gate', `#!/bin/sh\ntrue || ${GATE}\n`],
    ['exit 0 with comment before it', `#!/bin/sh\nexit 0  # nothing to do\n${GATE}\n`],
    ['exit 0; before it', `#!/bin/sh\nexit 0;\n${GATE}\n`],
    ['bare exit before it', `#!/bin/sh\nexit\n${GATE}\n`],
    ['[ -n "$X" ] || exit 0 before it', `#!/bin/sh\n[ -n "$CI" ] || exit 0\n${GATE}\n`],
    ['return 0 before it', `#!/bin/sh\nreturn 0\n${GATE}\n`],
    ['exit 1 before it (the gate never runs)', `#!/bin/sh\nexit 1\n${GATE}\n`],
    ['exit "$code" before it', `#!/bin/sh\ncode=0\nexit "$code"\n${GATE}\n`],
    ['commented out', `#!/bin/sh\n# ${GATE}\n`],
    ['removed', `#!/bin/sh\n`],
    ['moved into a string on another line', `#!/bin/sh\nMSG="run ${GATE} manually"\necho "$MSG"\n`],
  ])('flags: %s', (_n, after) => {
    const m = msgs(edit('.husky/pre-commit', HOOK, after));
    expect(m.length, m.join('\n')).toBeGreaterThan(0);
    expect(m.every((x) => /hook/.test(x))).toBe(true);
  });

  it('a decoy carrying the token on an added non-invocation line does not excuse the removal', () => {
    const decoys = [
      `#!/bin/sh\necho "npx"\n`,
      `#!/bin/sh\nNOTE="npx tamperward check --staged"\n`,
      `#!/bin/sh\n: npx tamperward check --staged\n`,
      `#!/bin/sh\nnpx tamperward --version\n`,
    ];
    for (const after of decoys) {
      expect(msgs(edit('.husky/pre-commit', HOOK, after)).some((x) => /script was changed: .*was removed/.test(x)), after).toBe(true);
    }
  });

  // These were the CONTROLS of the liveness model: honest edits the model read as
  // live and the detector passed. Since 2.10.0 the model is evidence, not the
  // verdict — a hand-written hook script is held byte-equal to its before modulo
  // a pin raise, because a line-by-line reading of a shell script cannot be sound
  // (pass 3b: thirteen more shapes read live that ran a failing gate to exit 0).
  // Every one of these is now a sign-off, with the reason saying so. The
  // assertion is inverted, not removed: the honest shape is still what is
  // being described, and what it costs now is one human sign-off.
  it.each([
    ['npx → pnpm exec', `#!/bin/sh\npnpm exec tamperward check --staged\n`],
    ['npx → yarn', `#!/bin/sh\nyarn tamperward check --staged\n`],
    ['npx → bunx', `#!/bin/sh\nbunx tamperward check --staged\n`],
    ['npx --yes with a pin', `#!/bin/sh\nnpx --yes tamperward@2.1.0 check --staged\n`],
    ['output suppressed', `#!/bin/sh\n${GATE} >/dev/null 2>&1\n`],
    ['an extra flag', `#!/bin/sh\n${GATE} --format text\n`],
    ['|| exit 1', `#!/bin/sh\n${GATE} || exit 1\n`],
    ['|| { echo; exit 1; }', `#!/bin/sh\n${GATE} || { echo "gate failed"; exit 1; }\n`],
    ['|| exit "$?"', `#!/bin/sh\n${GATE} || exit "$?"\n`],
    ['pipefail then pipe', `#!/bin/sh\nset -o pipefail\n${GATE} | tee /tmp/gate.log\n`],
    ['behind a reachable condition', `#!/bin/sh\nif [ -z "$SKIP_GATE" ]; then\n  ${GATE}\nfi\n`],
    ['in the else branch of a dead if', `#!/bin/sh\nif false; then\n  echo never\nelse\n  ${GATE}\nfi\n`],
    ['after a conditional exit 1', `#!/bin/sh\n[ -d .git ] || exit 1\n${GATE}\n`],
    ['env var in front', `#!/bin/sh\nCI=1 ${GATE}\n`],
    ['exec in front', `#!/bin/sh\nexec ${GATE}\n`],
    ['a comment added above', `#!/bin/sh\n# the gate\n${GATE}\n`],
    ['an unrelated line added', `#!/bin/sh\necho "checking..."\n${GATE}\n`],
    ['a second check added', `#!/bin/sh\n${GATE}\nnpx lint-staged\n`],
    ['reordered with another check', `#!/bin/sh\nnpx lint-staged\n${GATE}\n`],
    ['moved into a && chain', `#!/bin/sh\ncd "$(git rev-parse --show-toplevel)" && ${GATE}\n`],
  ])('honest edit · %s is a sign-off since 2.10.0 (byte-equal rule), the model reading it live', (_n, after) => {
    const f = run(edit('.husky/pre-commit', HOOK, after));
    expect(f.length).toBe(1);
    expect(f[0].evidence).toMatch(/the gate script changed; sign off/);
    // the model still reads the gate as live here, so the finding names no mechanism
    expect(f[0].message).toMatch(/changed: an edit other than a pin raise\./);
  });

  it('honest edit · replacing `npm test` with `npm run test`, or `yarn test`, is the same check to the model — and a sign-off since 2.10.0', () => {
    const h = (l: string) => `#!/bin/sh\n${l}\n`;
    // the model: the same check (no mechanism named); the rule: the script changed
    expect(scriptWeakening([h('npm test')], [h('npm run test')], { errexit: true })).toEqual([]);
    expect(scriptWeakening([h('npm test')], [h('yarn test')], { errexit: true })).toEqual([]);
    expect(msgs(edit('.husky/pre-push', h('npm test'), h('npm run test')))).toEqual([expect.stringMatching(/changed: an edit other than a pin raise/)]);
    expect(msgs(edit('.husky/pre-push', h('npm test'), h('yarn test')))).toEqual([expect.stringMatching(/changed: an edit other than a pin raise/)]);
    expect(msgs(edit('.husky/pre-push', h('npm test'), h('echo "npm test"')))).toEqual([expect.stringMatching(/`test` was removed/)]);
  });

  it('checkIdentity: runner, pin, redirection and flags are presentation; position and the mode flag are meaning', () => {
    expect(checkIdentity('npx tamperward@2.1.0 check --staged >/dev/null')).toBe('tamperward check --staged');
    expect(checkIdentity('pnpm exec tamperward check --staged')).toBe('tamperward check --staged');
    expect(checkIdentity('npx --yes tamperward check --worktree')).toBe('tamperward check --worktree');
    expect(checkIdentity('npx tamperward --version')).toBeNull();
    expect(checkIdentity('echo "npx tamperward check --staged"')).toBeNull();
    expect(checkIdentity('npm test')).toBe('test');
    expect(checkIdentity('test -n "$X"')).toBeNull(); // shell builtin, not a check
    expect(checkIdentity('make test')).toBe('make test');
    expect(checkIdentity('npx jest --ci')).toBe('jest');
  });

  it('insertsPassingExit / insertsDeadGuard / alwaysFalse spellings', () => {
    for (const l of ['exit 0', 'exit 0  # done', 'exit 0;', 'exit', '  exit 00', 'return 0', '[ -n "$X" ] || exit 0', 'then exit 0']) {
      expect(insertsPassingExit(l), l).toBe(true);
    }
    for (const l of ['exit 1', 'exit $?', 'echo exit 0', '# exit 0', 'EXIT=0', 'git commit --no-verify']) {
      expect(insertsPassingExit(l), l).toBe(false);
    }
    expect(insertsDeadGuard('if false; then')).toBe(true);
    expect(insertsDeadGuard('if [ 0 -eq 1 ]; then')).toBe(true);
    expect(insertsDeadGuard('if [ -z "$X" ]; then')).toBe(false);
    expect(insertsDeadGuard('if true; then')).toBe(false);
    expect(alwaysFalse('[ 1 -gt 2 ]')).toBe(true);
    expect(alwaysFalse('[[ "x" != "x" ]]')).toBe(true);
    expect(alwaysFalse('[ -z "abc" ]')).toBe(true);
    expect(alwaysFalse('[ "$A" = "b" ]')).toBe(false);
    expect(alwaysFalse('( exit 1 )')).toBe(true);
  });

  it('invocations reports the state of each occurrence', () => {
    const inv = invocations(['#!/bin/sh', '# npx tamperward check --staged', 'if false; then', '  npx jest', 'fi', 'npx vitest run || true', 'npx eslint .']);
    expect(inv.map((i) => [i.identity, i.state])).toEqual([
      ['tamperward check --staged', 'comment'], ['jest', 'unreachable'], ['vitest', 'neutered'], ['eslint', 'live'],
    ]);
    expect(scriptWeakening(['npx jest'], ['npx jest || true'])[0].reason).toMatch(/neutralised/);
    expect(scriptWeakening(['npx jest'], ['if false; then', 'npx jest', 'fi'])[0].reason).toMatch(/unreachable/);
    expect(scriptWeakening(['npx jest'], ['# npx jest'])[0].reason).toMatch(/commented out/);
    // reachability alone, with no passing-exit line to catch: an exit with ANY argument ends the script
    expect(invocations(['exit 1', 'npx jest'])[0].state).toBe('unreachable');
    expect(invocations(['exit "$code"', 'npx jest'])[0].state).toBe('unreachable');
    expect(invocations(['[ -d .git ] || exit 1', 'npx jest'])[0].state).toBe('live'); // conditional: still reachable
    expect(invocations(['if [ -z "$X" ]; then', '  exit 1', 'fi', 'npx jest'])[0].state).toBe('live'); // exits the frame, not the script
    expect(scriptWeakening(['npx jest'], ['exit 1', 'npx jest'])[0].reason).toMatch(/unreachable/);
    expect(scriptWeakening(['npx jest'], [])[0].reason).toMatch(/removed/);
  });

  it('hunk-only view (no full content) still sees an added dead guard and an added early exit', () => {
    const d = parseDiff(`diff --git a/.husky/pre-commit b/.husky/pre-commit
index 1..2 100755
--- a/.husky/pre-commit
+++ b/.husky/pre-commit
@@ -1,2 +1,4 @@
 #!/bin/sh
+if false; then
 npx tamperward check --staged
+fi
`);
    expect(msgs(d).some((x) => /never be true/.test(x))).toBe(true);
    const e = parseDiff(`diff --git a/.husky/pre-commit b/.husky/pre-commit
index 1..2 100755
--- a/.husky/pre-commit
+++ b/.husky/pre-commit
@@ -1,2 +1,3 @@
 #!/bin/sh
+[ -n "$CI" ] || exit 0
 npx tamperward check --staged
`);
    expect(msgs(e).some((x) => /early `exit 0`/.test(x))).toBe(true);
  });

  it('end to end through the engine at the staged view', () => {
    const f = evaluate(edit('.husky/pre-commit', HOOK, `#!/bin/sh\n${GATE} || true\n`), P, undefined, 'staged');
    expect(f.some((x) => x.rule === 'hook-tampering' && x.severity === 'block')).toBe(true);
  });
});

// ── 2 · the command surface ───────────────────────────────────────────────────
describe('2 · shell rewrites of a hook, in every spelling', () => {
  it.each([
    'chmod 0 .husky/pre-commit',
    'chmod 00644 .husky/pre-commit',
    'chmod 600 .husky/pre-commit',
    'chmod --reference=README.md .husky/pre-commit',
    'chmod u-x .husky/pre-commit',
    'chmod a=rw .husky/pre-commit',
    "perl -pi -e 's/tamperward/true/' .husky/pre-commit",
    "perl -i.bak -pe 's/x/y/' .husky/pre-commit",
    "awk -i inplace '{print}' .husky/pre-commit",
    "gawk -i inplace 'NR>1' .husky/pre-commit",
    'echo "exit 0" | sponge .husky/pre-commit',
    'ln -sf /bin/true .husky/pre-commit',
    'ln -s /bin/true .husky/pre-commit',
    'git checkout HEAD~5 -- .husky/pre-commit',
    'git checkout abc1234 .husky/pre-commit',
    'git checkout main -- .husky/pre-commit',
    'git restore --source=HEAD~3 .husky/pre-commit',
    'git restore -s v1.0.0 -- .husky/pre-commit',
    'git -C . restore --source HEAD~1 .husky/pre-commit',
    'cp /tmp/empty .husky/pre-commit',
    'install -m 755 /tmp/hook .husky/pre-commit',
    'mv .husky/pre-commit /tmp/',
    'mv /tmp/x .husky/pre-commit',
    'echo > .husky/pre-commit',
    'echo "exit 0" >> .husky/pre-commit',
    ': >.husky/pre-commit',
    'truncate -s 0 .husky/pre-commit',
    'dd if=/dev/null of=.husky/pre-commit',
    'printf x | tee .husky/pre-commit',
    "sed -i 's/tamperward/true/' .husky/pre-commit",
    "sed -Ei 's/a/b/' .husky/pre-commit",
    "sed --in-place 's/a/b/' .husky/pre-commit",
    'rm -f .husky/pre-commit',
    'sudo rm .husky/pre-commit',
    'rm .pre-commit-config.yaml',
    'cd /tmp && git checkout v1 -- lefthook.yml',
  ])('flags: %s', (c) => {
    const f = run([cmd(c)]);
    expect(f.length, c).toBe(1);
    expect(f[0].message).toMatch(/Hook tampering via shell/);
  });

  it('chmodDropsExec is direction-aware over every octal and symbolic spelling', () => {
    const t = (c: string) => chmodDropsExec(tokens(c).map(unquote));
    for (const c of ['chmod 0 h', 'chmod 00644 h', 'chmod 644 h', 'chmod 0644 h', 'chmod 66 h', 'chmod u-x h', 'chmod -x h', 'chmod u=rw h', 'chmod go-x,u-x h', 'chmod --reference=x h']) {
      expect(t(c), c).toBe(true);
    }
    for (const c of ['chmod +x h', 'chmod u+x h', 'chmod a+x h', 'chmod 755 h', 'chmod 0755 h', 'chmod 100 h', 'chmod u=rwx h', 'chmod u+w h', 'chmod go-w h', 'chmod +X h']) {
      expect(t(c), c).toBe(false);
    }
  });
});

// ── 4 + 5 · false positives on the command surface ────────────────────────────
describe('4 + 5 · restoring +x and READING a hook are not tampering', () => {
  it.each([
    'chmod +x .husky/pre-commit',
    'chmod u+x .husky/pre-commit',
    'chmod a+x .husky/pre-commit',
    'chmod 755 .husky/pre-commit',
    'chmod -R +x .husky',
    'cat .husky/pre-commit > /tmp/backup',
    'cat .husky/pre-commit >> /tmp/all-hooks.txt',
    'cp .husky/pre-commit /tmp/backup',
    'cp .husky/pre-commit /tmp/',
    'sed -n 1,5p .husky/pre-commit',
    "sed 's/a/b/' .husky/pre-commit > /tmp/out",
    "perl -ne 'print' .husky/pre-commit",
    "awk '{print}' .husky/pre-commit",
    'head -n 3 .husky/pre-commit',
    'less .husky/pre-commit',
    'grep tamperward .husky/pre-commit',
    'diff .husky/pre-commit /tmp/other',
    'git diff HEAD -- .husky/pre-commit',
    'git log -- .husky/pre-commit',
    'git show HEAD:.husky/pre-commit',
    'git checkout -- .husky/pre-commit',
    'git restore .husky/pre-commit',
    'git add .husky/pre-commit',
    'ls -la .husky/pre-commit',
    'sha256sum .husky/pre-commit',
    'install -m 755 .husky/pre-commit /tmp/copy',
    'ln -s .husky/pre-commit /tmp/link',
    'cat .husky/pre-commit | grep npx',
    'bash -n .husky/pre-commit',
  ])('does not flag: %s', (c) => {
    expect(run([cmd(c)])).toEqual([]);
  });

  it('shellWritesHook names the write, never the read', () => {
    const w = (c: string) => shellWritesHook(c, tokens(c).map(unquote), P);
    expect(w('cat .husky/pre-commit > /tmp/b')).toBeNull();
    expect(w('cat /tmp/b > .husky/pre-commit')).toMatch(/redirect/);
    expect(w('cp .husky/pre-commit /tmp/b')).toBeNull();
    expect(w('cp /tmp/b .husky/pre-commit')).toMatch(/cp replaces/);
    expect(w('chmod +x .husky/pre-commit')).toBeNull();
    expect(w('chmod -x .husky/pre-commit')).toMatch(/execute/);
  });
});

// ── 3 · lefthook / pre-commit / package.json ──────────────────────────────────
describe('3 · hook configurations compared as their tool reads them', () => {
  const LH = `pre-commit:\n  commands:\n    tamperward:\n      run: npx tamperward check --staged\n    lint:\n      run: npx eslint .\n`;
  const PC = `repos:\n  - repo: local\n    hooks:\n      - id: tamperward\n        name: tamperward\n        entry: npx tamperward check --staged\n        language: system\n        pass_filenames: false\n`;
  const PKG = (scripts: object) => JSON.stringify({ name: 'x', version: '1.0.0', scripts }, null, 2) + '\n';

  it.each([
    ['skip: true on the entry', LH.replace('      run: npx tamperward check --staged\n', '      run: npx tamperward check --staged\n      skip: true\n'), /skip: true/],
    ['skip: true on the hook', LH.replace('pre-commit:\n', 'pre-commit:\n  skip: true\n'), /skip: true/],
    ['glob added', LH.replace('      run: npx tamperward check --staged\n', '      run: npx tamperward check --staged\n      glob: "*.md"\n'), /glob/],
    ['exclude added', LH.replace('      run: npx tamperward check --staged\n', '      run: npx tamperward check --staged\n      exclude: ".*"\n'), /exclude/],
    ['only added', LH.replace('      run: npx tamperward check --staged\n', '      run: npx tamperward check --staged\n      only:\n        - ref: never\n'), /only/],
    ['entry removed', LH.replace('    tamperward:\n      run: npx tamperward check --staged\n', ''), /removed/],
    ['file corrupted', 'pre-commit: [\n', /no longer parses/],
  ])('lefthook: %s', (_n, after, re) => {
    const m = msgs(edit('lefthook.yml', LH, after));
    expect(m.length, m.join()).toBeGreaterThan(0);
    expect(m.join(' ')).toMatch(re);
  });

  it.each([
    ['another command added', LH + '    typecheck:\n      run: npx tsc --noEmit\n'],
    ['the lint entry skipped (not the gate)', LH + '      skip: true\n'],
    ['the gate re-pinned', LH.replace('npx tamperward check', 'npx tamperward@2.2.0 check')],
    ['a pre-push hook added', LH + 'pre-push:\n  commands:\n    gate:\n      run: npx tamperward check --diff origin/main...HEAD\n'],
    ['reformatted', LH.replace(/  /g, '    ')],
    ['skip: false spelled out', LH.replace('      run: npx tamperward check --staged\n', '      run: npx tamperward check --staged\n      skip: false\n')],
  ])('control · lefthook: %s is kept', (_n, after) => {
    expect(msgs(edit('lefthook.yml', LH, after))).toEqual([]);
  });

  it.each([
    ['stages: [manual]', PC + '        stages: [manual]\n', /manual/],
    ['stages: [post-checkout]', PC + '        stages: [post-checkout]\n', /stages/],
    ["exclude: '.*'", PC + "        exclude: '.*'\n", /exclude/],
    ['files narrowed', PC + "        files: ^never/\n", /files/],
    ['hook removed', 'repos: []\n', /removed/],
    ['top-level exclude', "exclude: '.*'\n" + PC, /top-level/],
  ])('pre-commit: %s', (_n, after, re) => {
    const m = msgs(edit('.pre-commit-config.yaml', PC, after));
    expect(m.length, m.join()).toBeGreaterThan(0);
    expect(m.join(' ')).toMatch(re);
  });

  it.each([
    ['another hook added', PC + '      - id: prettier\n        name: prettier\n        entry: npx prettier --check\n        language: system\n        exclude: "^dist/"\n'],
    ['stages widened', PC.replace('        pass_filenames: false\n', '        pass_filenames: false\n        stages: [pre-commit, pre-push]\n')],
    ['always_run added', PC + '        always_run: true\n'],
    ['reformatted', PC.replace(/pass_filenames: false/, 'pass_filenames: false # no paths needed')],
  ])('control · pre-commit: %s is kept', (_n, after) => {
    expect(msgs(edit('.pre-commit-config.yaml', PC, after))).toEqual([]);
  });

  it('pre-commit: stages that had pre-commit and lose it', () => {
    const b = PC + '        stages: [pre-commit, pre-push]\n';
    const a = PC + '        stages: [pre-push]\n';
    expect(msgs(edit('.pre-commit-config.yaml', b, a)).join()).toMatch(/no longer runs at stage/);
  });

  it('package.json: `prepare: husky` removed is flagged; moved or replaced by another installer is not', () => {
    const before = PKG({ prepare: 'husky', test: 'vitest run' });
    expect(msgs(edit('package.json', before, PKG({ test: 'vitest run' }))).join()).toMatch(/install script.*husky/);
    expect(msgs(edit('package.json', before, PKG({ prepare: 'echo ok', test: 'vitest run' }))).join()).toMatch(/install script/);
    expect(msgs(edit('package.json', before, PKG({ postinstall: 'husky', test: 'vitest run' })))).toEqual([]);
    expect(msgs(edit('package.json', before, PKG({ prepare: 'lefthook install', test: 'vitest run' })))).toEqual([]);
    expect(msgs(edit('package.json', before, PKG({ prepare: 'husky install', test: 'vitest run', lint: 'eslint' })))).toEqual([]);
    // no installer before: nothing to lose
    expect(msgs(edit('package.json', PKG({ test: 'x' }), PKG({ test: 'y' })))).toEqual([]);
    expect(packageJsonWeakening('{not json', '{}')).toEqual([]);
  });

  it('direct helpers', () => {
    const lh = (a: string) => lefthookWeakening(parseDoc(LH)!, parseDoc(a)!);
    expect(lh(LH)).toEqual([]);
    expect(lh(LH.replace('      run: npx tamperward check --staged\n', '      run: npx tamperward check --staged\n      skip: true\n')).length).toBe(1);
    expect(preCommitWeakening(parseDoc(PC)!, parseDoc(PC)!)).toEqual([]);
  });
});

// ── 6 · CODEOWNERS, renames, runner swaps ─────────────────────────────────────
describe('6 · CODEOWNERS is ownership wiring, not a script', () => {
  const CO = `# guard the gate\n/.tamperward.yml        @hexrift\n/.github/               @hexrift\n/.husky/                @hexrift\n/src/detectors/         @hexrift\n`;

  it('removing the /.husky/ rule is reported as a lost code-owner rule, not an invocation', () => {
    const m = msgs(edit('.github/CODEOWNERS', CO, CO.replace('/.husky/                @hexrift\n', '')));
    expect(m.length).toBe(1);
    expect(m[0]).toMatch(/code-owner rule covering \/\.husky\//);
    expect(m[0]).not.toMatch(/invocation/);
  });

  it.each([
    ['the workflows rule removed', CO.replace('/.github/               @hexrift\n', ''), /\.github\/workflows/],
    ['the policy rule emptied', CO.replace('/.tamperward.yml        @hexrift', '/.tamperward.yml'), /lost its owners/],
    ['every rule removed', '# nothing\n', /code-owner rule/],
    ['the catch-all that covered everything removed', '* @hexrift\n', '# none\n', /code-owner rule/],
  ] as Array<[string, string, string | RegExp, RegExp?]>)('flags: %s', (_n, a, b, c) => {
    const [before, after, re] = c ? [a, b as string, c] : [CO, a, b as RegExp];
    const m = msgs(edit('.github/CODEOWNERS', before, after));
    expect(m.length, m.join()).toBeGreaterThan(0);
    expect(m.join(' ')).toMatch(re);
  });

  it.each([
    ['a comment mentioning husky reworded', CO.replace('# guard the gate', '# husky hooks and the policy are owned')],
    ['the detectors rule removed (not gate-critical)', CO.replace('/src/detectors/         @hexrift\n', '')],
    ['a rule added', CO + '/docs/ @writer\n'],
    ['/.husky/ replaced by a catch-all', CO.replace('/.husky/                @hexrift\n', '* @hexrift\n')],
    ['owner changed spelling of spacing', CO.replace(/ +@hexrift/g, ' @hexrift')],
    ['the husky rule moved to the top', '/.husky/ @hexrift\n' + CO.replace('/.husky/                @hexrift\n', '')],
    ['a second owner added', CO.replace('/.husky/                @hexrift', '/.husky/                @hexrift @second')],
  ])('control · %s is kept', (_n, after) => {
    expect(msgs(edit('.github/CODEOWNERS', CO, after))).toEqual([]);
  });

  it('codeownersWeakening honours last-match-wins', () => {
    // a later rule without owners un-owns what an earlier one covered
    expect(codeownersWeakening('/.husky/ @a\n', '/.husky/ @a\n/.husky/\n').join()).toMatch(/lost its owners/);
    expect(codeownersWeakening('* @a\n', '/.husky/ @b\n* @a\n')).toEqual([]);
  });

  it('renames within the hooks class with unchanged content are kept; renames git will not run are not', () => {
    const body = 'pre-commit:\n  commands:\n    gate:\n      run: npx tamperward check --staged\n';
    expect(run([file('lefthook.yaml', body, body, 'rename', 'lefthook.yml')])).toEqual([]);
    expect(run([file('CODEOWNERS', '/.husky/ @a\n', '/.husky/ @a\n', 'rename', '.github/CODEOWNERS')])).toEqual([]);
    expect(run([file('.husky/pre-commit.bak', HOOK, HOOK, 'rename', '.husky/pre-commit')]).length).toBe(1);
    expect(run([file('.husky/pre-push', HOOK, HOOK, 'rename', '.husky/pre-commit')]).length).toBe(1);
    expect(run([file('lefthook.yaml', body, 'pre-commit: {}\n', 'rename', 'lefthook.yml')]).length).toBe(1); // content changed too
    expect(run([file('.husky/pre-commit.disabled', null, null, 'rename', '.husky/pre-commit')]).length).toBe(1); // hunk-only, unknown content
    expect(hookIdentity('lefthook.yml')).toBe('lefthook');
    expect(hookIdentity('.husky/pre-commit')).toBe('husky:pre-commit');
    expect(hookIdentity('.husky/notes.txt')).toBeNull();
  });
});
