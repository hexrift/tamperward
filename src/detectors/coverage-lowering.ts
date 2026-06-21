// #6 coverage-lowering (file surface, mechanical).
// Three moves, all on a protected config file: dropping a coverageThreshold number,
// stripping --coverage from a test script, or adding --passWithNoTests so an empty
// suite passes.

import { Change, Detector, Finding } from '../types';
import { addedLines, removedLines } from '../diff/select';
import { isProtected } from '../policy';
import { makeFinding } from './finding';

const RULE = 'coverage-lowering';
const KEY = /\b(branches|functions|lines|statements)\b\s*:\s*(\d+(?:\.\d+)?)/;

export const coverageLowering: Detector = {
  id: RULE,
  surface: ['file'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];
    for (const c of changes) {
      if (c.kind !== 'file') continue;
      if (!isProtected(c.path, policy, 'config')) continue;

      const removed = removedLines(c);
      const added = addedLines(c);

      // 1. a threshold number was lowered (same key, smaller value)
      const oldNums = new Map<string, number>();
      for (const l of removed) {
        const m = l.content.match(KEY);
        if (m) oldNums.set(m[1], Number(m[2]));
      }
      for (const l of added) {
        const m = l.content.match(KEY);
        if (!m) continue;
        const key = m[1];
        const nv = Number(m[2]);
        const ov = oldNums.get(key);
        if (ov !== undefined && nv < ov) {
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              line: l.newLine ?? undefined,
              message: `Coverage threshold for ${key} lowered ${ov} → ${nv}.`,
              evidence: l.content.trim(),
              remediation: 'Restore the threshold and raise real coverage; do not lower the gate to pass.',
            }),
          );
        }
      }

      // 2. --coverage stripped from a script
      const removedCoverage = removed.find((l) => /--coverage\b/.test(l.content));
      const stillHasCoverage = added.some((l) => /--coverage\b/.test(l.content));
      if (removedCoverage && !stillHasCoverage) {
        out.push(
          makeFinding(RULE, policy, {
            file: c.path,
            message: 'The --coverage flag was removed from a test script.',
            evidence: removedCoverage.content.trim(),
            remediation: 'Keep coverage reporting on; do not strip the flag to dodge the gate.',
          }),
        );
      }

      // 3. --passWithNoTests added
      for (const l of added) {
        if (/--passWithNoTests\b/.test(l.content)) {
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              line: l.newLine ?? undefined,
              message: '--passWithNoTests added — the suite can now pass with zero tests.',
              evidence: l.content.trim(),
              remediation: 'Remove --passWithNoTests; an empty suite must not be a green check.',
            }),
          );
        }
      }
    }
    return out;
  },
};
