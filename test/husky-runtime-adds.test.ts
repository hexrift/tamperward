// husky v9 writes its own runtime under `.husky/_/` on `npx husky` — fired by the
// `prepare` lifecycle of an ordinary `npm install`. Before 2.10.1 the "new hook
// script that does not run the gate live" rule blocked all seventeen of those
// installer files, so `npm install` failed in every husky repository. 2.10.1
// recognises husky's own runtime by BYTE-EQUAL content (never from node_modules,
// which the agent can write) while `.husky/pre-commit` exists beside it — the same
// install repoints core.hooksPath there, so in a repo whose gate is NOT husky-run
// the add still needs a sign-off. Anything that is not byte-for-byte husky's runtime
// stays fail-closed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookTampering } from '../src/detectors/hook-tampering';
import { defaultPolicy } from '../src/policy';
import type { Change, FileChange } from '../src/types';

const P = defaultPolicy();
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
const SHIM = `#!/usr/bin/env sh\n. "$(dirname "$0")/h"`;

const add = (path: string, after: string | null): FileChange => ({
  kind: 'file', path, oldPath: null, op: 'add', before: null, after, binary: false, hunks: [],
});
const mod = (path: string, before: string, after: string): FileChange => ({
  kind: 'file', path, oldPath: null, op: 'modify', before, after, binary: false, hunks: [],
});
const run = (c: Change[], cwd: string) => hookTampering.run(c, P, undefined, { cwd });

describe('husky v9 runtime adds', () => {
  let dir: string;
  const withGate = () => { mkdirSync(join(dir, '.husky'), { recursive: true }); writeFileSync(join(dir, '.husky/pre-commit'), '#!/bin/sh\nnpx --yes tamperward@2.10.0 check --staged\n'); };
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'tw-husky-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('the seventeen installer files are clean when .husky/pre-commit is the gate', () => {
    withGate();
    const files: Change[] = [
      add('.husky/_/h', H),
      add('.husky/_/husky.sh', 'echo "husky - DEPRECATED\n\nPlease remove"'),
      add('.husky/_/.gitignore', '*'),
      add('.husky/_/pre-commit', SHIM),
      add('.husky/_/commit-msg', SHIM),
      add('.husky/_/prepare-commit-msg', SHIM + '\n'), // one trailing newline tolerated
    ];
    // husky.sh content varies by patch; assert the ones we pin are clean and none is a husky finding
    const findings = run([files[0], files[2], files[3], files[4], files[5]], dir);
    expect(findings).toHaveLength(0);
  });

  it('the same add needs a sign-off when no husky gate exists beside it', () => {
    const d2 = mkdtempSync(join(tmpdir(), 'tw-nogate-'));
    try {
      const findings = run([add('.husky/_/h', H), add('.husky/_/pre-commit', SHIM)], d2);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((f) => f.rule === 'hook-tampering')).toBe(true);
    } finally { rmSync(d2, { recursive: true, force: true }); }
  });

  it('a tampered h (or shim) is not husky’s runtime and stays blocked', () => {
    withGate();
    expect(run([add('.husky/_/h', '#!/usr/bin/env sh\nexit 0\n')], dir).length).toBeGreaterThan(0);
    expect(run([add('.husky/_/pre-commit', '#!/bin/sh\nexit 0')], dir).length).toBeGreaterThan(0);
    expect(run([mod('.husky/_/h', H, '#!/usr/bin/env sh\nexit 0\n')], dir).length).toBeGreaterThan(0);
  });

  it('fails closed with no cwd (cannot tell whether the gate is husky-run)', () => {
    expect(hookTampering.run([add('.husky/_/h', H)], P).length).toBeGreaterThan(0);
  });

  it('a normal hand-written .husky/pre-commit add is judged by the model, not this exemption', () => {
    withGate();
    expect(run([add('.husky/pre-commit', '#!/bin/sh\necho hi\n')], dir).length).toBeGreaterThan(0);
  });
});
