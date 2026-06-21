#!/usr/bin/env node
// holdfast CLI entry. `check` is the gate; the agent hook, Stop sweep, init, and
// allow commands land in later phases.

import { runCheck, CheckOpts } from './check';
import { runHookClaude, runSweepClaude } from './hook';
import { runAllow, AllowOpts } from './allow';

function parseAllow(args: string[]): AllowOpts {
  const o: AllowOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--file') o.file = args[++i];
    else if (a === '--reason') o.reason = args[++i];
    else if (a === '--cwd') o.cwd = args[++i];
    else if (!a.startsWith('--') && !o.rule) o.rule = a;
  }
  return o;
}

function runAgentCommand(kind: 'hook' | 'sweep', args: string[]): number {
  const agent = args[0];
  if (agent !== 'claude') {
    process.stderr.write(`holdfast: unsupported ${kind} agent "${agent ?? ''}" (only "claude" so far)\n`);
    return 2;
  }
  return kind === 'hook' ? runHookClaude() : runSweepClaude();
}

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
  holdfast hook claude                    PreToolUse gate (reads hook JSON on stdin)
  holdfast sweep claude                   Stop sweep (re-scan the turn's working tree)
  holdfast allow <rule> --reason "..."    record a human sign-off (local audit ledger)

Exit code: check → 1 if any blocking finding. hook/sweep → 2 (deny) or 0 (allow).
`);
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'check':
      return runCheck(parseCheck(rest));
    case 'hook':
      return runAgentCommand('hook', rest);
    case 'sweep':
      return runAgentCommand('sweep', rest);
    case 'allow':
      return runAllow(parseAllow(rest));
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
