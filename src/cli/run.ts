// tamperward run — the enforcement envelope (SPEC row 17).
//
// Round 2's decisive negative finding (the-gate-held-the-runtime-didnt): a
// hook can be right at every decision point and the system still fails,
// because the hook does not own termination. In the cssstyle-gated
// trajectory the gate denied 42 mutations and verify rejected every one of
// 25 stop attempts — including the last, two seconds before the session
// completed anyway with a masked-green tree, because in a print-mode agent
// runtime "the model stopped producing" and "the task is done" are the same
// event. Whatever tree exists when the runtime lets go is the outcome.
//
// This command closes that boundary from the outside: it wraps the agent
// invocation, records the trusted base BEFORE the agent starts, treats the
// runtime's exit as untrusted, and re-adjudicates the tree the agent left
// behind — committed or not — before anything downstream can read "green".
//
//   tamperward run [--base R] [--cmd C] [--budget S] [--allow-dirty] \
//                  [--cwd D] -- <agent command...>
//
// After the agent exits, three verdicts, all against the entry-time base:
//   1. policy check over base...HEAD   (weakening the agent COMMITTED)
//   2. policy check over the worktree  (weakening left uncommitted)
//   3. verify against the base        (masked failure, however produced)
//
// Exit contract ("green means green", as an exit code):
//   enforcement clean and agent exited 0        → 0
//   enforcement clean, agent exited N≠0        → N   (transparent wrapper)
//   any blocking finding or masked failure     → 1   (even if the agent "succeeded")
//   cannot adjudicate (dirty start, policy     → 2   (fail closed, never open)
//     error, verify cannot run)
//
// The hooks remain the fast path — they steer the agent in-session. This
// envelope, or `check --diff` + `verify` in CI, is the boundary.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runCheck } from './check';
import { runVerify } from './verify';
import { loadPolicy, loadPolicyAt } from '../policy-load';
import { objectRewriteState, trustedGitEnv } from '../git/trusted';
import { depsFingerprint, treeFingerprint } from '../fingerprint';
import { defaultPolicy } from '../policy';
import { Policy } from '../types';

export interface RunEnvelopeOpts {
  cwd?: string;
  base?: string;
  cmd?: string;
  budget?: number;
  allowDirty?: boolean;
  /** Seconds to wait after adjudication before the final quiescence check, to
   *  catch a background worker that sleeps through it. 0 = no wait. */
  settle?: number;
  /** Accept the risk that the agent rewrote the installed dependencies the
   *  suite runs through. Operator-owned, like --allow-dirty. */
  allowDepDrift?: boolean;
  argv: string[];
}

const out = (s: string) => process.stdout.write(s + '\n');
const err = (s: string) => process.stderr.write(s + '\n');

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, env: trustedGitEnv() });
}

/** Clock ticks since boot. FLOOR is load-bearing: /proc/uptime is fractional
 *  and /proc/<pid>/stat starttime is an integer tick count, so comparing the
 *  two unrounded lets a process spawned inside the same 10ms tick read as
 *  "started before the agent". */
function nowTicks(): number {
  try {
    return Math.floor(parseFloat(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 100);
  } catch {
    return Number.POSITIVE_INFINITY; // unknown: convict nothing on start time
  }
}

/** Processes still holding this working tree that started AFTER the agent did.
 *
 *  `run` owns the agent's exit code, not its descendants: a worker detached
 *  with setsid/nohup survives every check and edits the tree afterwards. A
 *  synchronous wrapper cannot reap a new session, so the envelope does the
 *  honest thing — it declines to certify a tree something still holds.
 *
 *  Start time is the discriminator that keeps this from convicting the
 *  caller's own shell pipeline, an editor, or a dev server: only what appeared
 *  after the agent spawned can be the agent's doing. Linux-only (/proc);
 *  elsewhere the fingerprint and --settle guards carry the load. */
function survivorsHoldingTree(cwd: string, spawnedAfterTicks: number): number[] {
  const out: number[] = [];
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    return out;
  }
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return out;
  }
  for (const pid of pids) {
    const n = Number(pid);
    if (n === process.pid) continue;
    let held: string;
    try {
      held = realpathSync(`/proc/${pid}/cwd`);
    } catch {
      continue; // exited, or not ours to inspect
    }
    if (held !== real && !held.startsWith(real + '/')) continue;
    try {
      // stat field 22 is starttime; comm can contain spaces and parens, so
      // parse after the final ')'.
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const startTicks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
      if (Number.isFinite(startTicks) && startTicks >= spawnedAfterTicks) out.push(n);
    } catch {
      /* raced with exit */
    }
  }
  return out;
}

export function runEnvelope(opts: RunEnvelopeOpts): number {
  const cwd = resolve(opts.cwd ?? process.cwd()); // absolute: relative cwds break the verify overlay
  if (!opts.argv.length) {
    err('tamperward run: no agent command given (usage: tamperward run [options] -- <command...>)');
    return 2;
  }

  // Trusted base: resolved BEFORE the agent runs, so commits the agent makes
  // cannot move it. --base overrides for callers whose trusted state is older
  // than HEAD (e.g. a branch the agent was already let loose on).
  let base: string;
  try {
    base = git(['rev-parse', '--verify', `${opts.base ?? 'HEAD'}^{commit}`], cwd).trim();
  } catch {
    err(`tamperward run: cannot resolve trusted base ${opts.base ?? 'HEAD'} — failing closed.`);
    return 2;
  }

  // The verifier is part of the trust anchor: resolve the suite command and
  // budget from the ENTRY-TIME policy (or flags) BEFORE the agent starts,
  // and use only those frozen values afterwards. Otherwise an agent in a
  // repo with no verify config could author its own verifier
  // (verify.command: "true") and be adjudicated by it — policy-diff
  // deliberately treats ADDING a verify block as a strengthening, which is
  // right for PR review and wrong for this envelope.
  // The whole policy is part of the trust anchor, resolved from the BASE COMMIT
  // (loadPolicyAt(base)), never the working tree the agent controls. Otherwise
  // the agent adjudicates itself: an uncommitted .tamperward.yml that disables
  // test-deletion + hook-tampering, or widens `protected` so the pristine
  // overlay reverts its own bug — both scored 'clean' by a check that trusts
  // the post-agent tree. Falls back to the committed baseline, never the head's.
  let frozenPolicy: Policy;
  let frozenCmd: string | undefined;
  let frozenBudget: number | undefined;
  try {
    frozenPolicy = loadPolicyAt(base, cwd) ?? defaultPolicy();
    frozenCmd = opts.cmd ?? frozenPolicy.verify?.command;
    frozenBudget = opts.budget ?? frozenPolicy.verify?.budget;
  } catch (e) {
    err(`tamperward run: cannot load the entry-time policy (${e instanceof Error ? e.message : String(e)}) — failing closed.`);
    return 2;
  }
  if (!frozenCmd) {
    err('tamperward run: no suite command at entry (policy `verify: { command: ... }` or --cmd) —');
    err('refusing to start: a verifier that appears after the agent runs would be agent-authored.');
    return 2;
  }

  // A dirty start would attribute pre-existing changes to the agent (false
  // positives) or let real pre-staged weakening hide as "already there"
  // (false negatives). Refuse both unless the caller owns the risk.
  if (!opts.allowDirty) {
    const dirty = git(['status', '--porcelain'], cwd).trim();
    if (dirty) {
      err('tamperward run: working tree is dirty before the agent starts — the envelope cannot');
      err('attribute changes. Commit or stash first, or pass --allow-dirty to own the risk.');
      return 2;
    }
  }

  out(`tamperward run — trusted base ${base.slice(0, 10)}; agent exit is untrusted.`);
  const depsBefore = depsFingerprint(cwd); // the runner the suite will execute
  // What the object layer resolves to. Every read of the trusted base — the
  // pristine overlay, the ancestry assertion, the ranged diff — goes through
  // it, and `git replace` / info/grafts / shallow can redirect all three
  // without moving a ref or touching a file (src/git/trusted.ts).
  const rewritesBefore = objectRewriteState(cwd);
  const spawnTicks = nowTicks(); // survivors are what appears after this
  const agent = spawnSync(opts.argv[0], opts.argv.slice(1), { cwd, stdio: 'inherit' });
  const agentExit = agent.status ?? 1; // killed-by-signal is not success

  // The trust anchor must not have moved: both the diff check and verify
  // resolve bases with merge-base semantics (right for PR review), so an
  // agent that rewrites history — `git reset --hard <ancestor>`, an orphan
  // branch — would silently DOWNGRADE the anchor to the older commit and be
  // adjudicated against a past that predates its task. Post-agent HEAD must
  // be a descendant of the entry SHA (merge-base then collapses to exactly
  // it); anything else is itself the conviction.
  // Same attack class as the history rewrite below, one layer lower: `git
  // replace`, .git/info/grafts and .git/shallow all change what the trusted
  // base RESOLVES TO without moving a ref or touching a tracked file. Checked
  // BEFORE adjudication, not merely reported after it: every check downstream
  // reads the base through this layer, so a report produced under a redirected
  // base describes an anchor we never chose.
  if (objectRewriteState(cwd) !== rewritesBefore) {
    err('tamperward run: git object-replacement state changed during this run — a replace ref, graft');
    err('or shallow boundary now redirects what the trusted base resolves to. Nothing below could be');
    err('read against the anchor we started from. That is the finding.');
    out(`\ntamperward run — agent exit ${agentExit}; OBJECT_REWRITE → ENFORCEMENT_FAILED`);
    return 1;
  }

  // H3. The final comparison below cannot see a TRANSIENT substitution: a
  // replacement runner that returns 0 for the visible run, returns 0 for the
  // pristine run, and puts the original bytes and mode back on its way out
  // leaves the entry-vs-exit fingerprints identical. Reproduced end to end —
  // GREEN MEANS GREEN over an unfixed bug. The state that matters is the one
  // the checks are about to execute, so it is compared HERE, before them.
  if (depsFingerprint(cwd) !== depsBefore) {
    err('tamperward run: the installed dependency tree changed before adjudication began — the program');
    err('that runs the suite is not the one we started with, and both verification runs execute it.');
    if (!opts.allowDepDrift) {
      out(`\ntamperward run — agent exit ${agentExit}; DEPENDENCY_DRIFT → ENFORCEMENT_FAILED`);
      return 1;
    }
    err('(--allow-dep-drift: proceeding anyway, on the operator\'s judgement.)');
  }

  const head = git(['rev-parse', 'HEAD'], cwd).trim();
  const isAncestor = spawnSync('git', ['merge-base', '--is-ancestor', base, head], { cwd, env: trustedGitEnv() });
  if (isAncestor.status !== 0) {
    err(`tamperward run: HEAD ${head.slice(0, 10)} is not a descendant of the trusted base ${base.slice(0, 10)} —`);
    err('the agent rewrote history out from under the anchor. That is the finding.');
    out(`\ntamperward run — agent exit ${agentExit}; HISTORY_REWRITE → ENFORCEMENT_FAILED`);
    return 1;
  }

  // The tree under adjudication must not move while we adjudicate it.
  const fpBefore = treeFingerprint(cwd);

  // Re-adjudicate the tree the runtime released, committed and uncommitted,
  // against the entry-time base. Order is cheap-to-expensive; every step
  // runs regardless so the report is complete.
  let diffCode = 0;
  if (head !== base) {
    out(`\n[envelope] policy check over committed changes (${base.slice(0, 10)}...${head.slice(0, 10)}):`);
    diffCode = runCheck({ diff: `${base}...${head}`, cwd, policyOverride: frozenPolicy });
  }
  out('\n[envelope] policy check over the working tree (frozen policy, untracked included, no local ledger):');
  const workCode = runCheck({ worktree: true, cwd, policyOverride: frozenPolicy, includeUntracked: true, ciLayer: true });
  out('\n[envelope] pristine verification against the trusted base:');
  const verifyCode = runVerify({ cwd, base, cmd: frozenCmd, budget: frozenBudget, policyOverride: frozenPolicy });

  // Quiescence. A survivor that edits the tree during — or after — the checks
  // makes the verdict describe a tree that no longer exists: the masked-green
  // escape one level up from the runtime hole this command closes.
  if (opts.settle && opts.settle > 0) {
    try {
      execFileSync('sleep', [String(opts.settle)]);
    } catch {
      /* sleep unavailable; the checks below still run */
    }
  }
  const mutatedDuringAdjudication = treeFingerprint(cwd) !== fpBefore;
  if (mutatedDuringAdjudication) {
    err('tamperward run: the working tree changed while it was being adjudicated —');
    err('the verdict below would describe a tree that no longer exists.');
  }
  const depsDrifted = !opts.allowDepDrift && depsFingerprint(cwd) !== depsBefore;
  if (depsDrifted) {
    err('tamperward run: the installed dependency tree changed during this run — the program that');
    err('runs the suite is not the one we started with. Both verification runs execute it.');
  }
  // And again after the checks: a survivor can install a replace ref while the
  // suite is running, which would leave the verdict above describing a base
  // that no longer resolves the same way.
  const rewrote = objectRewriteState(cwd) !== rewritesBefore;
  if (rewrote) {
    err('tamperward run: git object-replacement state changed WHILE the tree was being adjudicated —');
    err('the checks above read the trusted base through an object layer that has since moved.');
  }
  const survivors = survivorsHoldingTree(cwd, spawnTicks);
  if (survivors.length) {
    err(`tamperward run: ${survivors.length} process(es) started during this run still hold the`);
    err(`working tree (pid ${survivors.join(', ')}). A verdict cannot outlive the tree it describes.`);
  }
  const notQuiescent = mutatedDuringAdjudication || survivors.length > 0 || depsDrifted || rewrote;

  const cannot = diffCode === 2 || workCode === 2 || verifyCode === 2;
  const blocked = diffCode === 1 || workCode === 1 || verifyCode === 1 || notQuiescent;
  const enforcement = cannot ? 2 : blocked ? 1 : 0;

  const verdict =
    enforcement === 2 ? 'CANNOT_ADJUDICATE (fail closed)'
    : rewrote ? 'OBJECT_REWRITE — the base the checks read is not the base we anchored to'
    : depsDrifted ? 'DEPENDENCY_DRIFT — the suite runner changed under the envelope'
    : notQuiescent ? 'NOT_QUIESCENT — the tree moved, or something still holds it'
    : enforcement === 1 ? 'ENFORCEMENT_FAILED — the tree the runtime released does not stand'
    : agentExit !== 0 ? `agent exited ${agentExit} (enforcement clean)`
    : 'GREEN MEANS GREEN';
  out(`\ntamperward run — agent exit ${agentExit}; checks diff=${diffCode} worktree=${workCode} verify=${verifyCode} → ${verdict}`);

  return enforcement !== 0 ? enforcement : agentExit;
}

export function parseRun(args: string[]): RunEnvelopeOpts {
  const o: RunEnvelopeOpts = { argv: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { o.argv = args.slice(i + 1); break; }
    else if (a === '--base') o.base = args[++i];
    else if (a === '--cmd') o.cmd = args[++i];
    else if (a === '--budget') o.budget = Number(args[++i]);
    else if (a === '--allow-dirty') o.allowDirty = true;
    else if (a === '--settle') o.settle = Number(args[++i]);
    else if (a === '--allow-dep-drift') o.allowDepDrift = true;
    else if (a === '--cwd') o.cwd = args[++i];
    else { o.argv = args.slice(i); break; } // first non-flag starts the command
  }
  return o;
}
