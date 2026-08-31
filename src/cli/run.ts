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
import { runCheck } from './check';
import { runVerify } from './verify';
import { loadPolicy } from '../policy-load';

export interface RunEnvelopeOpts {
  cwd?: string;
  base?: string;
  cmd?: string;
  budget?: number;
  allowDirty?: boolean;
  argv: string[];
}

const out = (s: string) => process.stdout.write(s + '\n');
const err = (s: string) => process.stderr.write(s + '\n');

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
}

export function runEnvelope(opts: RunEnvelopeOpts): number {
  const cwd = opts.cwd ?? process.cwd();
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
  let frozenCmd: string | undefined;
  let frozenBudget: number | undefined;
  try {
    const entryPolicy = loadPolicy(cwd);
    frozenCmd = opts.cmd ?? entryPolicy.verify?.command;
    frozenBudget = opts.budget ?? entryPolicy.verify?.budget;
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
  const agent = spawnSync(opts.argv[0], opts.argv.slice(1), { cwd, stdio: 'inherit' });
  const agentExit = agent.status ?? 1; // killed-by-signal is not success

  // The trust anchor must not have moved: both the diff check and verify
  // resolve bases with merge-base semantics (right for PR review), so an
  // agent that rewrites history — `git reset --hard <ancestor>`, an orphan
  // branch — would silently DOWNGRADE the anchor to the older commit and be
  // adjudicated against a past that predates its task. Post-agent HEAD must
  // be a descendant of the entry SHA (merge-base then collapses to exactly
  // it); anything else is itself the conviction.
  const head = git(['rev-parse', 'HEAD'], cwd).trim();
  const isAncestor = spawnSync('git', ['merge-base', '--is-ancestor', base, head], { cwd });
  if (isAncestor.status !== 0) {
    err(`tamperward run: HEAD ${head.slice(0, 10)} is not a descendant of the trusted base ${base.slice(0, 10)} —`);
    err('the agent rewrote history out from under the anchor. That is the finding.');
    out(`\ntamperward run — agent exit ${agentExit}; HISTORY_REWRITE → ENFORCEMENT_FAILED`);
    return 1;
  }

  // Re-adjudicate the tree the runtime released, committed and uncommitted,
  // against the entry-time base. Order is cheap-to-expensive; every step
  // runs regardless so the report is complete.
  let diffCode = 0;
  if (head !== base) {
    out(`\n[envelope] policy check over committed changes (${base.slice(0, 10)}...${head.slice(0, 10)}):`);
    diffCode = runCheck({ diff: `${base}...${head}`, cwd });
  }
  out('\n[envelope] policy check over the working tree:');
  const workCode = runCheck({ worktree: true, cwd });
  out('\n[envelope] pristine verification against the trusted base:');
  const verifyCode = runVerify({ cwd, base, cmd: frozenCmd, budget: frozenBudget });

  const cannot = diffCode === 2 || workCode === 2 || verifyCode === 2;
  const blocked = diffCode === 1 || workCode === 1 || verifyCode === 1;
  const enforcement = cannot ? 2 : blocked ? 1 : 0;

  const verdict =
    enforcement === 2 ? 'CANNOT_ADJUDICATE (fail closed)'
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
    else if (a === '--cwd') o.cwd = args[++i];
    else { o.argv = args.slice(i); break; } // first non-flag starts the command
  }
  return o;
}
