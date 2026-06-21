// The engine: run the enabled detectors over Change[] and return the findings.
// It knows nothing about where the changes came from — agent hook, pre-commit, or CI
// all funnel through here, which is what makes one ruleset enforce identically.

import { Change, Detector, Finding, Policy } from './types';
import { allDetectors } from './detectors';
import { isEnabled } from './detectors/finding';
import { isIgnored } from './policy';

function key(f: Finding): string {
  return `${f.rule}|${f.file ?? ''}|${f.line ?? ''}|${f.evidence}`;
}

/** File changes whose path is ignored by policy are dropped before detection.
 *  Command changes are never path-scoped, so they always run. */
export function activeChanges(changes: Change[], policy: Policy): Change[] {
  return changes.filter((c) => c.kind !== 'file' || !isIgnored(c.path, policy));
}

export function evaluate(
  changes: Change[],
  policy: Policy,
  detectors: Detector[] = allDetectors,
): Finding[] {
  const active = activeChanges(changes, policy);
  const out: Finding[] = [];
  for (const d of detectors) {
    if (!isEnabled(d.id, policy)) continue;
    out.push(...d.run(active, policy));
  }
  // de-duplicate identical findings (e.g. a command both rm-ing and matching a path)
  const seen = new Set<string>();
  return out.filter((f) => {
    const k = key(f);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function hasBlocking(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === 'block');
}
