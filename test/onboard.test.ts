// `tamperward onboard` — the interactive first-run path (#388). The contract under
// test: orchestration over the canonical init / verifier detection / verify /
// doctor primitives with an injected prompt answerer; nothing is written before
// an explicit confirmation; no inferred verifier command is ever written without
// operator acceptance; the demo runs only on disposable state it created and
// leaves the working tree byte-for-byte as it was; non-interactive stdin refuses
// unless scripted; abort and re-run are idempotent and diagnosable.

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { readlineAsker, runOnboard, type OnboardIo, type OnboardOpts } from '../src/cli/onboard';
import type { DoctorOutcome } from '../src/cli/doctor';
import { runInit } from '../src/cli/init';
import { loadPolicy } from '../src/policy-load';
import { treeFingerprint } from '../src/fingerprint';
import { guardedMain } from '../src/cli/main';
import { TW_VERSION } from '../src/wiring';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** A green JavaScript fixture: `npm test` runs `node test/check.test.js`, whose
 *  first statement is an `it(` block, so the demo has a skip target. */
function repo(opts: { pkg?: boolean; pytest?: boolean; origin?: boolean; commit?: boolean } = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-onboard-'));
  dirs.push(d);
  git(d, 'init', '-q');
  git(d, 'config', 'user.email', 't@b');
  git(d, 'config', 'user.name', 'acme');
  mkdirSync(join(d, 'test'));
  if (opts.pkg !== false) {
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node test/check.test.js' } }, null, 2) + '\n',
    );
  }
  if (opts.pytest) writeFileSync(join(d, 'pytest.ini'), '[pytest]\n');
  writeFileSync(join(d, 'src.js'), 'module.exports = 42;\n');
  writeFileSync(
    join(d, 'test', 'check.test.js'),
    "const v = require('../src.js');\nfunction it(name, fn) { fn(); }\n" +
      "it('returns 42', () => { if (v !== 42) { console.error('expected 42'); process.exit(1); } });\n",
  );
  if (opts.origin) git(d, 'remote', 'add', 'origin', 'https://github.com/acme/project.git');
  if (opts.commit !== false) {
    git(d, 'add', '-A');
    git(d, 'commit', '-qm', 'base');
  }
  return d;
}

interface Session {
  code: number;
  out: string;
  err: string;
  questions: string[];
}

/** Drive onboarding with a scripted answerer. `answers` are consumed in order;
 *  a `null` answer models the operator closing stdin (Ctrl-D / Ctrl-C). When the
 *  script runs out, the answer is an empty line (Enter = the default). */
async function onboard(
  cwd: string,
  answers: Array<string | null> = [],
  opts: Partial<OnboardOpts> = {},
  io: Partial<OnboardIo> = {},
): Promise<Session> {
  const questions: string[] = [];
  const queue = [...answers];
  const so = process.stdout.write;
  const se = process.stderr.write;
  let out = '';
  let err = '';
  process.stdout.write = ((chunk: unknown) => { out += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { err += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    const code = await runOnboard(
      { cwd, ...opts },
      {
        interactive: true,
        ask: async (question: string) => {
          questions.push(question);
          return queue.length ? queue.shift() ?? null : '';
        },
        ...io,
      },
    );
    return { code, out, err, questions };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

const WIRED = ['.tamperward.yml', '.claude/settings.json', '.git/hooks/pre-commit', '.github/workflows/tamperward.yml', '.github/CODEOWNERS'];
const wired = (d: string): boolean => WIRED.every((f) => existsSync(join(d, f)));
const snapshot = (d: string): Record<string, string> =>
  Object.fromEntries(WIRED.filter((f) => existsSync(join(d, f))).map((f) => [f, readFileSync(join(d, f), 'utf8')]));

describe('happy path', () => {
  it('walks a fresh repository to a diagnosed posture through the canonical primitives', async () => {
    const d = repo();
    // yes: continue past preflight is not asked on a clean tree; the questions are:
    // write the plan? / accept `npm test`? / run first verify? / run the demo? / check GitHub?
    const s = await onboard(d, ['y', 'y', 'y', 'y'], { noGithub: true });
    expect(s.err).toBe('');
    expect(s.out).toContain(`TamperWard ${TW_VERSION}`);
    expect(s.out).toMatch(/Preflight/);
    // Preview came from the init planner (dry-run rows), then explanations, then the write.
    expect(s.out).toMatch(/would create\s+\.tamperward\.yml/);
    expect(s.out).toMatch(/5 change\(s\) applied/);
    expect(wired(d)).toBe(true);
    // The verifier suggestion was accepted explicitly and written to the policy.
    expect(s.questions.some((q) => /npm test/.test(q) && /verify\.command/.test(q))).toBe(true);
    expect(loadPolicy(d).verify?.command).toBe('npm test');
    // The first verify ran through runVerify and was explained in plain language.
    expect(s.out).toMatch(/tamperward verify — verified/);
    expect(s.out).toMatch(/VERIFIED: your suite passes/);
    // The demo showed a real finding and restored the tree byte-for-byte.
    expect(s.out).toMatch(/BLOCK\s+test-skip/);
    expect(s.out).toMatch(/restored byte-for-byte/);
    // The posture came from doctor; the GitHub half is honestly unverified.
    expect(s.out).toMatch(/tamperward doctor: \[/);
    expect(s.out).toMatch(/^POSTURE: READY WITH WARNINGS/m);
    expect(s.out).toMatch(/GitHub repository authority: NOT VERIFIED/);
    // Next steps name the day-to-day command set and the container verifier.
    expect(s.out).toContain('tamperward check --worktree');
    expect(s.out).toContain('tamperward verify --base');
    expect(s.out).toContain('tamperward run --base');
    expect(s.out).toContain('tamperward doctor --github');
    expect(s.out).toMatch(/backend: container/);
    expect(s.code).toBe(0);
  });

  it('explains each enforcement point in one sentence before asking to write', async () => {
    const d = repo();
    const s = await onboard(d, ['n'], { noGithub: true, skipDemo: true });
    const preview = s.out.slice(0, s.out.indexOf('POSTURE'));
    for (const item of ['policy', 'hooks', 'pre-commit', 'CI', 'CODEOWNERS']) {
      expect(preview).toMatch(new RegExp(`${item}[^\\n]*—`));
    }
  });
});

describe('declined writes', () => {
  it('writes nothing when the operator declines the plan and reports an incomplete posture', async () => {
    const d = repo();
    const s = await onboard(d, ['n'], { noGithub: true, skipDemo: true });
    expect(snapshot(d)).toEqual({});
    expect(s.out).toMatch(/nothing was written/i);
    expect(s.out).toMatch(/^POSTURE: INCOMPLETE/m);
    expect(s.code).toBe(1);
  });

  it('defaults to NOT writing when the operator just presses Enter', async () => {
    const d = repo();
    const s = await onboard(d, [''], { noGithub: true, skipDemo: true });
    expect(snapshot(d)).toEqual({});
    expect(s.code).toBe(1);
  });
});

describe('existing and partial installation', () => {
  it('reports an already wired repository without asking to write, and is idempotent', async () => {
    const d = repo();
    expect(runInit({ cwd: d })).toBe(0);
    writeFileSync(join(d, '.tamperward.yml'), readFileSync(join(d, '.tamperward.yml'), 'utf8') + 'verify:\n  command: npm test\n  budget: 60\n');
    const before = snapshot(d);
    const s = await onboard(d, ['n'], { noGithub: true, skipDemo: true });
    expect(s.questions.some((q) => /write/i.test(q))).toBe(false);
    expect(s.out).toMatch(/already wired/);
    expect(s.out).toMatch(/verification configured — npm test/);
    expect(snapshot(d)).toEqual(before);
    expect(s.code).toBe(0);
  });

  it('previews and writes only the missing item of a partial installation', async () => {
    const d = repo();
    expect(runInit({ cwd: d })).toBe(0);
    rmSync(join(d, '.github', 'CODEOWNERS'));
    const policy = readFileSync(join(d, '.tamperward.yml'), 'utf8');
    const s = await onboard(d, ['y', 'n', ''], { noGithub: true, skipDemo: true });
    expect(s.out).toMatch(/would create\s+\.github\/CODEOWNERS/);
    expect(s.out).not.toMatch(/would create\s+\.tamperward\.yml/);
    expect(existsSync(join(d, '.github', 'CODEOWNERS'))).toBe(true);
    // Declining the verifier suggestion and the manual entry leaves the policy untouched.
    expect(readFileSync(join(d, '.tamperward.yml'), 'utf8')).toBe(policy);
  });
});

describe('verifier configuration is explicit', () => {
  it('never writes the single detected candidate without acceptance', async () => {
    const d = repo();
    const s = await onboard(d, ['y', 'n', ''], { noGithub: true, skipDemo: true });
    expect(loadPolicy(d).verify?.command).toBeUndefined();
    expect(s.out).toMatch(/verify\.command (was )?not (written|configured)/);
    expect(s.out).toMatch(/cannot verify|CANNOT_VERIFY/i);
    expect(s.out).toMatch(/^POSTURE: INCOMPLETE/m);
    expect(s.code).toBe(1);
  });

  it('lists ambiguous candidates and writes the operator’s numbered choice', async () => {
    const d = repo({ pytest: true });
    const s = await onboard(d, ['y', '2', 'n'], { noGithub: true, skipDemo: true });
    const q = s.questions.find((x) => /npm test/.test(x) && /pytest/.test(x));
    expect(q).toBeDefined();
    expect(loadPolicy(d).verify?.command).toBe('pytest');
    expect(loadPolicy(d).verify?.budget).toBe(300);
    // The policy file keeps init's commented baseline: the block was merged, not rewritten.
    expect(readFileSync(join(d, '.tamperward.yml'), 'utf8')).toMatch(/^# protected:/m);
  });

  it('accepts a manually typed command when nothing is detected', async () => {
    const d = repo({ pkg: false });
    const s = await onboard(d, ['y', 'node test/check.test.js', 'y'], { noGithub: true, skipDemo: true });
    expect(s.out).toMatch(/no suite command (was )?detected/i);
    expect(loadPolicy(d).verify?.command).toBe('node test/check.test.js');
    expect(s.out).toMatch(/VERIFIED: your suite passes/);
  });

  it('treats a blank manual entry as a skip and leaves the policy bytes untouched', async () => {
    const d = repo({ pkg: false });
    const before = () => readFileSync(join(d, '.tamperward.yml'), 'utf8');
    await onboard(d, ['y'], { noGithub: true, skipDemo: true });
    const written = before();
    const s = await onboard(d, ['   '], { noGithub: true, skipDemo: true });
    expect(before()).toBe(written);
    expect(loadPolicy(d).verify?.command).toBeUndefined();
    expect(s.out).toMatch(/verify\.command (was )?not (written|configured)/);
  });
});

describe('the first verification is explained without changing verify semantics', () => {
  it('explains SUITE_RED as a red suite, exit 1', async () => {
    const d = repo();
    writeFileSync(join(d, 'src.js'), 'module.exports = 41;\n');
    git(d, 'commit', '-qam', 'break');
    const s = await onboard(d, ['y', 'y', 'y'], { noGithub: true, skipDemo: true });
    expect(s.out).toMatch(/SUITE_RED: your suite fails as it is/);
    expect(s.out).toMatch(/verify exited 1/);
  });

  it('explains MASKED_FAILURE as a weakened check, exit 1', async () => {
    const d = repo();
    writeFileSync(join(d, 'src.js'), 'module.exports = 41;\n');
    writeFileSync(join(d, 'test', 'check.test.js'), "function it(name, fn) { fn(); }\nit('trivially passes', () => {});\n");
    git(d, 'add', '-A');
    // Onboard is run against the committed base; the weakening is the working tree.
    const s = await onboard(d, ['y', 'y', 'y', 'y'], { noGithub: true, skipDemo: true });
    expect(s.out).toMatch(/working tree is not clean/);
    expect(s.out).toMatch(/MASKED_FAILURE: your suite passes as it is, but FAILS/);
    expect(s.out).toMatch(/verify exited 1/);
  });

  it('explains a cannot-verify result as failing closed, exit 2', async () => {
    const d = repo();
    const verify = () => 2;
    const s = await onboard(d, ['y', 'y', 'y'], { noGithub: true, skipDemo: true }, {
      runners: { verify },
    });
    expect(s.out).toMatch(/could not verify .* fails closed/i);
    expect(s.out).toMatch(/verify exited 2/);
  });
});

describe('dirty working tree', () => {
  it('warns, asks before continuing, and never stashes or resets user work', async () => {
    const d = repo();
    writeFileSync(join(d, 'src.js'), 'module.exports = 42; // wip\n');
    writeFileSync(join(d, 'scratch.txt'), 'untracked\n');
    const s = await onboard(d, ['y', 'y', 'y', 'y', 'y'], { noGithub: true });
    expect(s.out).toMatch(/working tree is not clean/);
    expect(s.questions[0]).toMatch(/continue/i);
    expect(readFileSync(join(d, 'src.js'), 'utf8')).toBe('module.exports = 42; // wip\n');
    expect(readFileSync(join(d, 'scratch.txt'), 'utf8')).toBe('untracked\n');
    expect(git(d, 'status', '--porcelain')).toContain('src.js');
    expect(s.out).toMatch(/restored byte-for-byte/);
  });

  it('stops when the operator declines to continue on a dirty tree', async () => {
    const d = repo();
    writeFileSync(join(d, 'src.js'), 'module.exports = 42; // wip\n');
    const s = await onboard(d, ['n'], { noGithub: true });
    expect(snapshot(d)).toEqual({});
    expect(s.code).toBe(2);
    expect(s.out).toMatch(/commit or stash/i);
  });
});

describe('preflight refusals', () => {
  it('refuses outside a git repository', async () => {
    const d = mkdtempSync(join(tmpdir(), 'tw-onboard-nogit-'));
    dirs.push(d);
    const s = await onboard(d, [], { noGithub: true });
    expect(s.code).toBe(2);
    expect(s.err).toMatch(/not (inside )?a git repository/);
    expect(s.questions).toEqual([]);
  });

  it('refuses a non-interactive stdin without a scripted mode, and never hangs', async () => {
    const d = repo();
    const s = await onboard(d, [], { noGithub: true }, { interactive: false });
    expect(s.code).toBe(2);
    expect(s.err).toMatch(/not interactive/);
    expect(s.err).toMatch(/--yes/);
    expect(s.questions).toEqual([]);
    expect(snapshot(d)).toEqual({});
  });

  it('scripted mode (--yes) asks nothing, writes the plan, and only writes an EXPLICIT verifier command', async () => {
    const d = repo();
    const s = await onboard(d, [], { noGithub: true, yes: true }, { interactive: false });
    expect(s.questions).toEqual([]);
    expect(wired(d)).toBe(true);
    expect(loadPolicy(d).verify?.command).toBeUndefined();
    expect(s.out).toMatch(/--verify-command/);
    expect(s.code).toBe(1);

    const d2 = repo();
    const s2 = await onboard(d2, [], { noGithub: true, yes: true, verifyCommand: 'npm test' }, { interactive: false });
    expect(s2.questions).toEqual([]);
    expect(loadPolicy(d2).verify?.command).toBe('npm test');
    expect(s2.out).toMatch(/VERIFIED: your suite passes/);
    // The demo is opt-in under --yes: nothing ran that was not asked for.
    expect(s2.out).not.toMatch(/test-skip/);
    expect(s2.code).toBe(0);
  });

  it('scripted mode runs the demo only with --demo', async () => {
    const d = repo();
    const s = await onboard(d, [], { noGithub: true, yes: true, verifyCommand: 'npm test', demo: true }, { interactive: false });
    expect(s.out).toMatch(/BLOCK\s+test-skip/);
    expect(s.out).toMatch(/restored byte-for-byte/);
  });
});

describe('unsupported platform', () => {
  it('surfaces the support contract and skips local verify without inventing a verdict', async () => {
    const d = repo();
    const calls: unknown[] = [];
    const s = await onboard(d, ['y', 'y', 'y', 'y'], { noGithub: true, skipDemo: true }, {
      platform: 'win32',
      runners: { verify: (o) => { calls.push(o); return 0; } },
    });
    expect(s.out).toMatch(/Windows/);
    expect(s.out).toMatch(/checkpointed-local verify is unsupported/);
    expect(calls).toEqual([]);
    expect(s.out).not.toMatch(/VERIFIED: your suite passes/);
  });
});

describe('GitHub authority', () => {
  const manual = (out: string): void => {
    expect(out).toMatch(/require the .?tamperward.? (status )?check/i);
    expect(out).toMatch(/Code Owner/);
    expect(out).toMatch(/[Dd]ismiss stale/);
  };

  it('prints the exact manual controls and doctor command when no repository can be determined', async () => {
    const d = repo();
    const s = await onboard(d, ['y', 'y', 'n'], { skipDemo: true });
    manual(s.out);
    expect(s.out).toContain('tamperward doctor --github --repo OWNER/REPO --branch <default-branch>');
    expect(s.out).toMatch(/GitHub repository authority: NOT VERIFIED/);
    expect(s.questions.some((q) => /GitHub/.test(q))).toBe(false);
  });

  it('offers doctor --github when the origin is on github.com and reports an unauthenticated failure honestly', async () => {
    const d = repo({ origin: true });
    const doctorCalls: unknown[] = [];
    const doctor = (o: { github?: boolean; repo?: string; branch?: string }): DoctorOutcome => {
      doctorCalls.push(o);
      return {
        code: 2,
        authoritative: false,
        summary: [],
        checks: [
          { id: 'policy', state: 'OK', detail: 'ok' },
          { id: 'github-authority', state: 'BROKEN', detail: 'cannot inspect GitHub repository authority. Rules API: HTTP 401. Authenticate gh with metadata read' },
        ],
        failure: { id: 'github-authority', message: 'cannot inspect GitHub repository authority. Rules API: HTTP 401. Authenticate gh with metadata read' },
      };
    };
    const s = await onboard(d, ['y', 'y', 'n', 'y'], { skipDemo: true, branch: 'main' }, { runners: { doctor } });
    expect(s.questions.some((q) => /doctor --github/.test(q))).toBe(true);
    expect(doctorCalls).toEqual([{ cwd: d, github: true, repo: 'acme/project', branch: 'main' }]);
    expect(s.out).toMatch(/GitHub repository authority: NOT VERIFIED/);
    expect(s.out).toMatch(/HTTP 401/);
    expect(s.out).toContain('tamperward doctor --github --repo acme/project --branch main');
    manual(s.out);
    expect(s.out).toMatch(/^POSTURE: INCOMPLETE/m);
    expect(s.code).toBe(1);
  });

  it('reports ENFORCED only when doctor --github verified it', async () => {
    const d = repo({ origin: true });
    const doctor = (): DoctorOutcome => ({
      code: 0,
      authoritative: true,
      summary: ['tamperward doctor: GitHub repository authority OK — acme/project#main requires tamperward, Code Owner review, and stale-review dismissal on new pushes.'],
      checks: [
        { id: 'policy', state: 'OK', detail: 'ok' },
        { id: 'github-authority', state: 'OK', detail: 'acme/project#main requires tamperward status, Code Owner review, and stale-review dismissal on new pushes' },
      ],
      github: { repo: 'acme/project', branch: 'main' },
    });
    const s = await onboard(d, ['y', 'y', 'n', 'y'], { skipDemo: true, branch: 'main' }, { runners: { doctor } });
    expect(s.out).toMatch(/GitHub repository authority: ENFORCED/);
    expect(s.out).toMatch(/^POSTURE: READY$/m);
    expect(s.code).toBe(0);
  });

  it('--no-github never calls the GitHub API and says the authority is unverified', async () => {
    const d = repo({ origin: true });
    const doctorCalls: Array<{ github?: boolean }> = [];
    const doctor = (o: { github?: boolean }): DoctorOutcome => {
      doctorCalls.push(o);
      return { code: 0, authoritative: true, summary: [], checks: [{ id: 'policy', state: 'OK', detail: 'ok' }] };
    };
    const s = await onboard(d, ['y', 'y', 'n'], { skipDemo: true, noGithub: true }, { runners: { doctor } });
    expect(doctorCalls.map((c) => c.github ?? false)).toEqual([false]);
    expect(s.out).toContain('tamperward doctor --github --repo acme/project --branch <default-branch>');
    expect(s.out).toMatch(/GitHub repository authority: NOT VERIFIED/);
  });
});

describe('posture is derived from doctor', () => {
  it('READY WITH WARNINGS when doctor completes with warnings only', async () => {
    const d = repo();
    const doctor = (): DoctorOutcome => ({
      code: 0,
      authoritative: true,
      summary: [],
      checks: [
        { id: 'policy', state: 'OK', detail: 'ok' },
        { id: 'verifier', state: 'WARN', detail: 'checkpointed-local verifier' },
      ],
    });
    const s = await onboard(d, ['y', 'y', 'n'], { skipDemo: true, noGithub: true }, { runners: { doctor } });
    expect(s.out).toMatch(/^POSTURE: READY WITH WARNINGS/m);
    expect(s.out).toMatch(/1 warning/);
    expect(s.code).toBe(0);
  });

  it('BROKEN when doctor completes with a broken check', async () => {
    const d = repo();
    const doctor = (): DoctorOutcome => ({
      code: 0,
      authoritative: false,
      summary: [],
      checks: [
        { id: 'claude-hooks', state: 'BROKEN', detail: 'error: .claude/settings.json exists but is not valid JSON' },
      ],
    });
    const s = await onboard(d, ['y', 'y', 'n'], { skipDemo: true, noGithub: true }, { runners: { doctor } });
    expect(s.out).toMatch(/^POSTURE: BROKEN/m);
    expect(s.out).toMatch(/claude-hooks/);
    expect(s.code).toBe(1);
  });

  it('INCOMPLETE when the real doctor cannot certify (a broken CI envelope)', async () => {
    const d = repo();
    const s0 = await onboard(d, ['y', 'y', 'n'], { skipDemo: true, noGithub: true });
    expect(s0.code).toBe(0);
    const wf = join(d, '.github', 'workflows', 'tamperward.yml');
    writeFileSync(wf, readFileSync(wf, 'utf8').replace(/timeout-minutes: \d+/, 'timeout-minutes: 1'));
    const s = await onboard(d, ['n'], { skipDemo: true, noGithub: true });
    expect(s.out).toMatch(/^POSTURE: INCOMPLETE/m);
    expect(s.out).toMatch(/timeout-minutes 1 is too small/);
    expect(s.code).toBe(1);
  });
});

describe('interrupted and re-run', () => {
  it('an abort at the write prompt leaves nothing written and says how to resume; a re-run completes; a third run is a no-op', async () => {
    const d = repo();
    const aborted = await onboard(d, [null], { skipDemo: true, noGithub: true });
    expect(aborted.code).toBe(2);
    expect(aborted.out).toMatch(/aborted/i);
    expect(aborted.out).toMatch(/tamperward onboard/);
    expect(aborted.out).toMatch(/tamperward doctor/);
    expect(snapshot(d)).toEqual({});

    const done = await onboard(d, ['y', 'y', 'n'], { skipDemo: true, noGithub: true });
    expect(done.code).toBe(0);
    expect(wired(d)).toBe(true);
    const after = snapshot(d);

    const again = await onboard(d, ['n'], { skipDemo: true, noGithub: true });
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/already wired/);
    expect(snapshot(d)).toEqual(after);
  });

  it('an abort between init and the verifier step leaves init’s files in place and the policy untouched', async () => {
    const d = repo();
    const s = await onboard(d, ['y', null], { skipDemo: true, noGithub: true });
    expect(s.code).toBe(2);
    expect(wired(d)).toBe(true);
    expect(loadPolicy(d).verify?.command).toBeUndefined();
    expect(s.out).toMatch(/aborted/i);
  });
});

describe('the safe demo', () => {
  it('shows a test-skip finding on disposable state and restores the working tree byte-for-byte', async () => {
    const d = repo();
    const before = treeFingerprint(d);
    const s = await onboard(d, ['y', 'y', 'n', 'y'], { noGithub: true });
    expect(s.out).toMatch(/BLOCK\s+test-skip\s+test\/check\.test\.js/);
    expect(s.out).toMatch(/restored byte-for-byte/);
    expect(s.out).toContain(treeFingerprint(d).slice(0, 16));
    // The demo happened after init wrote its files, so the fingerprint moved for
    // that reason only; the test file itself is exactly as committed.
    expect(git(d, 'status', '--porcelain', '--', 'test')).toBe('');
    expect(readFileSync(join(d, 'test', 'check.test.js'), 'utf8')).not.toContain('skip');
    expect(existsSync(join(d, '.git', 'worktrees'))).toBe(false);
    expect(before).not.toBe(treeFingerprint(d)); // init wrote files; the demo did not
  });

  it('is easy to skip and skipping runs nothing', async () => {
    const d = repo();
    const s = await onboard(d, ['y', 'y', 'n', ''], { noGithub: true });
    expect(s.questions.some((q) => /demo/i.test(q))).toBe(true);
    expect(s.out).not.toMatch(/test-skip/);
    expect(s.out).toMatch(/demo skipped/i);
  });

  it('is skipped with an explanation when the repository has no JavaScript test block to skip', async () => {
    const d = repo();
    writeFileSync(join(d, 'test', 'check.test.js'), "require('../src.js');\n");
    git(d, 'commit', '-qam', 'no it blocks');
    const s = await onboard(d, ['y', 'y', 'n', 'y'], { noGithub: true });
    expect(s.out).toMatch(/no .*test block .*to demonstrate/i);
    expect(s.out).not.toMatch(/BLOCK\s+test-skip/);
  });

  it('is skipped when there is no commit to build disposable state from', async () => {
    const d = repo({ commit: false });
    const s = await onboard(d, ['y', 'y', 'y', 'n', 'y'], { noGithub: true });
    expect(s.out).toMatch(/no commit/i);
    expect(s.out).not.toMatch(/BLOCK\s+test-skip/);
  });
});

describe('prompting', () => {
  it('readlineAsker answers from the input stream and resolves null when it closes', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const ask = readlineAsker(input, output);
    const first = ask('first? ');
    input.write('yes\n');
    expect(await first).toBe('yes');
    const second = ask('second? ');
    input.end();
    expect(await second).toBeNull();
    expect(await ask('third? ')).toBeNull();
  });
});

describe('CLI dispatch', () => {
  const run = async (argv: string[]): Promise<{ code: number; err: string }> => {
    const se = process.stderr.write;
    const so = process.stdout.write;
    let err = '';
    process.stderr.write = ((chunk: unknown) => { err += String(chunk); return true; }) as typeof process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await guardedMain(argv);
      return { code, err };
    } finally {
      process.stderr.write = se;
      process.stdout.write = so;
    }
  };

  it('rejects conflicting or unknown options before touching anything', async () => {
    const d = repo();
    expect((await run(['onboard', '--demo', '--skip-demo', '--cwd', d])).code).toBe(2);
    expect((await run(['onboard', '--bogus', '--cwd', d])).err).toMatch(/unknown option/);
    expect((await run(['onboard', '--verify-command', '--cwd', d])).err).toMatch(/needs a value/);
    expect(snapshot(d)).toEqual({});
  });

  it('refuses under a non-interactive stdin (the test runner) instead of hanging', async () => {
    const d = repo();
    const r = await run(['onboard', '--cwd', d, '--no-github']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/not interactive/);
    expect(snapshot(d)).toEqual({});
  });
});
