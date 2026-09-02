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
import { branchExists, defaultBranch, trackedFiles } from './repo';

const RULE = 'ci-tampering';
const USES = /^\s*-\s*uses:/;
const CHECK = /\b(test|tests|lint|typecheck|type-check|tsc|eslint|jest|vitest|playwright|coverage|tamperward)\b/i;
/** A line that is a YAML mapping key rather than a shell command in a `run:` body. */
const YAML_KEY = /^\s*-?\s*[A-Za-z_][\w-]*:\s*(?:$|\S)/;

// A check keyword only counts in INVOCATION POSITION. Matching it anywhere on the line
// flagged `TAGS="$(npm view tamperward dist-tags ...)"` as a removed check — the word
// "tamperward" was a PACKAGE NAME in argument position, and the line queries the
// registry, it checks nothing. Two invocation shapes:
//   a tool run directly (start of command, or after ; | && $( ` npx/yarn/pnpm) ...
const INVOKES_TOOL =
  /(?:^\s*|[;&|`]\s*|\$\(\s*|\b(?:npx|yarn|pnpm|bunx?)\s+)(?:jest|vitest|eslint|tsc|playwright|pytest|tamperward|mocha|ava|oxlint|tsgo|mypy|golangci-lint|node\s+--test|biome\s+(?:ci|check|lint)|deno\s+(?:test|lint|check)|ruff\s+check)\b/;
//   ... or a check script through a package runner / build tool.
const INVOKES_SCRIPT =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|lint|typecheck|type-check|coverage)\b|\b(?:make|cargo|go)\s+test\b|\bgradle\w*\s+(?:test|check)\b/;

/** GitHub runs a workflow only when it sits directly under .github/workflows
 *  with a .yml/.yaml extension. `ci.yml.disabled` is still inside the protected
 *  glob and still never runs — so glob membership is the wrong question here. */
function isActiveWorkflow(path: string): boolean {
  return /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
}

const invokesCheck = (line: string): boolean => INVOKES_TOOL.test(line) || INVOKES_SCRIPT.test(line);

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

/** A `${{ }}` expression inside a command, read as the runner reads it: folded to
 *  its constant when it has one (`${{ 'unit' }}` is the literal `unit`), otherwise a
 *  single opaque token — one that says whether the value comes from the matrix, the
 *  strategy or a workflow input (the job runs once per value; the whole set is run)
 *  or from anywhere else. Tokenising the raw text read `}}/4` of
 *  `--shard=${{ matrix.shard }}/4` as a path-shaped positional and
 *  `--project=${{ matrix.project }}` as a project narrowed by hand. */
export function foldExpressions(s: string): string {
  return s.replace(/\$\{\{([^}]*)\}\}/g, (_m, e: string) => {
    const v = foldConst(e.trim());
    if (v !== undefined && v !== TRUTHY) return String(v);
    return /\b(?:matrix|strategy|inputs)\./.test(e) ? MATRIX_TOKEN : EXPR_TOKEN;
  });
}
const EXPR_TOKEN = '__expr__';
const MATRIX_TOKEN = '__matrix__';
/** A flag whose value is the matrix (`--project=${{ matrix.project }}`, `--shard
 *  ${{ matrix.shard }}/${{ strategy.job-total }}`) selects the slice THIS job runs
 *  of a suite the whole matrix covers — dropped before the narrowing flags are
 *  read. A flag valued by any other expression (`-t ${{ github.sha }}`) keeps its
 *  flag: a pattern nothing matches empties the suite. */
const MATRIX_FLAG = new RegExp(`(?:^|\\s)-{1,2}[\\w-]+(?:=|\\s+)${MATRIX_TOKEN}(?:/\\S*)?(?=\\s|$)`, 'g');

/** The command with its package-runner spelling normalised, so `npm test`, `npm run
 *  test`, `npm t`, `pnpm test`, `yarn test` and a quoted `'npm test'` are one check,
 *  and `npx jest`, `pnpm exec jest`, `yarn jest`, `bunx jest` another. */
function canonical(core: string): string {
  let s = foldExpressions(core.replace(/^(['"])(.*)\1$/, '$2').trim()).replace(MATRIX_FLAG, ' ').replace(/\s+/g, ' ').trim();
  // `cd apps/web && npm test` runs the same check from another directory: the prefix
  // places it, and its path is not a positional of the check
  s = s.replace(/^(?:cd|pushd)\s+\S+\s*&&\s*/, '');
  s = s.replace(/^(?:npx|pnpm\s+(?:exec|dlx)|yarn\s+(?:exec|dlx)|bunx|bun\s+x)\s+/, 'exec ');
  s = s.replace(/^(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?/, 'exec ');
  s = s.replace(/^exec\s+(?:t|tst)(?=\s|$)/, 'exec test');
  s = s.replace(/^exec\s+/, '');
  return s.replace(/\s+--\s*$/, '').trim();
}

/** `uses:` identity stops at the version: `actions/setup-node@v3` → `@v4` is a bump. */
const usesRef = (core: string) => core.replace(/@.*$/, '');

/** Runner flags that select FEWER specs. Shared with test-deletion, which reads the
 *  same flags added to a package.json test script. */
export const SUITE_NARROWING_FLAGS =
  /--testPathIgnorePatterns\b|--testPathPattern\b|--testNamePattern\b|(?:^|\s)-t\s|--onlyChanged\b|--changed\b|--findRelatedTests\b|--exclude\b|--dir\b|--project\b/;

// Suffixes that turn a kept check into a non-check: shell status masking, coverage
// switched off, and runner flags that empty or narrow the suite it runs.
const NEUTRALISING_SUFFIX = new RegExp(
  `\\|\\||;|(?<!&)&(?!&)|\\|(?!\\|)|--passWithNoTests\\b|--coverage=false\\b|--coverageThreshold\\b|${SUITE_NARROWING_FLAGS.source}`,
);

/** `timeout 1 npm test`: the check is killed before it can decide. */
const TIMEOUT_WRAP = /^timeout\s+(?:-{1,2}\S+\s+)*\d\S*\s+(.+)$/;

/** A positional that names a spec or a path (`test/a.test.ts`, `src/`, `test/a`)
 *  narrows the suite exactly like `--testPathPattern` — the runner opens only what
 *  it names. A flag's value (`--config jest.ci.js`) and a redirect target are not
 *  positionals. */
const PATH_SHAPED = /\/|\.(?:test|spec)\./;
function narrowedByPositional(args: string): boolean {
  const toks = args.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '--' || t.startsWith('-')) continue;
    const prev = toks[i - 1];
    if (prev && ((prev.startsWith('-') && prev !== '--' && !prev.includes('=')) || /[<>]/.test(prev))) continue;
    if (/[<>|;&]/.test(t)) continue;
    if (PATH_SHAPED.test(t)) return true;
  }
  return false;
}

type Kind = 'test' | 'lint' | 'types' | 'gate';
/** What a check invocation checks — a replacement of the same kind is a respelling,
 *  of another kind a removal (`npm test` → `npm run lint` drops the tests). */
function checkKind(core: string): Kind | null {
  if (!invokesCheck(core)) return null;
  const s = canonical(core);
  if (/\btamperward\b/.test(s)) return 'gate';
  if (/\b(?:lint|eslint|biome|oxlint|golangci-lint|ruff)\b/i.test(s)) return 'lint';
  if (/\b(?:typecheck|type-check|tsc|tsgo|mypy)\b|\bdeno\s+check\b/i.test(s)) return 'types';
  return 'test';
}

type Kept = 'kept' | 'neutralised' | 'gone';

/** Whether a removed check survives among the after-file's command cores. `addedCores`
 *  are the cores of lines ADDED by this change — the only place a respelling of the
 *  removed check can be. */
function survives(removedCore: string, isUses: boolean, afterCores: string[], addedCores: string[]): { state: Kept; by?: string } {
  if (isUses) {
    const ref = usesRef(removedCore);
    return afterCores.some((a) => usesRef(a) === ref) ? { state: 'kept' } : { state: 'gone' };
  }
  const r = canonical(removedCore);
  const kind = checkKind(removedCore);
  // A path positional narrows a TEST suite (the runner opens only what it names); a
  // lint or a typecheck given `src/` or a glob is told what to read, not what to skip.
  const narrowed = (args: string) => kind === 'test' && narrowedByPositional(args);
  let neutralised: string | undefined;
  for (const raw of afterCores) {
    const a = canonical(raw);
    if (a === r) return { state: 'kept' };
    if (a.startsWith(r + ' ')) {
      const rest = a.slice(r.length);
      if (NEUTRALISING_SUFFIX.test(rest) || narrowed(rest)) neutralised ??= raw;
      else return { state: 'kept' };
    } else if (r.startsWith(a + ' ') && invokesCheck(a)) {
      return { state: 'kept' }; // the check got shorter — arguments dropped, the invocation kept
    } else {
      const w = a.match(TIMEOUT_WRAP);
      if (w && (canonical(w[1]) === r || canonical(w[1]).startsWith(r + ' '))) neutralised ??= raw;
    }
  }
  let respelled = false;
  for (const raw of addedCores) {
    if (!kind || checkKind(raw) !== kind) continue;
    const a = canonical(raw);
    if (a.match(TIMEOUT_WRAP)) {
      neutralised ??= raw;
      continue;
    }
    const args = a.slice(a.indexOf(' ') + 1 || a.length);
    if (a.includes(' ') && (NEUTRALISING_SUFFIX.test(' ' + args) || narrowed(args))) neutralised ??= raw;
    else respelled = true;
  }
  if (respelled) return { state: 'kept' };
  return neutralised ? { state: 'neutralised', by: neutralised } : { state: 'gone' };
}

const uncommented = (v: string) => v.replace(/\s+#.*$/, '').trim();

// ── a constant folder for the expression subset that has no context reference ──
//
// GitHub evaluates `if:` and `continue-on-error:` as expressions. Literals, `==`,
// `!=`, `&&`, `||`, `!` and parentheses fold to a value here; an identifier, a
// context reference or a function call is UNKNOWN — but `&&` and `||` short-circuit
// on the KNOWN side exactly as they do at runtime: `unknown && false` is always
// falsy and `unknown || true` always truthy, whatever the context holds. An unknown
// that survives reads as reachable — the same exposure as authoring a new guarded
// step.
const TRUTHY = Symbol('truthy'); // a value not known, except that it is truthy
type Val = string | number | boolean | null | typeof TRUTHY;
type Tok = { t: 'str' | 'num' | 'id' | 'op'; v: string };

function lex(src: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") {
          s += "'";
          j += 2;
        } else if (src[j] === "'") break;
        else s += src[j++];
      }
      if (j >= src.length) return null;
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    const num = src.slice(i).match(/^-?\d+(?:\.\d+)?/);
    if (num) {
      out.push({ t: 'num', v: num[0] });
      i += num[0].length;
      continue;
    }
    const op = src.slice(i).match(/^(?:==|!=|&&|\|\||<=|>=|[!()<>,[\]])/);
    if (op) {
      out.push({ t: 'op', v: op[0] });
      i += op[0].length;
      continue;
    }
    const id = src.slice(i).match(/^[A-Za-z_][\w.\-*]*/);
    if (id) {
      out.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    return null;
  }
  return out;
}

const truthy = (v: Val): boolean => (v === TRUTHY ? true : typeof v === 'string' ? v !== '' : typeof v === 'number' ? v !== 0 : v === true);

/** Fold an expression to a constant; undefined when it depends on anything. */
export function foldConst(src: string): Val | undefined {
  const toks = lex(src);
  if (!toks) return undefined;
  let p = 0;
  const peek = () => toks[p];
  const eat = (v: string) => (toks[p]?.t === 'op' && toks[p].v === v ? (p++, true) : false);
  const num = (v: Val): number =>
    v === TRUTHY ? NaN : typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : v === null ? 0 : v.trim() === '' ? 0 : Number(v);
  const eq = (a: Val, b: Val): boolean | undefined => {
    if (a === TRUTHY || b === TRUTHY) return undefined;
    if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
    if (a === null && b === null) return true;
    const x = num(a);
    const y = num(b);
    return !Number.isNaN(x) && x === y;
  };
  const or = (): Val | undefined => {
    let l = and();
    while (eat('||')) {
      const r = and();
      if (l !== undefined && truthy(l)) continue; // a truthy left decides
      if (l !== undefined) l = r; // a falsy left yields the right
      else l = r !== undefined && truthy(r) ? TRUTHY : undefined; // unknown || truthy is truthy
    }
    return l;
  };
  const and = (): Val | undefined => {
    let l = cmp();
    while (eat('&&')) {
      const r = cmp();
      if (l !== undefined && !truthy(l)) continue; // a falsy left decides
      if (l !== undefined) l = r; // a truthy left yields the right
      else l = r !== undefined && !truthy(r) ? false : undefined; // unknown && falsy is falsy
    }
    return l;
  };
  const cmp = (): Val | undefined => {
    let l = unary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'op' || !/^(?:==|!=|<|>|<=|>=)$/.test(t.v)) return l;
      p++;
      const r = unary();
      if (l === undefined || r === undefined) {
        l = undefined;
        continue;
      }
      if (t.v === '==' || t.v === '!=') {
        const e = eq(l, r);
        l = e === undefined ? undefined : t.v === '==' ? e : !e;
      } else {
        const x = num(l);
        const y = num(r);
        if (Number.isNaN(x) || Number.isNaN(y)) l = undefined;
        else l = t.v === '<' ? x < y : t.v === '>' ? x > y : t.v === '<=' ? x <= y : x >= y;
      }
    }
  };
  const unary = (): Val | undefined => {
    if (eat('!')) {
      const v = unary();
      return v === undefined ? undefined : !truthy(v);
    }
    return primary();
  };
  const primary = (): Val | undefined => {
    const t = peek();
    if (!t) return undefined;
    if (eat('(')) {
      const v = or();
      return eat(')') ? v : undefined;
    }
    p++;
    if (t.t === 'str') return t.v;
    if (t.t === 'num') return Number(t.v);
    if (t.t === 'id') {
      if (/^true$/i.test(t.v)) return true;
      if (/^false$/i.test(t.v)) return false;
      if (/^null$/i.test(t.v)) return null;
      // a function call or an index: consume its arguments so the operators
      // AROUND it still fold, and yield unknown — not ours to decide
      if (eat('(')) {
        if (!eat(')')) {
          for (;;) {
            or();
            if (eat(')')) break;
            if (!eat(',')) return undefined;
          }
        }
      }
      while (eat('[')) {
        or();
        if (!eat(']')) return undefined;
      }
      return undefined;
    }
    return undefined;
  };
  const v = or();
  return p === toks.length ? v : undefined;
}

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

const indentOf = (l: string) => l.match(/^\s*/)![0].length;
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

const NEUTRALISERS: Array<{ re: RegExp; what: string }> = [
  { re: /^\s*set\s+\+e\b/, what: 'set +e — a failing check no longer fails the step' },
  { re: /^\s*exit\s+0\s*(?:$|[;#])/, what: 'exit 0 — the step ends green whatever the check did' },
  { re: /^\s*if\s+false\s*;?\s*then\b/, what: 'if false; then — the check is never run' },
  { re: /^\s*:\s*<<\s*['"]?\w+/, what: 'a heredoc fed to `:` — the check is commented out' },
];

// ── `on:` narrowing ───────────────────────────────────────────────────────────
type ListKey = 'branches' | 'branchesIgnore' | 'pathsIgnore' | 'paths' | 'types';
interface Triggers {
  events: Set<string>;
  branches: Map<string, string[]>; // event → branches list (literal entries)
  branchesIgnore: Map<string, string[]>;
  pathsIgnore: Map<string, string[]>;
  paths: Map<string, string[]>;
  types: Map<string, string[]>;
  present: boolean;
}

const LIST_KEYS: Record<string, ListKey> = {
  branches: 'branches',
  'branches-ignore': 'branchesIgnore',
  'paths-ignore': 'pathsIgnore',
  paths: 'paths',
  types: 'types',
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

/** Whether a `paths:` filter lets any source file through: patterns apply in order,
 *  a later `!` entry excluding what an earlier one included. */
function pathsMatchSource(globs: string[], sources: string[]): boolean {
  const ms = globs.map((g) => ({ neg: g.startsWith('!'), m: ghGlob(g.startsWith('!') ? g.slice(1) : g) }));
  return sources.some((s) => {
    let on = false;
    for (const { neg, m } of ms) if (m(s)) on = !neg;
    return on;
  });
}

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
  const namesDefault = (l: string[]) => l.some(isDefault);
  for (const e of CODE_EVENTS) {
    if (before.events.has(e) && !after.events.has(e)) out.push(`the ${e} trigger was removed — the workflow no longer runs on it`);
  }
  for (const [e, list] of after.pathsIgnore) {
    const had = before.pathsIgnore.get(e) ?? [];
    if (list.some((g) => ALL(g) && !had.includes(g))) out.push(`on.${e}.paths-ignore now ignores every path — the workflow never runs on ${e}`);
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
  for (const [e, was] of before.branches) {
    const now = after.branches.get(e);
    if (!now || !after.events.has(e)) continue; // filter dropped = wider, or the event itself is reported above
    if (now.some(ALL)) continue;
    // `[main]` → `[master]` is a rename of the default branch, not a narrowing, when
    // master IS the default, when the repository cannot say which name it uses, or
    // when the name it now carries is a main/master branch the repository HAS:
    // `origin/HEAD` is set once at clone and stays `master` long after the branch
    // was renamed, so a stale remote head must not outvote a branch that exists.
    const renamed = (b: string) => DEFAULT_BRANCH.test(b) && opts.hasBranch(b) !== false;
    const lostDefault = namesDefault(was) && !namesDefault(now) && !now.some(renamed);
    const replaced = !namesDefault(was) && !namesDefault(now) && was.length > 0 && !was.some((b) => now.includes(b));
    if (lostDefault || replaced) out.push(`on.${e}.branches no longer names ${was.filter((b) => !now.includes(b)).join(', ')} (now [${now.join(', ')}])`);
  }
  return out;
}

const REUSED_WORKFLOW = /^\s*uses:\s*\.\/(\.github\/workflows\/[^\s@]+)/;

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
        // `on:` narrowed so the workflow no longer runs where the check matters.
        if (c.before != null) {
          triggerOpts ??= { defaultBranch: defaultBranch(ctx), sources: sourceProbes(ctx), hasBranch: (b) => branchExists(b, ctx) };
          for (const reason of triggerNarrowings(parseTriggers(c.before), parseTriggers(c.after!), triggerOpts)) {
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
      const afterCores = (afterLines ?? addedLines(c).map((l) => l.content)).map(commandCore);
      const addedCores = addedLines(c).map((l) => commandCore(l.content));
      // A check moved into a reusable workflow the same change carries is kept there.
      for (const l of afterLines ?? []) {
        const reused = l.match(REUSED_WORKFLOW)?.[1];
        const content = reused ? afterByPath.get(reused) : undefined;
        if (content == null || reused === c.path) continue;
        const cores = content.split('\n').map(commandCore);
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
