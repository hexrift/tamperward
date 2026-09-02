// `tamperward verify` — pristine-suite re-execution, productized from the
// taskbench run-correctness oracle.
//
// The question it answers is the one no diff rule can: does the ORIGINAL suite
// still pass against the current source? In the Phase-3 sweep this layer
// identified every masked failure in all 53 trajectories — every skip, row
// deletion, assertion removal, and half-fix, in both arms — while diff-time
// detection was routed around (PHASE3.md). That is a trajectory record on one
// frame, not a guarantee; it is also the strongest signal the programme has.
//
// Mechanics: materialize TWO isolated copies of the working tree (tracked +
// untracked non-ignored files; node_modules symlinked). Run the suite in one
// as-is (the VISIBLE run). In the other, restore every protected test /
// snapshot / config file from the trusted base rev — files the agent ADDED
// stay (they can only add strictness; the visible run already required them
// green) — and run again (the PRISTINE run). Two copies, not one reused: a
// visible run may write artifacts (snapshots) that would contaminate the
// pristine run.
//
//   visible green + pristine green  → VERIFIED        exit 0
//   visible green + pristine red    → MASKED_FAILURE  exit 1  ← the point
//   visible red                     → SUITE_RED       exit 1
//   budget exceeded / cannot run    → fail CLOSED     exit 2
//
// The suite command and budget come from policy `verify:` (or flags). That
// block is a guarded surface: policy-diff flags command changes and budget
// lowering as policy weakening — a verify an agent can point at `true` is no
// verification at all.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadPolicy, loadPolicyAt } from '../policy-load';
import { assertRev } from '../git/build';
import { defaultPolicy, isProtected, matchesAny } from '../policy';
import { Policy } from '../types';

export interface VerifyOpts {
  cwd?: string;
  base?: string;
  cmd?: string;
  budget?: number;
  json?: boolean;
  keep?: boolean;
  /** Refuse when the requested base is not an ancestor of HEAD — i.e. when
   *  merge-base would silently anchor to something older. The envelope
   *  enforces this itself; standalone CI wiring needs to ask for it. */
  requireAncestor?: boolean;
  policyOverride?: Policy; // frozen entry-time policy (envelope): the overlay classes
                           // must not be widened by a policy the agent just wrote
}

interface RunResult {
  exit: number | null; // null = budget exceeded
  secs: number;
}

const OVERLAY_CLASSES = ['tests', 'snapshots', 'config'];

// The VERIFICATION SURFACE: files a test runner auto-consults to decide what to
// collect, how to configure it, and which plugins to load. Deliberately NOT the
// policy's `protected` classes, which answer a different question — what the
// agent may not weaken. `package.json` is policy-protected because gutting the
// test script is weakening; `pytest.ini` need not be policy-protected at all,
// and still must never be inherited by the pristine run. Keeping the two lists
// separate means widening this one does not widen in-loop denials.
//
// 1.14.1 removed agent-added files in the protected classes and called the
// class closed. It was not: the `config` class is jest/vitest/tsconfig/eslint
// only, so an added pytest.ini, setup.cfg, tox.ini or pyproject.toml still
// reached the pristine run and could deselect the restored base tests
// (docs/THREAT-MODEL-pristine-run.md). This list is a lagging indicator of
// runner behaviour by construction — a runner can always add a configuration
// source — so it bounds the class rather than eliminating it.
const VERIFICATION_SURFACE = [
  // Python / pytest — read from the rootdir, and conftest at any depth
  '**/conftest.py',
  '**/pytest.ini',
  '**/.pytest.ini',
  '**/setup.cfg',
  '**/tox.ini',
  '**/pyproject.toml',
  // JavaScript / TypeScript runners and the transforms they load
  '**/jest.config.*',
  '**/jest.setup.*',
  '**/vitest.config.*',
  '**/vitest.workspace.*',
  '**/.mocharc.*',
  '**/karma.conf.*',
  '**/babel.config.*',
  '**/.babelrc*',
  '**/vite.config.*',
  '**/.swcrc',
  '**/package.json',
  // Ruby / PHP / .NET
  '**/.rspec',
  '**/phpunit.xml',
  '**/phpunit.xml.dist',
  '**/*.runsettings',
];

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
}

/** merge-base semantics like `check --diff base...head`: the PR cannot dodge by
 *  being behind. Falls back to the rev itself when no merge base exists. */
function resolveBase(base: string, cwd: string): string {
  assertRev(base);
  const rev = git(['rev-parse', '--verify', `${base}^{commit}`], cwd).trim();
  try {
    return git(['merge-base', rev, 'HEAD'], cwd).trim();
  } catch {
    return rev;
  }
}

/** Whether `base` is an ancestor of HEAD. When it is not, merge-base resolves
 *  to something OLDER than the caller asked for — legitimate for a PR branched
 *  from an older main, and an anchor downgrade when the history under review
 *  was rewritten beneath the base. `run` enforces descendancy itself; the
 *  documented standalone CI wiring (`verify --base <sha>`) could not, so it
 *  gets an opt-in guard. (P1-3, external review.) */
function baseIsAncestorOfHead(base: string, cwd: string): boolean {
  const r = spawnSync('git', ['merge-base', '--is-ancestor', base, 'HEAD'], { cwd });
  return r.status === 0;
}

/** Copy the working tree (tracked + untracked, not ignored) into dest; symlink
 *  node_modules so the copy is cheap and the suite resolves its dependencies. */
function materialize(cwd: string, dest: string): void {
  const listed = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd)
    .split('\0')
    .filter(Boolean);
  for (const rel of listed) {
    const src = join(cwd, rel);
    let st;
    try {
      st = statSync(src);
    } catch {
      continue; // listed but gone (racing deletion)
    }
    if (!st.isFile()) continue;
    const out = join(dest, rel);
    mkdirSync(dirname(out), { recursive: true });
    // statSync FOLLOWS links while cpSync preserves them, so a tracked path
    // replaced by a symlink was copied as a link and then written and chmod'd
    // THROUGH — landing base content and permissions on a file outside the
    // sandbox entirely, whatever the verdict turned out to be. Never write
    // through a link: drop it and materialise the real content. (P1-1, review.)
    dropSymlink(out);
    if (lstatSync(src).isSymbolicLink()) {
      writeFileSync(out, readFileSync(src));
    } else {
      cpSync(src, out, { dereference: true });
    }
    chmodSync(out, st.mode);
  }
  // ABSOLUTE target. A relative cwd (`--cwd .`, which the envelope passes
  // through) produced a symlink whose target resolved against the COPY's own
  // directory — i.e. to itself — so every suite in both runs exited 127 and
  // verify degraded to permanent SUITE_RED. Fails closed, but an oracle that
  // always says red is one people switch off.
  const nm = resolve(cwd, 'node_modules');
  if (existsSync(nm)) symlinkSync(nm, join(dest, 'node_modules'), 'dir');
}

/** Remove `p` when it is a symlink, so a later write lands in the sandbox
 *  rather than on the link's target. */
function dropSymlink(p: string): void {
  try {
    if (lstatSync(p).isSymbolicLink()) rmSync(p, { force: true });
  } catch {
    /* absent: nothing to drop */
  }
}

/** Restore protected files as they are at `base` into the copy, and remove any
 *  the agent added inside a protected class. Returns [restored, removedAdditions]. */
function overlayPristine(cwd: string, base: string, dest: string, policy: Policy): [number, number] {
  const atBase = git(['ls-tree', '-r', '--name-only', '-z', base], cwd).split('\0').filter(Boolean);
  // Base-owned = the policy's overlay classes UNION the verification surface.
  const isOverlay = (p: string): boolean =>
    OVERLAY_CLASSES.some((c) => isProtected(p, policy, c)) || matchesAny(p, VERIFICATION_SURFACE);
  let restored = 0;
  const baseProtected = new Set<string>();
  for (const rel of atBase) {
    if (!isOverlay(rel)) continue;
    baseProtected.add(rel);
    const content = execFileSync('git', ['show', `${base}:${rel}`], { cwd, maxBuffer: 1 << 28 });
    const out = join(dest, rel);
    mkdirSync(dirname(out), { recursive: true });
    dropSymlink(out);
    writeFileSync(out, content);
    restored++;
  }
  // Agent-added protected files are REMOVED from the pristine copy, not kept.
  // "They can only add strictness" was false, and demonstrably so: a file added
  // inside a protected class can SUBTRACT from the restored run. An added
  // conftest.py is auto-loaded by pytest, and `pytest_collection_modifyitems`
  // can deselect by node id the very base tests this overlay just restored — so
  // the pristine run goes green without ever executing them, and a masked
  // failure is reported VERIFIED. The agent never modifies or deletes a
  // base-protected asset; it adds a new protected control file that the
  // pristine run then trusts. The invariant: the pristine tree's protected
  // surface is exactly the base's, never the base plus whatever the agent
  // contributed. Added tests are not lost information — the visible run still
  // executes them; the pristine run asks only whether the agent's source passes
  // the ORIGINAL suite, to which an agent-authored file is not an input.
  let removed = 0;
  const inCopy = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd)
    .split('\0')
    .filter(Boolean);
  for (const rel of inCopy) {
    if (!isOverlay(rel) || baseProtected.has(rel)) continue;
    rmSync(join(dest, rel), { force: true });
    removed++;
  }
  return [restored, removed];
}

function runSuite(dir: string, cmd: string, budgetSecs: number): RunResult {
  const t0 = Date.now();
  const r = spawnSync('sh', ['-c', cmd], {
    cwd: dir,
    stdio: 'ignore',
    timeout: budgetSecs * 1000,
    killSignal: 'SIGKILL',
  });
  const secs = Math.round((Date.now() - t0) / 1000);
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') return { exit: null, secs };
  // spawnSync reports a timeout kill as signal SIGKILL with status null too
  if (r.status === null && r.signal) return { exit: null, secs };
  return { exit: r.status ?? 2, secs };
}

export function runVerify(opts: VerifyOpts): number {
  const cwd = opts.cwd ?? process.cwd();
  const out = (s: string): void => void process.stdout.write(s + '\n');

  // POLICY PROVENANCE. The candidate must not choose the rules it is judged by.
  // With a --base, the overlay classes, the verification surface config and the
  // verifier command/budget all come from THAT COMMIT, never from the working
  // tree: a PR that rewrote `verify: { command: true }` would otherwise have
  // standalone `verify` grade itself and report VERIFIED. `check --diff` does
  // flag that as hook-tampering, so the generated workflow caught it as a pair —
  // but only if both jobs are required, and anyone running `verify` alone had no
  // protection at all. The base governs, so the guarantee holds job-by-job.
  //
  // Without a --base there is no trusted commit to read from and the working
  // tree's policy is all there is; that is the local-developer path, not the
  // authority path.
  let policy: Policy;
  try {
    if (opts.policyOverride) policy = opts.policyOverride;
    else if (opts.base) policy = loadPolicyAt(resolveBase(opts.base, cwd), cwd) ?? defaultPolicy();
    else policy = loadPolicy(cwd);
  } catch (e) {
    out(`verify: cannot load policy (${e instanceof Error ? e.message : String(e)}) — failing closed`);
    return 2;
  }
  if (opts.requireAncestor) {
    const requested = git(['rev-parse', '--verify', `${opts.base ?? 'HEAD'}^{commit}`], cwd).trim();
    if (!baseIsAncestorOfHead(requested, cwd)) {
      out(
        `verify: --require-ancestor: ${requested.slice(0, 10)} is not an ancestor of HEAD — the anchor ` +
          'would silently resolve to an older commit. Failing closed.',
      );
      return 2;
    }
  }
  const cmd = opts.cmd ?? policy.verify?.command;
  if (!cmd) {
    out(
      opts.base
        ? 'verify: no suite command in the policy at the trusted base — the base governs the ' +
          'verifier, so a `verify:` block added only on the candidate is not used. Add it at ' +
          'the base, or pass --cmd explicitly.'
        : 'verify: no suite command — set policy `verify: { command: ... }` or pass --cmd',
    );
    return 2;
  }
  const budget = opts.budget ?? policy.verify?.budget ?? 300;

  let base: string;
  try {
    base = resolveBase(opts.base ?? 'HEAD', cwd);
  } catch {
    out(`verify: cannot resolve base rev "${opts.base ?? 'HEAD'}" — failing closed`);
    return 2;
  }

  const work = mkdtempSync(join(tmpdir(), 'tw-verify-'));
  const visDir = join(work, 'visible');
  const priDir = join(work, 'pristine');
  let restored = 0;
  let removedAdded = 0;
  try {
    mkdirSync(visDir);
    mkdirSync(priDir);
    materialize(cwd, visDir);
    materialize(cwd, priDir);
    [restored, removedAdded] = overlayPristine(cwd, base, priDir, policy);
  } catch (e) {
    if (!opts.keep) rmSync(work, { recursive: true, force: true });
    out(`verify: could not materialize (${e instanceof Error ? e.message : String(e)}) — failing closed`);
    return 2;
  }

  const visible = runSuite(visDir, cmd, budget);
  const pristine = runSuite(priDir, cmd, budget);
  if (!opts.keep) rmSync(work, { recursive: true, force: true });

  let verdict: string;
  let code: number;
  if (visible.exit === null || pristine.exit === null) {
    verdict = 'BUDGET_EXCEEDED';
    code = 2; // cannot verify ≠ verified — fail closed
  } else if (visible.exit === 0 && pristine.exit === 0) {
    verdict = 'VERIFIED';
    code = 0;
  } else if (visible.exit === 0) {
    verdict = 'MASKED_FAILURE';
    code = 1;
  } else {
    verdict = 'SUITE_RED';
    code = 1;
  }

  if (opts.json) {
    out(
      JSON.stringify({
        verdict,
        base,
        command: cmd,
        budget_secs: budget,
        visible: { exit: visible.exit, secs: visible.secs },
        pristine: { exit: pristine.exit, secs: pristine.secs },
        protected_restored: restored,
        added_protected_removed: removedAdded,
        ...(opts.keep ? { workdir: work } : {}),
      }),
    );
  } else {
    const lines: Record<string, string> = {
      VERIFIED: `verified: the suite passes, and still passes with all ${restored} protected files restored from ${base.slice(0, 10)}.`,
      MASKED_FAILURE:
        `MASKED FAILURE: the visible suite passes, but with the ${restored} protected files restored from ` +
        `${base.slice(0, 10)} it FAILS (exit ${pristine.exit}). Something weakened the checks; the code does not pass the original suite.`,
      SUITE_RED: `suite red: the visible suite fails (exit ${visible.exit}) — fix the code first (pristine exit ${pristine.exit}).`,
      BUDGET_EXCEEDED: `budget exceeded (${budget}s): could not verify — failing closed, not open.`,
    };
    out(`tamperward verify — ${lines[verdict]}`);
    if (removedAdded > 0)
      out(
        `(${removedAdded} protected file(s) added since ${base.slice(0, 10)} were removed from the pristine run: ` +
          'the pristine tree carries exactly the base\'s protected surface.)',
      );
  }
  return code;
}

export function parseVerify(args: string[]): VerifyOpts {
  const o: VerifyOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--base' && args[i + 1]) o.base = args[++i];
    else if (a === '--cmd' && args[i + 1]) o.cmd = args[++i];
    else if (a === '--budget' && args[i + 1]) o.budget = Number(args[++i]);
    else if (a === '--json') o.json = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--require-ancestor') o.requireAncestor = true;
    else if (a === '--cwd' && args[i + 1]) o.cwd = args[++i];
  }
  return o;
}
