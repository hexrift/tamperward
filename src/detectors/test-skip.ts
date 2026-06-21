// #2 test-skip (file surface, mechanical).
// Added skip/focus markers that quietly drop assertions from the run. `.only` is in
// the same class — it narrows the suite to one block, silencing all the others.
// Scoped to test files to keep precision high.

import { Change, Detector, Finding } from '../types';
import { addedLines } from '../diff/select';
import { isProtected } from '../policy';
import { makeFinding } from './finding';

const RULE = 'test-skip';

const PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\b(?:it|test|describe)\.(?:skip|only|todo)\b/, why: 'a .skip/.only/.todo marker' },
  { re: /\b(?:xit|xtest|xdescribe)\b/, why: 'an x-prefixed disabled test' },
  { re: /\b(?:fit|ftest|fdescribe)\b/, why: 'an f-prefixed focused test (narrows the suite)' },
  { re: /\bpending\(\s*\)/, why: 'a pending() marker' },
];

export const testSkip: Detector = {
  id: RULE,
  surface: ['file'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];
    for (const c of changes) {
      if (c.kind !== 'file') continue;
      if (!isProtected(c.path, policy, 'tests')) continue;
      for (const l of addedLines(c)) {
        for (const p of PATTERNS) {
          if (p.re.test(l.content)) {
            out.push(
              makeFinding(RULE, policy, {
                file: c.path,
                line: l.newLine ?? undefined,
                message: `Test skipped or narrowed: ${p.why}.`,
                evidence: l.content.trim(),
                remediation:
                  'Make the test pass rather than skipping it. If it is genuinely obsolete, a human must sign off.',
              }),
            );
            break;
          }
        }
      }
    }
    return out;
  },
};
