import type { VerifyCannotVerifyReason, VerifyVerdict } from '../../machine-output';

export interface VerifyAnnotationDetails {
  reason?: VerifyCannotVerifyReason;
  detail?: string;
}

const ERROR_MESSAGES: Record<Exclude<VerifyVerdict, 'VERIFIED' | 'MASKED_FAILURE'> | 'MASKED_FAILURE', string> = {
  MASKED_FAILURE:
    'MASKED_FAILURE: the visible suite passed, but the suite restored from the trusted base failed. Review the test changes and verification summary.',
  SUITE_RED:
    'SUITE_RED: the visible suite failed. Fix the failing change before merging.',
  BUDGET_EXCEEDED:
    'BUDGET_EXCEEDED: verification exceeded its configured budget; CI could not establish a clean result.',
  CANNOT_VERIFY:
    'CANNOT_VERIFY: CI could not establish a trusted verification result.',
};

const DETAIL_LIMIT = 320;

function safeDetail(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length <= DETAIL_LIMIT) return normalized;
  return normalized.slice(0, DETAIL_LIMIT - 1).trimEnd() + '…';
}

function workflowData(value: string): string {
  // Escape percent first so data cannot smuggle an encoded workflow-command delimiter.
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Emit a global annotation for whole-suite verify verdicts without inventing a
 * source location or allowing diagnostic text to become a workflow command. */
export function verifyWorkflowCommand(
  verdict: VerifyVerdict,
  exitCode: number,
  details: VerifyAnnotationDetails = {},
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.GITHUB_ACTIONS !== 'true' || verdict === 'VERIFIED') return undefined;

  if (verdict === 'MASKED_FAILURE' && exitCode === 0) {
    return '::warning title=TamperWard verify::MASKED_FAILURE: a trusted out-of-band sign-off was accepted; this is not a VERIFIED result. Review the verification summary.';
  }

  const parts = [ERROR_MESSAGES[verdict]];
  if (verdict === 'CANNOT_VERIFY') {
    if (details.reason) parts.push(`Reason: ${details.reason}`);
    if (details.detail) parts.push(`Detail: ${safeDetail(details.detail)}`);
  }
  return `::error title=TamperWard verify::${workflowData(parts.join('\n'))}`;
}
