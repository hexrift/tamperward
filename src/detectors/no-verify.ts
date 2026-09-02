// #9 no-verify (command surface, mechanical).
// The agent's most direct bypass: skip the git hooks entirely. Catches the literal
// flags and the env-var escape hatches, plus the short `-n` on `git commit` (but NOT
// on `git push`, where `-n` means --dry-run, not --no-verify).
//
// The flags are matched on the tokeniser's unquoted tokens, against the git
// SUBCOMMAND the segment runs, not on whitespace-split raw text. Raw text read
// `git log -n 5 -- src/commit.ts` as a `git commit -n` (the words were all there) and
// `-m "… --no-verify is banned"` as the flag, while `'--no-verify'` and `--no-veri`
// (git accepts any unambiguous prefix) walked past it.

import { Change, Detector, Finding } from '../types';
import { makeFinding } from './finding';
import { gitSubcommand, segments, words } from './command';

const RULE = 'no-verify';

// Segment-level spellings that are not single tokens: `git -c core.hooksPath=x`,
// `git config core.hooksPath x`, and GIT_CONFIG_* env injection. core.hooksPath is
// strictly MORE general than the flags below: it turns off husky, lefthook, plain
// .git/hooks and pre-commit alike. (P1-9, external review.)
const RAW: Array<{ re: RegExp; why: string }> = [
  { re: /\bcore\.hooksPath\b/i, why: 'core.hooksPath redirects git away from the installed hooks' },
  { re: /\bGIT_CONFIG_KEY_\d+\s*=\s*["']?core\.hooksPath/i, why: 'GIT_CONFIG_* injection sets core.hooksPath' },
];

// Environment escape hatches, matched as whole assignment tokens in the segment's env
// prefix (`HUSKY=0 git …`, `export HUSKY=0`, `env HUSKY=0 git …`).
const ENV: Array<{ re: RegExp; why: string }> = [
  { re: /^HUSKY=0$/, why: 'HUSKY=0 disables all Husky hooks' },
  { re: /^HUSKY_SKIP_HOOKS=1$/, why: 'HUSKY_SKIP_HOOKS=1 skips Husky hooks' },
  { re: /^LEFTHOOK=0$/, why: 'LEFTHOOK=0 disables Lefthook hooks' },
  { re: /^SKIP_SIMPLE_GIT_HOOKS=1$/, why: 'SKIP_SIMPLE_GIT_HOOKS=1 skips simple-git-hooks' },
  { re: /^PRE_COMMIT_ALLOW_NO_CONFIG=1$/, why: 'PRE_COMMIT_ALLOW_NO_CONFIG=1 lets pre-commit no-op' },
  { re: /^LEFTHOOK_EXCLUDE=./, why: 'LEFTHOOK_EXCLUDE=<name> skips the named Lefthook commands' },
];
// The pre-commit framework's own escape hatch: SKIP=<hook-id>[,…] skips those hooks
// for that invocation. `.pre-commit-config.yaml` is a protected hook, so its documented
// bypass has to be one too. `SKIP=` is a plausible variable name elsewhere, so it counts
// only for a git / pre-commit invocation — in the same segment, or in a LATER segment
// of the same command when the assignment persists (`export SKIP=x; git commit`, or a
// bare `SKIP=x` on its own line).
const SKIP = /^SKIP=./;
const SKIP_WHY = 'SKIP=<hook-id> tells the pre-commit framework to skip that hook';

const ENV_PREFIX = /^(?:export|env|sudo)$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Flags, matched as whole unquoted tokens of a `git commit|push|merge` invocation.
// git accepts any unambiguous prefix of a long option: `--no-veri` and `--no-verif`
// are --no-verify; `--no-ver` is ambiguous with --no-verbose and refused.
const HOOK_SUBCOMMANDS: ReadonlySet<string> = new Set(['commit', 'push', 'merge']);
const NO_VERIFY = /^--no-veri(?:f|fy)?$/;
const NO_HOOKS = '--no-hooks';
const SHORT_N = /^-[a-z]*n[a-z]*$/i; // -n, -nm, -an … a short-flag cluster containing n
// Options whose VALUE is the next token: a message or author text is never a flag.
const TAKES_VALUE: ReadonlySet<string> = new Set(['-m', '--message', '-F', '--file', '--author', '--date', '--trailer', '-c', '-C', '--reuse-message', '--reedit-message']);

/** The subcommand's argument tokens with option values dropped. */
function gitArgs(toks: string[], sub: string): string[] {
  const out: string[] = [];
  for (let j = toks.indexOf(sub) + 1; j < toks.length; j++) {
    if (TAKES_VALUE.has(toks[j])) {
      j++;
      continue;
    }
    out.push(toks[j]);
  }
  return out;
}

export const noVerify: Detector = {
  id: RULE,
  surface: ['command'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];
    for (const c of changes) {
      if (c.kind !== 'command') continue;
      let carriedSkip: string | null = null; // the earlier segment that set SKIP=
      for (const seg of segments(c.raw)) {
        let why: string | null = null;
        let evidence = seg;

        for (const p of RAW) {
          if (p.re.test(seg)) {
            why = p.why;
            break;
          }
        }

        const toks = words(seg);
        let k = 0;
        while (k < toks.length && ENV_PREFIX.test(toks[k])) k++;
        const exported = k > 0 && toks[0] === 'export';
        const assigns: string[] = [];
        while (k < toks.length && ASSIGNMENT.test(toks[k])) assigns.push(toks[k++]);
        const bareAssignment = k === toks.length && assigns.length > 0;

        const sub = gitSubcommand(toks);
        const runsHookTool = sub !== null || toks.includes('pre-commit');

        if (!why) {
          for (const a of assigns) {
            const hit = ENV.find((p) => p.re.test(a));
            if (hit) {
              why = hit.why;
              break;
            }
            if (SKIP.test(a)) {
              if (runsHookTool) why = SKIP_WHY;
              else if (exported || bareAssignment) carriedSkip = seg;
            }
          }
        }
        if (!why && carriedSkip && runsHookTool) {
          why = `${SKIP_WHY} (set earlier in the same command)`;
          evidence = `${carriedSkip}; ${seg}`;
        }

        if (!why && sub && HOOK_SUBCOMMANDS.has(sub)) {
          const args = gitArgs(toks, sub);
          if (args.some((t) => NO_VERIFY.test(t))) why = '--no-verify skips the pre-commit/pre-push hooks';
          else if (sub === 'commit' && args.some((t) => SHORT_N.test(t))) why = 'git commit -n skips the pre-commit hook';
        }
        if (!why && toks.includes(NO_HOOKS)) why = '--no-hooks disables hook execution';

        if (why) {
          out.push(
            makeFinding(RULE, policy, {
              message: `Command bypasses git hooks: ${why}.`,
              evidence,
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
