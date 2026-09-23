// `tamperward runtime verify` / `tamperward runtime status` (#599).
//
// An HONEST, version-bound, operation-specific runtime capability report. It reports what is
// PROVEN / UNPROVEN / UNSUPPORTED / FAIL-OPEN on THIS runtime/version/config today. `PROVEN` is
// gated on RETAINED real-runtime probe evidence (src/adapters/evidence.ts) matching the full
// binding; the shipped adapter's declared capabilities (src/adapters/contract.ts, #482) can only
// grade PARTIAL/UNPROVEN on their own — never a fabricated PROVEN, never a promotion, never a
// Round 4.1 verdict.
//
//  - `verify` computes the qualification, binds it to the interpretability inputs (runtime
//    version, TamperWard version/commit, adapter capability hash, hook config hash, execution
//    mode, platform, model, tested capability set, timestamp, evidence id), and PERSISTS it to
//    the git-local store so `status` can render it later without rerunning.
//  - `status` renders the latest stored qualification WITHOUT rerunning it, and marks it STALE
//    when any load-bearing input has changed since it was recorded.
//
// This surface consults EXISTING retained evidence. It does not run a live credentialed probe
// here (those are gated, #611/#616, and live in `npm run probe:*` / `spike:*`); it grades against
// the committed, sanitized probe captures those runs retained. A mock or adapter declaration can
// never move a live capability to PROVEN — only a retained real-runtime observation matching the
// binding can, and where none exists the capability is honestly PARTIAL/UNPROVEN.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { gitDir, headSha } from '../git/build';
import { repoContext } from '../repo-context';
import { TW_VERSION } from '../wiring';
import { machineOutput, type MachineSchemaVersion } from '../machine-output';
import { colourEnabled } from './render/text';
import { paint, severityColour, BOLD, DIM, type Severity } from './render/status';
import { adapterFor, canonicalRuntimeId, labelFor } from '../adapters/registry';
import { detectRuntimes } from '../runtimes';
import { RuntimeAdapter } from '../adapters/contract';
import { matchRetainedEvidence, type EvidenceMatchKey } from '../adapters/evidence';
import {
  assessCapabilities,
  aggregateInLoop,
  capabilityHash,
  evidenceId,
  sha16 as sha16Local,
  qualificationStaleness,
  FINAL_AUTHORITY,
  RUNTIME_CAPABILITY_IDS,
  type CapabilityAssessment,
  type CapabilityState,
  type ExecutionMode,
  type InLoopAggregate,
  type QualificationBinding,
} from '../runtime-qualification';

export interface RuntimeOpts {
  cwd?: string;
  runtime?: string;
  mode?: ExecutionMode;
  model?: string;
  json?: boolean;
}

/** The machine-readable qualification document (`schemas/runtime-qualification-v1.schema.json`). */
export interface RuntimeQualificationReport {
  schema_version: MachineSchemaVersion;
  command: 'runtime';
  subcommand: 'verify' | 'status';
  /** status only: whether a stored qualification was found. Always true for verify. */
  recorded: boolean;
  /** Whether a load-bearing input changed since the qualification was recorded. */
  stale: boolean;
  /** "field: old → new" for every changed load-bearing input (empty unless stale). */
  changed_inputs: string[];
  runtime: { id: string; label: string; version: string | null };
  tamperward: { version: string; commit: string | null };
  adapter: { name: string; capability_hash: string };
  hook_config_hash: string | null;
  execution_mode: ExecutionMode;
  platform: string;
  model: string | null;
  tested_capabilities: string[];
  timestamp: string;
  evidence_id: string;
  capabilities: CapabilityAssessment[];
  in_loop_protection: InLoopAggregate;
  final_authority: typeof FINAL_AUTHORITY;
  note: string;
}

const HONESTY_NOTE =
  'PROVEN is reserved for a capability a retained real-runtime probe observed holding under THIS exact runtime/version/config binding; a declaration alone grades PARTIAL (declared at the contract boundary, unproven live) and an absent capability UNPROVEN/UNSUPPORTED. No live in-process probe runs here — grading is against committed, sanitized real-runtime evidence, and absent a matching record nothing is PROVEN. This reports existing facts only — no promotion, no Round 4.1 eligibility claim.';

/** The git-local qualification store (never committed; sits beside the audit ledger). */
function storePath(cwd: string): string | null {
  const dir = gitDir(cwd);
  return dir ? join(dir, 'tamperward', 'runtime-qualification.json') : null;
}

interface QualificationStore {
  schema_version: MachineSchemaVersion;
  updated_at: string;
  records: Record<string, RuntimeQualificationReport>;
}

function readStore(cwd: string): QualificationStore | null {
  const path = storePath(cwd);
  if (!path || !existsSync(path)) return null;
  try {
    // Deserialization boundary: assert the on-disk shape then validate it before use; a store
    // that fails the guard is treated as absent (re-verify), never trusted.
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as QualificationStore;
    if (parsed && typeof parsed === 'object' && parsed.records && typeof parsed.records === 'object') return parsed;
  } catch {
    return null;
  }
  return null;
}

function writeRecord(cwd: string, id: string, report: RuntimeQualificationReport): boolean {
  const path = storePath(cwd);
  if (!path) return false;
  const existing = readStore(cwd);
  const store: QualificationStore = existing ?? { schema_version: report.schema_version, updated_at: '', records: {} };
  store.records[id] = report;
  store.updated_at = report.timestamp;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Best-effort exact runtime version. An env override keeps CI/tests deterministic; otherwise a
 *  short, guarded `<bin> --version` is tried, and any failure yields null (an unbound version,
 *  recorded honestly). */
function resolveRuntimeVersion(canonicalId: string): string | null {
  const override = process.env.TAMPERWARD_RUNTIME_VERSION;
  if (override && override.trim()) return override.trim();
  const bins: Record<string, string> = {
    'claude-code': 'claude',
    codex: 'codex',
    'github-copilot-cli': 'copilot',
  };
  const bin = bins[canonicalId];
  if (!bin) return null;
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
    return m ? m[0] : out.trim() || null;
  } catch {
    return null;
  }
}

/** Best-effort hash of the runtime's hook configuration, so a config change invalidates the
 *  qualification. Claude Code's is the `hooks` block of `.claude/settings.json`; null when none. */
function resolveHookConfigHash(canonicalId: string, cwd: string): string | null {
  const files: Record<string, string> = {
    'claude-code': join(cwd, '.claude', 'settings.json'),
    'github-copilot-cli': join(cwd, '.github', 'copilot', 'hooks.json'),
  };
  const file = files[canonicalId];
  if (!file || !existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8');
    let hooks: unknown = raw;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      hooks = parsed && typeof parsed === 'object' && 'hooks' in parsed ? parsed.hooks : parsed;
    } catch {
      /* hash the raw bytes of a malformed file — still a change signal */
    }
    return sha16Local(JSON.stringify(hooks ?? null));
  } catch {
    return null;
  }
}

/** Assemble the binding + assessments for a runtime under the current inputs. */
function buildQualification(
  adapter: RuntimeAdapter,
  opts: RuntimeOpts,
  cwd: string,
): { binding: QualificationBinding; assessments: CapabilityAssessment[] } {
  const canonical = adapter.name;
  const capHash = capabilityHash(adapter.capabilities);
  const mode: ExecutionMode = opts.mode ?? 'headless';
  const version = resolveRuntimeVersion(canonical);
  const platform = `${process.platform}-${process.arch}`;
  const model = opts.model ?? null;
  const hookConfigHash = resolveHookConfigHash(canonical, cwd);
  // Grade against RETAINED real-runtime probe evidence, and ONLY when it matches this exact
  // binding (runtime/version/model/platform/mode/config). No match → no evidence → nothing is
  // promoted to PROVEN; the static declaration grades PARTIAL/UNPROVEN. This is what gates
  // PROVEN on real evidence rather than a contract/adapter declaration (#599).
  const matchKey: EvidenceMatchKey = {
    runtime_id: canonical,
    runtime_version: version,
    model,
    platform,
    execution_mode: mode,
    hook_config_hash: hookConfigHash,
  };
  const evidence = matchRetainedEvidence(matchKey);
  const assessments = assessCapabilities(adapter.capabilities, evidence);
  const testedRaw = assessments.map((a) => a.id);
  const base: Omit<QualificationBinding, 'timestamp' | 'evidence_id'> = {
    runtime: { id: canonical, label: labelFor(canonical), version },
    tamperward: { version: TW_VERSION, commit: headSha(cwd) },
    adapter: { name: canonical, capability_hash: capHash },
    hook_config_hash: hookConfigHash,
    execution_mode: mode,
    platform,
    model,
    tested_capabilities: testedRaw,
  };
  const eid = evidenceId(base, assessments);
  const binding: QualificationBinding = { ...base, timestamp: new Date().toISOString(), evidence_id: eid };
  return { binding, assessments };
}

function reportFrom(
  subcommand: 'verify' | 'status',
  binding: QualificationBinding,
  assessments: CapabilityAssessment[],
): RuntimeQualificationReport {
  return machineOutput({
    command: 'runtime' as const,
    subcommand,
    recorded: true,
    stale: false,
    changed_inputs: [],
    runtime: binding.runtime,
    tamperward: binding.tamperward,
    adapter: binding.adapter,
    hook_config_hash: binding.hook_config_hash,
    execution_mode: binding.execution_mode,
    platform: binding.platform,
    model: binding.model,
    tested_capabilities: binding.tested_capabilities,
    timestamp: binding.timestamp,
    evidence_id: binding.evidence_id,
    capabilities: assessments,
    in_loop_protection: aggregateInLoop(assessments),
    final_authority: FINAL_AUTHORITY,
    note: HONESTY_NOTE,
  });
}

/** Resolve the target adapter from --runtime or auto-detection, defaulting to Claude Code
 *  (the shipped in-loop adapter) when nothing adapter-backed is detected. */
function resolveTarget(opts: RuntimeOpts, cwd: string): RuntimeAdapter | { error: string } {
  if (opts.runtime) {
    const a = adapterFor(opts.runtime);
    return a ?? { error: `no shipped runtime adapter for "${opts.runtime}"` };
  }
  for (const rt of detectRuntimes(cwd)) {
    const a = adapterFor(rt.id);
    if (a) return a;
  }
  return adapterFor('claude-code')!;
}

const STATE_SEVERITY: Record<CapabilityState, Severity> = {
  PROVEN: 'ok',
  PARTIAL: 'warn',
  UNPROVEN: 'warn',
  UNSUPPORTED: 'info',
  'FAIL-OPEN': 'bad',
  INCONCLUSIVE: 'bad',
};

const AGGREGATE_SEVERITY: Record<InLoopAggregate, Severity> = { FULL: 'ok', PARTIAL: 'warn', NONE: 'bad' };

function renderText(report: RuntimeQualificationReport, cwd: string): void {
  const colour = colourEnabled(process.env, process.stdout);
  const w = (s: string) => process.stdout.write(s + '\n');
  const dim = (s: string) => paint(s, DIM, colour);

  w(`${paint(report.runtime.label, BOLD, colour)} — runtime protection qualification`);
  w(dim(`  runtime ${report.runtime.version ?? '(version unresolved)'} · tamperward ${report.tamperward.version} · adapter ${report.adapter.capability_hash} · ${report.execution_mode} · ${report.platform}`));
  w(dim(`  evidence ${report.evidence_id} · ${report.timestamp}`));

  if (!report.recorded) {
    w('');
    w(`${paint('[UNQUALIFIED]', severityColour('bad') + BOLD, colour)} no qualification recorded for this runtime.`);
    w(`Run: ${paint('tamperward runtime verify', BOLD, colour)}`);
    return;
  }
  if (report.stale) {
    w('');
    w(`${paint('[STALE]', severityColour('bad') + BOLD, colour)} a load-bearing input changed — this qualification no longer applies:`);
    for (const c of report.changed_inputs) w(`  · ${c}`);
    w(`Run: ${paint('tamperward runtime verify', BOLD, colour)}`);
  }

  w('');
  const width = Math.max(...report.capabilities.map((c) => c.id.length));
  for (const cap of report.capabilities) {
    const sev = STATE_SEVERITY[cap.state];
    const tag = paint(cap.state.padEnd(12), (sev === 'bad' ? BOLD : '') + severityColour(sev), colour);
    w(`  ${cap.id.padEnd(width)}  ${tag}`);
  }

  w('');
  const agg = report.in_loop_protection;
  const aggTag = paint(agg, (AGGREGATE_SEVERITY[agg] === 'bad' ? BOLD : '') + severityColour(AGGREGATE_SEVERITY[agg]), colour);
  w(`  ${'In-loop protection'.padEnd(width)}  ${aggTag}`);
  w(`  ${'Final authority'.padEnd(width)}  ${paint(report.final_authority, severityColour('ok'), colour)}`);
  w('');
  w(dim('  Final authority (CI / pristine verification) is independent of the runtime hook: a weak in-loop'));
  w(dim('  capability never weakens adjudication. Steering and authority remain separate.'));
  w('');
  w(dim('  ' + report.note.replace(/—/g, '-')));

  // The full evidence per capability, so a negative/fail-open result is never hidden.
  w('');
  w(dim('  Evidence:'));
  for (const cap of report.capabilities) {
    w(dim(`    ${cap.id} [${cap.state}] (${cap.evidence.source}): ${cap.evidence.detail}`));
  }
}

function emit(report: RuntimeQualificationReport, opts: RuntimeOpts, cwd: string): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(report) + '\n');
    return;
  }
  renderText(report, cwd);
}

export function runRuntime(sub: string | undefined, opts: RuntimeOpts): number {
  const cwd = opts.cwd ?? process.cwd();

  if (sub === 'verify') {
    const target = resolveTarget(opts, cwd);
    if ('error' in target) {
      process.stderr.write(`tamperward: ${target.error}\n`);
      return 2;
    }
    const { binding, assessments } = buildQualification(target, opts, cwd);
    const report = reportFrom('verify', binding, assessments);
    writeRecord(cwd, target.name, report);
    emit(report, opts, cwd);
    return 0;
  }

  if (sub === 'status') {
    const target = resolveTarget(opts, cwd);
    if ('error' in target) {
      process.stderr.write(`tamperward: ${target.error}\n`);
      return 2;
    }
    const store = readStore(cwd);
    const stored = store?.records[target.name];
    if (!stored) {
      // No stored qualification: report honestly, do not synthesize one.
      const { binding, assessments } = buildQualification(target, opts, cwd);
      const empty: RuntimeQualificationReport = {
        ...reportFrom('status', binding, assessments),
        recorded: false,
        capabilities: [],
        in_loop_protection: 'NONE',
        note: `No qualification recorded for ${binding.runtime.label}. Run: tamperward runtime verify`,
      };
      emit(empty, opts, cwd);
      return 0;
    }
    // Render the STORED qualification (no rerun), but recompute staleness against current inputs.
    const { binding: current } = buildQualification(target, opts, cwd);
    const storedBinding: QualificationBinding = {
      runtime: stored.runtime,
      tamperward: stored.tamperward,
      adapter: stored.adapter,
      hook_config_hash: stored.hook_config_hash,
      execution_mode: stored.execution_mode,
      platform: stored.platform,
      model: stored.model,
      tested_capabilities: stored.tested_capabilities,
      timestamp: stored.timestamp,
      evidence_id: stored.evidence_id,
    };
    const staleness = qualificationStaleness(storedBinding, current);
    const report: RuntimeQualificationReport = {
      ...stored,
      subcommand: 'status',
      stale: staleness.stale,
      changed_inputs: staleness.changed,
    };
    emit(report, opts, cwd);
    return 0;
  }

  process.stderr.write(`tamperward: runtime requires one of verify | status (got "${sub ?? ''}")\n`);
  return 2;
}

/** Parse `runtime` subcommand + options. */
export function parseRuntime(args: string[]): { sub: string | undefined; opts: RuntimeOpts } {
  const [sub, ...rest] = args;
  const opts: RuntimeOpts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--cwd') opts.cwd = rest[++i];
    else if (a === '--runtime') opts.runtime = rest[++i];
    else if (a === '--model') opts.model = rest[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--mode') {
      const v = rest[++i];
      if (v === 'headless' || v === 'interactive') opts.mode = v;
    }
  }
  return { sub, opts };
}

export const RUNTIME_SUBCOMMANDS = ['verify', 'status'] as const;
export { RUNTIME_CAPABILITY_IDS };
