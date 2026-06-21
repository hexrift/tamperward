// `holdfast check` — the one engine, three views. Manufactures Change[] from the
// requested git view, runs the engine, prints the verdict, and exits non-zero on a
// blocking finding so it can serve as a gate at pre-commit and in CI.

import { Change } from '../types';
import { diffRange, diffStaged, diffWorktree } from '../git/build';
import { evaluate, hasBlocking } from '../engine';
import { loadPolicy } from '../policy-load';
import { isIgnored } from '../policy';
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

  let changes: Change[];
  if (opts.staged) {
    changes = diffStaged({ cwd: opts.cwd });
  } else if (opts.worktree) {
    changes = diffWorktree({ cwd: opts.cwd });
  } else if (opts.diff) {
    const [base, head] = opts.diff.split(/\.{2,3}/);
    if (!base || !head) {
      process.stderr.write(`holdfast: invalid --diff range "${opts.diff}" (expected <base>...<head>)\n`);
      return 2;
    }
    changes = diffRange(base, head, { cwd: opts.cwd });
  } else {
    process.stderr.write('holdfast: specify --staged, --worktree, or --diff <base>...<head>\n');
    return 2;
  }

  const ignoredFiles = changes.filter((c) => c.kind === 'file' && isIgnored(c.path, policy)).length;
  const findings = evaluate(changes, policy);
  report({ findings, scanned: changes.length, ignoredFiles, json: opts.json });

  return hasBlocking(findings) ? 1 : 0;
}
