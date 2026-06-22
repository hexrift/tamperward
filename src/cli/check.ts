// `holdfast check` — the one engine, three views. Manufactures Change[] from the
// requested git view, runs the engine, prints the verdict, and exits non-zero on a
// blocking finding so it can serve as a gate at pre-commit and in CI.

import { Change } from '../types';
import { diffRange, diffStaged, diffWorktree } from '../git/build';
import { evaluate, hasBlocking } from '../engine';
import { loadPolicy } from '../policy-load';
import { isIgnored } from '../policy';
import { applyLocalSignoffs, applyOobSignoffs, oobFromEnv } from '../signoff';
import { report } from './report';

export interface CheckOpts {
  diff?: string; // "<base>...<head>" (or "<base>..<head>")
  staged?: boolean; // pre-commit view
  worktree?: boolean; // stop-sweep view
  json?: boolean;
  cwd?: string;
}

export function runCheck(opts: CheckOpts): number {
  const policy = loadPolicy(opts.cwd);
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
      process.stderr.write(`holdfast: invalid --diff range "${opts.diff}" (expected <base>...<head>)\n`);
      return 2;
    }
    changes = diffRange(base, head, { cwd: opts.cwd });
    layer = 'ci'; // authority for main: out-of-band approval ONLY, never the committed ledger
  } else {
    process.stderr.write('holdfast: specify --staged, --worktree, or --diff <base>...<head>\n');
    return 2;
  }

  const ignoredFiles = changes.filter((c) => c.kind === 'file' && isIgnored(c.path, policy)).length;
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
    process.stderr.write(`holdfast: ${cleared.length} blocking finding(s) cleared by ${how}: ${cleared.map((f) => f.rule + (f.file ? `(${f.file})` : '')).join(', ')}\n`);
  }

  report({ findings, scanned: changes.length, ignoredFiles, json: opts.json });
  return hasBlocking(findings) ? 1 : 0;
}
