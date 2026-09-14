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
//
// The flag can also live somewhere other than the invocation (#433): in a config
// VALUE (`git config alias.ci "commit --no-verify"`, then `git ci`), in the shell text
// a `sh -c` / `eval` / `!`-alias runs, or nowhere at all — `pre-commit uninstall`,
// `rm .git/hooks/pre-commit` and the commit paths that never run pre-commit
// (`commit-tree`, `am`, `cherry-pick`, `rebase`) reach the same end without it.

import { Change, Detector, Finding } from '../types';
import { makeFinding } from './finding';
import { gitSubcommand, segments, words } from './command';
import { GIT_HOOKS, chmodDropsExec } from './hook-wiring';

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
// prefix (`HUSKY=0 git …`, `export HUSKY=0`, `env HUSKY=0 git …`). The tokens are
// fully unquoted, so `HUSKY="0"` and `HUSKY='0'` are the same assignment.
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

// Flags, matched as whole unquoted tokens of the git invocation. git accepts any
// unambiguous prefix of a long option: `--no-veri` and `--no-verif` are --no-verify;
// `--no-ver` is ambiguous with --no-verbose and refused. `commit`, `push` and `merge`
// run the hook the flag names; `am` (pre-applypatch) and `rebase` (pre-rebase) take
// the flag too, and on `cherry-pick` it is the same intent spelled at a command git
// refuses — the literal flag is the block class wherever it is typed.
const HOOK_SUBCOMMANDS: ReadonlySet<string> = new Set(['commit', 'push', 'merge', 'am', 'cherry-pick', 'rebase']);
const NO_VERIFY = /^--no-veri(?:f|fy)?$/;
const NO_HOOKS = '--no-hooks';
const SHORT_N = /^-[a-z]*n[a-z]*$/i; // -n, -nm, -an … a short-flag cluster containing n
// Options whose VALUE is the next token: a message or author text is never a flag.
const TAKES_VALUE: ReadonlySet<string> = new Set(['-m', '--message', '-F', '--file', '--author', '--date', '--trailer', '-c', '-C', '--reuse-message', '--reedit-message']);
// A short-flag cluster whose letter takes a value takes THE REST OF THE TOKEN as
// that value (`-mfinal` is `-m final`; `-anm x` is `-a -n -m x`): only the letters
// before it are flags, and when nothing follows it the next token is the value.
const VALUE_IN_CLUSTER = /^-([A-Za-z]*?)[mFCc](.*)$/;

/** The subcommand's argument tokens with option values dropped. */
function gitArgs(toks: string[], sub: string): string[] {
  const out: string[] = [];
  for (let j = toks.indexOf(sub) + 1; j < toks.length; j++) {
    const t = toks[j];
    if (TAKES_VALUE.has(t)) {
      j++;
      continue;
    }
    const cluster = t.startsWith('--') ? null : t.match(VALUE_IN_CLUSTER);
    if (cluster) {
      if (cluster[1]) out.push(`-${cluster[1]}`);
      if (cluster[2] === '') j++;
      continue;
    }
    out.push(t);
  }
  return out;
}

/** The literal flag on the invocation `toks` runs, or null. */
function flagBypass(toks: string[], sub: string | null): string | null {
  if (sub && HOOK_SUBCOMMANDS.has(sub)) {
    const args = gitArgs(toks, sub);
    if (args.some((t) => NO_VERIFY.test(t))) return '--no-verify skips the pre-commit/pre-push hooks';
    if (sub === 'commit' && args.some((t) => SHORT_N.test(t))) return 'git commit -n skips the pre-commit hook';
  }
  if (toks.includes(NO_HOOKS)) return '--no-hooks disables hook execution';
  return null;
}

// ── aliases: the flag in a config value ───────────────────────────────────────
//
// `git config alias.ci "commit --no-verify"` puts the flag where no later `git ci`
// shows it; `git -c alias.ci='commit -n' ci` and GIT_CONFIG_{KEY,VALUE}_n /
// GIT_CONFIG_PARAMETERS injection do the same for one invocation. The alias BODY
// is judged as the git invocation it expands to (a `!` body as the shell text it
// runs), so `alias.lg "log -n 20"` and `alias.ci "commit -v"` stay clean.
const ALIAS_KEY = /^alias\.([A-Za-z0-9_-]+)$/;
// GIT_CONFIG_PARAMETERS carries its own inner quoting (`"'alias.ci=…'"`), which the
// shell hands git verbatim and unquote keeps as content.
const ALIAS_ASSIGN = /^(?:GIT_CONFIG_PARAMETERS=['"]?)?alias\.([A-Za-z0-9_-]+)=([\s\S]*?)['"]?$/;
const CONFIG_KEY_ENV = /^GIT_CONFIG_KEY_(\d+)=alias\.([A-Za-z0-9_-]+)$/;
const CONFIG_READ = /^--(?:get|get-all|get-regexp|unset|unset-all|list|remove-section|rename-section)$|^-l$/;

function aliasBodies(toks: string[], sub: string | null): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const assign = t.match(ALIAS_ASSIGN);
    if (assign) {
      out.push({ name: assign[1], body: assign[2] });
      continue;
    }
    const env = t.match(CONFIG_KEY_ENV);
    if (env) {
      const value = toks.find((v) => v.startsWith(`GIT_CONFIG_VALUE_${env[1]}=`));
      if (value !== undefined) out.push({ name: env[2], body: value.slice(value.indexOf('=') + 1) });
      continue;
    }
    const key = t.match(ALIAS_KEY);
    if (key && sub === 'config' && i + 1 < toks.length && !toks.slice(0, i).some((o) => CONFIG_READ.test(o))) {
      out.push({ name: key[1], body: toks[i + 1] });
    }
  }
  return out;
}

/** Why an alias body bypasses the hooks, or null. */
function aliasBypass(body: string): string | null {
  const text = body.trim();
  if (text.startsWith('!')) return shellBypass(text.slice(1))?.why ?? null;
  const toks = ['git', ...words(text)];
  return flagBypass(toks, gitSubcommand(toks));
}

// ── nested shell text ─────────────────────────────────────────────────────────
const SHELL = /^(?:.*\/)?(?:sh|bash|zsh|dash|ksh)$/;
const SHELL_C = /^-[A-Za-z]*c$/;

/** The first hook bypass in the shell text a `sh -c '…'` / `eval …` / `!alias`
 *  runs. A fresh SKIP= carry: the nested text is its own command. */
function shellBypass(text: string): Verdict | null {
  const carried = { skip: null as string | null };
  for (const seg of segments(text)) {
    const v = inspect(seg, carried);
    if (v) return v;
  }
  return null;
}

// ── unwiring the hook frameworks ──────────────────────────────────────────────
//
// `pre-commit uninstall`, `lefthook uninstall` and `husky uninstall` remove the
// hook scripts each framework installed; `rm .git/hooks/pre-commit` removes the
// pre-commit framework's install target by hand. `.git/hooks/**` is outside every
// git view, so `protected.hooks` cannot cover it and hook-tampering never sees it:
// it is guarded here, as the bypass it is. Only the removal is: reading the hook,
// installing one, or deleting git's `*.sample` files is routine.
const HOOK_TOOL = /^(?:.*\/)?(?:pre-commit|pre_commit|lefthook|husky)(?:\.js|\.py)?$/;
// what may stand between the start of a segment and the tool it runs
const TOOL_WRAPPER = /^(?:sudo|env|command|exec|npx|npm|pnpm|yarn|bunx|bun|python3?|py|poetry|uv|uvx|pipx|node|exec|dlx|run|x|--?[A-Za-z][A-Za-z0-9-]*(?:=.*)?|[A-Za-z_][A-Za-z0-9_]*=.*)$/;
const GIT_DIR = String.raw`(?:\.git|\$\(git rev-parse --git-dir\)|\$\{?GIT_DIR\}?)`;
const HOOK_NAMES = [...GIT_HOOKS].join('|');
const INSTALL_TARGET = new RegExp(String.raw`(?:^|/)(?:${GIT_DIR}/hooks|\$\(git rev-parse --git-path hooks\))(?:/(?:\*|${HOOK_NAMES}))?/?$`);
const REMOVERS: ReadonlySet<string> = new Set(['rm', 'unlink', 'mv', 'chmod', 'truncate', 'shred']);

function unwiring(toks: string[]): string | null {
  let at = 0;
  while (at < toks.length && TOOL_WRAPPER.test(toks[at])) {
    if (HOOK_TOOL.test(toks[at])) break;
    at++;
  }
  const head = toks[at] ?? '';
  if (HOOK_TOOL.test(head) && toks[at + 1] === 'uninstall') {
    return `${head.replace(/^.*\//, '')} uninstall removes the installed git hooks`;
  }
  const cmd = head.replace(/^.*\//, '');
  if (!REMOVERS.has(cmd)) return null;
  const positional = toks.slice(at + 1).filter((t) => !t.startsWith('-'));
  // `mv <hook> <elsewhere>`: the hook as the SOURCE is the removal; as the last
  // positional it is the destination, an install.
  const sources = cmd === 'mv' ? positional.slice(0, -1) : positional;
  const target = sources.find((t) => INSTALL_TARGET.test(t));
  if (target === undefined) return null;
  if (cmd === 'chmod' && !chmodDropsExec(toks)) return null;
  const what = /\/hooks\/?$/.test(target) ? "the pre-commit framework's install directory" : "the pre-commit framework's install target";
  return `${cmd} ${target} removes ${what}`;
}

// ── commit paths that never run pre-commit ────────────────────────────────────
//
// These write commits (or move a branch onto one) without the pre-commit hook:
// `commit-tree` is plumbing, `update-ref` publishes what it made, and `am`,
// `cherry-pick` and `rebase` copy existing commits. They ship at WARN by default,
// whatever the rule's severity: a rebase onto main or a cherry-picked fix lands
// commits the hook already checked, and the harness corpus (1,511 recorded agent
// commands) holds none of them either way, so blocking would refuse routine history
// work on no evidence. Resuming or abandoning an in-progress operation is not a new
// path, and `cherry-pick --no-commit` hands the change to `git commit`, which runs
// the hook. The literal `--no-verify` on any of them is the block class above.
const RESUME = /^--(?:continue|abort|skip|quit|edit-todo|show-current-patch|retry)$/;
const NO_COMMIT = /^--no-commit$|^-[a-zA-Z]*n[a-zA-Z]*$/;

function hookLessPath(toks: string[], sub: string | null): string | null {
  if (sub === null) return null;
  const args = toks.slice(toks.indexOf(sub) + 1);
  switch (sub) {
    case 'commit-tree':
      return 'git commit-tree writes a commit object directly';
    case 'update-ref': {
      if (args.some((a) => a === '-d' || a === '--stdin')) return null;
      const refs = args.filter((a) => !a.startsWith('-'));
      return refs.length >= 2 ? 'git update-ref moves a branch onto a commit no hook checked' : null;
    }
    case 'am':
    case 'cherry-pick':
    case 'rebase':
      if (args.some((a) => RESUME.test(a))) return null;
      if (sub === 'cherry-pick' && args.some((a) => NO_COMMIT.test(a))) return null;
      return `git ${sub} copies commits in without the hook`;
    default:
      return null;
  }
}

// ── the per-segment judgement ─────────────────────────────────────────────────

interface Verdict {
  why: string;
  evidence?: string;
  /** a hook-less commit path: a review prompt, capped at warn */
  path?: true;
}

function inspect(seg: string, carried: { skip: string | null }): Verdict | null {
  for (const p of RAW) if (p.re.test(seg)) return { why: p.why };

  const toks = words(seg);
  let k = 0;
  while (k < toks.length && ENV_PREFIX.test(toks[k])) k++;
  const exported = k > 0 && toks[0] === 'export';
  const assigns: string[] = [];
  while (k < toks.length && ASSIGNMENT.test(toks[k])) assigns.push(toks[k++]);
  const bareAssignment = k === toks.length && assigns.length > 0;

  const sub = gitSubcommand(toks);
  const runsHookTool = sub !== null || toks.includes('pre-commit');

  for (const a of assigns) {
    const hit = ENV.find((p) => p.re.test(a));
    if (hit) return { why: hit.why };
    if (SKIP.test(a)) {
      if (runsHookTool) return { why: SKIP_WHY };
      if (exported || bareAssignment) carried.skip = seg;
    }
  }
  if (carried.skip && runsHookTool) {
    return { why: `${SKIP_WHY} (set earlier in the same command)`, evidence: `${carried.skip}; ${seg}` };
  }

  const flag = flagBypass(toks, sub);
  if (flag) return { why: flag };

  for (const { name, body } of aliasBodies(toks, sub)) {
    const why = aliasBypass(body);
    if (why) return { why: `the git alias \`${name}\` carries the bypass (${why})` };
  }

  for (let i = 0; i + 1 < toks.length; i++) {
    if (SHELL.test(toks[i]) && SHELL_C.test(toks[i + 1]) && i + 2 < toks.length) {
      const inner = shellBypass(toks[i + 2]);
      if (inner) return { why: `${inner.why} (inside a \`${toks[i].replace(/^.*\//, '')} -c\` script)` };
    }
    if (toks[i] === 'eval') {
      const inner = shellBypass(toks.slice(i + 1).join(' '));
      if (inner) return { why: `${inner.why} (inside an \`eval\`)` };
    }
  }

  const removed = unwiring(toks);
  if (removed) return { why: removed };

  const path = hookLessPath(toks, sub);
  if (path) return { why: path, path: true };
  return null;
}

export const noVerify: Detector = {
  id: RULE,
  surface: ['command'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];
    for (const c of changes) {
      if (c.kind !== 'command') continue;
      const carried = { skip: null as string | null }; // the earlier segment that set SKIP=
      for (const seg of segments(c.raw)) {
        const v = inspect(seg, carried);
        if (!v) continue;
        out.push(
          v.path
            ? makeFinding(RULE, policy, {
                message: `Command lands commits without running the pre-commit hook: ${v.why}.`,
                evidence: v.evidence ?? seg,
                remediation:
                  'Rebase, cherry-pick, am and commit-tree copy commits in without re-running the hook. Run the checks the hook runs on the result before pushing, or land the change with `git commit` so the hook sees it.',
                maxSeverity: 'warn',
              })
            : makeFinding(RULE, policy, {
                message: `Command bypasses git hooks: ${v.why}.`,
                evidence: v.evidence ?? seg,
                remediation:
                  'Let the hooks run and fix what they catch. Skipping verification is exactly the move this gate blocks — editing the hook and --no-hooks are blocked too.',
              }),
        );
      }
    }
    return out;
  },
};
