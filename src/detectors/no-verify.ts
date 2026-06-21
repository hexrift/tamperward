// #9 no-verify (command surface, mechanical).
// The agent's most direct bypass: skip the git hooks entirely. Catches the literal
// flags and the env-var escape hatches, plus the short `-n` on `git commit` (but NOT
// on `git push`, where `-n` means --dry-run, not --no-verify).

import { Change, Detector, Finding } from '../types';
import { makeFinding } from './finding';
import { segments, tokens } from './command';

const RULE = 'no-verify';

const LITERAL: Array<{ re: RegExp; why: string }> = [
  { re: /(?:^|\s)--no-verify(?:\s|$)/, why: '--no-verify skips the pre-commit/pre-push hooks' },
  { re: /(?:^|\s)--no-hooks(?:\s|$)/, why: '--no-hooks disables hook execution' },
  { re: /(?:^|[\s;&|=])HUSKY=0(?:\s|$)/, why: 'HUSKY=0 disables all Husky hooks' },
  { re: /\bHUSKY_SKIP_HOOKS=1\b/, why: 'HUSKY_SKIP_HOOKS=1 skips Husky hooks' },
];

const SHORT_N = /^-[a-z]*n[a-z]*$/i; // -n, -nm, -an … a short-flag cluster containing n

export const noVerify: Detector = {
  id: RULE,
  surface: ['command'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];
    for (const c of changes) {
      if (c.kind !== 'command') continue;
      for (const seg of segments(c.raw)) {
        let why: string | null = null;

        for (const p of LITERAL) {
          if (p.re.test(seg)) {
            why = p.why;
            break;
          }
        }

        if (!why && /\bgit\b/.test(seg) && /\bcommit\b/.test(seg)) {
          if (tokens(seg).some((t) => SHORT_N.test(t))) {
            why = 'git commit -n skips the pre-commit hook';
          }
        }

        if (why) {
          out.push(
            makeFinding(RULE, policy, {
              message: `Command bypasses git hooks: ${why}.`,
              evidence: seg,
              remediation:
                'Let the hooks run and fix what they catch. Skipping verification is exactly the move this gate blocks — editing the hook and --no-hooks are blocked too.',
            }),
          );
        }
      }
    }
    return out;
  },
};
