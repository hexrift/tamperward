import { Detector } from '../types';
import { noVerify } from './no-verify';
import { tsAnyCast } from './ts-any-cast';
import { lintSuppression } from './lint-suppression';
import { testSkip } from './test-skip';
import { coverageLowering } from './coverage-lowering';
import { ciTampering } from './ci-tampering';
import { hookTampering } from './hook-tampering';
import { testDeletion } from './test-deletion';
import { snapshotRewrite } from './snapshot-rewrite';

/** The eight mechanical detectors. Heuristic rules (assertion-weakening,
 *  guard-removal) are added in a later phase as `warn`. */
export const allDetectors: Detector[] = [
  noVerify,
  tsAnyCast,
  lintSuppression,
  testSkip,
  coverageLowering,
  ciTampering,
  hookTampering,
  testDeletion,
  snapshotRewrite,
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
  snapshotRewrite,
};
