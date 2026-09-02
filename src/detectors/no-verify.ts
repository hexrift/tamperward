// #9 no-verify (command surface, mechanical).
// The agent's most direct bypass: skip the git hooks entirely. Catches the literal
// flags and the env-var escape hatches, plus the short `-n` on `git commit` (but NOT
// on `git push`, where `-n` means --dry-run, not --no-verify).

import { Change, Detector, Finding } from '../types';
import { makeFinding } from './finding';
import { segments, tokens } from './command';

const RULE = 'no-verify';

const LITERAL: Array<{ re: RegExp; why: string; when?: RegExp }> = [
  { re: /(?:^|\s)--no-verify(?:\s|$)/, why: '--no-verify skips the pre-commit/pre-push hooks' },
  { re: /(?:^|\s)--no-hooks(?:\s|$)/, why: '--no-hooks disables hook execution' },
  { re: /(?:^|[\s;&|=])HUSKY=0(?:\s|$)/, why: 'HUSKY=0 disables all Husky hooks' },
  { re: /\bHUSKY_SKIP_HOOKS=1\b/, why: 'HUSKY_SKIP_HOOKS=1 skips Husky hooks' },
  // git-native hook disabling. core.hooksPath is strictly MORE general than the
  // flags above: it turns off husky, lefthook, plain .git/hooks and pre-commit
  // alike, and it was reachable in three spellings the literal list missed
  // (-c, `git config`, and GIT_CONFIG_* env injection). (P1-9, external review.)
  { re: /\bcore\.hooksPath\b/i, why: 'core.hooksPath redirects git away from the installed hooks' },
  { re: /\bGIT_CONFIG_KEY_\d+\s*=\s*["']?core\.hooksPath/i, why: 'GIT_CONFIG_* injection sets core.hooksPath' },
  { re: /(?:^|[\s;&|=])LEFTHOOK=0(?:\s|$)/, why: 'LEFTHOOK=0 disables Lefthook hooks' },
  { re: /\bSKIP_SIMPLE_GIT_HOOKS=1\b/, why: 'SKIP_SIMPLE_GIT_HOOKS=1 skips simple-git-hooks' },
  { re: /\bPRE_COMMIT_ALLOW_NO_CONFIG=1\b/, why: 'PRE_COMMIT_ALLOW_NO_CONFIG=1 lets pre-commit no-op' },
  // The pre-commit framework's own escape hatch: SKIP=<hook-id>[,…] skips those
  // hooks for that one invocation. `.pre-commit-config.yaml` is a protected hook,
  // so its documented bypass has to be one too. `SKIP=` is a plausible variable
  // name elsewhere, so it counts only in a segment that runs git or pre-commit.
  { re: /(?:^|[\s;&|])SKIP=\S+/, why: 'SKIP=<hook-id> tells the pre-commit framework to skip that hook', when: /\b(?:git|pre-commit)\b/ },
  { re: /(?:^|[\s;&|])LEFTHOOK_EXCLUDE=\S+/, why: 'LEFTHOOK_EXCLUDE=<name> skips the named Lefthook commands' },
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
          if (p.re.test(seg) && (!p.when || p.when.test(seg))) {
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
