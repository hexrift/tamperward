// Explicit bare-suite timing: this executes the requested command in the live
// checkout. It neither verifies nor approves the candidate.
import { execFileSync } from 'node:child_process';
import { repoRoot } from '../repo-context';
import { loadPolicy } from '../policy-load';
import { isProtected } from '../policy';
import { treeFingerprint } from '../fingerprint';
import { trustedGitEnv } from '../git/trusted';
import { runCapturedProcessSync } from '../suite-diagnostics';
import { configuredAuditPath } from './audit';
import { localVerifierShell } from './verify';
import { measurementComparison, recordMeasurement, type MeasurementOutcome } from './measurements';

export function runMeasureSuite(args: string[]): number {
  let cwd = process.cwd();
  let cmd: string | undefined;
  let budget = 300;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cwd') cwd = args[++i];
    else if (args[i] === '--cmd') cmd = args[++i];
    else if (args[i] === '--budget') budget = Number(args[++i]);
    else throw new Error(`unknown measure-suite argument ${args[i]}`);
  }
  if (!cmd || !Number.isFinite(budget) || budget <= 0) throw new Error('measure-suite requires --cmd and a positive --budget');
  cwd = repoRoot(cwd);
  const shell = localVerifierShell(process.platform, cmd);
  if (!shell) throw new Error('measure-suite requires a supported POSIX shell');
  const policy = loadPolicy(cwd);
  const fingerprint = (): string => treeFingerprint(cwd, rel => isProtected(rel, policy));
  const head = (): string => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, env: trustedGitEnv(), encoding: 'utf8' }).trim();
  const before = fingerprint();
  const initialHead = head();
  const comparison = measurementComparison(initialHead, before, cmd);
  let path: string | null = null;
  try { path = configuredAuditPath(cwd); } catch { /* evidence only */ }
  const started = performance.now();
  let outcome: MeasurementOutcome = 'INCOMPLETE';
  let code = 2;
  let duration_ms: number | undefined;
  try {
    const result = runCapturedProcessSync(shell.executable, shell.args, {
      cwd, env: process.env, timeoutMs: budget * 1000, detached: true, killGroupOnFinish: true,
    });
    duration_ms = Math.max(0, Math.round(performance.now() - started));
    if (!result.error && !result.timedOut && !result.pipeHeldOpen && result.exit !== null && fingerprint() === before && head() === initialHead) {
      outcome = result.exit === 0 ? 'PASSED' : 'FAILED';
      code = result.exit === 0 ? 0 : 1;
    }
    return code;
  } finally {
    duration_ms ??= Math.max(0, Math.round(performance.now() - started));
    recordMeasurement(path, { kind: 'bare-suite', outcome, duration_ms, comparison });
    process.stdout.write(`bare suite: ${outcome}, ${duration_ms} ms, comparison ${comparison}\n`);
  }
}
