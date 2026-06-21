// #7 ci-tampering (file surface, mechanical).
// On a protected workflow file: neutering a job (continue-on-error / if:false) or
// deleting a check step (test/lint/typecheck).

import { Change, Detector, Finding } from '../types';
import { addedLines, removedLines } from '../diff/select';
import { isProtected } from '../policy';
import { makeFinding } from './finding';

const RULE = 'ci-tampering';
const STEP = /^\s*-?\s*(?:run|uses):/;
const CHECK = /\b(test|tests|lint|typecheck|type-check|tsc|eslint|jest|vitest|playwright|coverage|holdfast)\b/i;

export const ciTampering: Detector = {
  id: RULE,
  surface: ['file'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];
    for (const c of changes) {
      if (c.kind !== 'file') continue;
      if (!isProtected(c.path, policy, 'ci')) continue;

      for (const l of addedLines(c)) {
        if (/continue-on-error:\s*true\b/.test(l.content)) {
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              line: l.newLine ?? undefined,
              message: 'continue-on-error: true added — failures will no longer fail the job.',
              evidence: l.content.trim(),
              remediation: 'Remove it. A check that cannot fail is not a check.',
            }),
          );
        } else if (/^\s*if:\s*false\b/.test(l.content)) {
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              line: l.newLine ?? undefined,
              message: 'if: false added — this step is disabled.',
              evidence: l.content.trim(),
              remediation: 'Re-enable the step instead of conditioning it off.',
            }),
          );
        }
      }

      // A line removed AND re-added (a reformat or reorder) is not a deletion.
      const stillPresent = new Set(addedLines(c).map((l) => l.content.trim()));
      for (const l of removedLines(c)) {
        if (STEP.test(l.content) && CHECK.test(l.content) && !stillPresent.has(l.content.trim())) {
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              message: 'A CI check step (test/lint/typecheck) was removed.',
              evidence: l.content.trim(),
              remediation: 'Restore the step. Removing the check that protects main is itself the tamper.',
            }),
          );
        }
      }
    }
    return out;
  },
};
