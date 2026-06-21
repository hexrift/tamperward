// #4 ts-any-cast (file surface, mechanical, additive-token).
// Added casts/suppressions that discard the type checker's verdict.

import { Change, Detector, Finding } from '../types';
import { addedLines } from '../diff/select';
import { isCodeFile } from './files';
import { makeFinding } from './finding';

const RULE = 'ts-any-cast';

const PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\bas\s+unknown\s+as\b/, why: 'as unknown as — a double cast that defeats the checker' },
  { re: /\bas\s+any\b/, why: 'as any discards type safety' },
  { re: /:\s*any\b/, why: ': any opts the value out of type checking' },
  { re: /@ts-ignore\b/, why: '@ts-ignore suppresses a type error' },
  { re: /@ts-expect-error\b/, why: '@ts-expect-error suppresses a type error' },
  { re: /@ts-nocheck\b/, why: '@ts-nocheck disables type checking for the whole file' },
];

export const tsAnyCast: Detector = {
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
                message: `Type safety weakened: ${p.why}.`,
                evidence: l.content.trim(),
                remediation: 'Fix the underlying type instead of silencing the checker.',
              }),
            );
            break; // one finding per added line
          }
        }
      }
    }
    return out;
  },
};
