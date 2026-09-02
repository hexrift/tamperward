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
//     removed, `paths-ignore: ['**']`, `branches:` no longer naming main;
//   - `continue-on-error` / `if:` written as an expression that folds to a constant
//     (`"true"`, `${{ 1 == 1 }}`, `${{ 'a' == 'b' }}`, `${{ !true }}`). Anything
//     with a context reference stays "reachable" — the documented class.
//
// And one class of edit that is NOT a removal, because Dependabot and ordinary
// maintenance produce it daily: a check line edited in place. `npm test` →
// `npm test -- --reporter=dot`, `npm run test`, `pnpm test`, quoting, an action
// bumped `@v3` → `@v4` — the command core is a prefix / superset / equivalent
// spelling of the removed one, and it is kept. A superset that carries a
// neutraliser (`|| true`, `--passWithNoTests`, a narrowed `-t`) is reported as such.

import { Change, Detector, Finding } from '../types';
import { addedLines, removedLines } from '../diff/select';
import { isProtected } from '../policy';
import { makeFinding } from './finding';

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
  /(?:^\s*|[;&|`]\s*|\$\(\s*|\b(?:npx|yarn|pnpm|bunx?)\s+)(?:jest|vitest|eslint|tsc|playwright|pytest|tamperward)\b/;
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

/** The command with its package-runner spelling normalised, so `npm test`, `npm run
 *  test`, `npm t`, `pnpm test`, `yarn test` and a quoted `'npm test'` are one check,
 *  and `npx jest`, `pnpm exec jest`, `yarn jest`, `bunx jest` another. */
function canonical(core: string): string {
  let s = core.replace(/^(['"])(.*)\1$/, '$2').trim();
  s = s.replace(/^(?:npx|pnpm\s+(?:exec|dlx)|yarn\s+(?:exec|dlx)|bunx|bun\s+x)\s+/, 'exec ');
  s = s.replace(/^(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?/, 'exec ');
  s = s.replace(/^exec\s+(?:t|tst)(?=\s|$)/, 'exec test');
  s = s.replace(/^exec\s+/, '');
  return s.replace(/\s+--\s*$/, '').trim();
}

/** `uses:` identity stops at the version: `actions/setup-node@v3` → `@v4` is a bump. */
const usesRef = (core: string) => core.replace(/@.*$/, '');

// Suffixes that turn a kept check into a non-check: shell status masking, and runner
// flags that empty or narrow the suite it runs.
const NEUTRALISING_SUFFIX =
  /\|\||;|(?<!&)&(?!&)|\|(?!\|)|--passWithNoTests\b|--coverage=false\b|--coverageThreshold\b|--testPathIgnorePatterns\b|--testPathPattern\b|--testNamePattern\b|(?:^|\s)-t\s|--onlyChanged\b|--changed\b|--findRelatedTests\b/;

type Kept = 'kept' | 'neutralised' | 'gone';

/** Whether a removed check survives among the after-file's command cores. */
function survives(removedCore: string, isUses: boolean, afterCores: string[]): { state: Kept; by?: string } {
  if (isUses) {
    const ref = usesRef(removedCore);
    return afterCores.some((a) => usesRef(a) === ref) ? { state: 'kept' } : { state: 'gone' };
  }
  const r = canonical(removedCore);
  let neutralised: string | undefined;
  for (const raw of afterCores) {
    const a = canonical(raw);
    if (a === r) return { state: 'kept' };
    if (a.startsWith(r + ' ')) {
      const rest = a.slice(r.length);
      if (NEUTRALISING_SUFFIX.test(rest)) neutralised = raw;
      else return { state: 'kept' };
    } else if (r.startsWith(a + ' ') && invokesCheck(a)) {
      return { state: 'kept' }; // the check got shorter — arguments dropped, the invocation kept
    }
  }
  return neutralised ? { state: 'neutralised', by: neutralised } : { state: 'gone' };
}

const uncommented = (v: string) => v.replace(/\s+#.*$/, '').trim();

// ── a constant folder for the expression subset that has no context reference ──
//
// GitHub evaluates `if:` and `continue-on-error:` as expressions. Literals, `==`,
// `!=`, `&&`, `||`, `!` and parentheses fold to a value here; an identifier, a
// context reference or a function call makes the whole expression UNKNOWN, which
// reads as reachable — the same exposure as authoring a new guarded step.
type Val = string | number | boolean | null;
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
    const op = src.slice(i).match(/^(?:==|!=|&&|\|\||<=|>=|[!()<>])/);
    if (op) {
      out.push({ t: 'op', v: op[0] });
      i += op[0].length;
      continue;
    }
    const id = src.slice(i).match(/^[A-Za-z_][\w.\-[\]*]*/);
    if (id) {
      out.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    return null;
  }
  return out;
}

/** Fold an expression to a constant; undefined when it depends on anything. */
export function foldConst(src: string): Val | undefined {
  const toks = lex(src);
  if (!toks) return undefined;
  let p = 0;
  const peek = () => toks[p];
  const eat = (v: string) => (toks[p]?.t === 'op' && toks[p].v === v ? (p++, true) : false);
  const truthy = (v: Val): boolean => (typeof v === 'string' ? v !== '' : typeof v === 'number' ? v !== 0 : v === true);
  const num = (v: Val): number => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : v === null ? 0 : v.trim() === '' ? 0 : Number(v));
  const eq = (a: Val, b: Val): boolean => {
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
      if (l === undefined || r === undefined) return undefined;
      l = truthy(l) ? l : r;
    }
    return l;
  };
  const and = (): Val | undefined => {
    let l = cmp();
    while (eat('&&')) {
      const r = cmp();
      if (l === undefined || r === undefined) return undefined;
      l = truthy(l) ? r : l;
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
      if (l === undefined || r === undefined) return undefined;
      if (t.v === '==') l = eq(l, r);
      else if (t.v === '!=') l = !eq(l, r);
      else {
        const x = num(l);
        const y = num(r);
        if (Number.isNaN(x) || Number.isNaN(y)) return undefined;
        l = t.v === '<' ? x < y : t.v === '>' ? x > y : t.v === '<=' ? x <= y : x >= y;
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
      return undefined; // a context reference or a function: not ours to decide
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
  return v !== undefined && !(typeof v === 'string' ? v !== '' : typeof v === 'number' ? v !== 0 : v === true);
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
  return f !== undefined && (typeof f === 'string' ? f !== '' : typeof f === 'number' ? f !== 0 : f === true);
}

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

const stepHasCheck = (lines: string[], range: [number, number] | null): boolean =>
  range === null || lines.slice(range[0], range[1]).some((l) => invokesCheck(l) || (USES.test(l) && CHECK.test(l)));

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
interface Triggers {
  events: Set<string>;
  branches: Map<string, string[]>; // event → branches list (literal entries)
  branchesIgnore: Map<string, string[]>;
  pathsIgnore: Map<string, string[]>;
  present: boolean;
}

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
  const t: Triggers = { events: new Set(), branches: new Map(), branchesIgnore: new Map(), pathsIgnore: new Map(), present: false };
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
  let listKey: 'branches' | 'branchesIgnore' | 'pathsIgnore' | null = null;
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
    if (event && /^(?:branches|branches-ignore|paths-ignore)$/.test(kv[1])) {
      listKey = kv[1] === 'branches' ? 'branches' : kv[1] === 'branches-ignore' ? 'branchesIgnore' : 'pathsIgnore';
      listInd = ind;
      const list = flowList(kv[2]);
      t[listKey].set(event, list ?? []);
    } else listKey = null;
  }
  return t;
}

const DEFAULT_BRANCH = /^(?:main|master)$/;
const ALL = (g: string) => /^\*\*?$|^\*\*\/\*$/.test(g);

function triggerNarrowings(before: Triggers, after: Triggers): string[] {
  const out: string[] = [];
  if (!before.present || !after.present) return out;
  for (const e of ['push', 'pull_request', 'pull_request_target']) {
    if (before.events.has(e) && !after.events.has(e)) out.push(`the ${e} trigger was removed — the workflow no longer runs on it`);
  }
  for (const [e, list] of after.pathsIgnore) {
    const had = before.pathsIgnore.get(e) ?? [];
    if (list.some((g) => ALL(g) && !had.includes(g))) out.push(`on.${e}.paths-ignore now ignores every path — the workflow never runs on ${e}`);
  }
  for (const [e, list] of after.branchesIgnore) {
    const had = before.branchesIgnore.get(e) ?? [];
    if (list.some((g) => (ALL(g) || DEFAULT_BRANCH.test(g)) && !had.includes(g))) out.push(`on.${e}.branches-ignore now covers the default branch`);
  }
  for (const [e, was] of before.branches) {
    const now = after.branches.get(e);
    if (!now || !after.events.has(e)) continue; // filter dropped = wider, or the event itself is reported above
    if (now.some(ALL)) continue;
    const lostDefault = was.some((b) => DEFAULT_BRANCH.test(b) && !now.includes(b));
    const replaced = was.length > 0 && !was.some((b) => now.includes(b));
    if (lostDefault || replaced) out.push(`on.${e}.branches no longer names ${was.filter((b) => !now.includes(b)).join(', ')} (now [${now.join(', ')}])`);
  }
  return out;
}

export const ciTampering: Detector = {
  id: RULE,
  surface: ['file'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];
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
        // enclosing step) applies to every step and is always reported.
        const step = afterLines && l.newLine != null ? stepOf(afterLines, l.newLine - 1) : null;
        if (afterLines && step && !stepHasCheck(afterLines, step)) continue;
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
        // the block's last command decides, and a trailing `true` decides green.
        for (const l of addedLines(c)) {
          if (!/^\s*-?\s*shell:\s*.*\{0\}/.test(l.content) || l.newLine == null) continue;
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
          for (const reason of triggerNarrowings(parseTriggers(c.before), parseTriggers(c.after!))) {
            out.push(
              makeFinding(RULE, policy, {
                file: c.path,
                message: `The workflow's triggers were narrowed: ${reason}.`,
                evidence: reason,
                remediation: 'Keep the workflow running on push and pull_request for the default branch; a check that never runs is no check.',
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
      for (const l of removedLines(c)) {
        // A YAML comment is prose, not a step. Rewording a comment that quoted
        // `tamperward:allow:<rule>` in a code span read as "a check command was
        // removed", because the backtick before the word satisfied the
        // invocation-position test — the repo's own gate blocked a comment edit.
        if (/^\s*#/.test(l.content)) continue;
        const isUsesLine = USES.test(l.content) && CHECK.test(l.content);
        const isCheckCommand = !isUsesLine && !/^\s*-?\s*uses:/.test(l.content) &&
          (YAML_KEY.test(l.content) ? /^\s*-?\s*run:/.test(l.content) : true) && invokesCheck(l.content);
        if (!isUsesLine && !isCheckCommand) continue;
        const s = survives(commandCore(l.content), isUsesLine, afterCores);
        if (s.state === 'kept') continue; // moved, reformatted, respelled or extended — not removed
        if (s.state === 'neutralised') {
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              message: 'A CI check command was neutralised in place: it still runs, but its result no longer decides (or its suite was narrowed).',
              evidence: `${l.content.trim()} → ${s.by}`,
              remediation: 'Let the check decide the step; do not mask its status or narrow what it runs.',
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
