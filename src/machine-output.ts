/**
 * Public machine-output schema major.
 *
 * Additive fields may ship without changing this value. Removing/renaming a
 * required field, changing its type, or changing a discriminator's meaning
 * requires a new major and new published *-vN.schema.json files.
 */
export const MACHINE_SCHEMA_VERSION = 1 as const;
export type MachineSchemaVersion = typeof MACHINE_SCHEMA_VERSION;

export function machineOutput<T extends Record<string, unknown>>(
  payload: T,
): T & { schema_version: MachineSchemaVersion } {
  return { ...payload, schema_version: MACHINE_SCHEMA_VERSION };
}

/**
 * Discriminator vocabularies. These constants are the single source for both
 * the emitters and the published schemas: `test/json-schema.test.ts` asserts
 * that each schema enum equals the constant here, so a new verdict or reason
 * cannot ship in the CLI without also shipping in the contract.
 */

/** `verify --json` top-level verdicts. */
export const VERIFY_VERDICTS = [
  'VERIFIED',
  'MASKED_FAILURE',
  'SUITE_RED',
  'BUDGET_EXCEEDED',
  'CANNOT_VERIFY',
] as const;
export type VerifyVerdict = (typeof VERIFY_VERDICTS)[number];

/** Why a `verify` document carries `verdict: "CANNOT_VERIFY"`. Every
 *  fail-closed exit before a verdict exists names one of these; `stage` says
 *  which suite execution (if any) was in flight. */
export const VERIFY_CANNOT_VERIFY_REASONS = [
  'INVALID_ARGUMENTS',
  'POLICY_ERROR',
  'BASE_NOT_ANCESTOR',
  'NO_SUITE_COMMAND',
  'VERIFIER_BACKEND_UNAVAILABLE',
  'LOCAL_VERIFIER_UNSUPPORTED_PLATFORM',
  'DEPENDENCY_ENVIRONMENT_UNATTESTABLE',
  'BASE_UNRESOLVABLE',
  'DEPENDENCY_DRIFT',
  'MATERIALIZATION_FAILED',
  'VERIFIER_BACKEND_RUNTIME_FAILURE',
  'VERIFIER_RESOURCE_EXHAUSTED',
  'WORKTREE_CHANGED',
  'PRISTINE_INTEGRITY_CHANGED',
  'PATH_CASE_COLLISION',
] as const;
export type VerifyCannotVerifyReason = (typeof VERIFY_CANNOT_VERIFY_REASONS)[number];

/** `run --json` top-level verdicts. */
export const RUN_VERDICTS = [
  'VERIFIED',
  'AGENT_TIMEOUT',
  'AGENT_FAILED',
  'ENFORCEMENT_FAILED',
  'CANNOT_ADJUDICATE',
  'OBJECT_REWRITE',
  'HISTORY_REWRITE',
  'DEPENDENCY_DRIFT',
  'NOT_QUIESCENT',
  'TRANSIENT_OBSERVER_BLOCK',
] as const;
export type RunVerdict = (typeof RUN_VERDICTS)[number];

/** Why a `run` document carries `verdict: "CANNOT_ADJUDICATE"`. */
export const RUN_CANNOT_ADJUDICATE_REASONS = [
  'AGENT_LIFECYCLE_NOT_OWNED',
  'VERIFY_CANNOT_VERIFY',
  'CHECK_DIFF_UNJUDGEABLE',
  'CHECK_WORKTREE_UNJUDGEABLE',
] as const;
export type RunCannotAdjudicateReason = (typeof RUN_CANNOT_ADJUDICATE_REASONS)[number];
