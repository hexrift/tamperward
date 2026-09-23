// `tamperward status` — one continuous answer to "is the exact candidate state
// I am looking at still the state that was independently verified?" (#600).
//
// Three DISTINCT lanes, never collapsed into one number:
//
//   Authority     repository/final-adjudication posture (reused from `doctor`);
//   Intervention  runtime steering capability (is the in-loop hook wired?);
//   Verification  whether the last successful verification still applies to the
//                 exact current state (the first-class state machine, #600).
//
// The `--json` form is the stable consumer contract for the #500 VS Code status
// bar, WardOS, CI job summaries and dashboards: they read the enumerated state
// and never reconstruct security posture by scraping `doctor` / `verify` prose.
// Local CURRENT is posture/evidence, NOT repository or CI merge authority.

import { machineOutput, type MachineSchemaVersion } from '../machine-output';
import { repoContext } from '../repo-context';
import { outsideRepository } from '../repo-context';
import { diagnose, type DoctorCheck, type DoctorState } from './doctor';
import {
  evaluateVerificationState,
  type VerificationEvaluation,
} from '../verification-state';
import { colourEnabled } from './render/text';
import { statusLine, type Severity } from './render/status';

export interface StatusOpts {
  cwd?: string;
  json?: boolean;
}

type AuthorityState = 'ACTIVE' | 'PARTIAL' | 'BROKEN' | 'UNKNOWN';
type InterventionState = 'ACTIVE' | 'PARTIAL' | 'INACTIVE' | 'UNKNOWN';

interface Lane<S extends string> {
  state: S;
  detail?: string;
}

interface StatusModel {
  authority: Lane<AuthorityState>;
  intervention: Lane<InterventionState>;
  verification: VerificationEvaluation;
  runtime: { agent: string };
}

/** Map a set of doctor checks to the Authority lane: any BROKEN dominates, then
 *  any WARN, otherwise ACTIVE. */
function authorityFromChecks(checks: DoctorCheck[]): AuthorityState {
  if (checks.some((c) => c.state === 'BROKEN')) return 'BROKEN';
  if (checks.some((c) => c.state === 'WARN')) return 'PARTIAL';
  return 'ACTIVE';
}

function interventionFromCheck(check: DoctorCheck | undefined): Lane<InterventionState> {
  if (!check) return { state: 'UNKNOWN', detail: 'agent hook wiring could not be evaluated' };
  const map: Record<DoctorState, InterventionState> = {
    OK: 'ACTIVE',
    WARN: 'PARTIAL',
    BROKEN: 'INACTIVE',
  };
  return { state: map[check.state], detail: check.detail };
}

/** Build the three lanes. Authority and Intervention reuse `doctor`'s posture so
 *  status never grows a second definition of "installed correctly"; a diagnose
 *  failure degrades both lanes to UNKNOWN rather than throwing. */
export function buildStatusModel(cwd: string): StatusModel {
  let authority: Lane<AuthorityState>;
  let intervention: Lane<InterventionState>;
  try {
    const outcome = diagnose({ cwd });
    authority = { state: authorityFromChecks(outcome.checks) };
    const summary = outcome.checks
      .filter((c) => c.state !== 'OK')
      .map((c) => `${c.id}: ${c.state}`);
    if (summary.length) authority.detail = summary.join('; ');
    intervention = interventionFromCheck(outcome.checks.find((c) => c.id === 'claude-hooks'));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    authority = { state: 'UNKNOWN', detail };
    intervention = { state: 'UNKNOWN', detail };
  }

  const verification = evaluateVerificationState(cwd);
  // The runtime agent is named from the EVALUATED hook wiring, not the mere
  // presence of `.claude/settings.json` (finding 4): a settings file with no
  // TamperWard PreToolUse hook steers nothing, so it reports `none`. The
  // Intervention lane already carries that `claude-hooks`/`planInit` evaluation.
  const agent =
    intervention.state === 'ACTIVE' || intervention.state === 'PARTIAL' ? 'claude-code' : 'none';
  return { authority, intervention, verification, runtime: { agent } };
}

const AUTHORITY_SEVERITY: Record<AuthorityState, Severity> = {
  ACTIVE: 'ok',
  PARTIAL: 'warn',
  BROKEN: 'bad',
  UNKNOWN: 'info',
};
const INTERVENTION_SEVERITY: Record<InterventionState, Severity> = {
  ACTIVE: 'ok',
  PARTIAL: 'warn',
  INACTIVE: 'bad',
  UNKNOWN: 'info',
};
const VERIFICATION_SEVERITY: Record<VerificationEvaluation['state'], Severity> = {
  CURRENT: 'ok',
  STALE: 'warn',
  VERIFYING: 'info',
  BROKEN: 'bad',
  UNVERIFIED: 'info',
};

function shortId(id: string | undefined): string | undefined {
  return id ? `${id.slice(0, 10)}...` : undefined;
}

/** The human three-lane report (#600). Each lane's WORD alone carries severity,
 *  so the output reads correctly with colour stripped. */
export function renderStatus(model: StatusModel, colour: boolean): string {
  const v = model.verification;
  const lines = ['TamperWard', ''];
  lines.push(statusLine(AUTHORITY_SEVERITY[model.authority.state], 'Authority', model.authority.state, colour));
  lines.push(statusLine(INTERVENTION_SEVERITY[model.intervention.state], 'Intervention', model.intervention.state, colour));
  lines.push(statusLine(VERIFICATION_SEVERITY[v.state], 'Verification', v.state, colour));

  const rows: Array<[string, string]> = [];
  const record = v.record;
  if (record) {
    const verifiedTree = shortId(record.binding.tree);
    if (verifiedTree) rows.push(['Verified tree', verifiedTree]);
    const baseShort = shortId(v.base ?? record.binding.base);
    if (baseShort) rows.push(['Base', `${record.inputs.base_ref}@${baseShort}`]);
    if (v.verifier_command) rows.push(['Verifier', v.verifier_command]);
  }
  rows.push(['Runtime', model.runtime.agent]);
  if (v.state === 'STALE' && v.reason) rows.push(['Reason', v.reason]);
  else if (v.state === 'BROKEN') rows.push(['Reason', v.detail ?? v.reason ?? 'authority wiring is invalid']);
  else if (v.state === 'VERIFYING') rows.push(['Reason', v.reason ?? 'a verification is in progress']);
  else if (v.state === 'UNVERIFIED') rows.push(['Next', 'run `tamperward verify` to establish a verified baseline']);

  if (rows.length) {
    lines.push('');
    const width = Math.max(...rows.map(([k]) => k.length));
    for (const [k, val] of rows) lines.push(`${k.padEnd(width)}  ${val}`);
  }
  return lines.join('\n') + '\n';
}

export interface StatusDocument {
  schema_version: MachineSchemaVersion;
  command: 'status';
  authority: { state: AuthorityState; detail?: string };
  intervention: { state: InterventionState; detail?: string };
  verification: {
    state: VerificationEvaluation['state'];
    reason?: string;
    changed_input?: string;
    detail?: string;
    verified_at?: string;
    base?: string;
    head?: string;
    verifier_command?: string;
    tree?: string;
    binding?: Record<string, string>;
  };
  runtime: { agent: string };
}

export function statusDocument(model: StatusModel): StatusDocument {
  const v = model.verification;
  const verification: StatusDocument['verification'] = { state: v.state };
  if (v.reason) verification.reason = v.reason;
  if (v.changed_input) verification.changed_input = v.changed_input;
  if (v.detail) verification.detail = v.detail;
  if (v.verified_at) verification.verified_at = v.verified_at;
  if (v.base) verification.base = v.base;
  if (v.head) verification.head = v.head;
  if (v.verifier_command) verification.verifier_command = v.verifier_command;
  if (v.record) {
    verification.tree = v.record.binding.tree;
    verification.binding = { ...v.record.binding };
  }
  return machineOutput({
    command: 'status' as const,
    authority: model.authority,
    intervention: model.intervention,
    verification,
    runtime: model.runtime,
  });
}

export function runStatus(opts: StatusOpts = {}): number {
  const cwd = opts.cwd ?? process.cwd();
  if (!repoContext(cwd)) {
    const why = outsideRepository(cwd) ?? 'cwd is not inside a repository the gate can read';
    process.stderr.write(`tamperward: status needs a git repository (${why})\n`);
    return 2;
  }
  const model = buildStatusModel(cwd);
  if (opts.json) {
    process.stdout.write(JSON.stringify(statusDocument(model)) + '\n');
  } else {
    process.stdout.write(renderStatus(model, colourEnabled(process.env, process.stdout)));
  }
  return 0;
}
