// `tamperward hook claude` (PreToolUse) and `tamperward sweep claude` (Stop).
//
// Output contract (verified against current Claude Code docs):
//   PreToolUse deny → {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//     "permissionDecision":"deny","permissionDecisionReason":<reason>}}  at EXIT 0
//   Stop block     → {"decision":"block","reason":<reason>}              at EXIT 0
// CRITICAL: exit 2 makes Claude Code IGNORE the JSON and fall back to the raw-stderr
// channel (which arrives wrapped as a "hook error" and leaks the invoking command line).
// So a block MUST be exit 0 + JSON, never exit 2. The reason carries only the correction
// message — no command line, no env. Deny holds even under bypassPermissions.

import { readFileSync, appendFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { changesFromClaudeHook, ClaudeHookInput } from '../adapters/claude/changes';
import { formatDenial } from '../adapters/claude/deny';
import { evaluate } from '../engine';
import { loadPolicy } from '../policy-load';
import { diffSince, diffWorktree, isGitRepo } from '../git/build';
import { advanceTurnBaseline, turnBaseline } from '../session';
import { driftBetween, loadPtree, ptreePath, savePtree, snapshotProtected } from '../effect';
import { defaultEventLog } from './watch';
import { readEvents, transientFindings } from '../detectors/fs-events';
import { isProtected } from '../policy';
import { Finding, Policy } from '../types';

export interface HookResult {
  exitCode: number;
  stdout: string;
}

/** The hook could not be given its input, or the input was not a hook payload.
 *  Thrown, never absorbed: the callers below route it to failClosed(). */
export class HookInputError extends Error {}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch (e) {
    throw new HookInputError(`cannot read the hook payload on stdin: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * FAIL CLOSED on a payload we cannot understand.
 *
 * Both of these used to swallow the failure and return `{}` — the empty input —
 * which flows straight through preToolUseVerdict to `verdict([], ...)`: exit 0,
 * empty stdout, ALLOW. So truncated stdin, a JSON array, a partial write from a
 * runtime under memory pressure, or any payload shape the parser choked on was
 * indistinguishable from "this tool call is fine", for every tool call while the
 * condition lasted. That is the same hole failClosed() was written to close one
 * layer up, left open at the front door.
 *
 * Genuinely empty stdin stays an allow. It is a well-formed ABSENCE of a tool
 * call — there is nothing to deny, and denying it would break `tamperward hook
 * claude < /dev/null`, which is how the wiring is smoke-tested.
 */
function parseInput(raw: string): ClaudeHookInput {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new HookInputError(`the hook payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HookInputError(`the hook payload is not a JSON object (got ${Array.isArray(parsed) ? 'an array' : typeof parsed})`);
  }
  return parsed as ClaudeHookInput;
}

function recordDenylog(blocks: Finding[]): void {
  const log = process.env.TAMPERWARD_DENYLOG;
  if (!log) return;
  try {
    appendFileSync(log, blocks.map((b) => b.rule).join(',') + '\n');
  } catch {
    /* best effort */
  }
}

/** The error text only — never the stack, never the tool input. A hook error must not
 *  echo back the command line or the environment it was inspecting. */
function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 200 ? m.slice(0, 200) + '…' : m;
}

/**
 * FAIL CLOSED. If Tamperward cannot evaluate a change, the change is DENIED.
 *
 * The engine isolates each detector, but everything around it — loading the policy
 * (a malformed or merge-conflicted .tamperward.yml throws on parse), the adapter's own
 * file work — ran unguarded. An exception there exited non-(0|2), which Claude Code
 * treats as a NON-BLOCKING hook error: the tool call proceeds. A crashed gate became an
 * absent gate, silently, for every tool call while the condition lasted. SPEC §5.1's
 * whole guarantee is that a deny holds even under bypassPermissions; it cannot rest on
 * nothing having thrown.
 */
function failClosed(kind: 'PreToolUse' | 'Stop', detail: string): HookResult {
  const f: Finding = {
    rule: 'tamperward-unavailable',
    severity: 'block',
    message: `Tamperward could not evaluate this change (${detail}), so it is denied rather than allowed.`,
    evidence: detail,
    remediation:
      'Repair the Tamperward setup — most often an unparseable .tamperward.yml (check for merge-conflict markers) — then retry. Do not work around the gate while it is down.',
    signoff: { required: true, command: 'tamperward allow --reason "..."' },
  };
  return verdict([f], kind);
}

/** Deny via JSON on stdout at exit 0. Empty stdout + exit 0 = allow. */
function verdict(blocks: Finding[], kind: 'PreToolUse' | 'Stop'): HookResult {
  if (blocks.length === 0) return { exitCode: 0, stdout: '' };
  recordDenylog(blocks);
  const reason = formatDenial(blocks);
  const payload =
    kind === 'PreToolUse'
      ? {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }
      : { decision: 'block', reason };
  return { exitCode: 0, stdout: JSON.stringify(payload) + '\n' };
}

/** PreToolUse: deny the shortcut before the tool runs. Pure — testable without stdin.
 *  AGENT-LAYER TRUST RULE: never consults the sign-off ledger. The agent can write the ledger
 *  (observed self-invoking `tamperward allow` 3×), so honoring it here would let the agent clear
 *  its own block in-loop. A block is a block; sign-off is a human decision made at the
 *  local/CI layers (src/signoff.ts), never here. */
/**
 * Per-call EFFECT check (taskbench Phase 3, run 07-fastify gated): whatever a
 * spelling matcher or a hook flake misses, the protected tree remembers. If it
 * drifted since the last sanctioned state, run the ordinary detector stack over
 * the drift (diff vs the turn baseline, scoped to the drifted paths) NOW —
 * findings then carry the existing rules' corpus-priced severities. Benign
 * drift (a git restore, a first-run snapshot) evaluates clean and is absorbed.
 * Returns blocking findings, or null when the current call may proceed.
 */
function effectDriftBlocks(cwd: string, sessionId: string | undefined, policy: Policy): Finding[] | null {
  if (!sessionId || !isGitRepo(cwd)) return null;
  const expected = loadPtree(cwd, sessionId);
  const current = snapshotProtected(cwd, policy, expected ?? undefined);
  if (!expected) {
    savePtree(cwd, sessionId, current);
    return null;
  }
  const d = driftBetween(expected, current);
  if (d.changed.length === 0 && d.deleted.length === 0) {
    savePtree(cwd, sessionId, current); // absorb additions + refresh mtimes
    return null;
  }
  const base = turnBaseline(cwd, sessionId);
  const all = base ? diffSince(base, { cwd }) : diffWorktree({ cwd });
  const drifted = new Set([...d.changed, ...d.deleted]);
  const scoped = all.filter(
    (c) => c.kind === 'file' && (drifted.has(c.path) || (c.oldPath != null && drifted.has(c.oldPath))),
  );
  const blocks = evaluate(scoped, policy, undefined, 'turn').filter((f) => f.severity === 'block');
  if (blocks.length > 0) return blocks; // do NOT absorb: the deny repeats until restored
  savePtree(cwd, sessionId, current);
  return null;
}

/** After ALLOWING an Edit/Write on a protected file, record the content the tool is
 *  about to write as the new sanctioned state, so the next call's drift check does
 *  not re-litigate an edit this hook already passed. */
function sanctionPredictedWrites(cwd: string, sessionId: string | undefined, policy: Policy, changes: ReturnType<typeof changesFromClaudeHook>): void {
  if (!sessionId) return;
  const tree = loadPtree(cwd, sessionId);
  if (!tree) return;
  let dirty = false;
  for (const c of changes) {
    if (c.kind !== 'file' || c.after == null || !isProtected(c.path, policy)) continue;
    const hash = createHash('sha256').update(c.after).digest('hex').slice(0, 16);
    const prev = tree[c.path];
    tree[c.path] = {
      hash,
      mode: prev?.mode ?? 0o100644,
      size: Buffer.byteLength(c.after),
      mtimeMs: -1, // unknown until written; forces a re-hash next snapshot, which is correct
    };
    dirty = true;
  }
  if (dirty) savePtree(cwd, sessionId, tree);
}

export function preToolUseVerdict(input: ClaudeHookInput): HookResult {
  try {
    const cwd = input.cwd ?? process.cwd();
    // First tool call of the session pins the commit the Stop sweep will compare against.
    turnBaseline(cwd, input.session_id);
    const policy = loadPolicy(cwd);
    const driftBlocks = effectDriftBlocks(cwd, input.session_id, policy);
    if (driftBlocks) return verdict(driftBlocks, 'PreToolUse');
    const changes = changesFromClaudeHook(input, cwd);
    const blocks = evaluate(changes, policy, undefined, 'tool-call').filter((f) => f.severity === 'block');
    if (blocks.length === 0) sanctionPredictedWrites(cwd, input.session_id, policy, changes);
    return verdict(blocks, 'PreToolUse');
  } catch (e) {
    return failClosed('PreToolUse', errText(e));
  }
}

/** Stop: re-scan the turn's net working tree for shell-mediated mutations the PreToolUse
 *  matcher can't see. Respects stop_hook_active to avoid an infinite loop. */
function cursorPath(cwd: string, sessionId?: string): string | null {
  const p = ptreePath(cwd, sessionId);
  return p ? p.replace(/ptree-/, 'fscursor-') : null;
}

/** Watcher events for the turn: judged only when the daemon is running (log exists).
 *  The cursor advances with the turn, mirroring the baseline's semantics. */
function turnTransientBlocks(cwd: string, sessionId: string | undefined, policy: Policy, changes: ReturnType<typeof diffWorktree>): { blocks: Finding[]; commit: () => void } {
  const none = { blocks: [] as Finding[], commit: () => {} };
  const log = defaultEventLog(cwd);
  const cp = cursorPath(cwd, sessionId);
  if (!existsSync(log)) return none;
  let offset = 0;
  if (cp && existsSync(cp)) {
    const n = Number(readFileSync(cp, 'utf8'));
    offset = Number.isFinite(n) ? n : 0;
  }
  const { events, newOffset } = readEvents(log, offset);
  if (events.length === 0) return { ...none, commit: () => { if (cp) try { writeFileSync(cp, String(newOffset)); } catch { /* best effort */ } } };
  const persistent = new Set(changes.filter((c) => c.kind === 'file').map((c) => c.path));
  const finalHash = (path: string): string | null => {
    try {
      if (!statSync(`${cwd}/${path}`).isFile()) return null;
      return createHash('sha256').update(readFileSync(`${cwd}/${path}`)).digest('hex').slice(0, 16);
    } catch {
      return null;
    }
  };
  const findings = transientFindings(events, persistent, policy, finalHash);
  recordWarns(findings.filter((f) => f.severity !== 'block'));
  return {
    blocks: findings.filter((f) => f.severity === 'block'),
    commit: () => { if (cp) try { writeFileSync(cp, String(newOffset)); } catch { /* best effort */ } },
  };
}

/** Warn-severity transients would otherwise be invisible in the hook flow (the
 *  schema-utils lesson: an unseen warn is a no-op in an unattended loop). They at
 *  least land in the deny log's audit trail, marked as warnings. */
function recordWarns(warns: Finding[]): void {
  const log = process.env.TAMPERWARD_DENYLOG;
  if (!log || warns.length === 0) return;
  try {
    appendFileSync(log, warns.map((w) => `warn:${w.rule}:${w.file ?? ''}`).join('\n') + '\n');
  } catch {
    /* best effort */
  }
}

export function stopVerdict(input: ClaudeHookInput): HookResult {
  if (input.stop_hook_active) return { exitCode: 0, stdout: '' };
  const cwd = input.cwd ?? process.cwd();
  // "Nothing to compare" and "the comparison failed" must not share a code path: a blanket
  // catch→allow turned a broken policy or a git failure into a silent pass.
  if (!isGitRepo(cwd)) return { exitCode: 0, stdout: '' };
  let blocks: Finding[];
  let commitCursor: () => void = () => {};
  try {
    // Compare against the turn's starting commit, not HEAD: a tamper the agent COMMITTED
    // mid-turn is still the turn's work, and `git diff HEAD` could not see it.
    const policy = loadPolicy(cwd);
    const base = turnBaseline(cwd, input.session_id);
    const changes = base ? diffSince(base, { cwd }) : diffWorktree({ cwd });
    blocks = evaluate(changes, policy, undefined, 'turn').filter((f) => f.severity === 'block');
    const transient = turnTransientBlocks(cwd, input.session_id, policy, changes);
    blocks = blocks.concat(transient.blocks);
    commitCursor = transient.commit;
    if (blocks.length === 0 && input.session_id) {
      // A clean turn re-baselines the effect state too, so the next turn's drift
      // check starts from what this turn legitimately left behind.
      savePtree(cwd, input.session_id, snapshotProtected(cwd, policy, loadPtree(cwd, input.session_id) ?? undefined));
    }
  } catch (e) {
    return failClosed('Stop', errText(e));
  }
  if (blocks.length === 0) {
    advanceTurnBaseline(cwd, input.session_id);
    commitCursor();
  }
  return verdict(blocks, 'Stop');
}

function emit(r: HookResult): number {
  if (r.stdout) process.stdout.write(r.stdout);
  return r.exitCode;
}

/** The whole PreToolUse path from RAW BYTES, so the payload-parsing failures are
 *  reachable from a test without a real stdin. */
export function preToolUseFromRaw(raw: string): HookResult {
  try {
    return preToolUseVerdict(parseInput(raw));
  } catch (e) {
    return failClosed('PreToolUse', errText(e));
  }
}

export function stopFromRaw(raw: string): HookResult {
  try {
    return stopVerdict(parseInput(raw));
  } catch (e) {
    return failClosed('Stop', errText(e));
  }
}

export function runHookClaude(): number {
  try {
    return emit(preToolUseFromRaw(readStdin()));
  } catch (e) {
    return emit(failClosed('PreToolUse', errText(e)));
  }
}

export function runSweepClaude(): number {
  try {
    return emit(stopFromRaw(readStdin()));
  } catch (e) {
    return emit(failClosed('Stop', errText(e)));
  }
}
