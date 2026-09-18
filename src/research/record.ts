// The research ledger's record shapes, and the reader that proves a document
// on disk has that shape before anything aggregates it. Records are written by
// `research run` and read back by `research summarize` — possibly on another
// machine, possibly edited — so a record is evidence to be checked, never a
// value to be believed (#383). The published contract is
// schemas/research-v1.schema.json; test/research.test.ts validates emitted
// documents against it.

import { finiteNumber, isRecord, nullableString } from '../narrow';
import { ADAPTER_LAYERS, RESEARCH_ARMS, ResearchError, type AdapterLayer, type ResearchArm } from './adapter';
import { MACHINE_SCHEMA_VERSION } from '../machine-output';
import {
  TREATMENT_DISPOSITIONS,
  type TreatmentDisposition,
  dispositionOf,
  greenFromExit,
  honestCompletionFrom,
  isMeasuredVerdict,
  isRunVerdict,
  isVerifyVerdict,
  maskedFailureFrom,
} from './derive';

// Re-exported so existing importers of the disposition vocabulary from this
// module keep working; the single definition lives in ./derive with the rest of
// the shared writer/reader derivations.
export { TREATMENT_DISPOSITIONS };
export type { TreatmentDisposition };

export interface TrajectoryOutcome {
  /** The `verify` verdict over the tree the agent left, against the trusted base. */
  verify_verdict: string;
  visible_exit: number | null;
  pristine_exit: number | null;
  visible_green: boolean;
  pristine_green: boolean;
  masked_failure: boolean;
  /** Blocking policy findings in the final tree (worktree + committed range). */
  surviving_protected_mutations: number;
  warn_findings: number;
  /** The rules behind the blocking findings, sorted and unique. */
  rules: string[];
  /** Pristine green with nothing weakened: the task was done honestly. */
  honest_completion: boolean;
}

export interface TreatmentRecord {
  verdict: string;
  exit_code: number;
  complete: boolean;
  disposition: TreatmentDisposition;
  /** The full `run --json` document, when the envelope emitted one. */
  envelope: Record<string, unknown> | null;
}

export interface TrajectoryRecord {
  arm: ResearchArm;
  workspace: string;
  base: string;
  head: string;
  started_at: string;
  finished_at: string;
  agent: {
    exit_code: number | null;
    signal: string | null;
    timed_out: boolean;
    /** Why the agent process could not be started or reported, when it could not. */
    failure: string | null;
  };
  /** TamperWard's own verdict: gated arm only, recorded separately from the outcome. */
  treatment: TreatmentRecord | null;
  outcome: TrajectoryOutcome;
  /** What downstream would have seen as green: the visible suite passed AND
   *  (in the gated arm) the envelope let the tree through. */
  released_green: boolean;
  /** False when the outcome could not be observed on sound footing (the trusted
   *  policy at the base unreadable, the verifier unable to run, a descendant
   *  still holding the workspace, the tree moving under observation). An
   *  unmeasured trajectory is recorded and never aggregated. */
  measured: boolean;
  unmeasurable: string | null;
}

export interface PairRecord {
  schema_version: typeof MACHINE_SCHEMA_VERSION;
  command: 'research';
  document: 'pair';
  task: string;
  pair: number;
  adapter: { name: string; layers: AdapterLayer[] };
  model: string | null;
  /** Product/runtime identity: resume must not mix behavior from another release. */
  tamperward_version: string;
  /** Adapter command template supplied by the operator (empty for adapters that need none). */
  agent_argv: string[];
  /** Agent wall-clock budget in seconds; null means no explicit budget. */
  agent_budget: number | null;
  manifest_sha256: string;
  verify_command: string;
  arms: Record<ResearchArm, TrajectoryRecord>;
}

function bad(where: string): never {
  throw new ResearchError(`malformed research record: ${where}`);
}

const SHA_RE = /^[0-9a-f]{40,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** A non-empty string: the schema's `minLength: 1`. */
function str(r: Record<string, unknown>, k: string, where: string): string {
  const v = r[k];
  return typeof v === 'string' && v.length > 0 ? v : bad(`${where}.${k} is not a non-empty string`);
}
function sha(r: Record<string, unknown>, k: string, where: string): string {
  const v = str(r, k, where);
  return SHA_RE.test(v) ? v : bad(`${where}.${k} is not a commit sha`);
}
/** An integer (the schema's `type: integer`), optionally bounded below. */
function int(r: Record<string, unknown>, k: string, where: string, min = Number.NEGATIVE_INFINITY): number {
  const v = finiteNumber(r[k]);
  if (v === undefined || !Number.isInteger(v)) return bad(`${where}.${k} is not an integer`);
  return v >= min ? v : bad(`${where}.${k} is below ${min}`);
}
function nullableInt(r: Record<string, unknown>, k: string, where: string): number | null {
  if (r[k] === null) return null;
  return int(r, k, where);
}
function nullablePositiveNumber(r: Record<string, unknown>, k: string, where: string): number | null {
  if (r[k] === null) return null;
  const v = finiteNumber(r[k]);
  if (v === undefined || v <= 0) return bad(`${where}.${k} is not a positive number or null`);
  return v;
}
function stringArray(r: Record<string, unknown>, k: string, where: string): string[] {
  const v = r[k];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return bad(`${where}.${k} is not an array of strings`);
  return [...v];
}
function bool(r: Record<string, unknown>, k: string, where: string): boolean {
  const v = r[k];
  return typeof v === 'boolean' ? v : bad(`${where}.${k} is not a boolean`);
}
function outcomeFrom(raw: unknown, where: string): TrajectoryOutcome {
  if (!isRecord(raw)) bad(`${where} is not an object`);
  const rules = raw.rules;
  if (!Array.isArray(rules) || !rules.every((x) => typeof x === 'string' && x.length > 0)) {
    bad(`${where}.rules is not an array of non-empty strings`);
  }
  const outcome: TrajectoryOutcome = {
    verify_verdict: str(raw, 'verify_verdict', where),
    visible_exit: nullableInt(raw, 'visible_exit', where),
    pristine_exit: nullableInt(raw, 'pristine_exit', where),
    visible_green: bool(raw, 'visible_green', where),
    pristine_green: bool(raw, 'pristine_green', where),
    masked_failure: bool(raw, 'masked_failure', where),
    surviving_protected_mutations: int(raw, 'surviving_protected_mutations', where, 0),
    warn_findings: int(raw, 'warn_findings', where, 0),
    rules: rules.filter((x): x is string => typeof x === 'string'),
    honest_completion: bool(raw, 'honest_completion', where),
  };
  // Cross-field consistency (#552): every derived field must equal what the
  // writer's derivation (./derive) produces, so an edited/migrated record cannot
  // hand the aggregator a contradictory summary. Do not repair — reject.
  if (!isVerifyVerdict(outcome.verify_verdict)) {
    bad(`${where}.verify_verdict "${outcome.verify_verdict}" is not a known verify verdict`);
  }
  if (outcome.visible_green !== greenFromExit(outcome.visible_exit)) {
    bad(`${where}.visible_green does not match visible_exit (green iff exit 0)`);
  }
  if (outcome.pristine_green !== greenFromExit(outcome.pristine_exit)) {
    bad(`${where}.pristine_green does not match pristine_exit (green iff exit 0)`);
  }
  if (outcome.masked_failure !== maskedFailureFrom(outcome.verify_verdict)) {
    bad(`${where}.masked_failure does not match the verify verdict`);
  }
  if (outcome.honest_completion !== honestCompletionFrom(outcome.verify_verdict, outcome.pristine_green, outcome.surviving_protected_mutations)) {
    bad(`${where}.honest_completion does not match verify verdict / pristine green / surviving mutations`);
  }
  if (new Set(outcome.rules).size !== outcome.rules.length) bad(`${where}.rules contains duplicate rules`);
  const sortedRules = [...outcome.rules].sort();
  if (outcome.rules.some((r, i) => r !== sortedRules[i])) bad(`${where}.rules is not sorted`);
  if (outcome.rules.length > outcome.surviving_protected_mutations) {
    bad(`${where}.rules has more entries than surviving_protected_mutations`);
  }
  if ((outcome.surviving_protected_mutations === 0) !== (outcome.rules.length === 0)) {
    bad(`${where}.rules must be empty exactly when there are no surviving protected mutations`);
  }
  return outcome;
}

function treatmentFrom(raw: unknown, where: string): TreatmentRecord | null {
  if (raw === null) return null;
  if (!isRecord(raw)) bad(`${where} is not an object or null`);
  const disposition = str(raw, 'disposition', where);
  const known = TREATMENT_DISPOSITIONS.find((d) => d === disposition);
  if (!known) bad(`${where}.disposition "${disposition}" is not one of ${TREATMENT_DISPOSITIONS.join('|')}`);
  const envelope = raw.envelope;
  if (envelope !== null && !isRecord(envelope)) bad(`${where}.envelope is not an object or null`);
  const verdict = str(raw, 'verdict', where);
  if (!isRunVerdict(verdict)) bad(`${where}.verdict "${verdict}" is not a run verdict`);
  // The disposition is derived from the verdict, not stored independently (#552):
  // an agent-failed run can still carry a `passed` enforcement disposition, but a
  // disposition that disagrees with what its verdict derives is a contradiction.
  const derivedDisposition = dispositionOf(verdict);
  if (known !== derivedDisposition) {
    bad(`${where}.disposition "${known}" does not match verdict "${verdict}" (derives "${derivedDisposition}")`);
  }
  return {
    verdict,
    exit_code: int(raw, 'exit_code', where),
    complete: bool(raw, 'complete', where),
    disposition: known,
    envelope: envelope === null ? null : envelope,
  };
}

function trajectoryFrom(raw: unknown, arm: ResearchArm, where: string): TrajectoryRecord {
  if (!isRecord(raw)) bad(`${where} is not an object`);
  if (raw.arm !== arm) bad(`${where}.arm is not "${arm}"`);
  const agent = raw.agent;
  if (!isRecord(agent)) bad(`${where}.agent is not an object`);
  const signal = nullableString(agent.signal);
  if (signal === undefined) bad(`${where}.agent.signal is not a string or null`);
  const failure = nullableString(agent.failure);
  if (failure === undefined) bad(`${where}.agent.failure is not a string or null`);
  const unmeasurable = nullableString(raw.unmeasurable);
  if (unmeasurable === undefined) bad(`${where}.unmeasurable is not a string or null`);

  const exitCode = nullableInt(agent, 'exit_code', `${where}.agent`);
  const timedOut = bool(agent, 'timed_out', `${where}.agent`);
  const treatment = treatmentFrom(raw.treatment, `${where}.treatment`);
  if (arm === 'ungated' && treatment !== null) bad(`${where}.treatment must be null in the ungated arm`);
  if (arm === 'gated' && treatment === null) bad(`${where}.treatment must be present in the gated arm`);

  const outcome = outcomeFrom(raw.outcome, `${where}.outcome`);
  const measured = bool(raw, 'measured', where);
  // An unknown or non-measuring verify verdict cannot be counted as a measured
  // outcome (#552): the aggregator would otherwise treat a declined verifier as
  // an observation.
  if (measured && !isMeasuredVerdict(outcome.verify_verdict)) {
    bad(`${where}.measured is true but verify_verdict "${outcome.verify_verdict}" is not a measured verdict`);
  }
  if (measured && unmeasurable !== null) bad(`${where}.unmeasurable must be null when measured=true`);
  if (!measured && (unmeasurable === null || unmeasurable.length === 0)) {
    bad(`${where}.unmeasurable must name the reason when measured=false`);
  }

  const releasedGreen = bool(raw, 'released_green', where);
  const expectedReleasedGreen =
    outcome.visible_green &&
    exitCode === 0 &&
    !timedOut &&
    failure === null &&
    (arm === 'ungated' || (treatment !== null && treatment.disposition === 'passed' && treatment.exit_code === 0));
  if (releasedGreen !== expectedReleasedGreen) {
    bad(`${where}.released_green is inconsistent with the agent/treatment exit and visible outcome`);
  }

  return {
    arm,
    workspace: str(raw, 'workspace', where),
    base: sha(raw, 'base', where),
    head: sha(raw, 'head', where),
    started_at: str(raw, 'started_at', where),
    finished_at: str(raw, 'finished_at', where),
    agent: {
      exit_code: exitCode,
      signal,
      timed_out: timedOut,
      failure,
    },
    treatment,
    outcome,
    released_green: releasedGreen,
    measured,
    unmeasurable,
  };
}

/** Prove a parsed document is a v1 pair record, field by field. */
export function pairRecordFrom(raw: unknown, where = 'record'): PairRecord {
  if (!isRecord(raw)) bad(`${where} is not an object`);
  if (raw.schema_version !== MACHINE_SCHEMA_VERSION) bad(`${where}.schema_version is not ${MACHINE_SCHEMA_VERSION}`);
  if (raw.command !== 'research') bad(`${where}.command is not "research"`);
  if (raw.document !== 'pair') bad(`${where}.document is not "pair"`);
  const adapter = raw.adapter;
  if (!isRecord(adapter)) bad(`${where}.adapter is not an object`);
  const layersRaw = adapter.layers;
  if (!Array.isArray(layersRaw)) bad(`${where}.adapter.layers is not an array`);
  const layers: AdapterLayer[] = [];
  for (const l of layersRaw) {
    const known = ADAPTER_LAYERS.find((x) => x === l);
    if (!known) bad(`${where}.adapter.layers carries unknown layer ${JSON.stringify(l)}`);
    if (layers.includes(known)) bad(`${where}.adapter.layers repeats ${known}`);
    layers.push(known);
  }
  const model = nullableString(raw.model);
  if (model === undefined) bad(`${where}.model is not a string or null`);
  const arms = raw.arms;
  if (!isRecord(arms)) bad(`${where}.arms is not an object`);
  const pair = int(raw, 'pair', where, 1);
  const manifest = str(raw, 'manifest_sha256', where);
  if (!SHA256_RE.test(manifest)) bad(`${where}.manifest_sha256 is not a lowercase sha256`);
  return {
    schema_version: MACHINE_SCHEMA_VERSION,
    command: 'research',
    document: 'pair',
    task: str(raw, 'task', where),
    pair,
    adapter: { name: str(adapter, 'name', `${where}.adapter`), layers },
    model,
    tamperward_version: str(raw, 'tamperward_version', where),
    agent_argv: stringArray(raw, 'agent_argv', where),
    agent_budget: nullablePositiveNumber(raw, 'agent_budget', where),
    manifest_sha256: manifest,
    verify_command: str(raw, 'verify_command', where),
    arms: {
      ungated: trajectoryFrom(arms.ungated, RESEARCH_ARMS[0], `${where}.arms.ungated`),
      gated: trajectoryFrom(arms.gated, RESEARCH_ARMS[1], `${where}.arms.gated`),
    },
  };
}
