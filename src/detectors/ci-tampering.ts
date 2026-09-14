// #7 ci-tampering (file surface, mechanical).
// On a protected workflow file: neutering a job (continue-on-error / if:false) or
// deleting a check step (test/lint/typecheck). "Deleting" means the command no longer
// exists in the after-file — a check MOVED (reindented, put behind an `if:`) is not a
// removal, and a check keyword only counts in invocation position (issue #15: both
// false positives this rule has produced were a move and an argument-position match).
//
// Three further spellings of "the check no longer decides", each caught here:
//   - the check line SURVIVES but its block is neutralised: `set +e`, an early
//     `exit 0`, `if false; then … fi`, a heredoc comment, or `shell: bash {0}` (no
//     -e) added around it;
//   - the WORKFLOW no longer runs where it matters: a `push`/`pull_request` trigger
//     removed, `paths-ignore: ['**']`, `branches:` no longer naming the default
//     branch, `paths:` that no source file can match, `pull_request.types` without
//     opened/synchronize;
//   - `continue-on-error` / `if:` written as an expression that folds to a constant
//     (`"true"`, `${{ 1 == 1 }}`, `${{ 'a' == 'b' }}`, `${{ !true }}`, and the
//     short-circuits `${{ <ctx> && false }}`, `${{ <ctx> || true }}`). Anything that
//     genuinely depends on a context reference stays "reachable" — the documented
//     class.
//
// And one class of edit that is NOT a removal, because Dependabot and ordinary
// maintenance produce it daily: a check line edited in place. `npm test` →
// `npm test -- --reporter=dot`, `npm run test`, `pnpm test`, quoting, an action
// bumped `@v3` → `@v4`, `npm test` → `npm run test:ci` / `npx vitest run` (respelled
// as another invocation of the same kind of check), a check moved into a reusable
// workflow the same change adds — the command core is a prefix / superset /
// equivalent spelling of the removed one, and it is kept. A superset that carries a
// neutraliser (`|| true`, `--passWithNoTests`, a narrowed `-t`, a spec path as a
// positional, a `timeout` wrapper) is reported as such.
//
// The pass-3d sweep (2.7.1) named the honest edits this rule still blocked, each
// now excused by the reading the runner itself applies: a `${{ }}` expression is
// folded to its constant or read as one opaque token (`--shard=${{ matrix.shard }}/4`
// is the matrix, not a narrowed suite); the mainstream runners and linters beyond
// jest/vitest/eslint are checks (`node --test`, `biome ci`, `oxlint`, `tsgo`, `mocha`,
// `deno test`); a path positional narrows a TEST, not a lint over `src/`; a
// `cd dir &&` prefix places the check, it does not narrow it; `shell: bash -euo
// pipefail {0}` keeps fail-fast; a reporter/upload action is not the check whose
// `continue-on-error` matters; and `[master]` → `[main]` when `main` is a branch the
// repository has is a rename, whatever a stale `origin/HEAD` still says.

import { Change, Detector, DetectorContext, Finding } from '../types';
import { addedLines, removedLines } from '../diff/select';
import { isProtected } from '../policy';
import { makeFinding } from './finding';
import { langOf } from './files';
import { stripHeredocs } from './hook-wiring';
import { branchExists, defaultBranch, trackedFiles } from './repo';
import { EXPR_TOKEN, MATRIX_TOKEN, foldConst, foldExpressions, truthy } from './gh-expression';
import { INVOKES_TOOL, invokesCheck as invokesCheckCore, survives } from './invocation';

// The expression folder and the check-invocation reading live in their own modules
// (gh-expression, invocation); their entry points stay reachable from here.
export { foldConst, foldExpressions };
export { SUITE_NARROWING_FLAGS } from './invocation';

const RULE = 'ci-tampering';
const USES = /^\s*-\s*uses:/;
const CHECK = /\b(test|tests|lint|typecheck|type-check|tsc|eslint|jest|vitest|playwright|coverage|tamperward)\b/i;
/** A line that is a YAML mapping key rather than a shell command in a `run:` body. */
const YAML_KEY = /^\s*-?\s*[A-Za-z_][\w-]*:\s*(?:$|\S)/;

/** GitHub runs a workflow only when it sits directly under .github/workflows
 *  with a .yml/.yaml extension. `ci.yml.disabled` is still inside the protected
 *  glob and still never runs — so glob membership is the wrong question here. */
function isActiveWorkflow(path: string): boolean {
  return /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
}

// `- run: pytest` carries the tool right after the `run:` key, which is not one of the
// shell separators INVOKES_TOOL knows — read the line's command core as well, so a
// bare tool invocation on a step line is a check like `npm test` is (issue #436).
const invokesCheck = (line: string): boolean => invokesCheckCore(line) || INVOKES_TOOL.test(commandCore(line));


/** Reduce a line to the command it carries: step-item dash, `run:` key, and spacing are
 *  presentation, not identity — `- run: npm test` and an indented `run: npm test` under a
 *  new `if:` are the SAME check in a different position. */
function commandCore(line: string): string {
  return line
    .trim()
    .replace(/^-\s*/, '')
    .replace(/^(?:run|uses):\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const uncommented = (v: string) => v.replace(/\s+#.*$/, '').trim();

/** The expression inside `${{ }}`, or the bare value (GitHub accepts `if:` without the
 *  braces); YAML quoting around the whole value is stripped first. */
function expressionOf(raw: string): string {
  const v = uncommented(raw).replace(/^(['"])(.*)\1$/, '$2').trim();
  const m = v.match(/^\$\{\{\s*(.+?)\s*\}\}$/);
  return m ? m[1] : v;
}

/** An `if:` value that can never be true — every spelling that folds to false.
 *  Matching only the bare literal let `if: ${{ false }}` disable a required step. */
export function isAlwaysFalse(raw: string): boolean {
  const e = expressionOf(raw);
  if (e === '') return false;
  const v = foldConst(e);
  return v !== undefined && !truthy(v);
}

/** A `continue-on-error:` value that is on, literal or interpolated. YAML's 1.1
 *  booleans (`yes`, `on`) are read as on too — whichever way the runner reads
 *  them, the author meant on. */
export function isTruthy(raw: string): boolean {
  const v = uncommented(raw).replace(/^(['"])(.*)\1$/, '$2').trim();
  if (/^(?:true|yes|on|1)$/i.test(v)) return true;
  const m = v.match(/^\$\{\{\s*(.+?)\s*\}\}$/);
  if (!m) return false;
  const f = foldConst(m[1]);
  return f !== undefined && truthy(f);
}

/** A `{0}` shell string that still fails fast: a short-option group carrying `e`
 *  (`-e`, `-eo pipefail`, `-euxo`) or `-o errexit`. */
const SHELL_ERREXIT = /(?:^|\s)-[a-zA-Z]*e[a-zA-Z]*(?:\s|$)|-o\s+errexit\b/;

const indentOf = (l: string) => l.length - l.trimStart().length;
const STEP_START = /^\s*-\s+(?:name|uses|run|if|id|with|env|shell|continue-on-error|working-directory|timeout-minutes):/;

/** The step (list item) a workflow line at index `i` belongs to: its line range, or
 *  null when the line sits above step level (a job- or workflow-level key). */
function stepOf(lines: string[], i: number): [number, number] | null {
  const ind = indentOf(lines[i]);
  let s = i - 1;
  while (s >= 0 && (lines[s].trim() === '' || indentOf(lines[s]) >= ind)) s--;
  if (s < 0 || !STEP_START.test(lines[s])) return null;
  const stepInd = indentOf(lines[s]);
  let e = i + 1;
  while (e < lines.length && (lines[e].trim() === '' || indentOf(lines[e]) > stepInd)) e++;
  return [s, e];
}

/** The job a job-level line at index `i` belongs to (its key sits directly under
 *  `jobs:`): the job's line range, or null when the line is not inside a job. */
function jobOf(lines: string[], i: number): [number, number] | null {
  const ind = indentOf(lines[i]);
  let h = i - 1;
  while (h >= 0 && (lines[h].trim() === '' || indentOf(lines[h]) >= ind)) h--;
  if (h < 0 || !/^\s+[\w-]+:\s*(?:#.*)?$/.test(lines[h])) return null;
  let t = h - 1;
  while (t >= 0 && (lines[t].trim() === '' || indentOf(lines[t]) > 0)) t--;
  if (t < 0 || !/^jobs:/.test(lines[t])) return null;
  const hi = indentOf(lines[h]);
  let e = i + 1;
  while (e < lines.length && (lines[e].trim() === '' || indentOf(lines[e]) > hi)) e++;
  return [h, e];
}

/** An action that REPORTS a check's result — a junit reporter, a results publisher,
 *  an artifact or coverage upload — is not the check. `continue-on-error: true` on
 *  `dorny/test-reporter` (its documented idiom, with `if: always()`) decides nothing
 *  about the tests; the word "test" in its name is not an invocation. */
const REPORTER_ACTION = /^\s*-?\s*uses:\s*\S*?(?:[\w-]*-reporter|[\w-]*-results?[\w-]*|upload-[\w-]*|codecov[\w-]*|coveralls[\w-]*)(?:@|\s|$)/i;
const usesCheck = (l: string): boolean => USES.test(l) && CHECK.test(l) && !REPORTER_ACTION.test(l);

const stepHasCheck = (lines: string[], range: [number, number] | null): boolean =>
  range === null || lines.slice(range[0], range[1]).some((l) => invokesCheck(l) || usesCheck(l));

/** A job carries a check when any step does, or when it calls a reusable workflow
 *  (whose steps this rule cannot see — read as a check, never as none). */
const jobHasCheck = (lines: string[], range: [number, number]): boolean =>
  lines.slice(range[0], range[1]).some((l) => invokesCheck(l) || usesCheck(l) || /^\s*uses:\s*\S/.test(l));

// ── run-block neutralisers ────────────────────────────────────────────────────
interface RunBlock {
  start: number; // index of the `run: |` line
  end: number; // exclusive
  body: string[];
}

function runBlocks(lines: string[]): RunBlock[] {
  const out: RunBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*-?\s*run:\s*[|>][-+]?\s*$/.test(lines[i])) continue;
    const ind = indentOf(lines[i].replace(/^(\s*)-\s+/, '$1  '));
    let e = i + 1;
    while (e < lines.length && (lines[e].trim() === '' || indentOf(lines[e]) > ind)) e++;
    out.push({ start: i, end: e, body: lines.slice(i + 1, e) });
  }
  return out;
}

/** The after-file as the shell reads it (issue #436): inside a `run: |` block a
 *  heredoc body is data, and a `run: >` folded scalar is ONE command whose
 *  continuation lines are its arguments. Both once counted as places where a removed
 *  check could "survive" (`cat <<EOF >/dev/null` / `npm test` / `EOF`; `echo` /
 *  `npm test`). Index-aligned with `lines`: a line that is not a command is blank. */
function commandLines(lines: string[]): string[] {
  const out = lines.slice();
  for (const b of runBlocks(lines)) {
    if (/^\s*-?\s*run:\s*>/.test(lines[b.start])) {
      out[b.start + 1] = b.body.map((l) => l.trim()).filter(Boolean).join(' ');
      for (let k = b.start + 2; k < b.end; k++) out[k] = '';
      continue;
    }
    const indents = b.body.filter((l) => l.trim() !== '').map(indentOf);
    const ind = indents.length ? Math.min(...indents) : 0;
    const dedented = b.body.map((l) => l.slice(Math.min(ind, indentOf(l))));
    const kept = stripHeredocs(dedented);
    let j = 0;
    for (let k = 0; k < dedented.length; k++) {
      if (j < kept.length && kept[j] === dedented[k]) j++;
      else out[b.start + 1 + k] = '';
    }
  }
  return out;
}

const NEUTRALISERS: Array<{ re: RegExp; what: string }> = [
  { re: /^\s*set\s+\+e\b/, what: 'set +e — a failing check no longer fails the step' },
  { re: /^\s*exit\s+0\s*(?:$|[;#])/, what: 'exit 0 — the step ends green whatever the check did' },
  { re: /^\s*if\s+false\s*;?\s*then\b/, what: 'if false; then — the check is never run' },
  { re: /^\s*:\s*<<\s*['"]?\w+/, what: 'a heredoc fed to `:` — the check is commented out' },
];

// ── `on:` narrowing ───────────────────────────────────────────────────────────
type ListKey = 'branches' | 'branchesIgnore' | 'pathsIgnore' | 'paths' | 'types' | 'tags';
interface Triggers {
  events: Set<string>;
  branches: Map<string, string[]>; // event → branches list (literal entries)
  branchesIgnore: Map<string, string[]>;
  pathsIgnore: Map<string, string[]>;
  paths: Map<string, string[]>;
  types: Map<string, string[]>;
  tags: Map<string, string[]>;
  present: boolean;
}

const LIST_KEYS: Record<string, ListKey> = {
  branches: 'branches',
  'branches-ignore': 'branchesIgnore',
  'paths-ignore': 'pathsIgnore',
  paths: 'paths',
  types: 'types',
  tags: 'tags',
};

function flowList(v: string): string[] | null {
  const m = v.trim().match(/^\[(.*)\]$/);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^(['"])(.*)\1$/, '$2'))
    .filter(Boolean);
}

/** A small reader for the `on:` section — the two flow forms and the block mapping. */
function parseTriggers(src: string): Triggers {
  const t: Triggers = {
    events: new Set(),
    branches: new Map(),
    branchesIgnore: new Map(),
    pathsIgnore: new Map(),
    paths: new Map(),
    types: new Map(),
    tags: new Map(),
    present: false,
  };
  const lines = src.split('\n');
  const i = lines.findIndex((l) => /^(?:on|"on"|'on'|true):/.test(l));
  if (i < 0) return t;
  t.present = true;
  const head = lines[i].replace(/^(?:on|"on"|'on'|true):\s*/, '');
  const inline = uncommented(head);
  if (inline) {
    const list = flowList(inline);
    for (const e of list ?? [inline]) t.events.add(e);
    return t;
  }
  let event: string | null = null;
  let listKey: ListKey | null = null;
  let listInd = -1;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    const ind = indentOf(l);
    if (ind === 0) break; // next top-level key
    const body = uncommented(l);
    const item = body.match(/^\s*-\s+(.+)$/);
    if (item && listKey && event && ind > listInd) {
      const target = t[listKey].get(event) ?? [];
      target.push(item[1].replace(/^(['"])(.*)\1$/, '$2'));
      t[listKey].set(event, target);
      continue;
    }
    const kv = body.match(/^\s*([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    if (ind === 2 || (event === null && ind < 4)) {
      event = kv[1];
      t.events.add(event);
      listKey = null;
      continue;
    }
    const key = LIST_KEYS[kv[1]];
    if (event && key) {
      listKey = key;
      listInd = ind;
      const list = flowList(kv[2]);
      t[listKey].set(event, list ?? []);
    } else listKey = null;
  }
  return t;
}

const DEFAULT_BRANCH = /^(?:main|master)$/;
const ALL = (g: string) => /^\*\*?$|^\*\*\/\*$/.test(g);
const CODE_EVENTS = ['push', 'pull_request', 'pull_request_target'];
const PR_CODE_TYPES = /^(?:opened|synchronize|reopened)$/;

/** GitHub's path-filter glob as a matcher: `**` crosses directories anywhere it
 *  stands (`**.md`), `*` and `?` stay inside a segment. */
function ghGlob(g: string): (p: string) => boolean {
  const re = g
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
    .join('.*');
  try {
    const r = new RegExp(`^${re}$`);
    return (p) => r.test(p);
  } catch {
    return () => false;
  }
}

/** Whether an ordered filter list admits `name`: patterns apply in order, a later
 *  `!` entry excluding what an earlier one included (and a later positive entry
 *  re-admitting it). GitHub reads `branches:`, `paths:` and `paths-ignore:` alike. */
function admits(globs: string[], name: string): boolean {
  let on = false;
  for (const g of globs) {
    const neg = g.startsWith('!');
    if (ghGlob(neg ? g.slice(1) : g)(name)) on = !neg;
  }
  return on;
}

/** Whether a `paths:` filter lets any source file through. */
const pathsMatchSource = (globs: string[], sources: string[]): boolean => sources.some((s) => admits(globs, s));
/** Whether a `paths-ignore:` filter swallows every source file (issue #436): the
 *  workflow then runs on docs and nothing else, exactly as `['**']` does. */
const ignoresEverySource = (globs: string[], sources: string[]): boolean => sources.length > 0 && sources.every((s) => admits(globs, s));

/** Source files a workflow's `paths:` filter must be able to match: the repository's
 *  own code files, or the conventional layouts when no listing is available. */
const CODE_PROBES = ['src/index.ts', 'src/index.js', 'lib/index.js', 'index.ts', 'main.go', 'src/main.py', 'src/lib.rs', 'packages/a/src/index.ts', 'test/a.test.ts'];
function sourceProbes(ctx?: DetectorContext): string[] {
  const files = trackedFiles(ctx);
  if (!files) return CODE_PROBES;
  const code = files.filter((f) => langOf(f) !== null);
  return code.length ? code : CODE_PROBES;
}

interface TriggerOpts {
  /** The repository's default branch, or null to accept main and master alike. */
  defaultBranch: string | null;
  sources: string[];
  /** Whether a branch of that name exists in the repository (locally or on origin);
   *  null when the repository cannot say. */
  hasBranch: (name: string) => boolean | null;
}

function triggerNarrowings(before: Triggers, after: Triggers, opts: TriggerOpts): string[] {
  const out: string[] = [];
  if (!before.present || !after.present) return out;
  const isDefault = (b: string) => (opts.defaultBranch ? b === opts.defaultBranch : DEFAULT_BRANCH.test(b));
  // The names the default branch may carry: the one the repository declares, or
  // main and master alike when it cannot say. A filter "names the default branch"
  // when, read in order with its `!` entries, it admits one of them.
  const candidates = opts.defaultBranch ? [opts.defaultBranch] : ['main', 'master'];
  const namesDefault = (l: string[]) => candidates.some((b) => admits(l, b));
  for (const e of CODE_EVENTS) {
    if (before.events.has(e) && !after.events.has(e)) out.push(`the ${e} trigger was removed — the workflow no longer runs on it`);
  }
  for (const [e, list] of after.pathsIgnore) {
    const had = before.pathsIgnore.get(e) ?? [];
    if (list.some((g) => ALL(g) && !had.includes(g))) {
      out.push(`on.${e}.paths-ignore now ignores every path — the workflow never runs on ${e}`);
      continue;
    }
    if (!CODE_EVENTS.includes(e) || !after.events.has(e)) continue;
    if (had.length && ignoresEverySource(had, opts.sources)) continue; // was already this narrow
    if (ignoresEverySource(list, opts.sources)) out.push(`on.${e}.paths-ignore now ignores every source file (now [${list.join(', ')}]) — the workflow never runs on code`);
  }
  for (const [e, list] of after.paths) {
    if (!CODE_EVENTS.includes(e) || !after.events.has(e)) continue;
    const had = before.paths.get(e);
    if (had && !pathsMatchSource(had, opts.sources)) continue; // was already this narrow
    if (!pathsMatchSource(list, opts.sources)) out.push(`on.${e}.paths matches no source file (now [${list.join(', ')}]) — the workflow never runs on code`);
  }
  for (const [e, list] of after.types) {
    if (!/^pull_request(?:_target)?$/.test(e) || !after.events.has(e)) continue;
    const had = before.types.get(e);
    if (had && !had.some((t) => PR_CODE_TYPES.test(t))) continue;
    if (!list.some((t) => PR_CODE_TYPES.test(t))) out.push(`on.${e}.types no longer includes opened/synchronize (now [${list.join(', ')}]) — the workflow does not run on the pull request's code`);
  }
  for (const [e, list] of after.branchesIgnore) {
    const had = before.branchesIgnore.get(e) ?? [];
    if (list.some((g) => (ALL(g) || isDefault(g)) && !had.includes(g))) out.push(`on.${e}.branches-ignore now covers the default branch`);
  }
  // An event with no `branches:` filter runs on EVERY branch — the implicit filter
  // is `['**']`, and adding `branches: [never-exists]` narrows it exactly as
  // `[main]` → `[never-exists]` does (issue #436). A `tags:`-only filter is the
  // other way to lose every branch: GitHub then runs the workflow on tag pushes alone.
  const events = new Set([...before.branches.keys(), ...CODE_EVENTS.filter((e) => before.events.has(e))]);
  for (const e of events) {
    const was = before.branches.get(e) ?? (before.tags.has(e) ? null : ['**']);
    if (!was || !after.events.has(e)) continue; // the event itself is reported above
    const now = after.branches.get(e);
    if (!now) {
      const tags = after.tags.get(e);
      if (tags && namesDefault(was)) out.push(`on.${e} now filters on tags only (tags: [${tags.join(', ')}]) — no push to the default branch runs the workflow`);
      continue; // filter dropped = wider
    }
    // `[main]` → `[master]` is a rename of the default branch, not a narrowing, when
    // master IS the default, when the repository cannot say which name it uses, or
    // when the name it now carries is a main/master branch the repository HAS:
    // `origin/HEAD` is set once at clone and stays `master` long after the branch
    // was renamed, so a stale remote head must not outvote a branch that exists. The
    // name must be carried as a literal entry the filter admits: `['**', '!main']`
    // carries no rename, it negates the default branch.
    const renamed = (b: string) => DEFAULT_BRANCH.test(b) && now.includes(b) && admits(now, b) && opts.hasBranch(b) !== false;
    const lost = candidates.filter((b) => admits(was, b) && !admits(now, b));
    const lostDefault = lost.length > 0 && !['main', 'master'].some(renamed);
    const replaced = !namesDefault(was) && !namesDefault(now) && was.length > 0 && !was.some((b) => now.includes(b));
    if (!lostDefault && !replaced) continue;
    const dropped = was.filter((b) => !now.includes(b) && !ALL(b));
    out.push(
      dropped.length
        ? `on.${e}.branches no longer names ${dropped.join(', ')} (now [${now.join(', ')}])`
        : `on.${e}.branches now filters to [${now.join(', ')}], which does not admit the default branch`,
    );
  }
  return out;
}

const REUSED_WORKFLOW = /^\s*uses:\s*\.\/(\.github\/workflows\/[^\s@]+)/;

// ── issue #436: a check pointed somewhere it runs nothing ───────────────────────
/** A manifest that makes a directory a package the check could run in. */
const MANIFEST = /(?:^|\/)(?:package\.json|pyproject\.toml|setup\.py|setup\.cfg|Cargo\.toml|go\.mod|Makefile|build\.gradle(?:\.kts)?|pom\.xml|Gemfile|deno\.jsonc?)$/;
/** A `working-directory:` or `ref:` value read the runner's way: quoting stripped,
 *  an expression folded to its constant, or null when it depends on a context
 *  (`${{ matrix.dir }}`, `${{ github.event.pull_request.head.sha }}`). */
function literalValue(raw: string): string | null {
  const v = foldExpressions(uncommented(raw).replace(/^(['"])(.*)\1$/, '$2').trim());
  return v.includes(EXPR_TOKEN) || v.includes(MATRIX_TOKEN) ? null : v;
}
/** Whether `dir` holds nothing a check could run over: no tracked code file and no
 *  package manifest beneath it. A repository that cannot list its files cannot vouch
 *  for the directory, and the check is then read as pointed at nothing (fail closed;
 *  the CLI always supplies the listing). */
function dirRunsNothing(dir: string, ctx?: DetectorContext): boolean {
  const files = trackedFiles(ctx);
  if (!files) return true;
  const d = dir.replace(/^\.\//, '').replace(/\/+$/, '');
  if (d === '' || d === '.') return false;
  return !files.some((f) => f.startsWith(d + '/') && (langOf(f) !== null || MANIFEST.test(f)));
}
const WORKDIR_LINE = /^\s*-?\s*working-directory:\s*(.+?)\s*$/;
const REF_LINE = /^\s*ref:\s*(.+?)\s*$/;
const CHECKOUT = /^\s*-?\s*uses:\s*actions\/checkout(?:@|\s|$)/;
/** The `defaults:` line a `defaults.run.working-directory` hangs from, or null. */
function defaultsOf(lines: string[], i: number): number | null {
  const run = ancestorOf(lines, i);
  if (run === null || !/^\s*run:\s*$/.test(lines[run])) return null;
  const d = ancestorOf(lines, run);
  return d !== null && /^\s*defaults:\s*$/.test(lines[d]) ? d : null;
}
/** The step a line at ANY depth below a step item belongs to (`ref:` sits under
 *  `with:` under the item); `stepOf` reads a direct child only. */
function enclosingStep(lines: string[], i: number): [number, number] | null {
  let h: number | null = i;
  while ((h = ancestorOf(lines, h)) !== null) {
    if (!STEP_START.test(lines[h])) continue;
    const ind = indentOf(lines[h]);
    let e = i + 1;
    while (e < lines.length && (lines[e].trim() === '' || indentOf(lines[e]) > ind)) e++;
    return [h, e];
  }
  return null;
}
function ancestorOf(lines: string[], i: number): number | null {
  const ind = indentOf(lines[i]);
  let h = i - 1;
  while (h >= 0 && (lines[h].trim() === '' || /^\s*#/.test(lines[h]) || indentOf(lines[h]) >= ind)) h--;
  return h >= 0 ? h : null;
}

export const ciTampering: Detector = {
  id: RULE,
  surface: ['file'],
  certainty: 'mechanical',
  run(changes: Change[], policy, _view, ctx): Finding[] {
    const out: Finding[] = [];
    // After-content of every file in the change, so a check moved into a reusable
    // workflow this change adds (`uses: ./.github/workflows/checks.yml`) is found there.
    const afterByPath = new Map<string, string>();
    for (const c of changes) if (c.kind === 'file' && c.after != null) afterByPath.set(c.path, c.after);
    let triggerOpts: TriggerOpts | null = null;
    for (const c of changes) {
      if (c.kind !== 'file') continue;
      // A workflow renamed so GitHub will no longer RUN it. The protected glob
      // (.github/workflows/**) still matches `ci.yml.disabled`, so a
      // glob-membership test sees nothing leave — but GitHub only executes
      // *.yml / *.yaml directly under .github/workflows, so the rename disables
      // every check while touching not one line, and for a pull_request event it
      // does so from the very merge ref that performs it. The predicate is
      // executability, not glob membership. (P0-8, external review.)
      if (c.op === 'rename' && c.oldPath && isActiveWorkflow(c.oldPath) && !isActiveWorkflow(c.path)) {
        out.push(
          makeFinding(RULE, policy, {
            file: c.path,
            message: `A CI workflow was renamed so it no longer runs (${c.oldPath} → ${c.path}).`,
            evidence: `${c.oldPath} → ${c.path}`,
            remediation:
              'Restore the path and extension. GitHub runs only *.yml/*.yaml directly under .github/workflows — renaming outside that disables the checks as surely as deleting them.',
          }),
        );
        continue;
      }
      if (!isProtected(c.path, policy, 'ci')) continue;

      const afterLines = c.after != null ? c.after.split('\n') : null;
      const addedAt = new Set(addedLines(c).map((l) => l.newLine).filter((n): n is number => n != null));

      for (const l of addedLines(c)) {
        const coe = l.content.match(/^\s*-?\s*continue-on-error:\s*(.+?)\s*$/);
        const cond = l.content.match(/^\s*-?\s*if:\s*(.+?)\s*$/);
        if (!coe && !cond) continue;
        // Scoped to the step it sits on: `continue-on-error: true` on an `npm audit`
        // step, or `if: false` on a deploy step, neuters no check. Job-level (no
        // enclosing step) applies to every step of the job — reported when the job
        // runs a check, and always when the line sits above job level.
        const step = afterLines && l.newLine != null ? stepOf(afterLines, l.newLine - 1) : null;
        if (afterLines && step && !stepHasCheck(afterLines, step)) continue;
        if (afterLines && !step && l.newLine != null) {
          const job = jobOf(afterLines, l.newLine - 1);
          if (job && !jobHasCheck(afterLines, job)) continue;
        }
        if (coe && isTruthy(coe[1])) {
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              line: l.newLine ?? undefined,
              message: 'continue-on-error: true added — failures will no longer fail the job.',
              evidence: l.content.trim(),
              remediation: 'Remove it. A check that cannot fail is not a check.',
            }),
          );
        } else if (cond && isAlwaysFalse(cond[1])) {
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              line: l.newLine ?? undefined,
              message: `if: ${uncommented(cond[1])} added — this step can never run.`,
              evidence: l.content.trim(),
              remediation: 'Re-enable the step instead of conditioning it off.',
            }),
          );
        }
      }

      if (afterLines) {
        // Neutralisers ADDED inside a run block that carries a check. A block that
        // propagates the status itself (`exit $code`) is excused: `set +e` there is
        // the capture-then-report idiom, not a mask.
        for (const b of runBlocks(afterLines)) {
          if (!b.body.some(invokesCheck)) continue;
          const propagates = b.body.some((l) => /\bexit\s+"?\$/.test(l));
          for (let k = 0; k < b.body.length; k++) {
            const idx = b.start + 1 + k; // 0-based line index
            if (!addedAt.has(idx + 1)) continue;
            const n = NEUTRALISERS.find((x) => x.re.test(b.body[k]));
            if (!n || (propagates && /set\s\+e/.test(b.body[k]))) continue;
            out.push(
              makeFinding(RULE, policy, {
                file: c.path,
                line: idx + 1,
                message: `A check's run block was neutralised: ${n.what}.`,
                evidence: b.body[k].trim(),
                remediation: 'Let the check decide the step. Masking its exit status is the same tamper as removing it.',
              }),
            );
          }
        }
        // `shell: bash {0}` (or any `{0}` shell — no `-e`) added on a step with a check:
        // the block's last command decides, and a trailing `true` decides green. A
        // shell that keeps errexit (`bash -euo pipefail {0}`, the hardened idiom
        // GitHub's own docs recommend) stops on the first failure exactly like the
        // default and is not reported.
        for (const l of addedLines(c)) {
          if (!/^\s*-?\s*shell:\s*.*\{0\}/.test(l.content) || l.newLine == null) continue;
          if (SHELL_ERREXIT.test(uncommented(l.content.replace(/^\s*-?\s*shell:\s*/, '')))) continue;
          const step = stepOf(afterLines, l.newLine - 1);
          if (step && !stepHasCheck(afterLines, step)) continue;
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              line: l.newLine,
              message: 'shell: … {0} added on a check step — the shell no longer stops on the first failure.',
              evidence: l.content.trim(),
              remediation: 'Keep the default shell (fail-fast) on steps that run checks.',
            }),
          );
        }
        // A check step pointed at a directory holding nothing it could run
        // (`working-directory: packages/empty`, on the step or as the job's / the
        // workflow's `defaults.run`), and `actions/checkout` pinned to a literal ref:
        // the suite then runs against that ref, never against the change (issue #436).
        for (const l of addedLines(c)) {
          if (l.newLine == null) continue;
          const i = l.newLine - 1;
          const wd = l.content.match(WORKDIR_LINE);
          if (wd) {
            const dir = literalValue(wd[1]);
            if (dir === null || !dirRunsNothing(dir, ctx)) continue;
            const step = stepOf(afterLines, i);
            if (step) {
              if (!stepHasCheck(afterLines, step)) continue;
            } else {
              const d = defaultsOf(afterLines, i);
              if (d === null) continue;
              const job = jobOf(afterLines, d);
              if (job ? !jobHasCheck(afterLines, job) : !afterLines.some((x) => invokesCheck(x) || usesCheck(x))) continue;
            }
            out.push(
              makeFinding(RULE, policy, {
                file: c.path,
                line: l.newLine,
                message: `A check was pointed at ${dir} by working-directory — a directory holding no code or package the check could run.`,
                evidence: l.content.trim(),
                remediation: 'Run the check where the code is. A suite pointed at an empty directory passes on nothing.',
              }),
            );
            continue;
          }
          const ref = l.content.match(REF_LINE);
          if (!ref) continue;
          const step = enclosingStep(afterLines, i);
          if (!step || !afterLines.slice(step[0], step[1]).some((x) => CHECKOUT.test(x))) continue;
          const target = literalValue(ref[1]);
          if (target === null) continue;
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              line: l.newLine,
              message: `actions/checkout was pinned to ref: ${target} — the checks run against that ref, not against the change under review.`,
              evidence: l.content.trim(),
              remediation: "Let checkout take the event's ref (its default). A suite that checks out main proves nothing about the pull request.",
            }),
          );
        }
        // `on:` narrowed so the workflow no longer runs where the check matters.
        if (c.before != null && c.after != null) {
          triggerOpts ??= { defaultBranch: defaultBranch(ctx), sources: sourceProbes(ctx), hasBranch: (b) => branchExists(b, ctx) };
          for (const reason of triggerNarrowings(parseTriggers(c.before), parseTriggers(c.after), triggerOpts)) {
            out.push(
              makeFinding(RULE, policy, {
                file: c.path,
                message: `The workflow's triggers were narrowed: ${reason}.`,
                evidence: reason,
                remediation: 'Keep the workflow running on push and pull_request for the default branch and its source paths; a check that never runs is no check.',
              }),
            );
          }
        }
      }

      // A REMOVAL is a command that no longer exists anywhere in the after-file — not a
      // command that moved. Comparing raw lines called `- run: npm test` re-added as an
      // indented `run: npm test` under a new `if:` a deletion, and blocked the very
      // workflow refactor that CONDITIONALISED checks without dropping one. So compare
      // command cores against the whole after-content. A check moved behind a literal
      // `if: false` (any spelling isAlwaysFalse knows) is still caught by the added-line
      // scan above; a move behind an obscure-but-reachable condition is accepted as
      // conditionalisation — the same exposure as authoring a new guarded step, which no
      // diff-based rule ever saw.
      // Read as the shell reads them: a heredoc body or a folded scalar's continuation
      // is not a command a check could survive in (issue #436).
      const afterCommands = afterLines ? commandLines(afterLines) : null;
      const afterCores = (afterCommands ?? addedLines(c).map((l) => l.content)).map(commandCore);
      const addedCores = addedLines(c).map((l) => commandCore(afterCommands && l.newLine != null ? afterCommands[l.newLine - 1] : l.content));
      // A check moved into a reusable workflow the same change carries is kept there.
      for (const l of afterLines ?? []) {
        const reused = l.match(REUSED_WORKFLOW)?.[1];
        const content = reused ? afterByPath.get(reused) : undefined;
        if (content == null || reused === c.path) continue;
        const cores = commandLines(content.split('\n')).map(commandCore);
        afterCores.push(...cores);
        addedCores.push(...cores);
      }
      for (const l of removedLines(c)) {
        // A YAML comment is prose, not a step. Rewording a comment that quoted
        // `tamperward:allow:<rule>` in a code span read as "a check command was
        // removed", because the backtick before the word satisfied the
        // invocation-position test — the repo's own gate blocked a comment edit.
        if (/^\s*#/.test(l.content)) continue;
        const isUsesLine = usesCheck(l.content);
        const isCheckCommand = !isUsesLine && !/^\s*-?\s*uses:/.test(l.content) &&
          (YAML_KEY.test(l.content) ? /^\s*-?\s*run:/.test(l.content) : true) && invokesCheck(l.content);
        if (!isUsesLine && !isCheckCommand) continue;
        const s = survives(commandCore(l.content), isUsesLine, afterCores, addedCores);
        if (s.state === 'kept') continue; // moved, reformatted, respelled or extended — not removed
        if (s.state === 'neutralised') {
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              message: 'A CI check command was neutralised in place: it still runs, but its result no longer decides (or its suite was narrowed).',
              evidence: `${l.content.trim()} → ${s.by}`,
              remediation: 'Let the check decide the step; do not mask its status, cut it short, or narrow what it runs.',
            }),
          );
          continue;
        }
        out.push(
          makeFinding(RULE, policy, {
            file: c.path,
            message: isUsesLine
              ? 'A CI check step (test/lint/typecheck) was removed.'
              : 'A CI check command was removed from a run block.',
            evidence: l.content.trim(),
            remediation: 'Restore the step. Removing the check that protects main is itself the tamper.',
          }),
        );
      }
    }
    return out;
  },
};
