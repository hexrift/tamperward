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

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLICY_FILE } from '../policy';

export interface InitOpts {
  cwd?: string;
  dryRun?: boolean;
}

interface Action {
  item: string;
  path: string;
  status: 'create' | 'update' | 'ok' | 'skip' | 'error';
  detail: string;
  apply?: () => void;
}

const HOOK_CMD = 'npx --yes tamperward hook claude';
const SWEEP_CMD = 'npx --yes tamperward sweep claude';
const PRECOMMIT_CMD = 'npx --yes tamperward check --staged';
const MARKER = '# tamperward: block agent shortcuts before they land';

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

// The gate resolves ITSELF from the registry at gate time, so it is pinned to
// the version that wrote the workflow: an unpinned \`npx --yes tamperward\` is a
// floating dependency in the one component whose job is integrity.
// (P2-15, external review.)
function shippedVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of ['../package.json', '../../package.json', '../../../package.json']) {
      try {
        const pkg = JSON.parse(readFileSync(join(here, rel), 'utf8')) as { name?: string; version?: string };
        if (pkg.name === 'tamperward' && pkg.version) return pkg.version;
      } catch {
        /* keep looking */
      }
    }
  } catch {
    /* fall through */
  }
  return 'latest'; // unknown: prefer a working gate over a broken pin
}
const TW_VERSION = shippedVersion();

const WORKFLOW_CONTENT = `name: tamperward

# The CI authority for main: the same engine as the agent hook and pre-commit, run over
# the PR's commit range. A block fails the check and clears ONLY via the out-of-band
# label \`tamperward:allow:<rule>\` applied by someone with write access — never a file
# the PR itself can commit.
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
        run: npx --yes tamperward@${TW_VERSION} verify --require-ancestor --base "\${{ github.event.pull_request.base.sha }}"
`;

interface HookEntry { type?: string; command?: string }
interface HookMatcher { matcher?: string; hooks?: HookEntry[] }
interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[] | undefined>;
  [key: string]: unknown;
}

function planPolicy(cwd: string): Action {
  const path = join(cwd, POLICY_FILE);
  if (existsSync(path)) return { item: 'policy', path: POLICY_FILE, status: 'ok', detail: 'already present — left untouched' };
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

  const hooks = (settings.hooks ??= {});
  const has = (arr: HookMatcher[] | undefined, needle: string) =>
    (arr ?? []).some((m) => (m.hooks ?? []).some((h) => String(h.command ?? '').includes(needle)));

  const needPre = !has(hooks.PreToolUse, 'tamperward hook claude');
  const needStop = !has(hooks.Stop, 'tamperward sweep claude');
  if (!needPre && !needStop) return { item: 'agent', path: rel, status: 'ok', detail: 'PreToolUse + Stop hooks already wired' };

  return {
    item: 'agent', path: rel, status: existsSync(path) ? 'update' : 'create',
    detail: `wire ${[needPre && 'PreToolUse deny', needStop && 'Stop sweep'].filter(Boolean).join(' + ')}`,
    apply: () => {
      if (needPre) {
        (hooks.PreToolUse ??= []).push({
          // NotebookEdit is modelled by the adapter but was absent here, so
          // that branch was unreachable in the wiring we install. (P2-12.)
          matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit',
          hooks: [{ type: 'command', command: HOOK_CMD }],
        });
      }
      if (needStop) {
        (hooks.Stop ??= []).push({ hooks: [{ type: 'command', command: SWEEP_CMD }] });
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
    },
  };
}

/** Husky when present; the plain git hook otherwise. Appending to an existing script is
 *  safe for shell (a new line at the end) and marked, so re-runs find it. */
function planPreCommit(cwd: string): Action {
  const line = `${MARKER}\n${PRECOMMIT_CMD}\n`;
  const husky = join(cwd, '.husky');
  const gitDir = join(cwd, '.git');
  const target = existsSync(husky)
    ? { rel: '.husky/pre-commit', note: 'husky' }
    : existsSync(gitDir)
      ? { rel: '.git/hooks/pre-commit', note: 'plain git hook (local-only: .git/hooks is not committed — consider husky to share it)' }
      : null;
  if (!target) return { item: 'pre-commit', path: '(none)', status: 'skip', detail: 'not a git repo and no .husky/ — nothing to wire' };

  const path = join(cwd, target.rel);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (existing?.includes('tamperward check --staged')) {
    return { item: 'pre-commit', path: target.rel, status: 'ok', detail: 'already runs the staged check' };
  }
  return {
    item: 'pre-commit', path: target.rel, status: existing === null ? 'create' : 'update',
    detail: existing === null ? `create via ${target.note}` : `append the staged check (${target.note})`,
    apply: () => {
      mkdirSync(dirname(path), { recursive: true });
      const content = existing === null ? `#!/bin/sh\n${line}` : existing.replace(/\n?$/, '\n') + line;
      writeFileSync(path, content);
      chmodSync(path, 0o755);
    },
  };
}

function planWorkflow(cwd: string): Action {
  const rel = '.github/workflows/tamperward.yml';
  const path = join(cwd, rel);
  if (existsSync(path)) return { item: 'ci', path: rel, status: 'ok', detail: 'workflow already present — left untouched' };
  return {
    item: 'ci', path: rel, status: 'create',
    detail: 'PR gate with out-of-band label sign-off (re-runs on labeled/unlabeled)',
    apply: () => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, WORKFLOW_CONTENT);
    },
  };
}

export function planInit(cwd: string): Action[] {
  return [planPolicy(cwd), planClaudeHooks(cwd), planPreCommit(cwd), planWorkflow(cwd)];
}

export function runInit(opts: InitOpts): number {
  const cwd = opts.cwd ?? process.cwd();
  const plan = planInit(cwd);
  const w = process.stdout;

  for (const a of plan) {
    const verb = opts.dryRun && (a.status === 'create' || a.status === 'update') ? `would ${a.status}` : a.status;
    w.write(`  ${a.item.padEnd(10)} ${verb.padEnd(12)} ${a.path}  — ${a.detail}\n`);
    if (!opts.dryRun && a.apply) a.apply();
  }

  const errors = plan.filter((a) => a.status === 'error');
  const changed = plan.filter((a) => a.apply).length;
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
  return 0;
}
