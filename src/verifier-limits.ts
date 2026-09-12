/**
 * Outer-time contract for the generated GitHub Actions authority.
 *
 * GitHub documents jobs.<job_id>.timeout-minutes as defaulting to 360 minutes:
 * https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idtimeout-minutes
 *
 * verify.budget is a PER-STAGE wall clock: visible and pristine can each consume
 * the full value. Keep the policy maximum at 150 minutes so two worst-case
 * stages use at most 300 minutes and leave 60 minutes for authority install,
 * checkout, materialisation, hashing, cleanup and reporting.
 *
 * A direct CLI --budget remains an operator/custom-runner override; this cap is
 * specifically the policy surface consumed by TamperWard's generated authority.
 */
export const GENERATED_CI_TIMEOUT_MINUTES = 360;
export const MAX_POLICY_VERIFY_BUDGET_SECS = 9_000;
export const GENERATED_CI_OVERHEAD_RESERVE_SECS =
  GENERATED_CI_TIMEOUT_MINUTES * 60 - 2 * MAX_POLICY_VERIFY_BUDGET_SECS;
