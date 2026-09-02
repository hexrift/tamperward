// tamperward CLI dispatch: argument parsing, help, and the process-level guard.
// Kept apart from the entry file (index.ts) so it can be imported by tests
// without running the entry's `process.exit`.

import { runCheck, CheckOpts } from './check';
import { FORMATS, isFormat } from './report';
import { runHookClaude, runSweepClaude } from './hook';
import { runAllow, AllowOpts } from './allow';
import { runInit, InitOpts } from './init';
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
                                            from the trusted base; a visible-green /
                                            pristine-red result is a MASKED FAILURE
                                            (exit 1, or 0 under an out-of-band
                                            verify@<head-sha> approval); cannot-verify
                                            fails closed (2)
  tamperward run [opts] -- <agent cmd...>   enforcement envelope: record the trusted
             [--base R] [--cmd C]           base, run the agent, treat its exit as
             [--budget S] [--allow-dirty]   untrusted, then re-adjudicate the tree it
                                            left (policy over base...HEAD and the
                                            worktree, plus verify). Exit: agent's code
                                            when clean; 1 on any blocking finding or
                                            masked failure; 2 when it cannot
                                            adjudicate (fails closed)
  tamperward allow <rule> --reason "..."    record a human sign-off (local audit ledger)
  tamperward init [--dry-run]               wire the policy file plus every
             [--force-workflow]             enforcement point: Claude Code hooks,
                                            pre-commit, CI. Idempotent; never
                                            overwrites your files. Re-running it
                                            MIGRATES a CI workflow it generated and
                                            you have not edited, and widens a
                                            PreToolUse matcher that no longer covers
                                            every tool the gate must see.
                                            --force-workflow replaces a workflow it
                                            did not write, or one you have edited.

Exit code: check → 1 if any blocking finding; 2 if it cannot evaluate (bad policy,
           bad range, not a git repo — any failure is one line on stderr, never
           a stack trace). hook/sweep → always 0; a deny is emitted as JSON on
           stdout (exit 2 makes Claude Code ignore the JSON).
`);
}

export function main(argv: string[]): number {
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

/**
 * The process-level guard. Anything `main` does not catch used to escape as a
 * Node stack trace at exit 1 — the code that means "blocking finding" — for a
 * bad `--diff` revision, a `--worktree` outside a repository, an invalid policy
 * reaching `allow`, or a directory where `init` expected a file. A crash is a
 * verdict the gate could not reach, so it exits 2 (cannot evaluate: fail closed,
 * never 0, never 1) with one clean line. `hook`/`sweep` catch their own errors
 * and deny as JSON at exit 0 (src/cli/hook.ts); nothing of theirs arrives here.
 */
export function guardedMain(argv: string[], stderr: { write: (s: string) => unknown } = process.stderr): number {
  try {
    return main(argv);
  } catch (e) {
    // The first line only: git folds its usage text into some errors, and a
    // screenful of options is not a diagnostic.
    const first = (e instanceof Error ? e.message : String(e)).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    stderr.write(`tamperward: ${first || 'unexpected failure'}\n`);
    return 2;
  }
}
