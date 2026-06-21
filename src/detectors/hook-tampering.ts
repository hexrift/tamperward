// #8 hook-tampering (file + command surface, mechanical).
// The "guard the guardrail" rule: the hooks and the policy file are protected assets.
// Deleting/renaming them, lowering a severity, disabling a rule, or chmod/rm-ing a
// hook from the shell are all the tamper.

import { Change, Detector, Finding } from '../types';
import { addedLines, removedLines } from '../diff/select';
import { isProtected } from '../policy';
import { makeFinding } from './finding';
import { policyWeakening } from './policy-diff';
import { segments, tokens, unquote } from './command';

const RULE = 'hook-tampering';

export const hookTampering: Detector = {
  id: RULE,
  surface: ['file', 'command'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];

    for (const c of changes) {
      if (c.kind === 'file') {
        const targetsHook =
          isProtected(c.path, policy, 'hooks') ||
          (c.oldPath ? isProtected(c.oldPath, policy, 'hooks') : false);
        if (!targetsHook) continue;

        if (c.op === 'delete') {
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              message: 'A protected hook/policy file was deleted.',
              evidence: c.path,
              remediation: 'Restore it. The hooks and the policy are protected assets, not obstacles to remove.',
            }),
          );
        } else if (c.op === 'rename') {
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              message: `A protected hook/policy file was renamed (${c.oldPath} → ${c.path}).`,
              evidence: `${c.oldPath} → ${c.path}`,
              remediation: 'Renaming a hook out of place disables it. Restore the original path.',
            }),
          );
        } else if (c.path.endsWith('.holdfast.yml') && c.before != null && c.after != null) {
          // Full content available → compare the policy SEMANTICALLY, catching every
          // weakening move (added ignore globs, narrowed protected, lowered/disabled/
          // removed rules incl. the multiline form, weakened sign-off).
          for (const reason of policyWeakening(c.before, c.after)) {
            out.push(
              makeFinding(RULE, policy, {
                file: c.path,
                message: `The policy was weakened: ${reason}.`,
                evidence: reason,
                remediation:
                  'A change that weakens the guardrail is a high-risk edit requiring human sign-off, not an automated pass.',
              }),
            );
          }
        } else {
          // Fallback when full content isn't available: pair severity by RULE NAME
          // (inline form: `rule: { severity: block }`), so reformatting — which removes
          // block lines and adds warn lines for unrelated rules — does not read as a
          // lowering. Only the same rule going block → warn fires.
          const INLINE = /^\s*([A-Za-z0-9_-]+):\s*\{[^}]*\bseverity:\s*(block|warn)\b/;
          const removedSeverity = new Map<string, string>();
          for (const l of removedLines(c)) {
            const m = l.content.match(INLINE);
            if (m) removedSeverity.set(m[1], m[2]);
          }
          for (const l of addedLines(c)) {
            const m = l.content.match(INLINE);
            if (m && m[2] === 'warn' && removedSeverity.get(m[1]) === 'block') {
              out.push(
                makeFinding(RULE, policy, {
                  file: c.path,
                  line: l.newLine ?? undefined,
                  message: `Rule "${m[1]}" was lowered from block to warn in the policy.`,
                  evidence: l.content.trim(),
                  remediation: 'Do not weaken the policy to pass. Lowering a gate is a human sign-off decision.',
                }),
              );
            } else if (/enabled:\s*false\b/.test(l.content)) {
              out.push(
                makeFinding(RULE, policy, {
                  file: c.path,
                  line: l.newLine ?? undefined,
                  message: 'A rule was disabled (enabled: false) in the policy.',
                  evidence: l.content.trim(),
                  remediation: 'Re-enable the rule. Disabling the check to pass is the tamper.',
                }),
              );
            }
          }
        }
      } else {
        for (const seg of segments(c.raw)) {
          const hitsHook = tokens(seg).map(unquote).some((t) => isProtected(t, policy, 'hooks'));
          if (!hitsHook) continue;

          let why: string | null = null;
          if (/\bchmod\b/.test(seg) && /(?:^|\s)[-+=]?[a-z]*x/i.test(seg)) {
            why = 'chmod alters execute permission on a hook, which can disable it';
          } else if (/\brm\b/.test(seg)) {
            why = 'rm deletes a protected hook';
          } else if (/\btruncate\b/.test(seg) || /(?:^|\s)>\s*\S/.test(seg)) {
            why = 'a redirect/truncate empties a protected hook';
          }

          if (why) {
            out.push(
              makeFinding(RULE, policy, {
                message: `Hook tampering via shell: ${why}.`,
                evidence: seg,
                remediation: 'Leave the hooks in place. Mutating them from the shell is still tampering.',
              }),
            );
          }
        }
      }
    }
    return out;
  },
};
