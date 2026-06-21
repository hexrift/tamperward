#!/usr/bin/env node
// holdfast CLI entry. `check` is the gate; the agent hook, Stop sweep, init, and
// allow commands land in later phases.

import { runCheck, CheckOpts } from './check';

function parseCheck(args: string[]): CheckOpts {
  const o: CheckOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--staged') o.staged = true;
    else if (a === '--worktree') o.worktree = true;
    else if (a === '--json') o.json = true;
    else if (a === '--diff') o.diff = args[++i];
    else if (a === '--cwd') o.cwd = args[++i];
    else {
      process.stderr.write(`holdfast: unknown flag "${a}"\n`);
    }
  }
  return o;
}

function printHelp(): void {
  process.stdout.write(`holdfast — the deterministic agent-integrity gate

Usage:
  holdfast check --staged                 check staged changes (pre-commit)
  holdfast check --worktree               check working-tree changes (stop sweep)
  holdfast check --diff <base>...<head>   check a commit range (CI authority)
  holdfast check ... --json               machine-readable output

Exit code: 1 if any blocking finding, 0 otherwise.
`);
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'check':
      return runCheck(parseCheck(rest));
    case undefined:
    case '-h':
    case '--help':
      printHelp();
      return 0;
    default:
      process.stderr.write(`holdfast: unknown command "${cmd}"\n`);
      printHelp();
      return 2;
  }
}

process.exit(main(process.argv.slice(2)));
