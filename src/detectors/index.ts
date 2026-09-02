import { Detector } from '../types';
import { noVerify } from './no-verify';
import { tsAnyCast } from './ts-any-cast';
import { lintSuppression } from './lint-suppression';
import { testSkip } from './test-skip';
import { coverageLowering } from './coverage-lowering';
import { ciTampering } from './ci-tampering';
import { hookTampering } from './hook-tampering';
import { testDeletion } from './test-deletion';
import { testContentRemoval } from './test-content-removal';
import { snapshotRewrite } from './snapshot-rewrite';
import { snapshotOnlyRewrite } from './snapshot-only';

/** The eleven mechanical detectors. The heuristic rules (assertion-weakening,
 *  guard-removal) are reserved names with no detector yet — SPEC §4 rows 3 and 10. */
export const allDetectors: Detector[] = [
  noVerify,
  tsAnyCast,
  lintSuppression,
  testSkip,
  coverageLowering,
  ciTampering,
  hookTampering,
  testDeletion,
  testContentRemoval,
  snapshotRewrite,
  snapshotOnlyRewrite,
];

export {
  noVerify,
  tsAnyCast,
  lintSuppression,
  testSkip,
  coverageLowering,
  ciTampering,
  hookTampering,
  testDeletion,
  testContentRemoval,
  snapshotRewrite,
  snapshotOnlyRewrite,
};
