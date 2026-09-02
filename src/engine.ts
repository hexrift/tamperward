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
      process.stderr.write(`tamperward: detector "${d.id}" errored: ${String(e)}\n`);
      // Isolation is right at the tool-call/turn hooks, where a thrown error
      // exits non-(0|2) and Claude treats it as a non-blocking hook failure —
      // there, dropping one rule beats losing the whole gate. At the layers
      // that ADJUDICATE (staged, worktree, range), silently dropping a rule
      // means repository content that makes a detector throw removes it from
      // the verdict, and the gate reports "clean". Those layers fail CLOSED.
      // (P1-7, external review.)
      if (view === 'staged' || view === 'worktree' || view === 'range') {
        out.push({
          rule: 'detector-error',
          severity: 'block',
          message: `Detector "${d.id}" failed to run; the verdict is incomplete.`,
          evidence: String(e).slice(0, 200),
          remediation:
            'A rule that cannot run is not a rule that passed. Fix the input or the detector; do not read this as clean.',
          signoff: { required: true, command: `tamperward allow detector-error --reason "..."` },
        } as Finding);
      }
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
  return deduped.filter((f) => {
    // `enabled: false` is honoured per FINDING rule id, not only per detector id.
    // `ts-any-launder` is emitted by the `ts-any-cast` detector, so disabling it
    // in policy did nothing — the detector stayed enabled and kept emitting the
    // rule the user had switched off. The engine's own `detector-error` is not a
    // policy rule and can never be disabled: a rule that could not run is not a
    // rule that passed, whatever the file says.
    if (f.rule !== 'detector-error' && !isEnabled(f.rule, policy)) return false;
    // Per-rule exclude globs: drop this ONE rule's findings on matching paths, leaving
    // every other rule's coverage intact. The policy file itself is never excludable —
    // a rule scoped off its own governing file is the self-switch-off this tool exists
    // to block (the same exception `ignore` carries).
    const ex = policy.rules[f.rule]?.exclude;
    if (!ex?.length || !f.file || isPolicyFile(f.file)) return true;
    return !matchesAny(f.file, ex);
  });
}

export function hasBlocking(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === 'block');
}
