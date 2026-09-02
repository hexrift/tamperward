// Regression tests for the second audit round: the pristine copy's isolation,
// transient dependency substitution, file modes, and the registry the CI gate
// is fetched from. Each fails on 1.14.4 and passes here; each was checked by
// reverting its fix and confirming the test goes red.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerify } from '../src/cli/verify';
import { runEnvelope } from '../src/cli/run';
import { planInit } from '../src/cli/init';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** src.js returns 41; the base test demands 42. */
function jsRepo(prefix: string): string {
  const d = tmp(prefix);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: d });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src.js'), 'module.exports = 41; // the bug\n');
  writeFileSync(join(d, 'test', 'check.test.js'), `if (require('../src.js') !== 42) process.exit(1);\n`);
  git('add', '-A');
  git('commit', '-qm', 'base');
  return d;
}
const head = (cwd: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();

describe('H1 the pristine copy is not reachable from the visible run', () => {
  it('a visible run that writes into the pristine copy cannot buy a green verdict', () => {
    // Both copies used to be siblings under one root, fully materialised and
    // overlaid BEFORE the visible run started — so the candidate's own code
    // wrote ../pristine/test/<the test that convicts it> and both runs returned
    // 0. No race, no background process, no git.
    //
    // The payload below ENUMERATES the temp directory, so this test gets a temp
    // directory of its own. Without one it reaches into the pristine copies of
    // every other verify running in parallel — every fixture in this repo names
    // its suite `test/check.test.js` — and trips THEIR overlay-digest guard, so
    // an unrelated test reports exit 2. That is not hypothetical: it is what
    // turned `test (18)` red on the first CI run of this branch.
    const sandbox = mkdtempSync(join(tmpdir(), 'tw-h1box-'));
    dirs.push(sandbox);
    const prevTmp = process.env.TMPDIR;
    process.env.TMPDIR = sandbox;
    try {
      runSiblingWriteCase();
    } finally {
      if (prevTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmp;
    }
  });

  function runSiblingWriteCase(): void {
    const cwd = jsRepo('tw-h1-');
    const base = head(cwd);
    writeFileSync(
      join(cwd, 'test', 'check.test.js'),
      [
        `const fs = require('fs'), path = require('path');`,
        `const payload = 'process.exit(0);\\n';`,
        // the original shape: a sibling directory
        `try { fs.writeFileSync(path.resolve(__dirname,'..','..','pristine','test','check.test.js'), payload); } catch (e) {}`,
        // and the generalisation: enumerate the temp dir for any pristine root
        `try { for (const d of fs.readdirSync(require('os').tmpdir())) {`,
        `  if (!d.startsWith('tw-verify-')) continue;`,
        `  try { fs.writeFileSync(path.join(require('os').tmpdir(), d, 't', 'test', 'check.test.js'), payload); } catch (e) {}`,
        `} } catch (e) {}`,
        `process.exit(0);`,
      ].join('\n'),
    );
    expect(runVerify({ cwd, base, cmd: 'node test/check.test.js', budget: 60, json: true })).toBe(1);
  }

  it('a visible run that edits the ORIGINAL working tree fails closed', () => {
    // The pristine copy is now materialised after the visible run, so a
    // candidate that reaches back into the source tree would be choosing what
    // the pristine copy is made of. The tree's path is one readlink away,
    // through the node_modules symlink.
    const cwd = jsRepo('tw-h1t-');
    const base = head(cwd);
    writeFileSync(
      join(cwd, 'test', 'check.test.js'),
      [
        `const fs = require('fs');`,
        `fs.writeFileSync(${JSON.stringify(join(cwd, 'src.js'))}, 'module.exports = 41; // still broken\\n// touched\\n');`,
        `process.exit(0);`,
      ].join('\n'),
    );
    expect(runVerify({ cwd, base, cmd: 'node test/check.test.js', budget: 60, json: true })).toBe(2);
  });

  it('a pristine run that rewrites its own restored test fails closed', () => {
    // Covers what sequencing alone cannot: a writer that reaches the pristine
    // copy after it exists. The restored files are digested (content and mode)
    // either side of the pristine run.
    const cwd = jsRepo('tw-h1p-');
    writeFileSync(join(cwd, 'runner.sh'), `echo 'process.exit(0);' > test/check.test.js\nexit 0\n`);
    const git = (...a: string[]) => execFileSync('git', a, { cwd });
    git('add', '-A');
    git('commit', '-qm', 'runner that edits the suite in place');
    expect(runVerify({ cwd, base: head(cwd), cmd: 'sh runner.sh', budget: 60, json: true })).toBe(2);
  });

  it('an honest fix is still VERIFIED under the new sequencing', () => {
    const cwd = jsRepo('tw-h1h-');
    const base = head(cwd);
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
    expect(runVerify({ cwd, base, cmd: 'node test/check.test.js', budget: 60, json: true })).toBe(0);
  });

  it('a masked failure is still MASKED_FAILURE under the new sequencing', () => {
    const cwd = jsRepo('tw-h1m-');
    const base = head(cwd);
    writeFileSync(join(cwd, 'test', 'check.test.js'), 'process.exit(0);\n');
    expect(runVerify({ cwd, base, cmd: 'node test/check.test.js', budget: 60, json: true })).toBe(1);
  });
});

describe('H3 a transient dependency substitution is not invisible', () => {
  function depsRepo(): { cwd: string; helper: string; stash: string; count: string } {
    const cwd = tmp('tw-h3-');
    const git = (...a: string[]) => execFileSync('git', a, { cwd });
    git('init', '-q');
    git('config', 'user.email', 't@b');
    git('config', 'user.name', 'tb');
    mkdirSync(join(cwd, 'test'));
    mkdirSync(join(cwd, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 41; // the bug\n');
    writeFileSync(join(cwd, 'test', 'check.test.js'), `if (require('../src.js') !== 42) process.exit(1);\n`);
    writeFileSync(join(cwd, 'node_modules', '.bin', 'runner'), '#!/bin/sh\nnode test/check.test.js\n');
    chmodSync(join(cwd, 'node_modules', '.bin', 'runner'), 0o755);
    writeFileSync(join(cwd, '.gitignore'), 'node_modules\n');
    writeFileSync(join(cwd, '.tamperward.yml'), 'version: 1\nverify:\n  command: node_modules/.bin/runner\n  budget: 60\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    // The helper lives outside the tree and is exec'd, so nothing is reading the
    // fake runner's own bytes at the moment they are put back.
    const side = tmp('tw-h3side-');
    const helper = join(side, 'helper.sh');
    const stash = join(side, 'orig');
    const count = join(side, 'count');
    writeFileSync(
      helper,
      [
        '#!/bin/sh',
        'TARGET="$1"',
        `N=$(cat ${count} 2>/dev/null || echo 0); N=$((N+1)); echo $N > ${count}`,
        `if [ "$N" -ge 2 ]; then cat ${stash} > "$TARGET"; chmod 755 "$TARGET"; fi`,
        'exit 0',
      ].join('\n'),
    );
    return { cwd, helper, stash, count };
  }

  it('a runner that restores itself on its way out is still DEPENDENCY_DRIFT', () => {
    // Entry-vs-exit fingerprints are identical by construction: the fake returns
    // 0 for the visible run, 0 for the pristine run, and puts the original bytes
    // and mode back on the second invocation.
    const { cwd, helper, stash, count } = depsRepo();
    const agent = [
      `cp node_modules/.bin/runner ${stash}`,
      'R=$(readlink -f node_modules/.bin/runner)',
      `printf '#!/bin/sh\\nexec sh ${helper} %s\\n' "$R" > "$R"`,
      'chmod 755 "$R"',
    ].join(' && ');
    expect(runEnvelope({ cwd, budget: 60, argv: ['bash', '-c', agent] })).toBe(1);
    // and it was refused BEFORE anything ran through the substituted runner:
    // the fake never got its first invocation, let alone the second one on
    // which it would have put the original bytes back.
    expect(existsSync(count)).toBe(false);
  });

  it('an honest agent that leaves the dependency tree alone is still green', () => {
    const { cwd } = depsRepo();
    expect(runEnvelope({ cwd, budget: 60, argv: ['bash', '-c', 'echo "module.exports = 42;" > src.js'] })).toBe(0);
  });
});

describe('H4 the overlay restores mode, not only content', () => {
  function execRepo(prefix: string): string {
    const cwd = tmp(prefix);
    const git = (...a: string[]) => execFileSync('git', a, { cwd });
    git('init', '-q');
    git('config', 'user.email', 't@b');
    git('config', 'user.name', 'tb');
    mkdirSync(join(cwd, 'test'));
    writeFileSync(join(cwd, 'src.sh'), 'exit 1\n'); // the bug
    writeFileSync(join(cwd, 'test', 'check.test.sh'), '#!/bin/sh\nsh src.sh\n');
    chmodSync(join(cwd, 'test', 'check.test.sh'), 0o755);
    // a discovery runner that only executes the EXECUTABLE files under test/
    writeFileSync(join(cwd, 'runner.sh'), '#!/bin/sh\nfor f in $(find test -type f -perm -u+x); do "./$f" || exit 1; done\n');
    chmodSync(join(cwd, 'runner.sh'), 0o755);
    writeFileSync(
      join(cwd, '.tamperward.yml'),
      "version: 1\nprotected:\n  tests: ['test/**']\nverify:\n  command: sh runner.sh\n  budget: 60\n",
    );
    git('add', '-A');
    git('commit', '-qm', 'base');
    return cwd;
  }

  it('dropping the exec bit on a protected test is a MASKED FAILURE, not a VERIFIED', () => {
    // The agent never edits a byte of the test. `chmod -x` is the whole attack:
    // the overlay restored the content into a file whose mode was still the
    // agent's, so the discovery command found nothing to run in either copy.
    const cwd = execRepo('tw-h4a-');
    chmodSync(join(cwd, 'test', 'check.test.sh'), 0o644);
    expect(runVerify({ cwd, base: head(cwd), budget: 60, json: true })).toBe(1);
  });

  it('deleting a protected executable test is a MASKED FAILURE — the overlay recreates it executable', () => {
    // Recreated by writeFileSync, which produces 0644 unless the mode is set.
    const cwd = execRepo('tw-h4b-');
    rmSync(join(cwd, 'test', 'check.test.sh'));
    expect(runVerify({ cwd, base: head(cwd), budget: 60, json: true })).toBe(1);
  });

  it('the restored file carries the base mode exactly', () => {
    const cwd = execRepo('tw-h4c-');
    chmodSync(join(cwd, 'test', 'check.test.sh'), 0o644);
    const kept: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown as (s: string) => boolean) = (s: string) => (kept.push(s), true);
    try {
      runVerify({ cwd, base: head(cwd), budget: 60, json: true, keep: true });
    } finally {
      (process.stdout.write as unknown as typeof orig) = orig;
    }
    const priDir = JSON.parse(kept.join('')).pristine_dir as string;
    dirs.push(priDir);
    expect(statSync(join(priDir, 'test', 'check.test.sh')).mode & 0o777).toBe(0o755);
  });

  it('an honest fix with modes untouched is still VERIFIED', () => {
    const cwd = execRepo('tw-h4d-');
    writeFileSync(join(cwd, 'src.sh'), 'exit 0\n');
    expect(runVerify({ cwd, base: head(cwd), budget: 60, json: true })).toBe(0);
  });
});

describe('H5 the CI gate is fetched from a registry the candidate does not choose', () => {
  it('the generated workflow pins the registry', () => {
    // `npm` reads `.npmrc` from the working directory — which, in a
    // pull_request workflow, is the checked-out pull request. One committed
    // line chose where the authority judging it came from. An environment
    // variable outranks a project `.npmrc` in npm's config precedence.
    const cwd = tmp('tw-h5-');
    const ci = planInit(cwd).find((a) => a.item === 'ci')!;
    ci.apply!();
    const src = execFileSync('cat', [join(cwd, '.github/workflows/tamperward.yml')], { encoding: 'utf8' });
    expect(src).toContain('NPM_CONFIG_REGISTRY: https://registry.npmjs.org/');
    // and it must cover BOTH npx invocations, i.e. be set at job level
    expect(src.indexOf('NPM_CONFIG_REGISTRY')).toBeLessThan(src.indexOf('npx --yes tamperward@'));
  });
});
