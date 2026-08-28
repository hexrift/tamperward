// #12 snapshot-only-rewrite (file surface, mechanical, WARN — graduation candidate).
//
// The narrow signal the FP study isolated (harness/fp-study/): a snapshot changed with
// NO accompanying non-snapshot change. Across 1,652 real mainline commits (prettier,
// jest, docusaurus, immer) the broad snapshot-rewrite rule fired on 216 — every one a
// legitimate update — but only ONE of those 216 was snapshot-only (a jest maintainer's
// two-line "Update snapshot." follow-up), while 7/7 observed harness tampers were
// snapshot-only. ~0.06% FP on mainline, 7/7 TP on attacks: that asymmetry is why this
// exists as a DISTINCT rule, so it can graduate warn -> block at a later policy
// `version:` (BLOCK_SINCE) without touching the broad rule, which stays warn forever.
//
// GRANULARITY IS LOAD-BEARING. "No accompanying change" is only meaningful at commit
// granularity — the granularity the FP corpus measured. At the PreToolUse hook a
// single Edit to a .snap file is ALWAYS "snapshot-only", and even the Stop sweep's
// turn granularity can split a legitimate source+snapshot update across turns. So this
// rule fires ONLY on the staged and range views (pre-commit and CI), where Change[]
// is a whole diff. On every other view it stays silent by design, not by omission.
//
// Known conservative edge: changes suppressed by policy.ignore are filtered before
// detection, so a commit pairing a snapshot with only ignored-path changes reads as
// snapshot-only here. That errs toward asking a human (warn), never toward missing.

import { Change, Detector, Finding, Policy, View } from '../types';
import { isProtected } from '../policy';
import { makeFinding } from './finding';

const RULE = 'snapshot-only-rewrite';

const COMMIT_VIEWS: ReadonlyArray<View> = ['staged', 'range'];

function isSnapshotChange(c: Change, policy: Policy): boolean {
  if (c.kind !== 'file') return false;
  // A brand-new snapshot is deliberately not counted (matching the broad rule): the
  // signal is a recorded expectation MOVING, not one appearing.
  if (c.op === 'add') return false;
  if (isProtected(c.path, policy, 'snapshots')) return true;
  return c.oldPath != null && isProtected(c.oldPath, policy, 'snapshots');
}

export const snapshotOnlyRewrite: Detector = {
  id: RULE,
  surface: ['file'],
  certainty: 'mechanical',
  run(changes: Change[], policy, view?: View): Finding[] {
    if (!view || !COMMIT_VIEWS.includes(view)) return [];
    const files = changes.filter((c) => c.kind === 'file');
    if (files.length === 0) return [];
    const snaps = files.filter((c) => isSnapshotChange(c, policy));
    if (snaps.length === 0 || snaps.length !== files.length) return [];

    const first = snaps[0] as Extract<Change, { kind: 'file' }>;
    const names = snaps
      .map((c) => (c.kind === 'file' ? c.path : ''))
      .filter(Boolean)
      .slice(0, 3)
      .join(', ');
    return [
      makeFinding(RULE, policy, {
        file: first.path,
        message:
          `Only recorded expectations changed in this diff (${snaps.length} snapshot ` +
          `file${snaps.length === 1 ? '' : 's'}, no code change to explain them).`,
        evidence: names + (snaps.length > 3 ? ', …' : ''),
        remediation:
          'Pair the snapshot update with the source change that motivates it, or confirm ' +
          'the new expectations are genuinely intended. In 1,652 audited mainline commits ' +
          'this shape occurred once; in observed tamper attempts, every time.',
        defaultSeverity: 'warn',
      }),
    ];
  },
};
