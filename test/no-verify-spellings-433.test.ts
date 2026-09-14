// Regressions for #433: the no-verify spellings an audit walked past, and the
// value-carrying short option the `-n` cluster test read as the flag.
//
//   - `HUSKY="0"` / `export HUSKY="0"`: unquote stripped only the OUTER quotes, so the
//     token stayed `HUSKY="0` and `^HUSKY=0$` never matched.
//   - a commit alias carrying the flag (`git config alias.ci "commit --no-verify"`,
//     `git -c alias.ci='commit -n' ci`, GIT_CONFIG_* injection): the flag lived in a
//     config VALUE, and the invocation `git ci` names no flag at all.
//   - `pre-commit uninstall` / `lefthook uninstall` / `husky uninstall` and `rm` of the
//     pre-commit framework's install target (`.git/hooks/pre-commit`, outside every
//     git view and so outside `protected.hooks`).
//   - commit paths that never run pre-commit: `git commit-tree` + `update-ref`,
//     `git am`, `git cherry-pick`, `git rebase`. These are ordinary history operations
//     that land ALREADY-CHECKED commits far more often than they smuggle a tree past
//     the hook, so they ship at WARN; the literal `--no-verify` on any of them stays
//     the block class.
//   - `git commit -mfinal`: `-m` glued to its value is not a short-flag cluster, and
//     the letters after a value-carrying option are the value, not flags.

import { describe, expect, it } from 'vitest';
import { defaultPolicy } from '../src/policy';
import { noVerify } from '../src/detectors/no-verify';
import { unquote, words } from '../src/detectors/command';
import type { CommandChange } from '../src/types';

const P = defaultPolicy();
const cmd = (raw: string): CommandChange => ({ kind: 'command', raw, argv: raw.split(/\s+/) });
const run = (raw: string) => noVerify.run([cmd(raw)], P);

describe('no-verify #433: quotes inside a token are not part of the value', () => {
  it.each([
    'HUSKY="0" git commit -m x',
    "HUSKY='0' git commit -m x",
    'export HUSKY="0"; git commit -m x',
    'export HUSKY="0"\ngit commit -m x',
    'env HUSKY="0" git commit -m x',
    'LEFTHOOK="0" git commit -m x',
    'HUSKY_SKIP_HOOKS="1" git commit -m x',
    'SKIP="tamperward" git commit -m x',
    'git commit -m x "--no-verify"',
    // the same spellings one shell deeper
    'bash -c "git commit --no-verify -m x"',
    "sh -c 'HUSKY=0 git commit -m x'",
    'eval "git commit -n -m x"',
  ])('blocks: %s', (c) => {
    const f = run(c);
    expect(f.length, c).toBeGreaterThanOrEqual(1);
    expect(f[0].severity).toBe('block');
  });

  it('unquotes inside the token, keeping the other quote kind as content', () => {
    expect(unquote('HUSKY="0"')).toBe('HUSKY=0');
    expect(unquote("HUSKY='0'")).toBe('HUSKY=0');
    expect(unquote('--no-verify""')).toBe('--no-verify');
    expect(unquote(`"it's"`)).toBe("it's");
    expect(unquote(`'say "hi"'`)).toBe('say "hi"');
    expect(unquote('--message="a b"')).toBe('--message=a b');
    expect(words('HUSKY="0" git commit -m "a b"')).toEqual(['HUSKY=0', 'git', 'commit', '-m', 'a b']);
  });
});

describe('no-verify #433: an alias that carries the flag is the flag', () => {
  it.each([
    'git config alias.ci "commit --no-verify"',
    "git config --global alias.ci 'commit -n'",
    'git config --local --add alias.pushf "push --no-verify --force"',
    'git config alias.ci "commit --no-veri"',
    "git config alias.ci '!git commit --no-verify'",
    'git config alias.ci "!sh -c \'git commit -n\'"',
    "git -c alias.ci='commit --no-verify' ci",
    'git -c "alias.ci=commit -n" ci',
    'git -c alias.ci="commit -anm x" ci',
    'GIT_CONFIG_KEY_0=alias.ci GIT_CONFIG_VALUE_0="commit --no-verify" git ci',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ci GIT_CONFIG_VALUE_0="commit -n" git ci',
    `GIT_CONFIG_PARAMETERS="'alias.ci=commit --no-verify'" git ci`,
    'git config core.hooksPath /dev/null',
  ])('blocks: %s', (c) => {
    const f = run(c);
    expect(f.length, c).toBeGreaterThanOrEqual(1);
    expect(f[0].severity).toBe('block');
  });

  it.each([
    'git config alias.st status',
    'git config alias.ci "commit -v"',
    'git config alias.lg "log -n 20 --oneline"',
    'git config alias.pushn "push -n"',
    'git config --get alias.ci',
    'git config --unset alias.ci',
    'git -c alias.l="log -n 5" l',
    'git config alias.ci "commit -mfinal"',
  ])('passes: %s', (c) => {
    expect(run(c), c).toHaveLength(0);
  });
});

describe('no-verify #433: unwiring the hook frameworks', () => {
  it.each([
    'pre-commit uninstall',
    'pre-commit uninstall -t pre-push',
    'pre-commit uninstall --hook-type pre-commit',
    'python -m pre_commit uninstall',
    'lefthook uninstall',
    'npx lefthook uninstall',
    'pnpm exec lefthook uninstall',
    'npx husky uninstall',
    'husky uninstall',
    'rm .git/hooks/pre-commit',
    'rm -f .git/hooks/pre-push',
    'rm -rf .git/hooks',
    'rm -rf .git/hooks/',
    'rm .git/hooks/*',
    'rm ./.git/hooks/commit-msg',
    'rm "$(git rev-parse --git-dir)/hooks/pre-commit"',
    'rm "$(git rev-parse --git-path hooks)/pre-commit"',
    'rm $GIT_DIR/hooks/pre-commit',
    'unlink .git/hooks/pre-commit',
    'mv .git/hooks/pre-commit .git/hooks/pre-commit.bak',
    'mv .git/hooks/pre-commit /tmp/',
    'chmod -x .git/hooks/pre-commit',
    'chmod 644 .git/hooks/pre-commit',
    'cd repo && rm .git/hooks/pre-commit',
  ])('blocks: %s', (c) => {
    const f = run(c);
    expect(f.length, c).toBeGreaterThanOrEqual(1);
    expect(f[0].severity).toBe('block');
  });

  it.each([
    'pre-commit install',
    'pre-commit install --hook-type pre-push',
    'pre-commit run --all-files',
    'npx husky init',
    'npx husky install',
    'lefthook install',
    'npm uninstall left-pad',
    'npm uninstall husky', // removes the package, not the hook: the installed hook script still runs (and fails closed)
    'pip uninstall -y pre-commit',
    'git commit -m "docs: how to uninstall pre-commit"',
    'echo "pre-commit uninstall" >> docs/faq.md',
    'cat .git/hooks/pre-commit',
    'ls -la .git/hooks',
    'ls .git/hooks/',
    'rm .git/hooks/pre-commit.sample',
    'rm -f .git/hooks/*.sample',
    'cp scripts/pre-commit .git/hooks/pre-commit',
    'chmod +x .git/hooks/pre-commit',
    'chmod 755 .git/hooks/pre-commit',
    'git rev-parse --git-path hooks',
    'rm -rf node_modules/.cache',
    'rm src/hooks/pre-commit.ts',
    'rm -rf dist/hooks',
  ])('passes: %s', (c) => {
    expect(run(c), c).toHaveLength(0);
  });
});

describe('no-verify #433: commit paths that never run the pre-commit hook warn', () => {
  it.each([
    'git commit-tree HEAD^{tree} -p HEAD -m fix',
    'git commit-tree $(git write-tree) -p HEAD -m fix',
    'git update-ref refs/heads/main abc123',
    'git update-ref HEAD $sha',
    'git am 0001-fix.patch',
    'git am < fix.patch',
    'git am --3way fix.patch',
    'git cherry-pick abc123',
    'git cherry-pick -x abc..def',
    'git rebase main',
    'git rebase -i HEAD~3',
    'git rebase --onto main dev',
    'git -C . rebase origin/main',
    'git fetch origin && git rebase origin/main',
  ])('warns: %s', (c) => {
    const f = run(c);
    expect(f.length, c).toBe(1);
    expect(f[0].severity).toBe('warn');
    expect(f[0].message).toMatch(/without running the pre-commit hook/);
  });

  it('warns even though the policy says block — the path is a review prompt, not a gate', () => {
    expect(P.rules['no-verify'].severity).toBe('block');
    const f = run('git rebase main');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warn');
    expect(f[0].signoff.required).toBe(false);
  });

  it.each([
    'git rebase --no-verify main',
    'git am --no-verify 0001-fix.patch',
    'git cherry-pick --no-verify abc123',
    'git rebase --no-veri main',
  ])('the literal flag on any of them is still block: %s', (c) => {
    const f = run(c);
    expect(f.length, c).toBe(1);
    expect(f[0].severity).toBe('block');
  });

  it.each([
    'git rebase --continue',
    'git rebase --abort',
    'git rebase --skip',
    'git rebase --quit',
    'git rebase --edit-todo',
    'git cherry-pick --continue',
    'git cherry-pick --abort',
    'git cherry-pick --skip',
    'git cherry-pick -n abc123', // --no-commit: the commit that follows runs the hook
    'git cherry-pick --no-commit abc123',
    'git am --continue',
    'git am --abort',
    'git am --skip',
    'git am --show-current-patch',
    'git update-ref -d refs/heads/tmp',
    'git commit-graph write --reachable',
    'git update-index --refresh',
    'git log --cherry-pick --oneline main...dev',
    'git log -n 5 -- src/commit-tree.ts',
    'echo "git rebase main" >> docs/workflow.md',
    'npm run rebase',
  ])('passes: %s', (c) => {
    expect(run(c), c).toHaveLength(0);
  });
});

describe('no-verify #433: a value glued to its short option is not a flag cluster', () => {
  it.each([
    'git commit -mfinal',
    'git commit -mdone',
    'git commit -mn',
    'git commit -m "no -n here"',
    'git commit -am "fix" -mno',
    'git commit -qmfix',
    'git commit -Ffile',
    'git commit -Chead',
    'git commit -chead',
    'git commit -m x --author="N <n@x>"',
    'git commit --message=-n',
  ])('passes: %s', (c) => {
    expect(run(c), c).toHaveLength(0);
  });

  it.each([
    'git commit -n',
    'git commit -nm x',
    'git commit -anm x',
    'git commit -n -mfinal',
    'git commit -qn -m x',
    'git commit -an',
  ])('blocks: %s', (c) => {
    const f = run(c);
    expect(f.length, c).toBeGreaterThanOrEqual(1);
    expect(f[0].severity).toBe('block');
  });
});
