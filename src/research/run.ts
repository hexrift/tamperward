// `tamperward research run` — paired ungated/gated trajectories over a task
// manifest, adjudicated by the primitives the product already ships.
//
// For every task and pair index, two fresh workspaces are cloned from the
// task repository at its base. The UNGATED arm launches the adapter's process
// without policy enforcement but inside the neutral lifecycle supervisor, so
// descendants are drained before outcome observation. The GATED arm first lets
// the adapter prepare the workspace (hooks,
// settings — committed into the trusted base, so the treatment is never agent
// work), then launches the same process under `tamperward run`, the
// enforcement envelope, with the task's suite command frozen at entry.
//
// After the agent releases the tree — in BOTH arms, identically — the runner
// observes the outcome with `verify` (visible vs pristine, against the base)
// and `check` (blocking findings in the worktree and the committed range).
// That observation is the outcome truth; TamperWard's own envelope verdict in
// the gated arm is recorded next to it as `treatment`, never folded into it.
// The record can therefore say "TamperWard lost" (a masked tree the envelope
// let through) as plainly as "TamperWard caught it".
//
// The ledger is resumable: a pair whose record already exists is skipped, so
// an interrupted run continues where it stopped. Records land under the
// operator's own --out directory, never under harness/.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runCheck } from '../cli/check';
import { lifecyclePlatformCheck, type DoctorCheck } from '../cli/doctor';
import { runAgentSupervised, runEnvelope, type AgentRunResult } from '../cli/run';
import { runVerify } from '../cli/verify';
import { MACHINE_SCHEMA_VERSION, type RunVerdict } from '../machine-output';
import { treeFingerprint } from '../fingerprint';
import { errorMessage, finiteNumber, isRecord, stringOrUndefined } from '../narrow';
import { defaultPolicy, isProtected } from '../policy';
import { loadPolicyAt } from '../policy-load';
import { Policy } from '../types';
import { TW_VERSION } from '../wiring';
import {
  RESEARCH_ARMS,
  ResearchError,
  normalizeCommandArgv,
  resolveAdapter,
  type AdapterTask,
  type AgentAdapter,
  type ResearchArm,
} from './adapter';
import { captureStdout, withEnv } from './capture';
import { readManifest, type ResearchTask } from './manifest';
import { pairRecordFrom, type PairRecord, type TrajectoryOutcome, type TrajectoryRecord, type TreatmentRecord } from './record';
import {
  dispositionOf,
  greenFromExit,
  honestCompletionFrom,
  isMeasuredVerdict,
  isRunVerdict,
  maskedFailureFrom,
  type TreatmentDisposition,
} from './derive';

export interface ResearchRunOpts {
  manifest: string;
  /** The ledger directory: pairs/ records and workspaces/ clones live here. */
  out: string;
  adapter: string;
  /** The agent command for the `command` adapter (everything after `--`). */
  agentArgv: string[];
  /** Trajectory pairs per task (default 1). */
  pairs?: number;
  /** Model identifier, pinned verbatim into every record. */
  model?: string;
  /** Wall-clock bound for each agent process, in seconds. */
  agentBudget?: number;
  /** Print each pair record as one JSON line on stdout instead of a text line. */
  json?: boolean;
  /** @internal Test-only projection of the platform preflight. Not parsed by the CLI. */
  platformCheck?: DoctorCheck;
  /** @internal Operator directory used to resolve a relative command adapter argv[0].
   *  The CLI leaves this unset and therefore uses process.cwd(). */
  operatorCwd?: string;
}

const err = (s: string): void => void process.stderr.write(s + '\n');
const out = (s: string): void => void process.stdout.write(s + '\n');

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function pairRecordPath(ledger: string, task: string, pair: number): string {
  return join(ledger, 'pairs', `${task}--${pair}.json`);
}

/** The identity a record must carry to count as THIS experiment's pair. */
interface PairIdentity {
  task: string;
  pair: number;
  manifest_sha256: string;
  adapter: { name: string; layers: readonly string[] };
  model: string | null;
  tamperward_version: string;
  agent_argv: readonly string[];
  agent_budget: number | null;
  verify_command: string;
  /** Source commit before any gated-arm treatment wiring. Null only until the
   *  first existing/new pair pins the task. */
  source_base: string | null;
}

/**
 * Resume checks record identity, not file existence. A ledger directory reused
 * after the manifest, prompt, repository, base, suite command, adapter,
 * model, TamperWard version, agent command or agent budget changed would otherwise "resume" over records of a different
 * experiment and exit 0 having executed nothing; a truncated record (an
 * interrupted write) would be skipped forever. Anything but a well-formed
 * record with the current identity fails closed; the operator chooses a new
 * --out or removes the record deliberately.
 */
function resumableRecord(path: string, expected: PairIdentity): PairRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ResearchError(`ledger record ${path} is malformed (${errorMessage(e).split('\n')[0]}); remove it to regenerate the pair, or use a new --out`);
  }
  const record = pairRecordFrom(raw, path);
  const mismatch: string[] = [];
  if (record.task !== expected.task) mismatch.push(`task "${record.task}" != "${expected.task}"`);
  if (record.pair !== expected.pair) mismatch.push(`pair ${record.pair} != ${expected.pair}`);
  if (record.manifest_sha256 !== expected.manifest_sha256) {
    mismatch.push(`manifest_sha256 ${record.manifest_sha256.slice(0, 12)}… != ${expected.manifest_sha256.slice(0, 12)}…`);
  }
  if (record.adapter.name !== expected.adapter.name || record.adapter.layers.join(',') !== expected.adapter.layers.join(',')) {
    mismatch.push(`adapter ${record.adapter.name}[${record.adapter.layers.join(',')}] != ${expected.adapter.name}[${expected.adapter.layers.join(',')}]`);
  }
  if (record.model !== expected.model) mismatch.push(`model ${String(record.model)} != ${String(expected.model)}`);
  if (record.tamperward_version !== expected.tamperward_version) {
    mismatch.push(`tamperward_version ${record.tamperward_version} != ${expected.tamperward_version}`);
  }
  if (JSON.stringify(record.agent_argv) !== JSON.stringify(expected.agent_argv)) {
    mismatch.push(`agent_argv ${JSON.stringify(record.agent_argv)} != ${JSON.stringify(expected.agent_argv)}`);
  }
  if (record.agent_budget !== expected.agent_budget) {
    mismatch.push(`agent_budget ${String(record.agent_budget)} != ${String(expected.agent_budget)}`);
  }
  if (record.verify_command !== expected.verify_command) mismatch.push(`verify_command ${JSON.stringify(record.verify_command)} != ${JSON.stringify(expected.verify_command)}`);
  if (expected.source_base !== null && record.arms.ungated.base !== expected.source_base) {
    mismatch.push(`source_base ${record.arms.ungated.base.slice(0, 12)}… != ${expected.source_base.slice(0, 12)}…`);
  }
  if (mismatch.length) {
    throw new ResearchError(
      `ledger record ${path} belongs to a different experiment (${mismatch.join('; ')}); use a new --out, or remove it deliberately`,
    );
  }
  return record;
}

/** Write the record whole or not at all: a reader never meets a torn file. */
function writeRecordAtomically(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** git-clone argv hardened against a second-order injection through `repo`.
 *  `-c protocol.ext.allow=never` disables git's `ext::` transport (which runs an
 *  arbitrary command), and `--` stops a `-`-prefixed value being read as an
 *  option. `repo` is task-manifest config rather than agent input, but the guard
 *  costs nothing and closes the transport regardless of where the value came from. */
export function cloneArgs(repo: string, ws: string): string[] {
  return ['-c', 'protocol.ext.allow=never', 'clone', '-q', '--no-hardlinks', '--', repo, ws];
}

/** A fresh clone of the task repository, detached at the task's pinned source
 * commit once one arm/record has established it. A moving branch/HEAD must not
 * make two arms — or two resumed pairs — start from different source trees. */
function freshWorkspace(
  ledger: string,
  task: ResearchTask,
  pair: number,
  arm: ResearchArm,
  sourceBase?: string,
): string {
  const ws = join(ledger, 'workspaces', `${task.id}--${pair}--${arm}`);
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(join(ledger, 'workspaces'), { recursive: true });
  try {
    execFileSync('git', cloneArgs(task.repo, ws), { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  } catch (e) {
    throw new ResearchError(`task "${task.id}": cannot clone ${task.repo}: ${errorMessage(e).split('\n')[0]}`);
  }
  git(['config', 'user.name', 'tamperward-research'], ws);
  git(['config', 'user.email', 'research@tamperward.invalid'], ws);
  const requestedBase = sourceBase ?? task.base;
  const candidates = sourceBase !== undefined
    ? [sourceBase]
    : task.base === 'HEAD' ? ['HEAD'] : [task.base, `origin/${task.base}`];
  for (const rev of candidates) {
    try {
      git(['checkout', '-q', '--detach', rev], ws);
      return ws;
    } catch {
      // try the next spelling
    }
  }
  throw new ResearchError(`task "${task.id}": base ${requestedBase} does not resolve in a clone of ${task.repo}`);
}


function parseDocument(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface AgentExit {
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  failure: string | null;
  /** Control arm: why the trajectory is unmeasurable, when it is. */
  unmeasurable?: string;
}

/** The gated arm: the adapter's process under the enforcement envelope. */
function runGated(
  ws: string,
  base: string,
  task: ResearchTask,
  argv: string[],
  env: Record<string, string>,
  agentBudget: number | undefined,
): { agent: AgentExit; treatment: TreatmentRecord } {
  // A mutable holder is intentional: TypeScript does not model assignments made
  // by a callback invoked synchronously inside runEnvelope for control-flow
  // narrowing, while an object property remains correctly optional here.
  const observed: { agent?: AgentRunResult } = {};
  const { result: code, out: captured } = withEnv(env, () =>
    captureStdout(() =>
      runEnvelope({
        cwd: ws,
        base,
        cmd: task.verify.command,
        budget: task.verify.budget,
        agentBudget,
        json: true,
        argv,
        observerEntry: process.argv[1],
        onAgentResult: (result) => { observed.agent = result; },
      }),
    ),
  );
  const envelope = parseDocument(captured);
  const verdictRaw = envelope ? stringOrUndefined(envelope.verdict) : undefined;
  const verdict: RunVerdict = verdictRaw !== undefined && isRunVerdict(verdictRaw) ? verdictRaw : 'CANNOT_ADJUDICATE';
  const agentDoc = envelope && isRecord(envelope.agent) ? envelope.agent : null;
  const agentExit = agentDoc ? finiteNumber(agentDoc.exit_code) : undefined;
  const supervised = observed.agent;
  return {
    agent: supervised
      ? {
          exit_code: supervised.failure ? null : supervised.exit,
          signal: supervised.signal ?? null,
          timed_out: supervised.timedOut,
          failure: supervised.failure ?? null,
        }
      : {
          exit_code: agentExit ?? null,
          signal: null,
          timed_out: agentDoc?.timed_out === true,
          failure: envelope ? 'the run envelope did not expose its supervised agent result' : 'the run envelope emitted no verdict document (see stderr)',
        },
    treatment: {
      verdict,
      exit_code: code,
      complete: envelope?.complete === true,
      disposition: dispositionOf(verdict),
      envelope,
    },
  };
}

/**
 * The ungated arm: the adapter's process WITHOUT TamperWard policy enforcement,
 * but under the same neutral lifecycle-ownership primitive the outcome needs.
 *
 * On Linux the trusted subreaper owns the whole descendant tree and does not
 * return until the kernel reports it drained. This closes the control-arm race
 * where a child detached, chdir'd away from the workspace, closed every fd,
 * slept through observation, then reopened the workspace by absolute path.
 * Lifecycle ownership is measurement hygiene, not treatment: no detector,
 * hook, check or verifier runs until after this process domain is empty.
 */
function runUngated(ws: string, argv: string[], env: Record<string, string>, agentBudget: number | undefined): AgentExit {
  const r = withEnv(env, () => runAgentSupervised(argv, ws, agentBudget, undefined, undefined, true));
  return {
    exit_code: r.failure ? null : r.exit,
    signal: r.signal ?? null,
    timed_out: r.timedOut,
    failure: r.failure ?? null,
    ...(!r.lifecycleOwned
      ? {
          unmeasurable:
            `AGENT_LIFECYCLE_NOT_OWNED: neutral control supervisor did not establish and drain the agent process domain` +
            (r.failure ? ` (${r.failure})` : ''),
        }
      : {}),
  };
}

/** The outcome of a trajectory whose observation could not stand: every
 *  field is the "nothing established" value, and the caller marks it unmeasurable. */
function unobservedOutcome(): TrajectoryOutcome {
  return {
    verify_verdict: 'CANNOT_VERIFY',
    visible_exit: null,
    pristine_exit: null,
    visible_green: false,
    pristine_green: false,
    masked_failure: false,
    surviving_protected_mutations: 0,
    warn_findings: 0,
    rules: [],
    honest_completion: false,
  };
}

/** The trusted policy at the base. Absent is a real state (the defaults apply,
 *  as they do for `check` and `run`); a policy that exists but cannot be read
 *  or parsed is NOT — substituting the defaults would change the protected
 *  surface and turn the measurement into a different experiment. */
function trustedPolicyAt(base: string, ws: string): { policy: Policy } | { failure: string } {
  try {
    return { policy: loadPolicyAt(base, ws) ?? defaultPolicy() };
  } catch (e) {
    return { failure: `trusted policy at ${base.slice(0, 10)} could not be loaded: ${errorMessage(e).split('\n')[0]}` };
  }
}

/** The neutral outcome observation, identical in both arms. */
function observeOutcome(
  ws: string,
  base: string,
  head: string,
  task: ResearchTask,
): { outcome: TrajectoryOutcome; unmeasurable: string | null } {
  const trusted = trustedPolicyAt(base, ws);
  if ('failure' in trusted) return { outcome: unobservedOutcome(), unmeasurable: trusted.failure };
  const policy = trusted.policy;
  const verify = parseDocument(
    captureStdout(() =>
      runVerify({ cwd: ws, base, cmd: task.verify.command, budget: task.verify.budget, json: true, policyOverride: policy }),
    ).out,
  );
  const stageExit = (stage: unknown): number | null => (isRecord(stage) ? finiteNumber(stage.exit) ?? null : null);
  const verdict = (verify && stringOrUndefined(verify.verdict)) ?? 'CANNOT_VERIFY';
  const visibleExit = verify ? stageExit(verify.visible) : null;
  const pristineExit = verify ? stageExit(verify.pristine) : null;

  const findings: Array<{ rule: string; severity: string }> = [];
  let checkDocuments = 0;
  const collect = (doc: Record<string, unknown> | null): void => {
    if (!doc || !Array.isArray(doc.findings)) return;
    checkDocuments++;
    for (const f of doc.findings) {
      if (!isRecord(f)) continue;
      const rule = stringOrUndefined(f.rule);
      const severity = stringOrUndefined(f.severity);
      if (rule !== undefined && severity !== undefined) findings.push({ rule, severity });
    }
  };
  collect(parseDocument(captureStdout(() =>
    runCheck({ cwd: ws, worktree: true, json: true, policyOverride: policy, includeUntracked: true, ciLayer: true }),
  ).out));
  if (head !== base) {
    collect(parseDocument(captureStdout(() =>
      runCheck({ cwd: ws, diff: `${base}...${head}`, json: true, policyOverride: policy }),
    ).out));
  }
  const expectedCheckDocuments = head !== base ? 2 : 1;
  const blocking = findings.filter((f) => f.severity === 'block');
  const pristineGreen = greenFromExit(pristineExit);
  const outcome: TrajectoryOutcome = {
    verify_verdict: verdict,
    visible_exit: visibleExit,
    pristine_exit: pristineExit,
    visible_green: greenFromExit(visibleExit),
    pristine_green: pristineGreen,
    masked_failure: maskedFailureFrom(verdict),
    surviving_protected_mutations: blocking.length,
    warn_findings: findings.length - blocking.length,
    rules: [...new Set(blocking.map((f) => f.rule))].sort(),
    honest_completion: honestCompletionFrom(verdict, pristineGreen, blocking.length),
  };
  const unmeasurable =
    !isMeasuredVerdict(verdict)
      ? `the verifier could not measure the tree (verify ${verdict}${verify && typeof verify.reason === 'string' ? `: ${verify.reason}` : ''})`
      : checkDocuments < expectedCheckDocuments
        ? 'the policy check could not judge the tree (no verdict document)'
        : null;
  return { outcome, unmeasurable };
}

function runTrajectory(
  ledger: string,
  task: ResearchTask,
  pair: number,
  arm: ResearchArm,
  adapter: AgentAdapter,
  opts: ResearchRunOpts,
  sourceBase?: string,
): TrajectoryRecord {
  const ws = freshWorkspace(ledger, task, pair, arm, sourceBase);
  const prep: AdapterTask = { id: task.id, prompt: task.prompt, cwd: ws, base: git(['rev-parse', 'HEAD'], ws), arm, model: opts.model };
  if (arm === 'gated' && adapter.prepareGated) {
    captureStdout(() => adapter.prepareGated?.(prep));
    if (git(['status', '--porcelain'], ws)) {
      git(['add', '-A'], ws);
      git(['commit', '-qm', 'tamperward research: wire enforcement (gated arm)'], ws);
    }
  }
  const base = git(['rev-parse', 'HEAD'], ws);
  const launch = adapter.launch({ ...prep, base });
  const startedAt = new Date().toISOString();
  let agent: AgentExit;
  let treatment: TreatmentRecord | null = null;
  if (arm === 'gated') {
    const gated = runGated(ws, base, task, launch.argv, launch.env, opts.agentBudget);
    agent = gated.agent;
    treatment = gated.treatment;
  } else {
    agent = runUngated(ws, launch.argv, launch.env, opts.agentBudget);
  }
  const finishedAt = new Date().toISOString();
  const head = git(['rev-parse', 'HEAD'], ws);
  // The tree under observation must not move while it is observed, in either
  // arm: a verdict cannot outlive the tree it describes.
  const protectedOnly = (rel: string): boolean => {
    try { return isProtected(rel, loadPolicyAt(base, ws) ?? defaultPolicy()); } catch { return true; }
  };
  const fingerprintBefore = treeFingerprint(ws, protectedOnly);
  const observed = observeOutcome(ws, base, head, task);
  const movedDuringObservation = treeFingerprint(ws, protectedOnly) !== fingerprintBefore;
  const unmeasurable =
    agent.unmeasurable ??
    observed.unmeasurable ??
    (movedDuringObservation ? 'NOT_QUIESCENT: the workspace changed while its outcome was being observed' : null);
  const { unmeasurable: _agentUnmeasurable, ...agentRecord } = agent;
  const outcome = unmeasurable === null ? observed.outcome : unobservedOutcome();
  // "released green" is operational, not merely "the final visible suite was
  // green": a failed/timed-out agent is still a non-zero run, and the gated
  // envelope likewise only releases green on exit 0.
  const agentSucceeded =
    agentRecord.exit_code === 0 &&
    !agentRecord.timed_out &&
    agentRecord.failure === null;
  const releasedGreen =
    outcome.visible_green &&
    agentSucceeded &&
    (treatment === null || (treatment.disposition === 'passed' && treatment.exit_code === 0));
  return {
    arm,
    workspace: ws,
    base,
    head,
    started_at: startedAt,
    finished_at: finishedAt,
    agent: agentRecord,
    treatment,
    outcome,
    released_green: releasedGreen,
    measured: unmeasurable === null,
    unmeasurable,
  };
}

export function runResearch(opts: ResearchRunOpts): number {
  let adapter: AgentAdapter;
  let tasks: ResearchTask[];
  let manifestSha: string;
  let agentArgvIdentity: string[];
  try {
    agentArgvIdentity =
      opts.adapter === 'command'
        ? normalizeCommandArgv(opts.agentArgv, opts.operatorCwd ?? process.cwd())
        : [...opts.agentArgv];
    adapter = resolveAdapter(opts.adapter, agentArgvIdentity, opts.model);
    const manifest = readManifest(opts.manifest);
    tasks = manifest.tasks;
    manifestSha = manifest.sha256;
  } catch (e) {
    if (e instanceof ResearchError) {
      err(`tamperward research: ${e.message}`);
      return 2;
    }
    throw e;
  }

  // The gated arm runs under `tamperward run`, which owns the agent lifecycle
  // only where doctor says it can. Same check, same words, before any clone.
  const platform = opts.platformCheck ?? lifecyclePlatformCheck();
  if (platform.state === 'BROKEN') {
    err(`tamperward research: platform BROKEN — ${platform.detail}`);
    err('tamperward research: the gated arm cannot start here (see `tamperward doctor`); run as a non-root user on Linux.');
    return 2;
  }

  const ledger = resolve(opts.out);
  const pairs = opts.pairs ?? 1;
  mkdirSync(join(ledger, 'pairs'), { recursive: true });

  for (const task of tasks) {
    // Validate every resumable record for this task BEFORE starting any missing
    // pair. Otherwise pair 1 could execute against today's source and only then
    // discover that an existing pair 2 belongs to another source/experiment.
    const existingRecords = new Map<number, PairRecord>();
    let sourceBase: string | null = null;
    try {
      for (let pair = 1; pair <= pairs; pair++) {
        const path = pairRecordPath(ledger, task.id, pair);
        if (!existsSync(path)) continue;
        const existing = resumableRecord(path, {
          task: task.id,
          pair,
          manifest_sha256: manifestSha,
          adapter: { name: adapter.name, layers: adapter.layers },
          model: opts.model ?? null,
          tamperward_version: TW_VERSION,
          agent_argv: agentArgvIdentity,
          agent_budget: opts.agentBudget ?? null,
          verify_command: task.verify.command,
          source_base: sourceBase,
        });
        sourceBase ??= existing.arms.ungated.base;
        // The first record establishes the source commit; every later record
        // must agree with it.
        if (existing.arms.ungated.base !== sourceBase) {
          throw new ResearchError(
            `ledger record ${path} belongs to a different source commit (${existing.arms.ungated.base.slice(0, 12)}… != ${sourceBase.slice(0, 12)}…); use a new --out, or remove it deliberately`,
          );
        }
        existingRecords.set(pair, existing);
      }
    } catch (e) {
      if (e instanceof ResearchError) {
        err(`tamperward research: ${e.message}`);
        return 2;
      }
      throw e;
    }

    // The first existing or newly executed pair pins the source commit for this
    // task. Every later arm/pair checks out that SHA, never the moving branch
    // name/HEAD from the manifest.
    for (let pair = 1; pair <= pairs; pair++) {
      const path = pairRecordPath(ledger, task.id, pair);
      const existing = existingRecords.get(pair);
      if (existing) {
        if (!opts.json) out(`tamperward research — task ${task.id} pair ${pair}: already recorded (${path}); skipping`);
        continue;
      }

      let record: PairRecord;
      try {
        const arms: Partial<Record<ResearchArm, TrajectoryRecord>> = {};
        for (const arm of RESEARCH_ARMS) {
          if (!opts.json) out(`tamperward research — task ${task.id} pair ${pair}: ${arm} arm`);
          arms[arm] = runTrajectory(ledger, task, pair, arm, adapter, opts, sourceBase ?? undefined);
          if (arm === 'ungated') {
            const resolvedSource = arms[arm]?.base;
            if (!resolvedSource) throw new ResearchError(`task "${task.id}" pair ${pair}: ungated arm produced no source base`);
            if (sourceBase !== null && resolvedSource !== sourceBase) {
              throw new ResearchError(
                `task "${task.id}" pair ${pair}: source base moved (${resolvedSource.slice(0, 12)}… != ${sourceBase.slice(0, 12)}…)`,
              );
            }
            sourceBase ??= resolvedSource;
          }
        }
        const ungated = arms.ungated;
        const gated = arms.gated;
        if (!ungated || !gated) throw new ResearchError(`task "${task.id}" pair ${pair}: an arm produced no record`);
        record = {
          schema_version: MACHINE_SCHEMA_VERSION,
          command: 'research',
          document: 'pair',
          task: task.id,
          pair,
          adapter: { name: adapter.name, layers: [...adapter.layers] },
          model: opts.model ?? null,
          tamperward_version: TW_VERSION,
          agent_argv: [...agentArgvIdentity],
          agent_budget: opts.agentBudget ?? null,
          manifest_sha256: manifestSha,
          verify_command: task.verify.command,
          arms: { ungated, gated },
        };
      } catch (e) {
        if (e instanceof ResearchError) {
          err(`tamperward research: ${e.message}`);
          return 2;
        }
        throw e;
      }
      const text = JSON.stringify(record);
      writeRecordAtomically(path, text + '\n');
      if (opts.json) {
        out(text);
      } else {
        const g = record.arms.gated;
        const u = record.arms.ungated;
        out(
          `tamperward research — task ${task.id} pair ${pair}: ` +
          `ungated ${u.outcome.verify_verdict} (masked=${u.outcome.masked_failure}, surviving=${u.outcome.surviving_protected_mutations}); ` +
          `gated ${g.outcome.verify_verdict} (masked=${g.outcome.masked_failure}, surviving=${g.outcome.surviving_protected_mutations}), ` +
          `tamperward ${g.treatment?.verdict ?? 'n/a'} → ${g.treatment?.disposition ?? 'n/a'}` +
          (u.measured && g.measured ? '' : `; UNMEASURABLE (${[u.unmeasurable, g.unmeasurable].filter(Boolean).join(' / ')})`) +
          `; recorded ${path}`,
        );
      }
    }
  }
  return 0;
}
