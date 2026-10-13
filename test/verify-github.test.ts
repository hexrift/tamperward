import { describe, expect, it } from 'vitest';
import { verifyWorkflowCommand } from '../src/cli/render/verify-github';

const actions = { GITHUB_ACTIONS: 'true' } as NodeJS.ProcessEnv;
const local = { GITHUB_ACTIONS: undefined } as NodeJS.ProcessEnv;

describe('verify workflow annotation', () => {
  it('does not emit outside GitHub Actions', () => {
    expect(verifyWorkflowCommand('MASKED_FAILURE', 1, local)).toBeUndefined();
  });

  it('does not annotate a VERIFIED result', () => {
    expect(verifyWorkflowCommand('VERIFIED', 0, actions)).toBeUndefined();
  });

  it('surfaces an unsigned masked failure as an error', () => {
    expect(verifyWorkflowCommand('MASKED_FAILURE', 1, actions)).toBe(
      '::error title=TamperWard verify::MASKED_FAILURE: the visible suite passed, but the suite restored from the trusted base failed. Review the test changes and verification summary.',
    );
  });

  it('keeps a signed-off masked failure visible without contradicting a green check', () => {
    expect(verifyWorkflowCommand('MASKED_FAILURE', 0, actions)).toBe(
      '::warning title=TamperWard verify::MASKED_FAILURE: a trusted out-of-band sign-off was accepted; this is not a VERIFIED result. Review the verification summary.',
    );
  });

  it.each([
    ['SUITE_RED', 1, 'SUITE_RED: the visible suite failed. Fix the failing change before merging.'],
    ['BUDGET_EXCEEDED', 2, 'BUDGET_EXCEEDED: verification exceeded its configured budget; CI could not establish a clean result.'],
    ['CANNOT_VERIFY', 2, 'CANNOT_VERIFY: CI could not establish a trusted verification result. Inspect the job summary and log.'],
  ] as const)('surfaces %s as an error', (verdict, exitCode, message) => {
    expect(verifyWorkflowCommand(verdict, exitCode, actions)).toBe(
      `::error title=TamperWard verify::${message}`,
    );
  });

  it('uses only fixed safe text, with no repository-controlled command payload', () => {
    for (const verdict of ['MASKED_FAILURE', 'SUITE_RED', 'BUDGET_EXCEEDED', 'CANNOT_VERIFY'] as const) {
      const command = verifyWorkflowCommand(verdict, verdict === 'MASKED_FAILURE' ? 1 : 2, actions)!;
      expect(command).not.toMatch(/[\r\n\u0000-\u001f]/);
      expect(command).not.toContain('::notice');
    }
  });
});
