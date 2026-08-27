#!/usr/bin/env node
// tamperward CLI entry. `check` is the gate; the agent hook, Stop sweep, init, and
// allow commands land in later phases.

import { runCheck, CheckOpts } from './check';
import { FORMATS, isFormat } from './report';
import { runHookClaude, runSweepClaude } from './hook';
import { runAllow, AllowOpts } from './allow';
import { runInit, InitOpts } from './init';

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
    process.stderr.write(`tamperward: unsupported ${kind} agent "${agent ?? ''}" (only "claude" so far)\n`);
    return 2;
  }
  return kind === 'hook' ? runHookClaude() : runSweepClaude();
}

function parseInit(args: string[]): InitOpts {
  const o: InitOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--cwd') o.cwd = args[++i];
    else if (a === '--dry-run') o.dryRun = true;
  }
  return o;
}

function parseCheck(args: string[]): CheckOpts {
  const o: CheckOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--staged') o.staged = true;
    else if (a === '--worktree') o.worktree = true;
    else if (a === '--json') o.json = true;
    else if (a === '--format') {
      const v = args[++i];
      if (v !== undefined && isFormat(v)) o.format = v;
      else process.stderr.write(`tamperward: unknown --format "${v ?? ''}" (expected ${FORMATS.join(' | ')})\n`);
    }
    else if (a === '--diff') o.diff = args[++i];
    else if (a === '--cwd') o.cwd = args[++i];
    else {
      process.stderr.write(`tamperward: unknown flag "${a}"\n`);
    }
  }
  return o;
}

function printHelp(): void {
  process.stdout.write(`tamperward — the deterministic agent-integrity gate

Usage:
  tamperward check --staged                 check staged changes (pre-commit)
  tamperward check --worktree               check working-tree changes (stop sweep)
  tamperward check --diff <base>...<head>   check a commit range (CI authority)
  tamperward check ... --json               machine-readable output (alias for --format json)
  tamperward check ... --format <fmt>       text | json | github | auto (default)

Formats:
  text    grouped, wrapped, colour-optional terminal output. Severity is always
          spelled out ("BLOCK" / "warn"), never carried by colour alone. Honours
          NO_COLOR and FORCE_COLOR; colour is off when stdout is not a terminal.
  github  GitHub Actions view: one inline annotation per finding (so it shows up
          on the line in "Files changed") plus a job-summary table on the run
          page, alongside the same text output in the log.
  json    the findings verbatim, plus a summary count.
  auto    github when GITHUB_ACTIONS=true, otherwise text.
  tamperward hook claude                    PreToolUse gate (reads hook JSON on stdin)
  tamperward sweep claude                   Stop sweep (re-scan the turn's working tree)
  tamperward allow <rule> --reason "..."    record a human sign-off (local audit ledger)
  tamperward init [--dry-run]               wire the policy file plus every
                                            enforcement point: Claude Code hooks,
                                            pre-commit, CI. Idempotent; never
                                            overwrites your files.

Exit code: check → 1 if any blocking finding. hook/sweep → always 0; a deny is
           emitted as JSON on stdout (exit 2 makes Claude Code ignore the JSON).
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
    case 'init':
      return runInit(parseInit(rest));
    case undefined:
    case '-h':
    case '--help':
      printHelp();
      return 0;
    default:
      process.stderr.write(`tamperward: unknown command "${cmd}"\n`);
      printHelp();
      return 2;
  }
}

process.exit(main(process.argv.slice(2)));
