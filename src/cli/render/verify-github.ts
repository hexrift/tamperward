// Global GitHub Actions annotations for whole-suite verify verdicts.
// These findings have no reliable file/line attribution; keep them on the check surface.
import type { VerifyVerdict } from '../../machine-output';

const ERROR_MESSAGES: Record<Exclude<VerifyVerdict, 'VERIFIED' | 'MASKED_FAILURE'> | 'MASKED_FAILURE', string> = {
  MASKED_FAILURE:
    'MASKED_FAILURE: the visible suite passed, but the suite restored from the trusted base failed. Review the test changes and verification summary.',
  SUITE_RED:
    'SUITE_RED: the visible suite failed. Fix the failing change before merging.',
  BUDGET_EXCEEDED:
    'BUDGET_EXCEEDED: verification exceeded its configured budget; CI could not establish a clean result.',
  CANNOT_VERIFY:
    'CANNOT_VERIFY: CI could not establish a trusted verification result. Inspect the job summary and log.',
};

/**
 * Produce a global workflow annotation for an effective non-green CI verdict.
 * Text is selected only from fixed messages: repository or test output must never
 * be interpolated into a GitHub workflow command.
 */
export function verifyWorkflowCommand(
  verdict: VerifyVerdict,
  exitCode: number,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.GITHUB_ACTIONS !== 'true' || verdict === 'VERIFIED') return undefined;

  // A MASKED_FAILURE remains visible, but a valid trusted sign-off makes the
  // effective CI exit green. Use a warning so the annotation agrees with status.
  if (verdict === 'MASKED_FAILURE' && exitCode === 0) {
    return '::warning title=TamperWard verify::MASKED_FAILURE: a trusted out-of-band sign-off was accepted; this is not a VERIFIED result. Review the verification summary.';
  }

  return `::error title=TamperWard verify::${ERROR_MESSAGES[verdict]}`;
}
