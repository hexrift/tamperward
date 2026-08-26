// `tamperward check` — the one engine, three views. Manufactures Change[] from the
// requested git view, runs the engine, prints the verdict, and exits non-zero on a
// blocking finding so it can serve as a gate at pre-commit and in CI.

import { Change, Policy } from '../types';
import { diffRange, diffStaged, diffWorktree, mergeBaseOf } from '../git/build';
import { evaluate, hasBlocking, isSuppressed } from '../engine';
import { loadPolicy, loadPolicyAt, PolicyError } from '../policy-load';
import { defaultPolicy } from '../policy';
import { applyLocalSignoffs, applyOobSignoffs, oobFromEnv } from '../signoff';
import { Format, report } from './report';

export interface CheckOpts {
  diff?: string; // "<base>...<head>" (or "<base>..<head>")
  staged?: boolean; // pre-commit view
  worktree?: boolean; // stop-sweep view
  json?: boolean;
  format?: Format;
  cwd?: string;
}

function check(opts: CheckOpts): number {
  let policy: Policy = loadPolicy(opts.cwd);
  const cwd = opts.cwd ?? process.cwd();

  let changes: Change[];
  let layer: 'local' | 'ci';
  if (opts.staged) {
    changes = diffStaged({ cwd: opts.cwd });
    layer = 'local'; // pre-commit: a human at their machine may sign off (ledger, fingerprint-bound)
  } else if (opts.worktree) {
    changes = diffWorktree({ cwd: opts.cwd });
    layer = 'local';
  } else if (opts.diff) {
    const [base, head] = opts.diff.split(/\.{2,3}/);
    if (!base || !head) {
      process.stderr.write(`tamperward: invalid --diff range "${opts.diff}" (expected <base>...<head>)\n`);
      return 2;
    }
    changes = diffRange(base, head, { cwd: opts.cwd });
    layer = 'ci'; // authority for main: out-of-band approval ONLY, never the committed ledger
    // TRUSTED-BASE POLICY. Everything on the head is agent-authorable, so the head's own
    // .tamperward.yml cannot decide the head's verdict — otherwise one line (`ignore: ['**']`,
    // a lowered severity, a narrowed protected glob) switches the gate off for the very
    // change that added it. Govern by the merge-base's policy; if the base has none, govern
    // by the baseline, never by the branch's. The edit is still REPORTED (hook-tampering) —
    // it just takes effect only once a human has merged it.
    policy = loadPolicyAt(mergeBaseOf(base, head, { cwd: opts.cwd }), opts.cwd) ?? defaultPolicy();
  } else {
    process.stderr.write('tamperward: specify --staged, --worktree, or --diff <base>...<head>\n');
    return 2;
  }

  const ignoredFiles = changes.filter((c) => isSuppressed(c, policy)).length;
  let findings = evaluate(changes, policy);

  // Sign-off, per layer. LOCAL consults the (fingerprint-bound) ledger; CI honors ONLY an
  // out-of-band approval surfaced via env, never the committed ledger.
  const { findings: remaining, cleared } =
    layer === 'local'
      ? applyLocalSignoffs(findings, cwd, policy)
      : applyOobSignoffs(findings, oobFromEnv());
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
