// `tamperward init` — wire the policy and every enforcement point in one command.
//
// SPEC promised this since v0.2 ("tamperward init is not yet shipped"); until now
// adoption meant hand-writing a policy, editing .claude/settings.json, a pre-commit
// hook, and a CI workflow. Four pieces of friction between `npm install` and
// "protected" is how a gate ends up guarding nothing.
//
// CONTRACT: idempotent and non-destructive. Running twice is a no-op; nothing a user
// wrote is ever overwritten. Files we own are created only when absent; files we share
// (.claude/settings.json, an existing pre-commit script) are MERGED — parsed and
// extended for JSON, appended-with-a-marker for shell — and an unparseable shared file
// aborts that item with an error rather than clobbering it. `--dry-run` prints the plan
// and writes nothing.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { POLICY_FILE } from '../policy';
import { loadPolicy } from '../policy-load';
import { HOOK_CMD, MARKER, OURS, PRECOMMIT_CMD, PRE_MATCHER, SWEEP_CMD, TW_VERSION } from '../wiring';

export interface InitOpts {
  cwd?: string;
  dryRun?: boolean;
  /** Overwrite a CI workflow init did not write, or one that has been edited
   *  since it did. Operator-owned: the default never destroys your work. */
  forceWorkflow?: boolean;
}

interface Action {
  item: string;
  path: string;
  status: 'create' | 'update' | 'ok' | 'skip' | 'error';
  detail: string;
  /** Something the operator must check even though the item applied — printed
   *  after the plan, where it cannot hide inside a table row. */
  warning?: string;
  apply?: () => void;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim();
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function gitConfig(cwd: string, key: string): string | null {
  try {
    return execFileSync('git', ['config', '--get', key], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

// The tools whose calls the PreToolUse gate must see (PRE_MATCHER, ../wiring).
// NotebookEdit was added in 1.13; an install wired before that has a matcher
// without it, and init's "already wired" check only ever asked whether OUR
// COMMAND was present — so every repo wired earlier kept a permanently narrower
// gate, and re-running init reported it as correctly configured. See
// planClaudeHooks. (P2-12.)
//
// Our three local commands, recognised in any pin. A command someone wrote by
// hand (`node ./node_modules/.bin/tamperward hook claude`) matches too and is
// left exactly as written; only the `npx --yes tamperward[@v]` form init itself
// writes is ever re-pinned (OURS, ../wiring). hook-tampering judges an edit to
// that form by the same shape: what init would write, modulo a pin that only
// goes up.
const HOOK_RE = /\btamperward(?:@\S+)?\s+hook\s+claude\b/;
const SWEEP_RE = /\btamperward(?:@\S+)?\s+sweep\s+claude\b/;
const PRECOMMIT_RE = /\btamperward(?:@\S+)?\s+check\s+--staged\b/;

// CODEOWNERS. The gate cannot guard the file that decides whether the gate runs.
//
// A `pull_request` workflow executes from the PULL REQUEST'S OWN HEAD, and a
// required status check is matched by JOB NAME. So a pull request can keep the
// job called `gate`, replace every Tamperward invocation in it with `true`, and
// present a green required check over any change it likes — including one the
// gate would have blocked. Reproduced end to end on this project's own CI: the
// job reported success in three seconds, having run `true`, over a pull request
// that lowered a mechanical rule from block to warn.
//
// No detector can close this, because the detector is defined by the candidate.
// The only thing that can is a human requirement on the paths that constitute
// the gate — which is what CODEOWNERS expresses, and what branch protection
// enforces. Both halves are needed: the file alone is advisory.
const CODEOWNERS_MARK = '# tamperward: the gate cannot guard the file that defines it';
const CODEOWNERS_PATHS = ['/.github/workflows/', '/.tamperward.yml', '/.github/CODEOWNERS'];

/**
 * Whether an existing CODEOWNERS already requires an owner on `critical`.
 *
 * Directory rules cover what is under them, so a repository that already writes
 * `/.github/ @someone` needs nothing added for `/.github/workflows/`. Checking
 * for the literal string instead would append rules that are already in force —
 * noise in the one file people need to be able to read at a glance.
 */
function coveredBy(existing: string, critical: string): boolean {
  for (const line of existing.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const raw = t.split(/\s+/)[0];
    if (!t.slice(raw.length).trim()) continue; // a pattern with no owner requires nobody
    if (raw === '*' || raw === '**') return true;
    // `/.github/**` and `/.github/*` are the glob spellings of the directory rule
    // `/.github/`; an unanchored pattern (`.github/`, `CODEOWNERS`) matches at any
    // depth, so it covers the anchored path too. Re-runs used to miss both forms
    // and append a second rule for a path that already had an owner. (D-10.)
    const pattern = raw.replace(/\/\*{1,2}$/, '/');
    if (pattern.includes('*')) continue; // other wildcards: not something this can vouch for
    const anchored = pattern.startsWith('/') ? pattern : '/' + pattern;
    if (anchored === critical) return true;
    if (anchored.endsWith('/') && critical.startsWith(anchored)) return true;
    if (!pattern.startsWith('/')) {
      if (critical.endsWith('/' + pattern)) return true;
      if (pattern.endsWith('/') && critical.includes('/' + pattern)) return true;
    }
  }
  return false;
}

/**
 * `@owner` from the origin remote, or null when it cannot be determined.
 *
 * The first path segment of a GitHub remote is a user OR an organisation, and
 * only a user is a valid CODEOWNERS owner on its own — an organisation must be
 * spelled `@org/team`. GitHub does not say which it is offline, so `confirmed`
 * is true only when the segment is the operator's own login (`github.user` or
 * `user.name` in git config); otherwise the rule is written with a TODO and
 * init warns, because a rule GitHub rejects protects nothing, silently. (D-10.)
 */
function inferOwner(cwd: string): { owner: string; confirmed: boolean } | null {
  const url = gitConfig(cwd, 'remote.origin.url');
  const m = url?.match(/github\.com[:/]+([^/]+)\//);
  if (!m) return null;
  const segment = m[1];
  const self = [gitConfig(cwd, 'github.user'), gitConfig(cwd, 'user.name')].filter((v): v is string => v !== null);
  return { owner: `@${segment}`, confirmed: self.some((v) => v.toLowerCase() === segment.toLowerCase()) };
}

const POLICY_CONTENT = `# Tamperward policy. The BASELINE (all rules, standard protected globs) applies even
# without this file — everything here is an override, so an empty file changes nothing.
# Docs: https://github.com/hexrift/tamperward#readme
#
# version gates rule GRADUATIONS: a baseline rule promoted warn -> block at policy
# version N blocks only when you declare version >= N. Raising it is opting in.
version: 1

# protected:            # categories MERGE with the baseline (additive, never replace)
#   tests: ['e2e/**']
# rules:                # an explicit severity wins over the baseline in either direction
#   snapshot-rewrite: { severity: block }
# ignore: []            # visible blind spots — the count is always reported
`;

// The local hooks are PINNED, like the workflow (HOOK_CMD, SWEEP_CMD,
// PRECOMMIT_CMD, ../wiring). They used to be `npx --yes tamperward` with no
// version: where the package is a devDependency npx runs the installed copy,
// but where it is not — the common case for a repo that only ran `init` —
// every hook invocation resolved `latest` from the registry, so the gate a
// repo ran changed under it without anyone changing anything. That is the
// P2-15 floating dependency again, in the two enforcement points nobody had
// pinned. `init` re-pins an install it wrote for an older version
// (planClaudeHooks, planPreCommit); a command someone edited by hand is left
// alone.

/** The pin an `npx --yes tamperward…` command of ours carries: a version, '' for
 *  unpinned, or null when the command is not one init writes. */
function pinOf(command: string): string | null {
  const m = command.match(OURS);
  return m ? (m[1] ?? '') : null;
}

/** Whether a command init wrote needs re-pinning to this build. */
function stalePin(command: string): boolean {
  const pin = pinOf(command);
  return pin !== null && pin !== TW_VERSION;
}

const WORKFLOW_CONTENT = `name: tamperward

# The CI authority for main: the same engine as the agent hook and pre-commit, run over
# the PR's commit range. A block fails the check and clears ONLY via the out-of-band
# label \`tamperward:allow:<rule>@<head-sha>\` applied by someone with triage access or higher —
# never a file the PR itself can commit. The verify step reads the same labels:
# \`tamperward:allow:verify@<head-sha>\` accepts a masked failure a reviewer has judged.
#
# labeled/unlabeled re-run the gate because the sign-off is read from the EVENT payload:
# a label applied after a failure could otherwise never take effect, and REVOKING a
# sign-off must re-block rather than linger green.
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]

permissions:
  contents: read

jobs:
  tamperward:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    # The gate is fetched from the registry AT GATE TIME, from inside the
    # checked-out pull request — and \`npm\` reads \`.npmrc\` from the working
    # directory. A PR that commits one line, \`registry=https://…\`, chooses where
    # the authority judging it is downloaded from; the version pin below pins the
    # STRING, not the SOURCE. An environment variable outranks a project
    # \`.npmrc\` in npm's config precedence, so this is what makes the pin mean
    # something.
    env:
      NPM_CONFIG_REGISTRY: https://registry.npmjs.org/
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0 # the range diff needs both endpoints
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - name: Resolve out-of-band sign-off from PR labels
        id: oob
        env:
          LABELS: \${{ toJSON(github.event.pull_request.labels.*.name) }}
        run: |
          RULES="$(printf '%s' "$LABELS" | jq -r '.[] | select(startswith("tamperward:allow:")) | sub("^tamperward:allow:"; "")' | paste -sd, -)"
          echo "rules=$RULES" >> "$GITHUB_OUTPUT"
      - name: Tamperward gate (diff-time)
        env:
          TAMPERWARD_OOB_SIGNOFF: \${{ steps.oob.outputs.rules }}
          # Binds each approval to the commit it was granted for: labels persist
          # across pushes, so an unbound one would clear every later finding on
          # the same PR. Labels must read tamperward:allow:<rule>@<head-sha>.
          TAMPERWARD_OOB_HEAD: \${{ github.event.pull_request.head.sha }}
        run: npx --yes tamperward@${TW_VERSION} check --diff "\${{ github.event.pull_request.base.sha }}...\${{ github.event.pull_request.head.sha }}"
      # Diff-time detection is spelling-dependent by nature; pristine
      # re-execution is not, and it was the layer nothing got past in the
      # taskbench sweeps. Shipping a CI template WITHOUT it meant every
      # masked-failure class was adjudicated only at the local layer — the
      # layer an agent shares a filesystem with. (P1-5, external review.)
      #
      # Requires a \`verify:\` block in .tamperward.yml naming the suite command;
      # without one this step fails closed (exit 2) rather than passing quietly.
      - name: Tamperward verify (pristine re-execution)
        env:
          # The same channel as the gate. \`tamperward:allow:verify@<head-sha>\`
          # accepts a MASKED_FAILURE — a reviewer has read the intentional test
          # change and agrees the original suite no longer applies. It clears
          # nothing else: a red visible suite, or a run that could not verify,
          # stays red whatever the labels say.
          TAMPERWARD_OOB_SIGNOFF: \${{ steps.oob.outputs.rules }}
          TAMPERWARD_OOB_HEAD: \${{ github.event.pull_request.head.sha }}
        run: npx --yes tamperward@${TW_VERSION} verify --require-ancestor --base "\${{ github.event.pull_request.base.sha }}"
`;

// Provenance mark for the generated workflow. A file init wrote and NOBODY has
// touched can be migrated safely when the template changes; a file someone
// edited must never be overwritten. The stamp records both facts — which
// version generated the body, and the hash of the body as generated — so the
// two cases are distinguishable years later without keeping old templates
// around. Un-stamped files are treated as somebody else's, not as ours.
const WORKFLOW_MARK = '# tamperward:generated';
const WORKFLOW_MARK_RE = /^# tamperward:generated v(\S+) sha256:([0-9a-f]+)\n/m;

function bodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

function workflowFile(body: string): string {
  return `${WORKFLOW_MARK} v${TW_VERSION} sha256:${bodyHash(body)}\n${body}`;
}

/** The stamp and the body, or null when the file carries no stamp. */
function readWorkflowMark(src: string): { version: string; hash: string; body: string } | null {
  const m = src.match(WORKFLOW_MARK_RE);
  if (!m) return null;
  return { version: m[1], hash: m[2], body: src.replace(WORKFLOW_MARK_RE, '') };
}

interface HookEntry { type?: string; command?: string }
interface HookMatcher { matcher?: string; hooks?: HookEntry[] }
interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[] | undefined>;
  [key: string]: unknown;
}

/** The tools a matcher selects, or null when it selects everything (`*`, or an
 *  absent matcher — Claude Code treats both as "every tool"). The runtime reads a
 *  matcher of letters, digits, `_`, `-`, spaces, `,` and `|` as an exact list
 *  separated by `|` or `,` with optional surrounding whitespace, so `Edit, Write`
 *  is the same list as `Edit|Write`. */
function toolSet(matcher: string | undefined): Set<string> | null {
  const m = String(matcher ?? '').trim();
  if (m === '' || m === '*') return null;
  return new Set(m.split(/[|,]/).map((t) => t.trim()).filter(Boolean));
}

/** Tools PRE_MATCHER requires that this matcher does not select. */
function missingTools(matcher: string | undefined): string[] {
  const have = toolSet(matcher);
  if (have === null) return []; // matches every tool: nothing is missing
  return PRE_MATCHER.split('|').filter((t) => !have.has(t));
}

/** Why `hooks` is not the shape Claude Code reads, or null when it is. */
function hooksShapeError(hooks: unknown): string | null {
  if (hooks === undefined || hooks === null) return null;
  if (!isPlainObject(hooks)) return 'hooks is not an object';
  for (const [event, arr] of Object.entries(hooks)) {
    if (arr === undefined || arr === null) continue;
    if (!Array.isArray(arr)) return `hooks.${event} is not a list`;
    for (const m of arr) {
      if (!isPlainObject(m)) return `hooks.${event} contains an entry that is not an object`;
      if (m.hooks !== undefined && m.hooks !== null && !(Array.isArray(m.hooks) && m.hooks.every(isPlainObject))) {
        return `hooks.${event} has a "hooks" value that is not a list of { type, command }`;
      }
    }
  }
  return null;
}

function planPolicy(cwd: string): Action {
  const path = join(cwd, POLICY_FILE);
  if (existsSync(path)) {
    // "Present" is not "in force": a policy that does not load switches the gate
    // off (check exits 2, the hook denies everything) — init used to report it as
    // fine without reading it. Load it with the real loader and say what is wrong.
    try {
      loadPolicy(cwd);
    } catch (e) {
      return { item: 'policy', path: POLICY_FILE, status: 'error', detail: `present but does not load — ${errText(e)}; fix it, then re-run init (left untouched)` };
    }
    return { item: 'policy', path: POLICY_FILE, status: 'ok', detail: 'already present and loads — left untouched' };
  }
  return {
    item: 'policy', path: POLICY_FILE, status: 'create',
    detail: 'baseline policy with commented overrides',
    apply: () => writeFileSync(path, POLICY_CONTENT),
  };
}

/** Merge our two hooks into .claude/settings.json, preserving everything else. */
function planClaudeHooks(cwd: string): Action {
  const rel = '.claude/settings.json';
  const path = join(cwd, rel);
  let settings: ClaudeSettings = {};
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return {
        item: 'agent', path: rel, status: 'error',
        detail: 'exists but is not valid JSON — fix it, then re-run init (refusing to overwrite)',
      };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { item: 'agent', path: rel, status: 'error', detail: 'exists but is not a JSON object — refusing to overwrite' };
    }
    settings = parsed as ClaudeSettings;
  }

  // The shape Claude Code reads: hooks → event → [{ matcher, hooks: [{ type, command }] }].
  // Anything else used to throw halfway through apply (after the policy was already
  // written) — planned here, so a malformed file is an error row and nothing else.
  const shapeError = hooksShapeError(settings.hooks);
  if (shapeError) {
    return { item: 'agent', path: rel, status: 'error', detail: `${shapeError} — fix it, then re-run init (refusing to overwrite)` };
  }

  const hooks = (settings.hooks ??= {});
  const entriesWith = (arr: HookMatcher[] | undefined, needle: RegExp): HookMatcher[] =>
    (arr ?? []).filter((m) => (m.hooks ?? []).some((h) => needle.test(String(h.command ?? ''))));

  const preEntries = entriesWith(hooks.PreToolUse, HOOK_RE);
  const needPre = preEntries.length === 0;
  const stopEntries = entriesWith(hooks.Stop, SWEEP_RE);
  const needStop = stopEntries.length === 0;

  // REPAIR an existing PreToolUse matcher that does not cover every tool the
  // gate must see. Presence of our command was the only thing checked before,
  // so an install wired against an older PRE_MATCHER stayed narrow forever and
  // re-running init confirmed it as fine. A matcher listing fewer tools is a
  // gate with a hole in it, not a preference. (P2-12.)
  const stale = preEntries.filter((m) => missingTools(m.matcher).length > 0);
  // RE-PIN commands init wrote for another version (or wrote unpinned, before
  // 1.14.7). Only the exact `npx --yes tamperward[@v] <ours>` shape qualifies.
  const repin = [...preEntries, ...stopEntries]
    .flatMap((m) => m.hooks ?? [])
    .filter((h) => stalePin(String(h.command ?? '')));
  // DECLARE `disableAllHooks: false`. The runtime honours the key from any settings
  // file, the project file overriding the user file, and reloads every file live
  // in-session — so a `true` written to `~/.claude/settings.json` (outside every
  // repository glob) switched the gate off for the rest of the session. With the
  // project file saying `false`, the user file's value never reaches the runtime.
  // hook-tampering holds the declaration in place: removing or flipping it is
  // the tamper. (Pass 3a, P0-1.)
  const needDisableFalse = settings.disableAllHooks !== false;
  if (!needPre && !needStop && stale.length === 0 && repin.length === 0 && !needDisableFalse) {
    return { item: 'agent', path: rel, status: 'ok', detail: 'PreToolUse + Stop hooks already wired' };
  }

  const repairing = stale.length > 0 ? [...new Set(stale.flatMap((m) => missingTools(m.matcher)))] : [];
  const pins = [...new Set(repin.map((h) => pinOf(String(h.command ?? '')) || 'unpinned'))];
  return {
    item: 'agent', path: rel, status: existsSync(path) ? 'update' : 'create',
    detail: [
      needPre && 'wire PreToolUse deny',
      needStop && 'wire Stop sweep',
      repairing.length > 0 && `widen the PreToolUse matcher to cover ${repairing.join(', ')}`,
      repin.length > 0 && `re-pin the hook commands to tamperward@${TW_VERSION} (was ${pins.join(', ')})`,
      needDisableFalse && (settings.disableAllHooks === undefined
        ? 'declare disableAllHooks: false so the user settings file cannot switch the hooks off'
        : `set disableAllHooks: false (was ${JSON.stringify(settings.disableAllHooks)})`),
    ].filter(Boolean).join(' + '),
    apply: () => {
      for (const h of repin) {
        const kind = String(h.command ?? '').match(OURS)?.[2];
        h.command = kind === 'hook claude' ? HOOK_CMD : kind === 'sweep claude' ? SWEEP_CMD : h.command;
      }
      if (needPre) {
        (hooks.PreToolUse ??= []).push({
          matcher: PRE_MATCHER,
          hooks: [{ type: 'command', command: HOOK_CMD }],
        });
      }
      for (const m of stale) {
        // Union, not replacement: a matcher someone widened with their own
        // tools keeps them. Only the missing ones are appended.
        m.matcher = [...(toolSet(m.matcher) ?? new Set<string>()), ...missingTools(m.matcher)].join('|');
      }
      if (needStop) {
        (hooks.Stop ??= []).push({ hooks: [{ type: 'command', command: SWEEP_CMD }] });
      }
      if (needDisableFalse) settings.disableAllHooks = false;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
    },
  };
}

// Hook MANAGERS that own the script in the hooks directory and regenerate it on
// their next install: a line appended to their file lasts until then, and the
// gate silently stops running. Their wiring belongs in their config, so init
// reports the exact snippet instead of writing where it cannot stay.
const MANAGED_HOOKS: ReadonlyArray<{ name: string; configs: string[]; hookRe: RegExp; hint: string }> = [
  {
    name: 'lefthook',
    configs: ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml', 'lefthook-local.yml', 'lefthook-local.yaml'],
    hookRe: /\blefthook\b/i,
    hint: `add this under \`pre-commit:\` → \`commands:\` in lefthook.yml:\n` +
      `        tamperward:\n          run: ${PRECOMMIT_CMD}`,
  },
  {
    name: 'pre-commit',
    configs: ['.pre-commit-config.yaml', '.pre-commit-config.yml'],
    hookRe: /pre-commit\.com|File generated by pre-commit/i,
    hint: `add this under \`repos:\` in .pre-commit-config.yaml:\n` +
      `        - repo: local\n          hooks:\n            - id: tamperward\n              name: tamperward\n` +
      `              entry: ${PRECOMMIT_CMD}\n              language: system\n              pass_filenames: false\n              always_run: true`,
  },
];

/**
 * The hooks directory git will actually run from. `git rev-parse --git-path hooks`
 * honours `core.hooksPath` (a committed `.githooks/`, simple-git-hooks, lefthook,
 * husky), a worktree's shared git dir, and a submodule's — where a hard-wired
 * `.git/hooks` used to write a hook git never ran and then report it as wired
 * on every re-run. (D-3.) Falls back to `.git/hooks` when git is unavailable
 * but a `.git` directory is present.
 */
function hooksDir(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out) return resolve(cwd, out);
  } catch {
    /* not a repo, or no git on PATH */
  }
  return existsSync(join(cwd, '.git')) ? join(cwd, '.git', 'hooks') : null;
}

/** A path for the plan table: repo-relative when it is inside the repo. */
function display(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

/**
 * Index of the first line after which nothing in the script runs — an `exec` or
 * `exit` at the TOP LEVEL (not inside if/case/loop/function, not after `&&` or
 * `||`, not a comment, not the redirection-only `exec < /dev/tty`) — or -1.
 * Appending the gate after such a line produced dead code that init then
 * reported as wired. (D-4.) Kept deliberately conservative: a construct this
 * does not understand reads as depth > 0, which means "append" — today's
 * behaviour — never a wrong insertion in the middle of somebody's script.
 */
export function unconditionalExitAt(lines: string[]): number {
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#')) continue;
    if (depth === 0) {
      if (/^exit(\s|$|;)/.test(t)) return i;
      const exec = t.match(/^exec(?:\s+(.*))?$/);
      // `exec` alone or followed only by redirections re-plumbs the shell; it does
      // not replace it. `exec cmd …` does.
      if (exec && exec[1] && !/^(\d*[<>]|&>)/.test(exec[1])) return i;
    }
    const opens =
      (t.match(/(?:^|[;(]\s*|&&\s*|\|\|\s*)(?:if|case|for|while|until)\s/g) ?? []).length +
      (/(?:^|\s)\{\s*$/.test(t) ? 1 : 0);
    const closes =
      (t.match(/(?:^|[;]\s*)(?:fi|esac|done)(?:\s|;|$)/g) ?? []).length + (/^\}/.test(t) ? 1 : 0);
    depth = Math.max(0, depth + opens - closes);
  }
  return -1;
}

/**
 * Husky when present; otherwise the hooks directory git resolves; never a file
 * a hook manager will regenerate. Appending to an existing script is safe for
 * shell (a new line at the end) UNLESS an unconditional `exec`/`exit` precedes
 * it, in which case the gate goes before that line. Marked, so re-runs find it.
 */
function planPreCommit(cwd: string): Action {
  const block = [MARKER, PRECOMMIT_CMD];
  const skip = (detail: string): Action => ({ item: 'pre-commit', path: '(none)', status: 'skip', detail });

  let path: string;
  let note: string;
  if (existsSync(join(cwd, '.husky'))) {
    path = join(cwd, '.husky', 'pre-commit');
    note = 'husky';
  } else {
    const managed = MANAGED_HOOKS.find((m) => m.configs.some((c) => existsSync(join(cwd, c))));
    if (managed) {
      return skip(`${managed.name} manages this repository's hooks and regenerates them on install, so a line in the hooks directory would not last — ${managed.hint}`);
    }
    const dir = hooksDir(cwd);
    if (!dir) return skip('not a git repo and no .husky/ — nothing to wire');
    if (basename(dir) === '_' && basename(dirname(dir)) === '.husky') {
      // husky v9 points core.hooksPath at its shim directory; the user's script is
      // .husky/pre-commit, which the shim runs.
      path = join(dirname(dir), 'pre-commit');
      note = 'husky';
    } else {
      path = join(dir, 'pre-commit');
      const rel = display(cwd, dir);
      note = rel === join('.git', 'hooks')
        ? 'plain git hook (local-only: .git/hooks is not committed — consider husky to share it)'
        : `git hooks directory ${rel} (core.hooksPath)`;
    }
  }
  const rel = display(cwd, path);

  if (existsSync(path) && !statSync(path).isFile()) {
    return { item: 'pre-commit', path: rel, status: 'error', detail: 'exists but is not a regular file — refusing to write' };
  }
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (existing === null) {
    return {
      item: 'pre-commit', path: rel, status: 'create', detail: `create via ${note}`,
      apply: () => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `#!/bin/sh\n${block.join('\n')}\n`);
        chmodSync(path, 0o755);
      },
    };
  }

  const owner = MANAGED_HOOKS.find((m) => m.hookRe.test(existing));
  if (owner) {
    return { item: 'pre-commit', path: rel, status: 'skip', detail: `generated by ${owner.name}, which overwrites it on install — ${owner.hint}` };
  }

  const lines = existing.split('\n');
  const dead = unconditionalExitAt(lines);
  const at = lines.findIndex((l) => PRECOMMIT_RE.test(l));
  const write = (out: string[]): void => {
    writeFileSync(path, out.join('\n'));
    chmodSync(path, 0o755);
  };

  if (at !== -1 && (dead === -1 || at < dead)) {
    // Present AND reachable. Re-pin the line init wrote if it carries another
    // version (or none); a hand-written invocation is left exactly as it is.
    if (!stalePin(lines[at])) {
      return { item: 'pre-commit', path: rel, status: 'ok', detail: 'already runs the staged check' };
    }
    const was = pinOf(lines[at]) || 'unpinned';
    return {
      item: 'pre-commit', path: rel, status: 'update',
      detail: `re-pin the staged check to tamperward@${TW_VERSION} (was ${was})`,
      apply: () => { lines[at] = PRECOMMIT_CMD; write(lines); },
    };
  }

  if (at !== -1) {
    // Present but UNREACHABLE: line `dead` ends the script before it. The block
    // init wrote (marker + our own command) is moved above; anything else is
    // somebody's script, so it is reported rather than rearranged.
    const ours = pinOf(lines[at]) !== null && lines[at - 1]?.trim() === MARKER;
    if (!ours) {
      return {
        item: 'pre-commit', path: rel, status: 'error',
        detail: `the staged check on line ${at + 1} never runs: line ${dead + 1} (\`${lines[dead].trim()}\`) ends the script first — move the tamperward line above it`,
      };
    }
    return {
      item: 'pre-commit', path: rel, status: 'update',
      detail: `move the staged check above line ${dead + 1} (\`${lines[dead].trim()}\`), which ended the script before it ran`,
      apply: () => {
        const out = lines.filter((_, i) => i !== at && i !== at - 1);
        out.splice(dead, 0, ...block);
        write(out);
      },
    };
  }

  if (dead !== -1) {
    return {
      item: 'pre-commit', path: rel, status: 'update',
      detail: `insert the staged check above line ${dead + 1} (\`${lines[dead].trim()}\`), which ends the script — ${note}`,
      apply: () => {
        const out = [...lines];
        out.splice(dead, 0, ...block);
        write(out);
      },
    };
  }

  return {
    item: 'pre-commit', path: rel, status: 'update', detail: `append the staged check (${note})`,
    apply: () => write([...existing.replace(/\n?$/, '\n').split('\n').slice(0, -1), ...block, '']),
  };
}

/**
 * The CI workflow, with MIGRATION.
 *
 * "Already present — left untouched" was the whole of the previous logic, and
 * it made the CI template write-once per repository. Everything shipped in that
 * template since is therefore absent from every repo that ran init before it:
 * the verify step (1.9), the version pin (P2-15), `--require-ancestor` (P1-3),
 * the head-bound sign-off label. Those are not cosmetic — a repo whose workflow
 * predates 1.9 has diff-time detection and no pristine re-execution at all, and
 * `init` told its owner, truthfully by its own logic and misleadingly in fact,
 * that CI was wired. Security fixes that only reach new adopters are not
 * shipped.
 *
 * So: files we generated AND nobody has edited are migrated in place; files
 * that were edited, or that we never wrote, are reported and left exactly as
 * they are. The stamp decides which — never a guess, never a heuristic on
 * content. `--force-workflow` is the operator's override for the second case.
 */
/**
 * Require a human on the paths that decide whether the gate runs.
 *
 * Appended at the END of an existing CODEOWNERS on purpose: the file is
 * last-match-wins, so our rules take precedence over a broader earlier pattern
 * rather than being shadowed by one.
 */
function planCodeowners(cwd: string): Action {
  const rel = '.github/CODEOWNERS';
  // GitHub reads whichever of these exists; do not add a second one.
  const existingRel = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].find((r) =>
    existsSync(join(cwd, r)),
  );
  const path = join(cwd, existingRel ?? rel);
  const existing = existingRel ? readFileSync(path, 'utf8') : null;

  const missing = CODEOWNERS_PATHS.filter((p) => existing === null || !coveredBy(existing, p));
  if (missing.length === 0) {
    return { item: 'codeowners', path: existingRel!, status: 'ok', detail: 'gate paths already have code owners' };
  }

  const inferred = inferOwner(cwd);
  const owner = inferred?.owner ?? null;
  const unconfirmed = inferred !== null && !inferred.confirmed;
  const block =
    `\n${CODEOWNERS_MARK}\n` +
    '# A pull request that rewrites the workflow can keep the job name, replace the\n' +
    '# gate with `true`, and still report a green required check. Only a human\n' +
    '# requirement on these paths prevents that.\n' +
    (owner === null
      ? '# REPLACE @OWNER BELOW with a real user or team — an unresolvable owner protects nothing.\n'
      : unconfirmed
        ? `# TODO: replace ${owner} with ${owner}/<team> if "${owner.slice(1)}" is an organisation. GitHub\n` +
          '# rejects a bare organisation as an owner, and a rule with an invalid owner protects\n' +
          '# nothing. A user login is fine as written.\n'
        : '') +
    missing.map((p) => `${p.padEnd(24)} ${owner ?? '@OWNER'}`).join('\n') +
    '\n';

  return {
    item: 'codeowners',
    path: existingRel ?? rel,
    status: existing === null ? 'create' : 'update',
    detail:
      (existing === null ? 'require a code owner on ' : 'add missing code-owner rules for ') +
      missing.join(', ') +
      (owner === null ? ' — OWNER UNKNOWN, edit @OWNER before this does anything' : ` (${owner}${unconfirmed ? ', unconfirmed — see warning below' : ''})`),
    ...(inferred && unconfirmed
      ? {
          warning:
            `${inferred.owner} was inferred from the origin remote and is not confirmed to be a user. If "${inferred.owner.slice(1)}" is an ` +
            `organisation, replace it with ${inferred.owner}/<team> in CODEOWNERS: GitHub rejects a bare organisation as an owner, ` +
            'and a rule with an invalid owner protects nothing.',
        }
      : {}),
    apply: () => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, existing === null ? block.replace(/^\n/, '') : existing.replace(/\n?$/, '\n') + block);
    },
  };
}

function planWorkflow(cwd: string, force: boolean): Action {
  const rel = '.github/workflows/tamperward.yml';
  const path = join(cwd, rel);
  const write = (): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, workflowFile(WORKFLOW_CONTENT));
  };
  if (!existsSync(path)) {
    return {
      item: 'ci', path: rel, status: 'create',
      detail: 'PR gate with out-of-band label sign-off (re-runs on labeled/unlabeled)',
      apply: write,
    };
  }

  let src: string;
  try {
    src = readFileSync(path, 'utf8');
  } catch {
    return { item: 'ci', path: rel, status: 'error', detail: 'exists but cannot be read — refusing to overwrite' };
  }
  const current = bodyHash(WORKFLOW_CONTENT);
  const mark = readWorkflowMark(src);

  if (mark && bodyHash(mark.body) === current) {
    return { item: 'ci', path: rel, status: 'ok', detail: `generated by tamperward and current (v${mark.version})` };
  }
  if (mark && bodyHash(mark.body) === mark.hash) {
    // Ours, byte-identical to what v<mark.version> generated: safe to migrate.
    return {
      item: 'ci', path: rel, status: 'update',
      detail: `generated by tamperward v${mark.version} and unmodified — migrating to the v${TW_VERSION} template`,
      apply: write,
    };
  }
  if (force) {
    return {
      item: 'ci', path: rel, status: 'update',
      detail: mark
        ? `edited since tamperward v${mark.version} generated it — OVERWRITING (--force-workflow)`
        : 'not generated by tamperward — OVERWRITING (--force-workflow)',
      apply: write,
    };
  }
  return {
    item: 'ci', path: rel, status: 'skip',
    detail:
      (mark ? `edited since tamperward v${mark.version} generated it` : 'present but not generated by tamperward') +
      ` — left untouched. Compare it against the v${TW_VERSION} template (an older one may lack the ` +
      'pristine-verify step) and re-run with --force-workflow to replace it.',
  };
}

/** A planner that throws (a directory where a file was expected, an unreadable
 *  file) becomes an error ROW, so the rest of the plan still exists and nothing is
 *  applied before every item has been planned. (D-6.) */
function planned(item: string, path: string, plan: () => Action): Action {
  try {
    return plan();
  } catch (e) {
    return { item, path, status: 'error', detail: `cannot plan this item — ${errText(e)}` };
  }
}

export function planInit(cwd: string, opts: { forceWorkflow?: boolean } = {}): Action[] {
  return [
    planned('policy', POLICY_FILE, () => planPolicy(cwd)),
    planned('agent', '.claude/settings.json', () => planClaudeHooks(cwd)),
    planned('pre-commit', '(hooks)', () => planPreCommit(cwd)),
    planned('ci', '.github/workflows/tamperward.yml', () => planWorkflow(cwd, opts.forceWorkflow ?? false)),
    planned('codeowners', '.github/CODEOWNERS', () => planCodeowners(cwd)),
  ];
}

export function runInit(opts: InitOpts): number {
  const cwd = opts.cwd ?? process.cwd();
  const plan = planInit(cwd, { forceWorkflow: opts.forceWorkflow });
  const w = process.stdout;

  // The plan is complete before the first write (planInit never throws). An apply
  // that fails anyway is reported as its own error row and never as a crash that
  // leaves the summary unprinted and the operator guessing what was written.
  let applied = 0;
  for (const a of plan) {
    if (!opts.dryRun && a.apply) {
      try {
        a.apply();
        applied++;
      } catch (e) {
        a.status = 'error';
        a.detail = `could not be written — ${errText(e)}`;
        a.apply = undefined;
      }
    }
    const verb = opts.dryRun && (a.status === 'create' || a.status === 'update') ? `would ${a.status}` : a.status;
    w.write(`  ${a.item.padEnd(10)} ${verb.padEnd(12)} ${a.path}  — ${a.detail}\n`);
  }
  for (const a of plan) {
    if (a.warning) w.write(`\nWARNING (${a.item}): ${a.warning}\n`);
  }

  const errors = plan.filter((a) => a.status === 'error');
  const changed = opts.dryRun ? plan.filter((a) => a.apply).length : applied;
  if (errors.length) {
    w.write(`\ntamperward init: ${errors.length} item(s) need your attention above; the rest ${opts.dryRun ? 'are planned' : 'were applied'}.\n`);
    return 2;
  }
  w.write(
    changed === 0
      ? '\ntamperward init: everything already wired — nothing to do.\n'
      : opts.dryRun
        ? `\ntamperward init: ${changed} change(s) planned. Re-run without --dry-run to apply.\n`
        : `\ntamperward init: ${changed} change(s) applied. Commit them so the gate travels with the repo.\n`,
  );
  // Always, and last, because it is the one thing init CANNOT do for you and the
  // one thing without which the CI half of this tool is decorative.
  w.write(
    '\nONE STEP LEFT, AND IT IS NOT OPTIONAL. In your branch-protection or ruleset\n' +
      'settings for the default branch, require the tamperward check AND enable\n' +
      '"Require review from Code Owners".\n\n' +
      'Until you do, the CI gate is advisory. A pull request runs the workflow from\n' +
      'its OWN head, and a required check is matched by job name — so a pull request\n' +
      'can keep the job called `tamperward`, replace the gate with `true`, and present\n' +
      'a green required check over a change the gate would have blocked. That is\n' +
      'reproduced, not theoretical. CODEOWNERS is what puts a human in front of it;\n' +
      'branch protection is what makes CODEOWNERS bind.\n',
  );
  return 0;
}
