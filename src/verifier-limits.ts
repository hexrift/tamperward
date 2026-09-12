/**
 * Time-envelope contract for TamperWard's generated GitHub Actions authority.
 *
 * GitHub documents jobs.<job_id>.timeout-minutes as defaulting to 360 minutes:
 * https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idtimeout-minutes
 *
 * verify.budget is a PER-STAGE wall clock. TamperWard currently executes two
 * independently budgeted stages (visible + pristine). Generated CI reserves an
 * additional hour for authority installation, checkout, materialisation,
 * hashing, cleanup and reporting.
 *
 * IMPORTANT: these constants do NOT constrain the policy schema. Existing
 * positive finite verify.budget values remain valid. `tamperward doctor`
 * compares the trusted budget with the workflow that will host verification and
 * refuses an outer authority that cannot honestly accommodate it.
 */
export const VERIFIER_STAGE_COUNT = 2;
export const GENERATED_CI_TIMEOUT_MINUTES = 360;
export const GENERATED_CI_MIN_OVERHEAD_RESERVE_SECS = 60 * 60;

function assertEnvelopeConstants(): void {
  if (!Number.isInteger(VERIFIER_STAGE_COUNT) || VERIFIER_STAGE_COUNT < 1) {
    throw new Error('TamperWard verifier envelope: stage count must be a positive integer');
  }
  if (!Number.isFinite(GENERATED_CI_TIMEOUT_MINUTES) || GENERATED_CI_TIMEOUT_MINUTES <= 0) {
    throw new Error('TamperWard verifier envelope: generated CI timeout must be positive');
  }
  if (
    !Number.isFinite(GENERATED_CI_MIN_OVERHEAD_RESERVE_SECS) ||
    GENERATED_CI_MIN_OVERHEAD_RESERVE_SECS < 0
  ) {
    throw new Error('TamperWard verifier envelope: overhead reserve cannot be negative');
  }
  if (GENERATED_CI_TIMEOUT_MINUTES * 60 <= GENERATED_CI_MIN_OVERHEAD_RESERVE_SECS) {
    throw new Error(
      'TamperWard verifier envelope: generated CI timeout leaves no time for verifier stages',
    );
  }
}

// Executable invariant: a future edit cannot make the generated authority's
// constants nonsensical and still load the module successfully.
assertEnvelopeConstants();

export function requiredVerifierAuthoritySeconds(stageBudgetSecs: number): number {
  if (!Number.isFinite(stageBudgetSecs) || stageBudgetSecs <= 0) {
    throw new Error('verifier stage budget must be a positive finite number');
  }
  return VERIFIER_STAGE_COUNT * stageBudgetSecs + GENERATED_CI_MIN_OVERHEAD_RESERVE_SECS;
}

export function maxStageBudgetForOuterTimeout(timeoutMinutes: number): number {
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error('outer timeout must be a positive finite number of minutes');
  }
  const available = timeoutMinutes * 60 - GENERATED_CI_MIN_OVERHEAD_RESERVE_SECS;
  if (available <= 0) return 0;
  return Math.floor(available / VERIFIER_STAGE_COUNT);
}
