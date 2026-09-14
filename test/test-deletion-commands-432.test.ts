// #432 — test-deletion's command surface: the spellings hook-tampering already
// reads (`unlink`, `shred`, `sponge`, `dd of=`, `mv <x> <spec>`, a fed `xargs rm`,
// embedded quotes and backslashes, simple globs against the listing) reach the
// spec too, and `rm`/`truncate` are read in COMMAND position after wrappers, so a
// grep for the word or a script named after it is not a deletion.

import { describe, expect, it } from 'vitest';
import { defaultPolicy } from '../src/policy';
import { testDeletion } from '../src/detectors/test-deletion';
import { hookTampering } from '../src/detectors/hook-tampering';
import type { CommandChange } from '../src/types';

const P = defaultPolicy();
const cmd = (raw: string): CommandChange => ({ kind: 'command', raw, argv: raw.split(/\s+/) });
const LISTING = ['test/a.test.ts', 'test/b.test.ts', 'src/junk.ts', 'src/index.ts', 'scripts/rm-cache.js', 'package.json', '.husky/pre-commit'];
const ctx = { trackedFiles: LISTING };
const td = (c: string, ctx2 = ctx) => testDeletion.run([cmd(c)], P, undefined, ctx2).map((f) => `${f.severity}: ${f.message}`).join(' ');

describe('#432 · command spellings that remove or overwrite a spec block', () => {
  it.each([
    // the nine bypasses from the issue
    'unlink test/a.test.ts',
    'mv src/junk.ts test/a.test.ts',
    'echo test/a.test.ts | xargs rm',
    'find . -name "*.test.ts" | xargs rm',
    'dd if=/dev/null of=test/a.test.ts',
    'rm test/a.te""st.ts',
    'rm test/a.te\\st.ts',
    'rm test/a.test.{ts}',
    'rm test/a.tes?.ts',
    // the neighbours
    'shred -u test/a.test.ts',
    'echo x | sponge test/a.test.ts',
    'sudo rm -f test/a.test.ts',
    'env rm test/a.test.ts',
    'command rm test/a.test.ts',
    'nice rm test/a.test.ts',
    'time rm test/a.test.ts',
    'FOO=1 rm test/a.test.ts',
    '/bin/rm test/a.test.ts',
    "rm 'test/a.te'st.ts",
    'rm test/*.test.ts',
    'rm test/a.test.{ts,js}',
    'rm -- test/a.test.ts',
    'ls test/*.test.ts | xargs rm -f',
    'printf test/a.test.ts | xargs -n1 unlink',
    'echo test/a.test.ts | xargs -I{} truncate -s0 {}',
    'echo test/a.test.ts | xargs shred -u',
    'echo test/a.test.ts | xargs sed -i s/expect/x/',
    'echo test/a.test.ts | xargs mv -t /tmp',
    'sudo truncate -s 0 test/a.test.ts',
    'mv -f src/junk.ts test/a.test.ts',
    'install src/junk.ts test/a.test.ts',
    'ln -sf /dev/null test/a.test.ts',
    'rsync src/junk.ts test/a.test.ts',
    'cat /dev/null >| test/a.test.ts',
    'echo x &> test/a.test.ts',
    // controls that blocked before and still do
    'rm test/a.test.ts',
    'cp src/junk.ts test/a.test.ts',
    'cp /dev/null test/a.test.ts',
    'truncate -s 0 test/a.test.ts',
    'rm -rf test',
    'sed -i "/expect/d" test/a.test.ts',
    'echo > test/a.test.ts',
  ])('blocks: %s', (c) => {
    expect(td(c), c).toMatch(/^block: Test removed via shell/);
  });

  it('names the spelling in the message', () => {
    expect(td('unlink test/a.test.ts')).toMatch(/unlink deletes a test file/);
    expect(td('mv src/junk.ts test/a.test.ts')).toMatch(/mv overwrites a test file/);
    expect(td('echo test/a.test.ts | xargs rm')).toMatch(/xargs rm/);
    expect(td('dd if=/dev/null of=test/a.test.ts')).toMatch(/dd rewrites a test file/);
    expect(td('echo x | sponge test/a.test.ts')).toMatch(/sponge/);
    expect(td('shred -u test/a.test.ts')).toMatch(/shred deletes a test file/);
  });

  it('reads a glob the shell would expand against the listing', () => {
    expect(td('rm test/a.test.{ts}')).toMatch(/rm deletes a test file/);
    expect(td('rm src/*.ts')).toBe(''); // src/junk.ts, src/index.ts: no spec there
    expect(td('rm src/*.ts', { trackedFiles: ['src/x.test.ts', 'src/y.ts'] })).toMatch(/rm deletes/);
  });

  it('without a listing, a wildcard is read by its literal part', () => {
    expect(td('rm test/a.tes?.ts', undefined)).toMatch(/rm deletes/);
    expect(td('rm src/*.test.ts', undefined)).toMatch(/rm deletes/);
    expect(td('rm test/a.test.{ts}', undefined)).toMatch(/rm deletes/);
    expect(td('rm src/*.ts', undefined)).toBe('');
    expect(td('rm dist/*.js', undefined)).toBe('');
  });
});

describe('#432 · a read of a spec, or the word in another position, is clean', () => {
  it.each([
    // the three false blocks from the issue
    'grep -n "rm " test/a.test.ts',
    'grep truncate test/a.test.ts',
    'node scripts/rm-cache.js test/a.test.ts',
    // the neighbours
    'echo "rm test/a.test.ts"',
    'echo rm test/a.test.ts',
    'grep -c "truncate(" test/a.test.ts',
    'rg "\\brm\\b" test/',
    'cat test/a.test.ts | xargs echo',
    'echo test/a.test.ts | xargs cat',
    'echo test/a.test.ts | xargs wc -l',
    'find test -name "*.test.ts" | xargs grep -l rm',
    'find . -name "*.test.ts"',
    'dd if=test/a.test.ts of=/tmp/x',
    'mv test/a.test.ts test/c.test.ts',
    'mv src/junk.ts test/',
    'cp test/a.test.ts /tmp/',
    'cp test/a.test.ts test/c.test.ts',
    'cp -t /tmp test/a.test.ts',
    'sed -n 1,5p test/a.test.ts',
    'echo x | tee -a test/a.test.ts',
    'git diff -- test/a.test.ts',
    'git log --grep rm -- test/a.test.ts',
    'ls src | xargs rm',
    'rm src/junk.ts',
    'rm src/*.ts',
    'cat test/a.te""st.ts',
    'npm rm lodash',
    'yarn remove lodash',
    'git rm --cached src/junk.ts',
    'node -e "console.log(1)" test/a.test.ts',
    'npx vitest run test/a.test.ts',
    'wc -l test/*.test.ts',
    'ls test/a.tes?.ts',
    'rm -rf node_modules/.cache',
    'rm -rf dist',
  ])('does not flag: %s', (c) => {
    expect(td(c), c).toBe('');
  });
});

// hook-tampering and test-deletion read the same shell: every spelling that
// removes or overwrites a hook removes or overwrites a spec, and every read of
// one is a read of the other. `<f>` stands for the file each rule protects.
describe('#432 · hook-tampering and test-deletion agree on the shared shell corpus', () => {
  const ht = (c: string) => hookTampering.run([cmd(c)], P, undefined, ctx).map((f) => f.message).join(' ');
  const HOOK = '.husky/pre-commit';
  const SPEC = 'test/a.test.ts';
  it.each([
    'rm <f>',
    'rm -f <f>',
    'sudo rm <f>',
    'env rm <f>',
    '/bin/rm <f>',
    'unlink <f>',
    'shred -u <f>',
    'truncate -s 0 <f>',
    'echo x > <f>',
    'cat /dev/null >| <f>',
    'echo x &> <f>',
    'echo x | tee <f>',
    'echo x | sponge <f>',
    'dd if=/dev/null of=<f>',
    'cp /dev/null <f>',
    'install /dev/null <f>',
    'ln -sf /dev/null <f>',
    'sed -i s/x/y/ <f>',
    'perl -pi -e s/x/y/ <f>',
    'echo <f> | xargs rm',
    'echo <f> | xargs -n1 rm -f',
    'printf <f> | xargs -I{} sed -i s/x/y/ {}',
    'git checkout v1 -- <f>',
  ])('both flag: %s', (t) => {
    expect(ht(t.replace('<f>', HOOK)), t).toMatch(/Hook tampering via shell/);
    expect(td(t.replace('<f>', SPEC)), t).toMatch(/Test removed via shell/);
  });

  it.each([
    'cat <f>',
    'cat <f> > /tmp/backup',
    'cp <f> /tmp/',
    'cp -t /tmp <f>',
    'sed -n 1,5p <f>',
    'grep -n rm <f>',
    'grep truncate <f>',
    'echo <f> | xargs cat',
    'ls src | xargs rm',
    'git diff -- <f>',
    'dd if=<f> of=/tmp/x',
  ])('neither flags: %s', (t) => {
    expect(ht(t.replace('<f>', HOOK)), t).toBe('');
    expect(td(t.replace('<f>', SPEC)), t).toBe('');
  });
});
