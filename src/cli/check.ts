// `tamperward check` — the one engine, three views. Manufactures Change[] from the
// requested git view, runs the engine, prints the verdict, and exits non-zero on a
// blocking finding so it can serve as a gate at pre-commit and in CI.

import { Change, Policy, View } from '../types';
import { diffRange, diffStaged, diffWorktree, diffWorktreeWithUntracked, isGitRepo, mergeBaseOf } from '../git/build';
import { evaluate, hasBlocking, isSuppressed } from '../engine';
import { loadPolicy, loadPolicyAt, PolicyError } from '../policy-load';
import { defaultPolicy, isProtected } from '../policy';
import { applyLocalSignoffs, applyOobSignoffs, oobFromEnv, oobHeadFromEnv } from '../signoff';
import { Format, report } from './report';

export interface CheckOpts {
  diff?: string; // "<base>...<head>" (or "<base>..<head>")
  staged?: boolean; // pre-commit view
  worktree?: boolean; // stop-sweep view
  json?: boolean;
  format?: Format;
  cwd?: string;
  /** Enforcement-envelope overrides (SPEC row 17). The envelope adjudicates the
   *  post-agent tree, so it cannot trust that tree's own policy, file view, or
   *  sign-off ledger — all agent-authorable. */
  policyOverride?: Policy; // frozen entry-time policy, not the current tree's
  includeUntracked?: boolean; // worktree view also scans untracked files, and ignored files on protected paths
  ciLayer?: boolean; // adjudicate at the CI layer: no local (agent-writable) ledger
}

function check(opts: CheckOpts): number {
  const cwd = opts.cwd ?? process.cwd();
  if (!isGitRepo(cwd)) {
    // Every view is a git view. Said plainly here rather than as whatever git
    // prints when `diff` runs outside a repository (its usage text, at exit 1).
    process.stderr.write(`tamperward: ${cwd} is not inside a git repository — nothing to check\n`);
    return 2;
  }
  let policy: Policy = opts.policyOverride ?? loadPolicy(opts.cwd);

  let changes: Change[];
  let layer: 'local' | 'ci';
  let view: View;
  if (opts.staged) {
    changes = diffStaged({ cwd: opts.cwd });
    layer = 'local'; // pre-commit: a human at their machine may sign off (ledger, fingerprint-bound)
    view = 'staged';
  } else if (opts.worktree) {
    // Untracked files as adds, and IGNORED files too when they sit on a protected
    // path: a protected file the agent hid behind `.git/info/exclude` or a
    // `.gitignore` line is in the tree the runner executes, whatever git lists.
    const p = policy;
    changes = opts.includeUntracked
      ? diffWorktreeWithUntracked({ cwd: opts.cwd }, (rel) => isProtected(rel, p))
      : diffWorktree({ cwd: opts.cwd });
    layer = opts.ciLayer ? 'ci' : 'local';
    view = 'worktree';
  } else if (opts.diff) {
    // Exactly two or three dots between two revisions. `a....b` used to split as
    // `a` / `.b` and reach git, which died with a stack trace; a rev may contain
    // dots (`v1.2.3...HEAD`) but never starts or ends with one.
    const m = opts.diff.match(/^(.+?)\.{2,3}(.+)$/);
    const [base, head] = m ? [m[1], m[2]] : ['', ''];
    if (!base || !head || base.endsWith('.') || head.startsWith('.')) {
      process.stderr.write(`tamperward: invalid --diff range "${opts.diff}" (expected <base>...<head>)\n`);
      return 2;
    }
    changes = diffRange(base, head, { cwd: opts.cwd });
    if (changes.length === 0) {
      // Exit 0 stands — an empty pull request is clean — but say so on stderr: a
      // consumer workflow that mis-resolves the range (HEAD...HEAD, a shallow clone
      // with no merge-base) otherwise looks identical to a clean review. (F10.)
      process.stderr.write(
        `tamperward: note: the range ${base}...${head} contains no changes — if this is not an empty pull request, check that the range resolves to the intended commits\n`,
      );
    }
    layer = 'ci';
    view = 'range'; // authority for main: out-of-band approval ONLY, never the committed ledger
    // TRUSTED-BASE POLICY. Everything on the head is agent-authorable, so the head's own
    // .tamperward.yml cannot decide the head's verdict — otherwise one line (`ignore: ['**']`,
    // a lowered severity, a narrowed protected glob) switches the gate off for the very
    // change that added it. Govern by the merge-base's policy; if the base has none, govern
    // by the baseline, never by the branch's. The edit is still REPORTED (hook-tampering) —
    // it just takes effect only once a human has merged it.
    policy = opts.policyOverride ?? loadPolicyAt(mergeBaseOf(base, head, { cwd: opts.cwd }), opts.cwd) ?? defaultPolicy();
  } else {
    process.stderr.write('tamperward: specify --staged, --worktree, or --diff <base>...<head>\n');
    return 2;
  }

  const ignoredFiles = changes.filter((c) => isSuppressed(c, policy)).length;
  let findings = evaluate(changes, policy, undefined, view, { cwd });

  // Sign-off, per layer. LOCAL consults the (fingerprint-bound) ledger; CI honors ONLY an
  // out-of-band approval surfaced via env, never the committed ledger.
  const { findings: remaining, cleared } =
    layer === 'local'
      ? applyLocalSignoffs(findings, cwd, policy)
      : applyOobSignoffs(findings, oobFromEnv(), oobHeadFromEnv());
  findings = remaining;
  if (cleared.length) {
    const how = layer === 'local' ? 'local human sign-off (ledger)' : 'out-of-band approval';
    process.stderr.write(`tamperward: ${cleared.length} blocking finding(s) cleared by ${how}: ${cleared.map((f) => f.rule + (f.file ? `(${f.file})` : '')).join(', ')}\n`);
  }

  report({ findings, scanned: changes.length, ignoredFiles, json: opts.json, format: opts.format });
  return hasBlocking(findings) ? 1 : 0;
}

export function runCheck(opts: CheckOpts): number {
  try {
    return check(opts);
  } catch (e) {
    if (e instanceof PolicyError) {
      // Fail CLOSED with a clean diagnostic. Never fall back to the baseline on a policy
      // the author may have meant to be stricter.
      process.stderr.write(`tamperward: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}
