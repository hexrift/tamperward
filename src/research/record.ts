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

/** How TamperWard's own verdict in the gated arm is classified for the readout.
 *  `refused`: the envelope exited with an enforcement finding; `passed`: the
 *  envelope let the tree through (the agent's own exit is passed on);
 *  `cannot`: the envelope could not adjudicate. */
export const TREATMENT_DISPOSITIONS = ['refused', 'passed', 'cannot'] as const;
export type TreatmentDisposition = (typeof TREATMENT_DISPOSITIONS)[number];

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
}

export interface PairRecord {
  schema_version: typeof MACHINE_SCHEMA_VERSION;
  command: 'research';
  document: 'pair';
  task: string;
  pair: number;
  adapter: { name: string; layers: AdapterLayer[] };
  model: string | null;
  manifest_sha256: string;
  verify_command: string;
  arms: Record<ResearchArm, TrajectoryRecord>;
}

function bad(where: string): never {
  throw new ResearchError(`malformed research record: ${where}`);
}

function str(r: Record<string, unknown>, k: string, where: string): string {
  const v = r[k];
  return typeof v === 'string' ? v : bad(`${where}.${k} is not a string`);
}
function bool(r: Record<string, unknown>, k: string, where: string): boolean {
  const v = r[k];
  return typeof v === 'boolean' ? v : bad(`${where}.${k} is not a boolean`);
}
function num(r: Record<string, unknown>, k: string, where: string): number {
  const v = finiteNumber(r[k]);
  return v === undefined ? bad(`${where}.${k} is not a number`) : v;
}
function nullableNum(r: Record<string, unknown>, k: string, where: string): number | null {
  const v = r[k];
  if (v === null) return null;
  const n = finiteNumber(v);
  return n === undefined ? bad(`${where}.${k} is not a number or null`) : n;
}

function outcomeFrom(raw: unknown, where: string): TrajectoryOutcome {
  if (!isRecord(raw)) bad(`${where} is not an object`);
  const rules = raw.rules;
  if (!Array.isArray(rules) || !rules.every((x) => typeof x === 'string')) bad(`${where}.rules is not a string array`);
  return {
    verify_verdict: str(raw, 'verify_verdict', where),
    visible_exit: nullableNum(raw, 'visible_exit', where),
    pristine_exit: nullableNum(raw, 'pristine_exit', where),
    visible_green: bool(raw, 'visible_green', where),
    pristine_green: bool(raw, 'pristine_green', where),
    masked_failure: bool(raw, 'masked_failure', where),
    surviving_protected_mutations: num(raw, 'surviving_protected_mutations', where),
    warn_findings: num(raw, 'warn_findings', where),
    rules: rules.filter((x): x is string => typeof x === 'string'),
    honest_completion: bool(raw, 'honest_completion', where),
  };
}

function treatmentFrom(raw: unknown, where: string): TreatmentRecord | null {
  if (raw === null) return null;
  if (!isRecord(raw)) bad(`${where} is not an object or null`);
  const disposition = str(raw, 'disposition', where);
  const known = TREATMENT_DISPOSITIONS.find((d) => d === disposition);
  if (!known) bad(`${where}.disposition "${disposition}" is not one of ${TREATMENT_DISPOSITIONS.join('|')}`);
  const envelope = raw.envelope;
  if (envelope !== null && !isRecord(envelope)) bad(`${where}.envelope is not an object or null`);
  return {
    verdict: str(raw, 'verdict', where),
    exit_code: num(raw, 'exit_code', where),
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
  return {
    arm,
    workspace: str(raw, 'workspace', where),
    base: str(raw, 'base', where),
    head: str(raw, 'head', where),
    started_at: str(raw, 'started_at', where),
    finished_at: str(raw, 'finished_at', where),
    agent: {
      exit_code: nullableNum(agent, 'exit_code', `${where}.agent`),
      signal,
      timed_out: bool(agent, 'timed_out', `${where}.agent`),
      failure,
    },
    treatment: treatmentFrom(raw.treatment, `${where}.treatment`),
    outcome: outcomeFrom(raw.outcome, `${where}.outcome`),
    released_green: bool(raw, 'released_green', where),
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
    layers.push(known);
  }
  const model = nullableString(raw.model);
  if (model === undefined) bad(`${where}.model is not a string or null`);
  const arms = raw.arms;
  if (!isRecord(arms)) bad(`${where}.arms is not an object`);
  const pair = num(raw, 'pair', where);
  if (!Number.isInteger(pair) || pair < 1) bad(`${where}.pair is not a positive integer`);
  const manifest = str(raw, 'manifest_sha256', where);
  if (!/^[0-9a-f]{64}$/.test(manifest)) bad(`${where}.manifest_sha256 is not a sha256`);
  return {
    schema_version: MACHINE_SCHEMA_VERSION,
    command: 'research',
    document: 'pair',
    task: str(raw, 'task', where),
    pair,
    adapter: { name: str(adapter, 'name', `${where}.adapter`), layers },
    model,
    manifest_sha256: manifest,
    verify_command: str(raw, 'verify_command', where),
    arms: {
      ungated: trajectoryFrom(arms.ungated, RESEARCH_ARMS[0], `${where}.arms.ungated`),
      gated: trajectoryFrom(arms.gated, RESEARCH_ARMS[1], `${where}.arms.gated`),
    },
  };
}
