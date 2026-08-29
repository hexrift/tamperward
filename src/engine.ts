// The engine: run the enabled detectors over Change[] and return the findings.
// It knows nothing about where the changes came from — agent hook, pre-commit, or CI
// all funnel through here, which is what makes one ruleset enforce identically.

import { Change, Detector, Finding, Policy, View } from './types';
import { allDetectors } from './detectors';
import { isEnabled } from './detectors/finding';
import { isIgnored, isPolicyFile, matchesAny } from './policy';

function key(f: Finding): string {
  return `${f.rule}|${f.file ?? ''}|${f.line ?? ''}|${f.evidence}`;
}

/** Whether policy.ignore suppresses this change from file-surface detection.
 *  A change to the POLICY FILE is never suppressible: `ignore` is read from the same file
 *  it would be hiding, so allowing it to cover itself lets one edit switch the whole gate
 *  off — including the detection of that edit. Command changes are never path-scoped. */
export function isSuppressed(c: Change, policy: Policy): boolean {
  if (c.kind !== 'file') return false;
  if (isPolicyFile(c.path) || (c.oldPath != null && isPolicyFile(c.oldPath))) return false;
  return isIgnored(c.path, policy);
}

/** File changes suppressed by policy.ignore are dropped before detection. */
export function activeChanges(changes: Change[], policy: Policy): Change[] {
  return changes.filter((c) => !isSuppressed(c, policy));
}

export function evaluate(
  changes: Change[],
  policy: Policy,
  detectors: Detector[] = allDetectors,
  view?: View,
): Finding[] {
  const active = activeChanges(changes, policy);
  const out: Finding[] = [];
  for (const d of detectors) {
    if (!isEnabled(d.id, policy)) continue;
    // Backstop: a single detector throwing must not crash the whole verdict. At the
    // PreToolUse hook a crash exits non-(0|2), which Claude treats as a non-blocking
    // error — i.e. it would fail OPEN. Isolate each detector; surface the failure loudly
    // on stderr but keep the other rules' verdicts intact.
    try {
      out.push(...d.run(active, policy, view));
    } catch (e) {
      process.stderr.write(`tamperward: detector "${d.id}" errored and was skipped: ${String(e)}\n`);
    }
  }
  // de-duplicate identical findings (e.g. a command both rm-ing and matching a path)
  const seen = new Set<string>();
  const deduped = out.filter((f) => {
    const k = key(f);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // Per-rule exclude globs: drop this ONE rule's findings on matching paths, leaving
  // every other rule's coverage intact. The policy file itself is never excludable —
  // a rule scoped off its own governing file is the self-switch-off this tool exists
  // to block (the same exception `ignore` carries).
  return deduped.filter((f) => {
    const ex = policy.rules[f.rule]?.exclude;
    if (!ex?.length || !f.file || isPolicyFile(f.file)) return true;
    return !matchesAny(f.file, ex);
  });
}

export function hasBlocking(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === 'block');
}
