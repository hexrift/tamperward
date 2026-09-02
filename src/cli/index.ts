#!/usr/bin/env node
// tamperward CLI entry. `check` is the gate; the agent hook, Stop sweep, init, and
// allow commands land in later phases.

import { runCheck, CheckOpts } from './check';
import { FORMATS, isFormat } from './report';
import { runHookClaude, runSweepClaude } from './hook';
import { runAllow, AllowOpts } from './allow';
import { runInit, InitOpts } from './init';
import { runWatch } from './watch';
import { runVerify, parseVerify } from './verify';
import { runEnvelope, parseRun } from './run';

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
    else if (a === '--force-workflow') o.forceWorkflow = true;
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
  tamperward watch [--dir D] [--log F]      filesystem-event observer daemon: records
                                            protected-file events so the sweep can
                                            observe supported transient effects
  tamperward verify [--base R] [--cmd C]    pristine-suite re-execution: run the suite
             [--budget S] [--json] [--keep] as-is AND with protected files restored
             [--require-ancestor] [--cwd D]  from the trusted base; a visible-green /
                                            pristine-red result is a MASKED FAILURE
                                            (exit 1, or 0 under an out-of-band
                                            verify@<head-sha> approval); cannot-verify
                                            fails closed (2)
  tamperward run [opts] -- <agent cmd...>   enforcement envelope: record the trusted
             [--base R] [--cmd C]           base, run the agent, treat its exit as
             [--budget S] [--allow-dirty]   untrusted, then re-adjudicate the tree it
             [--settle S] [--allow-dep-drift] left (policy over base...HEAD and the
             [--cwd D]
                                            worktree, plus verify). Exit: agent's code
                                            when clean; 1 on any blocking finding or
                                            masked failure; 2 when it cannot
                                            adjudicate (fails closed)
  tamperward allow <rule> --reason "..."    record a human sign-off (local audit ledger)
             [--file F] [--cwd D]
  tamperward init [--dry-run]               wire the policy file plus every
             [--force-workflow] [--cwd D]   enforcement point: Claude Code hooks,
                                            pre-commit, CI. Idempotent; never
                                            overwrites your files. Re-running it
                                            MIGRATES a CI workflow it generated and
                                            you have not edited, and widens a
                                            PreToolUse matcher that no longer covers
                                            every tool the gate must see.
                                            --force-workflow replaces a workflow it
                                            did not write, or one you have edited.

Exit codes: 0 clean · 1 a blocking finding (check), MASKED_FAILURE or SUITE_RED
            (verify), any blocking finding or masked failure (run) · 2 cannot
            evaluate, failing closed: policy error, bad --diff range, no view,
            unresolvable base, --require-ancestor refused, budget exceeded.
            hook/sweep → 0 with a deny emitted as JSON on stdout (exit 2 would make
            Claude Code ignore the JSON); 2 only for an unsupported agent name.
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
    case 'verify':
      return runVerify(parseVerify(rest));
    case 'run':
      return runEnvelope(parseRun(rest));
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

const argv = process.argv.slice(2);
if (argv[0] === 'watch') {
  // Daemon: the fs watcher keeps the event loop alive; exit is via signal.
  runWatch(argv.slice(1));
} else {
  process.exit(main(argv));
}
