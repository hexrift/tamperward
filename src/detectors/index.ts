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
import { assertionWeakening } from './assertion-weakening';

/** Mechanical detectors plus measured warning-only heuristics. guard-removal remains
 *  reserved; assertion-weakening is AST-backed and stays warn while precision accrues. */
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
  assertionWeakening,
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
  assertionWeakening,
};
