import { describe, expect, it } from 'vitest';
import { verifyWorkflowCommand } from '../src/cli/render/verify-github';

const actions = { GITHUB_ACTIONS: 'true' } as NodeJS.ProcessEnv;
const local = { GITHUB_ACTIONS: undefined } as NodeJS.ProcessEnv;

describe('verify workflow annotation', () => {
  it('does not emit outside GitHub Actions', () => {
    expect(verifyWorkflowCommand('MASKED_FAILURE', 1, {}, local)).toBeUndefined();
  });

  it('does not annotate a VERIFIED result', () => {
    expect(verifyWorkflowCommand('VERIFIED', 0, {}, actions)).toBeUndefined();
  });

  it('shows the concrete fail-closed reason and detail in a readable annotation', () => {
    expect(verifyWorkflowCommand('CANNOT_VERIFY', 2, {
      reason: 'VERIFIER_BACKEND_RUNTIME_FAILURE',
      detail: 'The visible suite process exited but left stdout open.',
    }, actions)).toBe(
      '::error title=TamperWard verify::CANNOT_VERIFY: CI could not establish a trusted verification result.%0AReason: VERIFIER_BACKEND_RUNTIME_FAILURE%0ADetail: The visible suite process exited but left stdout open.',
    );
  });

  it('keeps workflow syntax and newlines inside diagnostic text from creating commands', () => {
    const command = verifyWorkflowCommand('CANNOT_VERIFY', 2, {
      reason: 'VERIFIER_BACKEND_RUNTIME_FAILURE',
      detail: 'bad%0Avalue\r\n::error title=forged::message',
    }, actions)!;
    expect(command).toContain('bad%250Avalue ::error title=forged::message');
    expect(command).not.toMatch(/[\r\n\u0000-\u001f\u007f-\u009f]/);
  });

  it('caps long details while preserving a visible truncation marker', () => {
    const command = verifyWorkflowCommand('CANNOT_VERIFY', 2, { detail: 'x'.repeat(500) }, actions)!;
    expect(command).toContain(`Detail: ${'x'.repeat(319)}…`);
    expect(command.length).toBeLessThan(500);
  });

  it.each([
    ['MASKED_FAILURE', 1, 'MASKED_FAILURE: the visible suite passed, but the suite restored from the trusted base failed. Review the test changes and verification summary.'],
    ['SUITE_RED', 1, 'SUITE_RED: the visible suite failed. Fix the failing change before merging.'],
    ['BUDGET_EXCEEDED', 2, 'BUDGET_EXCEEDED: verification exceeded its configured budget; CI could not establish a clean result.'],
  ] as const)('uses the fixed %s error message', (verdict, exitCode, message) => {
    expect(verifyWorkflowCommand(verdict, exitCode, {}, actions)).toBe(`::error title=TamperWard verify::${message}`);
  });

  it('keeps a signed-off masked failure visible as a warning', () => {
    expect(verifyWorkflowCommand('MASKED_FAILURE', 0, {}, actions)).toBe(
      '::warning title=TamperWard verify::MASKED_FAILURE: a trusted out-of-band sign-off was accepted; this is not a VERIFIED result. Review the verification summary.',
    );
  });
});
