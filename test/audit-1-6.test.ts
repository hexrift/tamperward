// Regression tests for the 1.14.4 audit findings.
//
// Every one of these fails on the 1.14.3 code and passes here; each was checked
// by reverting its fix and confirming the test goes red (the mutation check the
// programme adopted after shipping two vacuously-passing tests).

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerify } from '../src/cli/verify';
import { runEnvelope } from '../src/cli/run';
import { preToolUseFromRaw } from '../src/cli/hook';
import { planInit } from '../src/cli/init';
import { policyWeakening } from '../src/detectors/policy-diff';
import { parsePolicy } from '../src/policy-load';
import { objectRewriteState } from '../src/git/trusted';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A repo whose suite is driven by a RUNNER the agent can write: `runner.js`
 *  requires the test file, which requires src.js. Base ships the bug. */
function runnerRepo(): string {
  const d = tmp('tw-a1-');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: d });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src.js'), 'module.exports = 41; // bug: should be 42\n');
  writeFileSync(join(d, 'test', 'check.test.js'), `const v = require('../src.js');\nif (v !== 42) process.exit(1);\n`);
  writeFileSync(join(d, 'runner.js'), `require('./test/check.test.js');\n`);
  git('add', '-A');
  git('commit', '-qm', 'base: failing suite, runner outside every protected class');
  return d;
}

describe('#1 the verifier executes files nothing restored', () => {
  it('IMPLICIT: rewriting the runner named in the command cannot buy a green pristine run', () => {
    // 1.14.3 froze the command STRING (`node runner.js`) against the base
    // policy. It did not freeze runner.js — which is in no protected class and
    // on no runner's config surface — so the pristine run, whose entire job is
    // to execute code the agent did not write, executed the agent's runner.
    const cwd = runnerRepo();
    writeFileSync(join(cwd, 'runner.js'), 'process.exit(0); // "all tests pass"\n');
    expect(runVerify({ cwd, cmd: 'node runner.js', budget: 30, json: true })).toBe(1);
  });

  it('IMPLICIT: an honest fix through the same command is still VERIFIED', () => {
    const cwd = runnerRepo();
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
    expect(runVerify({ cwd, cmd: 'node runner.js', budget: 30, json: true })).toBe(0);
  });

  it('EXPLICIT: verify.inputs restores what the command DELEGATES to', () => {
    // `run.sh` is named in the command, so the implicit half restores it — and
    // it delegates to scripts/inner.sh, which nothing names. That is the shape
    // of `npm test` -> package.json -> scripts/test.sh, without needing npm.
    const cwd = tmp('tw-a1d-');
    const git = (...a: string[]) => execFileSync('git', a, { cwd });
    git('init', '-q');
    git('config', 'user.email', 't@b');
    git('config', 'user.name', 'tb');
    mkdirSync(join(cwd, 'test'));
    mkdirSync(join(cwd, 'scripts'));
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 41;\n');
    writeFileSync(join(cwd, 'test', 'check.test.js'), `const v = require('../src.js');\nif (v !== 42) process.exit(1);\n`);
    writeFileSync(join(cwd, 'run.sh'), 'sh scripts/inner.sh\n');
    writeFileSync(join(cwd, 'scripts', 'inner.sh'), 'node test/check.test.js\n');
    writeFileSync(
      join(cwd, '.tamperward.yml'),
      "version: 1\nverify:\n  command: sh run.sh\n  budget: 30\n  inputs: ['scripts/**']\n",
    );
    git('add', '-A');
    git('commit', '-qm', 'base: delegating runner');

    // the tamper: gut the delegated script, leave the bug in place
    writeFileSync(join(cwd, 'scripts', 'inner.sh'), 'exit 0\n');
    expect(runVerify({ cwd, base: 'HEAD', budget: 30, json: true })).toBe(1);
  });

  it('EXPLICIT: an added file under verify.inputs is removed from the pristine run', () => {
    // The added-conftest.py argument, one layer down: a NEW input to the
    // verifier is no more the base's than a new protected file is.
    const cwd = tmp('tw-a1a-');
    const git = (...a: string[]) => execFileSync('git', a, { cwd });
    git('init', '-q');
    git('config', 'user.email', 't@b');
    git('config', 'user.name', 'tb');
    mkdirSync(join(cwd, 'test'));
    mkdirSync(join(cwd, 'scripts'));
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 41;\n');
    writeFileSync(join(cwd, 'test', 'check.test.js'), `const v = require('../src.js');\nif (v !== 42) process.exit(1);\n`);
    // run.sh sources every scripts/*.sh first, then runs the suite: an added
    // one is executed by the restored runner.
    writeFileSync(join(cwd, 'run.sh'), 'for f in scripts/*.sh; do . "$f"; done\nnode test/check.test.js\n');
    writeFileSync(join(cwd, 'scripts', 'setup.sh'), ':\n');
    writeFileSync(
      join(cwd, '.tamperward.yml'),
      "version: 1\nverify:\n  command: sh run.sh\n  budget: 30\n  inputs: ['scripts/**']\n",
    );
    git('add', '-A');
    git('commit', '-qm', 'base');

    writeFileSync(join(cwd, 'scripts', 'zz-shortcut.sh'), 'exit 0\n'); // added, not at base
    expect(runVerify({ cwd, base: 'HEAD', budget: 30, json: true })).toBe(1);
  });

  it('verify.inputs survives policy parsing', () => {
    // It shipped once as a field that parsed, validated, and was then dropped
    // when parsePolicy rebuilt the verify block field-by-field.
    const p = parsePolicy({ verify: { command: 'sh run.sh', budget: 30, inputs: ['scripts/**'] } });
    expect(p.verify?.inputs).toEqual(['scripts/**']);
  });

  it('narrowing verify.inputs is policy weakening', () => {
    const before = "verify:\n  command: sh run.sh\n  inputs: ['scripts/**', 'tools/**']\n";
    const after = "verify:\n  command: sh run.sh\n  inputs: ['scripts/**']\n";
    expect(policyWeakening(before, after)?.join(' ')).toMatch(/verify\.inputs narrowed/);
    expect(policyWeakening(before, before)).toEqual([]);
  });
});

describe('#2 git object rewriting redirects the trusted base', () => {
  it('a replace ref cannot make the pristine overlay read the agent\'s own tree', () => {
    // `git replace <base> <forged>` makes every read of <base> — ls-tree, show,
    // merge-base — return the forged object instead. No ref moves, no tracked
    // file changes, and the pristine overlay restores the agent's weakened test
    // as if it were the base's. Reproduced as VERIFIED on 1.14.3.
    const cwd = runnerRepo();
    const git = (...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
    const base = git('rev-parse', 'HEAD').trim();

    // the tamper: neuter the test, commit it on a side branch, then point the
    // base at that commit through the replace mechanism and restore the branch.
    writeFileSync(join(cwd, 'test', 'check.test.js'), 'process.exit(0);\n');
    git('add', '-A');
    git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'forged');
    const forged = git('rev-parse', 'HEAD').trim();
    git('reset', '-q', '--hard', base);
    writeFileSync(join(cwd, 'test', 'check.test.js'), 'process.exit(0);\n'); // visible green
    git('replace', '-f', base, forged);

    expect(runVerify({ cwd, base, cmd: 'node runner.js', budget: 30, json: true })).toBe(1);
  });

  it('a replace ref cannot make the overlay forget a base test exists', () => {
    // The other half of the same mechanism: `git show` decides the CONTENT of a
    // restored file, `git ls-tree` decides WHICH files exist at the base. A
    // forged base whose tree simply omits a test restores nothing for it, and
    // the deletion the agent performed is never undone — with no file left
    // behind for any other layer to notice.
    const cwd = tmp('tw-a2t-');
    const git = (...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 't@b');
    git('config', 'user.name', 'tb');
    mkdirSync(join(cwd, 'test'));
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 41; // bug\n');
    writeFileSync(join(cwd, 'test', 'check.test.js'), `if (typeof require('../src.js') !== 'number') process.exit(1);\n`);
    writeFileSync(join(cwd, 'test', 'second.test.js'), `if (require('../src.js') !== 42) process.exit(1);\n`);
    // A runner that COLLECTS: a test file that isn't there is simply not run,
    // which is the whole value of deleting one.
    writeFileSync(
      join(cwd, 'runner.js'),
      `for (const f of require('fs').readdirSync('test').sort()) require('./test/' + f);\n`,
    );
    git('add', '-A');
    git('commit', '-qm', 'base: two tests, one of them failing');
    const base = git('rev-parse', 'HEAD').trim();

    // the tamper: delete the failing test, then forge a base that never had it
    rmSync(join(cwd, 'test', 'second.test.js'));
    git('add', '-A');
    git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'forged: base without the failing test');
    const forged = git('rev-parse', 'HEAD').trim();
    git('replace', '-f', base, forged);

    expect(runVerify({ cwd, base, cmd: 'node runner.js', budget: 30, json: true })).toBe(1);
  });

  it('objectRewriteState moves when a replace ref appears', () => {
    const cwd = runnerRepo();
    const git = (...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
    const before = objectRewriteState(cwd);
    const base = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
    git('add', '-A');
    git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'other');
    const other = git('rev-parse', 'HEAD').trim();
    expect(objectRewriteState(cwd)).toBe(before); // an ordinary commit is not a rewrite
    git('replace', '-f', base, other);
    expect(objectRewriteState(cwd)).not.toBe(before);
  });

  it('objectRewriteState moves when info/grafts appears', () => {
    const cwd = runnerRepo();
    const before = objectRewriteState(cwd);
    mkdirSync(join(cwd, '.git', 'info'), { recursive: true });
    writeFileSync(join(cwd, '.git', 'info', 'grafts'), execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }));
    expect(objectRewriteState(cwd)).not.toBe(before);
  });

  it('the envelope convicts an agent that installs a replace ref, however green it looks', () => {
    // The agent leaves a tree that passes every check on its face — the bug is
    // genuinely fixed — and redirects the base underneath. The anchor moving is
    // the finding, exactly as a history rewrite is.
    const cwd = runnerRepo();
    const script =
      'BASE=$(git rev-parse HEAD) && ' +
      'echo "module.exports = 42;" > src.js && ' +
      'git -c user.email=a@b -c user.name=a commit -qam honest && ' +
      'git replace -f "$BASE" HEAD';
    expect(runEnvelope({ cwd, cmd: 'node runner.js', budget: 30, argv: ['bash', '-c', script] })).toBe(1);
  });

  it('the same honest agent WITHOUT the replace ref is green — the guard convicts the rewrite, not the fix', () => {
    const cwd = runnerRepo();
    const script =
      'echo "module.exports = 42;" > src.js && ' +
      'git -c user.email=a@b -c user.name=a commit -qam honest';
    expect(runEnvelope({ cwd, cmd: 'node runner.js', budget: 30, argv: ['bash', '-c', script] })).toBe(0);
  });
});

describe('#3 the generated CI workflow can be migrated', () => {
  const REL = '.github/workflows/tamperward.yml';
  const ciAction = (cwd: string, force = false) => planInit(cwd, { forceWorkflow: force }).find((a) => a.item === 'ci')!;
  const writeWorkflow = (cwd: string, body: string, stamp: string | null): void => {
    mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(cwd, REL), (stamp ?? '') + body);
  };
  const stampFor = (body: string, version: string): string =>
    `# tamperward:generated v${version} sha256:${createHash('sha256').update(body).digest('hex').slice(0, 16)}\n`;

  it('a workflow we generated and nobody edited is MIGRATED, not left stale', () => {
    // "already present — left untouched" made the CI template write-once per
    // repo: every repo wired before 1.9 still has no pristine-verify step, and
    // init reported it as correctly configured.
    const cwd = tmp('tw-a3-');
    const old = 'name: tamperward\n# an older template, without the verify step\n';
    writeWorkflow(cwd, old, stampFor(old, '1.8.0'));
    const a = ciAction(cwd);
    expect(a.status).toBe('update');
    a.apply!();
    const now = readFileSync(join(cwd, REL), 'utf8');
    expect(now).toContain('verify --require-ancestor');
    expect(ciAction(cwd).status).toBe('ok'); // idempotent: no second migration
  });

  it('a workflow we generated and someone EDITED is never overwritten', () => {
    const cwd = tmp('tw-a3e-');
    const old = 'name: tamperward\n# an older template\n';
    writeWorkflow(cwd, old + '      - name: our own extra step\n', stampFor(old, '1.8.0'));
    const a = ciAction(cwd);
    expect(a.status).toBe('skip');
    expect(a.apply).toBeUndefined();
    expect(a.detail).toMatch(/--force-workflow/);
  });

  it('a workflow we did not write is never overwritten', () => {
    const cwd = tmp('tw-a3u-');
    writeWorkflow(cwd, 'name: somebody else\non: push\n', null);
    expect(ciAction(cwd).status).toBe('skip');
  });

  it('--force-workflow replaces one we did not write', () => {
    const cwd = tmp('tw-a3f-');
    writeWorkflow(cwd, 'name: somebody else\non: push\n', null);
    const a = ciAction(cwd, true);
    expect(a.status).toBe('update');
    a.apply!();
    expect(readFileSync(join(cwd, REL), 'utf8')).toContain('verify --require-ancestor');
  });

  it('a fresh install writes a stamped workflow that reads back as current', () => {
    const cwd = tmp('tw-a3n-');
    const a = ciAction(cwd);
    expect(a.status).toBe('create');
    a.apply!();
    expect(ciAction(cwd).status).toBe('ok');
  });
});

describe('#4 an existing PreToolUse matcher is repaired, not blessed', () => {
  const SHIPPED = (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }).version;
  const agentAction = (cwd: string) => planInit(cwd).find((a) => a.item === 'agent')!;
  const writeSettings = (cwd: string, matcher: string): void => {
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify(
        {
          hooks: {
            // Pinned to the shipped version, so these cases exercise the MATCHER repair
            // alone; an unpinned command is its own repair since 1.14.7 (init-pin.test.ts).
            PreToolUse: [{ matcher, hooks: [{ type: 'command', command: `npx --yes tamperward@${SHIPPED} hook claude` }] }],
            Stop: [{ hooks: [{ type: 'command', command: `npx --yes tamperward@${SHIPPED} sweep claude` }] }],
          },
        },
        null,
        2,
      ),
    );
  };
  const matcherOf = (cwd: string): string =>
    JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse[0].matcher;

  it('a pre-1.13 matcher missing NotebookEdit is widened', () => {
    const cwd = tmp('tw-a4-');
    writeSettings(cwd, 'Bash|Edit|Write|MultiEdit');
    const a = agentAction(cwd);
    expect(a.status).toBe('update');
    expect(a.detail).toMatch(/NotebookEdit/);
    a.apply!();
    expect(matcherOf(cwd).split('|')).toContain('NotebookEdit');
    expect(agentAction(cwd).status).toBe('ok'); // idempotent
  });

  it('a matcher the user widened keeps their tools', () => {
    const cwd = tmp('tw-a4w-');
    writeSettings(cwd, 'Bash|Edit|Write|MultiEdit|Task');
    agentAction(cwd).apply!();
    const tools = matcherOf(cwd).split('|');
    expect(tools).toContain('Task');
    expect(tools).toContain('NotebookEdit');
  });

  it('a wildcard matcher already covers everything — nothing to repair', () => {
    const cwd = tmp('tw-a4s-');
    writeSettings(cwd, '*');
    expect(agentAction(cwd).status).toBe('ok');
  });

  it('a complete matcher is left alone', () => {
    const cwd = tmp('tw-a4c-');
    writeSettings(cwd, 'Bash|Edit|Write|MultiEdit|NotebookEdit');
    expect(agentAction(cwd).status).toBe('ok');
  });
});

describe('#6 the hook fails closed on a payload it cannot read', () => {
  const denied = (raw: string): boolean => {
    const r = preToolUseFromRaw(raw);
    if (r.stdout === '') return false;
    return JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision === 'deny';
  };

  it.each([
    ['not json at all', 'not json at all'],
    ['truncated object', '{"broken":'],
    ['a JSON array', '[1,2,3]'],
    ['a bare scalar', '"just a string"'],
    ['null', 'null'],
  ])('%s → deny, not allow', (_name, raw) => {
    expect(denied(raw)).toBe(true);
  });

  it('a deny for an unreadable payload is still exit 0 with JSON on stdout', () => {
    // exit 2 makes Claude Code IGNORE the JSON and fall back to the stderr
    // channel, which is not a deny at all.
    const r = preToolUseFromRaw('{"broken":');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('"permissionDecision":"deny"');
  });

  it('genuinely empty stdin is still an allow', () => {
    // A well-formed ABSENCE of a tool call, not a failure to read one — and how
    // the wiring is smoke-tested (`tamperward hook claude < /dev/null`).
    expect(preToolUseFromRaw('')).toEqual({ exitCode: 0, stdout: '' });
    expect(preToolUseFromRaw('   \n')).toEqual({ exitCode: 0, stdout: '' });
  });

  it('a well-formed benign payload is still an allow', () => {
    const cwd = tmp('tw-a6-');
    execFileSync('git', ['init', '-q'], { cwd });
    const raw = JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command: 'ls -la' } });
    expect(preToolUseFromRaw(raw).stdout).toBe('');
  });
});
