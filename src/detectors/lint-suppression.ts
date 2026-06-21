// #5 lint-suppression (file surface, mechanical, additive-token).
// Added directives that silence the linter/formatter rather than satisfying it.

import { Change, Detector, Finding } from '../types';
import { addedLines } from '../diff/select';
import { isCodeFile } from './files';
import { makeFinding } from './finding';

const RULE = 'lint-suppression';

const PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /eslint-disable(?:-next-line|-line)?\b/, why: 'eslint-disable suppresses lint rules' },
  { re: /\bprettier-ignore\b/, why: 'prettier-ignore suppresses formatting checks' },
  { re: /\bbiome-ignore\b/, why: 'biome-ignore suppresses Biome diagnostics' },
];

export const lintSuppression: Detector = {
  id: RULE,
  surface: ['file'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];
    for (const c of changes) {
      if (c.kind !== 'file' || !isCodeFile(c.path)) continue;
      for (const l of addedLines(c)) {
        for (const p of PATTERNS) {
          if (p.re.test(l.content)) {
            out.push(
              makeFinding(RULE, policy, {
                file: c.path,
                line: l.newLine ?? undefined,
                message: `Lint suppression added: ${p.why}.`,
                evidence: l.content.trim(),
                remediation: 'Resolve the finding rather than suppressing the rule.',
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
