// #7 ci-tampering (file surface, mechanical).
// On a protected workflow file: neutering a job (continue-on-error / if:false) or
// deleting a check step (test/lint/typecheck).

import { Change, Detector, Finding } from '../types';
import { addedLines, removedLines } from '../diff/select';
import { isProtected } from '../policy';
import { makeFinding } from './finding';

const RULE = 'ci-tampering';
const STEP = /^\s*-?\s*(?:run|uses):/;
const CHECK = /\b(test|tests|lint|typecheck|type-check|tsc|eslint|jest|vitest|playwright|coverage|holdfast)\b/i;
/** A line that is a YAML mapping key rather than a shell command in a `run:` body. */
const YAML_KEY = /^\s*-?\s*[A-Za-z_][\w-]*:\s*(?:$|\S)/;
/** A command that actually runs a check — used to tell a `run: |` body line from prose. */
const RUNNER = /\b(npm|npx|pnpm|yarn|bun|make|cargo|pytest|python|jest|vitest|eslint|tsc|playwright|holdfast|gradle|mvn|dotnet)\b/;

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

      // A line removed AND re-added (a reformat or reorder) is not a deletion.
      const stillPresent = new Set(addedLines(c).map((l) => l.content.trim()));
      for (const l of removedLines(c)) {
        if (stillPresent.has(l.content.trim())) continue;
        const isStepLine = STEP.test(l.content) && CHECK.test(l.content);
        // A check is usually invoked from a multi-line `run: |` body, where the `run:` line
        // carries no check keyword and the command lines are not `run:`/`uses:` lines — so
        // requiring both on ONE line missed the most common way workflows run tests at all.
        const isRunBodyLine = !YAML_KEY.test(l.content) && RUNNER.test(l.content) && CHECK.test(l.content);
        if (!isStepLine && !isRunBodyLine) continue;
        out.push(
          makeFinding(RULE, policy, {
            file: c.path,
            message: isStepLine
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
