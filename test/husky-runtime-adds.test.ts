// husky v9 writes its own runtime under `.husky/_/` on `npx husky` — fired by the
// `prepare` lifecycle of an ordinary `npm install`. Before 2.10.1 the "new hook
// script that does not run the gate live" rule blocked all seventeen of those
// installer files, so `npm install` failed in every husky repository. 2.10.1
// recognises husky's own runtime by BYTE-EQUAL content (never from node_modules,
// which the agent can write) while `.husky/pre-commit` ITSELF RUNS A LIVE
// `tamperward check` — not merely exists: an ordinary husky pre-commit (say
// `npm test`) whose real gate is elsewhere would otherwise let the install
// repoint core.hooksPath and displace the backstop. Anything that is not
// byte-for-byte husky's, or a pre-commit that does not run the gate live, stays
// fail-closed. This allowlist is security-sensitive, so every recognised filename
// and content variant is exercised here.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookTampering } from '../src/detectors/hook-tampering';
import { defaultPolicy } from '../src/policy';
import type { Change, FileChange } from '../src/types';

const P = defaultPolicy();

// The two pinned `h` variants and the pinned deprecation, byte-for-byte.
const H = `#!/usr/bin/env sh
[ "$HUSKY" = "2" ] && set -x
n=$(basename "$0")
s=$(dirname "$(dirname "$0")")/$n

[ ! -f "$s" ] && exit 0

if [ -f "$HOME/.huskyrc" ]; then
	echo "husky - '~/.huskyrc' is DEPRECATED, please move your code to ~/.config/husky/init.sh"
fi
i="\${XDG_CONFIG_HOME:-$HOME/.config}/husky/init.sh"
[ -f "$i" ] && . "$i"

[ "\${HUSKY-}" = "0" ] && exit 0

export PATH="node_modules/.bin:$PATH"
sh -e "$s" "$@"
c=$?

[ $c != 0 ] && echo "husky - $n script failed (code $c)"
[ $c = 127 ] && echo "husky - command not found in PATH=$PATH"
exit $c
`;
const HUSKY_SH = `echo "husky - DEPRECATED

Please remove the following two lines from $0:

#!/usr/bin/env sh
. \\"\\$(dirname -- \\"\\$0\\")/_/husky.sh\\"

They WILL FAIL in v10.0.0
"`;
const SHIM = `#!/usr/bin/env sh\n. "$(dirname "$0")/h"`;
const SHIM_NAMES = ['applypatch-msg', 'commit-msg', 'post-applypatch', 'post-checkout', 'post-commit', 'post-merge', 'post-rewrite', 'pre-applypatch', 'pre-auto-gc', 'pre-commit', 'pre-merge-commit', 'pre-push', 'pre-rebase', 'prepare-commit-msg'];
const GATE = '#!/bin/sh\nnpx --yes tamperward@2.10.1 check --staged\n';

const add = (path: string, after: string | null): FileChange => ({
  kind: 'file', path, oldPath: null, op: 'add', before: null, after, binary: false, hunks: [],
});
const mod = (path: string, before: string, after: string): FileChange => ({
  kind: 'file', path, oldPath: null, op: 'modify', before, after, binary: false, hunks: [],
});
const run = (c: Change[], cwd: string) => hookTampering.run(c, P, undefined, { cwd });

// Every file `npx husky` writes under .husky/_/ in husky 9.1.x.
const installerFiles = (): Change[] => [
  add('.husky/_/h', H),
  add('.husky/_/husky.sh', HUSKY_SH),
  add('.husky/_/.gitignore', '*'),
  ...SHIM_NAMES.map((n) => add(`.husky/_/${n}`, SHIM)),
];

describe('husky v9 runtime adds', () => {
  let dir: string;
  const gate = (body = GATE) => { mkdirSync(join(dir, '.husky'), { recursive: true }); writeFileSync(join(dir, '.husky/pre-commit'), body); };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tw-husky-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('all seventeen installer files are clean when .husky/pre-commit runs the gate live', () => {
    gate();
    expect(installerFiles().length).toBe(17);
    expect(run(installerFiles(), dir)).toHaveLength(0);
  });

  it('each of the seventeen files individually is clean', () => {
    gate();
    for (const c of installerFiles()) expect(run([c], dir)).toHaveLength(0);
  });

  it('one newline of slack is tolerated (husky may or may not terminate a file)', () => {
    gate();
    // shims and .gitignore ship WITHOUT a trailing newline; +1 must still be clean.
    expect(run([add('.husky/_/commit-msg', SHIM + '\n')], dir)).toHaveLength(0);
    expect(run([add('.husky/_/.gitignore', '*\n')], dir)).toHaveLength(0);
    // `h` ships WITH one; dropping it must still be clean.
    expect(run([add('.husky/_/h', H.replace(/\n$/, ''))], dir)).toHaveLength(0);
  });

  it('SECURITY: an ordinary husky pre-commit (npm test) is not a Tamperward gate — the runtime adds stay findings', () => {
    gate('#!/usr/bin/env sh\nnpm test\n');
    const findings = run(installerFiles(), dir);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.rule === 'hook-tampering')).toBe(true);
  });

  it('SECURITY: a pre-commit whose gate is neutered (|| true) is not live — adds stay findings', () => {
    gate('#!/bin/sh\nnpx --yes tamperward@2.10.1 check --staged || true\n');
    expect(run(installerFiles(), dir).length).toBeGreaterThan(0);
  });

  it('no .husky/pre-commit at all → the adds need a sign-off', () => {
    expect(run([add('.husky/_/h', H)], dir).length).toBeGreaterThan(0);
  });

  it('a tampered h, shim, husky.sh, or .gitignore is not husky’s runtime and stays blocked', () => {
    gate();
    expect(run([add('.husky/_/h', '#!/usr/bin/env sh\nexit 0\n')], dir).length).toBeGreaterThan(0);
    expect(run([add('.husky/_/pre-commit', '#!/bin/sh\nexit 0')], dir).length).toBeGreaterThan(0);
    expect(run([add('.husky/_/husky.sh', 'echo hi')], dir).length).toBeGreaterThan(0);
    expect(run([add('.husky/_/.gitignore', 'node_modules')], dir).length).toBeGreaterThan(0);
    expect(run([mod('.husky/_/h', H, '#!/usr/bin/env sh\nexit 0\n')], dir).length).toBeGreaterThan(0);
  });

  it('a shim under a name husky does not write is not recognised', () => {
    gate();
    expect(run([add('.husky/_/evil', SHIM)], dir).length).toBeGreaterThan(0);
  });

  it('fails closed with no cwd (cannot read the pre-commit to check the gate)', () => {
    expect(hookTampering.run([add('.husky/_/h', H)], P).length).toBeGreaterThan(0);
  });

  it('a normal hand-written .husky/pre-commit add is judged by the model, not this exemption', () => {
    gate();
    expect(run([add('.husky/pre-commit', '#!/bin/sh\necho hi\n')], dir).length).toBeGreaterThan(0);
  });
});
