// #7 ci-tampering (file surface, mechanical).
// On a protected workflow file: neutering a job (continue-on-error / if:false) or
// deleting a check step (test/lint/typecheck). "Deleting" means the command no longer
// exists in the after-file — a check MOVED (reindented, put behind an `if:`) is not a
// removal, and a check keyword only counts in invocation position (issue #15: both
// false positives this rule has produced were a move and an argument-position match).

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

const uncommented = (v: string) => v.replace(/\s+#.*$/, '').trim();

/** An `if:` value that can never be true — the expression spellings of `if: false`.
 *  Matching only the bare literal let `if: ${{ false }}` disable a required step. */
function isAlwaysFalse(raw: string): boolean {
  const v = uncommented(raw);
  if (/^false$/i.test(v)) return true;
  const m = v.match(/^\$\{\{\s*(.+?)\s*\}\}$/);
  if (!m) return false;
  const e = m[1];
  if (/^(false|0|''|"")$/i.test(e)) return true;
  const cmp = e.match(/^(-?\d+)\s*(==|!=)\s*(-?\d+)$/);
  if (cmp) return cmp[2] === '==' ? cmp[1] !== cmp[3] : cmp[1] === cmp[3];
  return false;
}

/** A `continue-on-error:` value that is on, literal or interpolated. */
function isTruthy(raw: string): boolean {
  const v = uncommented(raw);
  if (/^true$/i.test(v)) return true;
  const m = v.match(/^\$\{\{\s*(.+?)\s*\}\}$/);
  return !!m && /^(true|1)$/i.test(m[1]);
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

      for (const l of addedLines(c)) {
        const coe = l.content.match(/^\s*-?\s*continue-on-error:\s*(.+?)\s*$/);
        const cond = l.content.match(/^\s*-?\s*if:\s*(.+?)\s*$/);
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
              message: `if: ${uncommented(cond![1])} added — this step can never run.`,
              evidence: l.content.trim(),
              remediation: 'Re-enable the step instead of conditioning it off.',
            }),
          );
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
      const afterCores = new Set(
        (c.after != null ? c.after.split('\n') : addedLines(c).map((l) => l.content)).map(commandCore),
      );
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
        if (afterCores.has(commandCore(l.content))) continue; // moved or reformatted, not removed
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
