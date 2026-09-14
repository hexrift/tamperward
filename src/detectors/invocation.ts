// The reading of a check INVOCATION — `npm test`, `npx jest --coverage`, `pytest -k
// easy`, `nyc --check-coverage mocha` — shared by the rules that compare one before
// and after: ci-tampering over a workflow line, test-deletion over a package.json
// script (#435). One vocabulary, so a bypass the workflow rule already names
// (`|| true`, a spec path as a positional, `timeout 1`, a narrowing flag) is read
// the same way wherever the invocation lives.
//
// Two entry points. `survives()` is ci-tampering's: a removed line against every
// command core of the after-file, since a workflow check MOVES. `invocationWeakening()`
// is the one-to-one form: this script was `before`, it is now `after` — kept,
// neutralised (named), or removed (a non-check, or a check of another kind).

import { MATRIX_TOKEN, foldExpressions } from './gh-expression';
import { segments } from './command';

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

export const invokesCheck = (line: string): boolean => INVOKES_TOOL.test(line) || INVOKES_SCRIPT.test(line);

/** A flag whose value is the matrix (`--project=${{ matrix.project }}`, `--shard
 *  ${{ matrix.shard }}/${{ strategy.job-total }}`) selects the slice THIS job runs
 *  of a suite the whole matrix covers — dropped before the narrowing flags are
 *  read. A flag valued by any other expression (`-t ${{ github.sha }}`) keeps its
 *  flag: a pattern nothing matches empties the suite. */
const MATRIX_FLAG = new RegExp(`(?:^|\\s)-{1,2}[\\w-]+(?:=|\\s+)${MATRIX_TOKEN}(?:/\\S*)?(?=\\s|$)`, 'g');

/** The command with its package-runner spelling normalised, so `npm test`, `npm run
 *  test`, `npm t`, `pnpm test`, `yarn test` and a quoted `'npm test'` are one check,
 *  and `npx jest`, `pnpm exec jest`, `yarn jest`, `bunx jest` another. */
export function canonical(core: string): string {
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
export const usesRef = (core: string) => core.replace(/@.*$/, '');

/** Runner flags that select FEWER specs. Shared with test-deletion, which reads the
 *  same flags added to a package.json test script. */
export const SUITE_NARROWING_FLAGS =
  /--testPathIgnorePatterns\b|--testPathPattern\b|--testNamePattern\b|(?:^|\s)-t\s|--onlyChanged\b|--changed\b|--findRelatedTests\b|--exclude\b|--dir\b|--project\b/;

// Suffixes that turn a kept check into a non-check: shell status masking, coverage
// switched off, and runner flags that empty or narrow the suite it runs.
export const NEUTRALISING_SUFFIX = new RegExp(
  `\\|\\||;|(?<!&)&(?!&)|\\|(?!\\|)|--passWithNoTests\\b|--coverage=false\\b|--coverageThreshold\\b|${SUITE_NARROWING_FLAGS.source}`,
);

/** `timeout 1 npm test`: the check is killed before it can decide. */
export const TIMEOUT_WRAP = /^timeout\s+(?:-{1,2}\S+\s+)*\d\S*\s+(.+)$/;

/** A positional that names a spec or a path (`test/a.test.ts`, `src/`, `test/a`)
 *  narrows the suite exactly like `--testPathPattern` — the runner opens only what
 *  it names. A flag's value (`--config jest.ci.js`) and a redirect target are not
 *  positionals. */
const PATH_SHAPED = /\/|\.(?:test|spec)\./;
export function narrowedByPositional(args: string): boolean {
  return positionalOf(args) !== null;
}
/** The first path-shaped positional of `args`, or null. */
export function positionalOf(args: string): string | null {
  const toks = args.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '--' || t.startsWith('-')) continue;
    const prev = toks[i - 1];
    if (prev && ((prev.startsWith('-') && prev !== '--' && !prev.includes('=')) || /[<>]/.test(prev))) continue;
    if (/[<>|;&]/.test(t)) continue;
    if (PATH_SHAPED.test(t)) return t;
  }
  return null;
}

export type Kind = 'test' | 'lint' | 'types' | 'gate';
/** What a check invocation checks — a replacement of the same kind is a respelling,
 *  of another kind a removal (`npm test` → `npm run lint` drops the tests). */
export function checkKind(core: string): Kind | null {
  if (!invokesCheck(core)) return null;
  const s = canonical(core);
  if (/\btamperward\b/.test(s)) return 'gate';
  if (/\b(?:lint|eslint|biome|oxlint|golangci-lint|ruff)\b/i.test(s)) return 'lint';
  if (/\b(?:typecheck|type-check|tsc|tsgo|mypy)\b|\bdeno\s+check\b/i.test(s)) return 'types';
  return 'test';
}

export type Kept = 'kept' | 'neutralised' | 'gone';

/** Whether a removed check survives among the after-file's command cores. `addedCores`
 *  are the cores of lines ADDED by this change — the only place a respelling of the
 *  removed check can be. */
export function survives(removedCore: string, isUses: boolean, afterCores: string[], addedCores: string[]): { state: Kept; by?: string } {
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

// ── one invocation before → after ─────────────────────────────────────────────

export type Weakening =
  | { state: 'kept' }
  | { state: 'neutralised'; what: string; direction: 'added' | 'removed' }
  | { state: 'removed'; what: string; kind: Kind };

export interface WeakeningOpts {
  /** Whether `--config <file>` names a config the repository already reviews (a
   *  protected file that is not added by this change). Absent, any new `--config`
   *  is a narrowing: a config nothing protects can select nothing. */
  configReviewed?: (file: string) => boolean;
  /** A narrowing flag the caller excuses (`--exclude e2e/**` is another runner's
   *  directory, not a narrowing). */
  excuseFlag?: (flag: string, cmd: string) => boolean;
  /** The script is a deliberate slice of the suite (`test:unit`): a flag or a
   *  positional that selects its slice is its design, and only a masked status, a
   *  timeout, a dropped gate flag or a replacement counts. */
  sliceByDesign?: boolean;
  /** A check kind dropped from this invocation that reappears elsewhere in the same
   *  change (a `lint` script added beside it) is a move, not a removal. */
  relocated?: (kind: Kind) => boolean;
}

/** The runners whose narrowing flags are read. */
export type RunnerName = 'jest' | 'vitest' | 'mocha' | 'pytest' | 'go' | 'cargo' | 'node';

/** Flags that select FEWER tests than the runner's default, beyond the table
 *  ci-tampering reads (`SUITE_NARROWING_FLAGS`). Keyed by runner because the short
 *  spellings collide: `-m` selects pytest markers and is `python -m` elsewhere,
 *  `-g` is mocha's grep, `-run` is go's. `*` applies to every runner. */
const NARROWING_BY_RUNNER: Record<RunnerName | '*', RegExp[]> = {
  '*': [/--shard\b/],
  jest: [/--root\b/, /--rootDir\b/, /--testMatch\b/, /--testRegex\b/, /--modulePathIgnorePatterns\b/, /--selectProjects\b/, /--ignoreProjects\b/, /--filter\b/],
  vitest: [/--grep\b/],
  mocha: [/--grep\b/, /(?:^|\s)-g(?:\s|=)/, /--ignore\b/, /(?:^|\s)-f(?:\s|=)/, /--fgrep\b/],
  pytest: [/(?:^|\s)-k(?:\s|=)/, /(?:^|\s)-m(?:\s|=)/, /--deselect\b/, /--ignore\b/, /--ignore-glob\b/, /--last-failed\b/, /(?:^|\s)--lf(?:\s|$)/, /--collect-only\b/, /(?:^|\s)--co(?:\s|$)/],
  go: [/(?:^|\s)-run(?:\s|=)/, /(?:^|\s)-skip(?:\s|=)/],
  cargo: [],
  node: [/--test-name-pattern\b/, /--test-skip-pattern\b/],
};
/** `cargo test -- --skip <name>`: the skip sits past the `--` separator. */
const CARGO_SKIP = /\s--\s+(?:\S+\s+)*--skip\b/;

/** Flags that turn a kept check's status green whatever it found. `--if-present`
 *  is npm's: `npm run test:unit --if-present` passes when the script is missing. */
const MASKING_FLAGS = [/--passWithNoTests\b/, /--coverage=false\b/, /--coverageThreshold\b/, /--if-present\b/];

/** Flags whose REMOVAL weakens the check: the coverage gate nyc/c8 enforce. */
const GATE_FLAGS = [/--check-coverage\b/];

/** `--config <file>` / `-c <file>`: the value, or null. */
const CONFIG_FLAG = /(?:^|\s)(--config|-c)(?:=|\s+)(['"]?)([^\s'"]+)\2(?=\s|$)/;

/** The wrappers a package script puts in front of the runner: an env prefix
 *  (`cross-env NODE_ENV=test`, `NODE_OPTIONS=… jest`, `dotenv -e .env --`), a
 *  coverage wrapper (`nyc --check-coverage --lines 90 mocha`, `c8`), `python -m
 *  pytest`, or the runner's own bin file run through node. Peeled so the check
 *  underneath is read, not the wrapper. */
const WRAPPER = /^(?:(?:npx\s+)?(?:cross-env|env|dotenv(?:-cli)?|nyc|c8)|[A-Za-z_]\w*=)/;
const PYTHON_M = /^python\d?(?:\.\d+)?\s+-m\s+(?=pytest\b)/;
const NODE_BIN = /^node(?:\s+-\S+)*\s+\S*node_modules\/(?:\.bin\/)?(jest|vitest|mocha|ava)\b\S*/;

/** A script segment with its wrappers peeled: the invocation itself. The wrapper's
 *  own flags are dropped token by token until a check is in front (`--lines 90`
 *  is nyc's, `--check-coverage` is read from the segment BEFORE peeling); a
 *  segment that never reaches one is returned as it was. */
function unwrap(seg: string): string {
  const s = seg.trim().replace(PYTHON_M, '').replace(NODE_BIN, '$1');
  if (invokesCheck(s) || !WRAPPER.test(s)) return s;
  const toks = s.split(/\s+/);
  for (let i = 1; i < toks.length && i <= 16; i++) {
    const rest = toks.slice(i).join(' ');
    if (invokesCheck(rest)) return rest;
  }
  return s;
}

const RUNNER_NAME = /^(jest|vitest|mocha|pytest|go|cargo|node)\b/;
function runnerOfSegment(canon: string): RunnerName | null {
  const m = canon.match(RUNNER_NAME);
  if (!m) return null;
  const n = m[1];
  return n === 'jest' || n === 'vitest' || n === 'mocha' || n === 'pytest' || n === 'go' || n === 'cargo' ? n : 'node';
}

/** The first spelling of `re` in `s`: the flag alone, its value and anchors dropped. */
const spelled = (re: RegExp, s: string): string | null => {
  const m = s.match(re);
  return m ? m[0].trim().replace(/[=\s].*$/, '') : null;
};

interface Descriptor {
  key: string; // identity, for the before/after set difference
  what: string; // how it is reported
  direction: 'added' | 'removed';
}

/** Statements and the operator that FOLLOWS each: `jest || true` is `jest` then
 *  `||`. Quote-aware like `segments()`; a `|`/`&` after `>` is a redirection. */
function statements(raw: string): Array<{ seg: string; op: string | null }> {
  const out: Array<{ seg: string; op: string | null }> = [];
  let single = false;
  let double = false;
  let last = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && !single) { i++; continue; }
    if (ch === "'" && !double) { single = !single; continue; }
    if (ch === '"' && !single) { double = !double; continue; }
    if (single || double) continue;
    const prev = raw[i - 1];
    const next = raw[i + 1];
    let op: string | null = null;
    if (ch === '&' && next === '&') op = '&&';
    else if (ch === '|' && next === '|') op = '||';
    else if (ch === '|' && next === '&') op = '|&';
    else if (ch === ';' || ch === '\n') op = ';';
    else if (ch === '|' && prev !== '>') op = '|';
    else if (ch === '&' && prev !== '>' && next !== '>') op = '&';
    if (!op) continue;
    out.push({ seg: raw.slice(last, i).trim(), op });
    i += op.length - 1;
    last = i + 1;
  }
  out.push({ seg: raw.slice(last).trim(), op: null });
  return out.filter((s) => s.seg !== '');
}

/** Everything in an invocation that masks, cuts short or narrows the check it runs,
 *  as descriptors; the before/after difference is the weakening. */
function descriptors(cmd: string, runner: RunnerName | undefined, opts: WeakeningOpts): Descriptor[] {
  const out: Descriptor[] = [];
  const stmts = statements(cmd);
  for (let i = 0; i < stmts.length; i++) {
    const { seg, op } = stmts[i];
    const wrapped = seg.match(TIMEOUT_WRAP);
    const inner = unwrap(wrapped ? wrapped[1] : seg);
    if (!invokesCheck(inner)) continue;
    const kind = checkKind(inner);
    const canon = canonical(inner);
    const rn = runner ?? runnerOfSegment(canon);
    const args = canon.includes(' ') ? ' ' + canon.slice(canon.indexOf(' ') + 1) : ' ';
    if (wrapped) out.push({ key: 'timeout', what: 'a timeout wrapper', direction: 'added' });
    // the shell operator after the check: `|| true`, `; exit 0`, `| tee`, `&`. A `;`
    // before another check is sequencing (`jest; eslint .` ends on the lint's
    // status); `; exit 0` and `; true` decide green.
    const following = stmts[i + 1]?.seg ?? '';
    if (op === '||' || op === '|' || op === '&' || (op === ';' && !invokesCheck(unwrap(following)))) {
      out.push({ key: `op:${op}`, what: `${op} ${following.split(/\s+/).slice(0, 2).join(' ')}`.trim(), direction: 'added' });
    }
    for (const re of MASKING_FLAGS) {
      const f = spelled(re, args);
      if (f) out.push({ key: `flag:${f}`, what: f, direction: 'added' });
    }
    for (const re of GATE_FLAGS) {
      const f = spelled(re, ' ' + seg);
      if (f) out.push({ key: `gate:${f}`, what: f, direction: 'removed' });
    }
    if (kind !== 'test' || opts.sliceByDesign) continue;
    const flags = [SUITE_NARROWING_FLAGS, ...NARROWING_BY_RUNNER['*'], ...(rn ? NARROWING_BY_RUNNER[rn] : [])];
    for (const re of flags) {
      const f = spelled(re, args);
      if (f && !opts.excuseFlag?.(f, canon)) out.push({ key: `flag:${f}`, what: f, direction: 'added' });
    }
    if (rn === 'cargo' && CARGO_SKIP.test(args)) out.push({ key: 'flag:-- --skip', what: '-- --skip', direction: 'added' });
    const cfg = args.match(CONFIG_FLAG);
    if (cfg && !opts.configReviewed?.(cfg[3])) out.push({ key: `config:${cfg[3]}`, what: `${cfg[1]} ${cfg[3]}`, direction: 'added' });
    const pos = positionalOf(args);
    if (pos) out.push({ key: 'positional', what: `a path positional (${pos})`, direction: 'added' });
  }
  return out;
}

/** The kinds of check an invocation runs, across its statements. */
export function checkKinds(cmd: string): Set<Kind> {
  const kinds = new Set<Kind>();
  for (const seg of segments(cmd)) {
    const w = seg.match(TIMEOUT_WRAP);
    const k = checkKind(unwrap(w ? w[1] : seg));
    if (k) kinds.add(k);
  }
  return kinds;
}

/**
 * One check invocation before → after. `before` empty means the invocation is new:
 * nothing was removed, and anything that masks or narrows it counts.
 *
 *   - `removed`: a kind of check `before` ran no longer runs — the runner replaced
 *     by `echo ok`, a test script now running the lint, `&& npm test` dropped from
 *     a `check` script;
 *   - `neutralised`: the same check, but its status is masked (`|| true`, `; exit
 *     0`, a pipe, `--passWithNoTests`, `--if-present`), it is cut short (`timeout
 *     1`), a gate flag was dropped (`--check-coverage`), or the suite it runs was
 *     narrowed (a runner flag, a spec path as a positional, `--config` pointing at a
 *     file nothing reviews);
 *   - `kept`: a respelling (`jest` → `vitest run`), a flag added that selects nothing
 *     fewer, or a flag that was there already.
 */
export function invocationWeakening(before: string, after: string, runner?: RunnerName, opts: WeakeningOpts = {}): Weakening {
  const was = checkKinds(before);
  const now = checkKinds(after);
  for (const k of was) {
    if (now.has(k) || opts.relocated?.(k)) continue;
    const instead = [...now].filter((x) => !was.has(x));
    return { state: 'removed', kind: k, what: instead.length ? `runs a ${instead.join('/')} check instead` : now.size ? 'the check is gone' : 'no check is run' };
  }
  const beforeDs = descriptors(before, runner, opts);
  const afterDs = descriptors(after, runner, opts);
  const seenBefore = new Set(beforeDs.map((d) => d.key));
  const added = afterDs.find((d) => d.direction === 'added' && !seenBefore.has(d.key));
  if (added) return { state: 'neutralised', what: added.what, direction: 'added' };
  const seenAfter = new Set(afterDs.map((d) => d.key));
  const dropped = beforeDs.find((d) => d.direction === 'removed' && !seenAfter.has(d.key));
  if (dropped) return { state: 'neutralised', what: dropped.what, direction: 'removed' };
  return { state: 'kept' };
}
