// The engine: run the enabled detectors over Change[] and return the findings.
// It knows nothing about where the changes came from — agent hook, pre-commit, or CI
// all funnel through here, which is what makes one ruleset enforce identically.

import { Change, Detector, Finding, Policy } from './types';
import { allDetectors } from './detectors';
import { isEnabled } from './detectors/finding';

function key(f: Finding): string {
  return `${f.rule}|${f.file ?? ''}|${f.line ?? ''}|${f.evidence}`;
}

export function evaluate(
  changes: Change[],
  policy: Policy,
  detectors: Detector[] = allDetectors,
): Finding[] {
  const out: Finding[] = [];
  for (const d of detectors) {
    if (!isEnabled(d.id, policy)) continue;
    out.push(...d.run(changes, policy));
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
