// One place to build a Finding, so every detector reports severity and sign-off
// consistently from policy. Severity comes from the rule's policy entry; a mechanical
// rule with no entry defaults to `block`.

import { Finding, Policy, Severity } from '../types';

export function severityOf(rule: string, policy: Policy, fallback: Severity = 'block'): Severity {
  return policy.rules?.[rule]?.severity ?? fallback;
}

export function isEnabled(rule: string, policy: Policy): boolean {
  const r = policy.rules?.[rule];
  return !r || r.enabled !== false;
}

export interface FindingInput {
  message: string;
  evidence: string;
  remediation: string;
  file?: string;
  line?: number;
  defaultSeverity?: Severity;
}

export function makeFinding(rule: string, policy: Policy, input: FindingInput): Finding {
  const severity = severityOf(rule, policy, input.defaultSeverity ?? 'block');
  const required = (policy.signoff?.requiredFor ?? ['block']).includes(severity);
  return {
    rule,
    severity,
    ...(input.file !== undefined ? { file: input.file } : {}),
    ...(input.line !== undefined ? { line: input.line } : {}),
    message: input.message,
    evidence: input.evidence,
    remediation: input.remediation,
    signoff: {
      required,
      command: `tamperward allow ${rule}${input.file ? ` --file ${input.file}` : ''} --reason "..."`,
    },
  };
}
