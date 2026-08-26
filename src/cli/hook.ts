// `holdfast hook claude` (PreToolUse) and `holdfast sweep claude` (Stop).
//
// Output contract (verified against current Claude Code docs):
//   PreToolUse deny → {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//     "permissionDecision":"deny","permissionDecisionReason":<reason>}}  at EXIT 0
//   Stop block     → {"decision":"block","reason":<reason>}              at EXIT 0
// CRITICAL: exit 2 makes Claude Code IGNORE the JSON and fall back to the raw-stderr
// channel (which arrives wrapped as a "hook error" and leaks the invoking command line).
// So a block MUST be exit 0 + JSON, never exit 2. The reason carries only the correction
// message — no command line, no env. Deny holds even under bypassPermissions.

import { readFileSync, appendFileSync } from 'node:fs';
import { changesFromClaudeHook, ClaudeHookInput } from '../adapters/claude/changes';
import { formatDenial } from '../adapters/claude/deny';
import { evaluate } from '../engine';
import { loadPolicy } from '../policy-load';
import { diffWorktree, isGitRepo } from '../git/build';
import { Finding } from '../types';

export interface HookResult {
  exitCode: number;
  stdout: string;
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseInput(raw: string): ClaudeHookInput {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as ClaudeHookInput;
  } catch {
    return {};
  }
}

function recordDenylog(blocks: Finding[]): void {
  const log = process.env.HOLDFAST_DENYLOG;
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
 * FAIL CLOSED. If Holdfast cannot evaluate a change, the change is DENIED.
 *
 * The engine isolates each detector, but everything around it — loading the policy
 * (a malformed or merge-conflicted .holdfast.yml throws on parse), the adapter's own
 * file work — ran unguarded. An exception there exited non-(0|2), which Claude Code
 * treats as a NON-BLOCKING hook error: the tool call proceeds. A crashed gate became an
 * absent gate, silently, for every tool call while the condition lasted. SPEC §5.1's
 * whole guarantee is that a deny holds even under bypassPermissions; it cannot rest on
 * nothing having thrown.
 */
function failClosed(kind: 'PreToolUse' | 'Stop', detail: string): HookResult {
  const f: Finding = {
    rule: 'holdfast-unavailable',
    severity: 'block',
    message: `Holdfast could not evaluate this change (${detail}), so it is denied rather than allowed.`,
    evidence: detail,
    remediation:
      'Repair the Holdfast setup — most often an unparseable .holdfast.yml (check for merge-conflict markers) — then retry. Do not work around the gate while it is down.',
    signoff: { required: true, command: 'holdfast allow --reason "..."' },
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
 *  (observed self-invoking `holdfast allow` 3×), so honoring it here would let the agent clear
 *  its own block in-loop. A block is a block; sign-off is a human decision made at the
 *  local/CI layers (src/signoff.ts), never here. */
export function preToolUseVerdict(input: ClaudeHookInput): HookResult {
  try {
    const cwd = input.cwd ?? process.cwd();
    const changes = changesFromClaudeHook(input, cwd);
    const blocks = evaluate(changes, loadPolicy(cwd)).filter((f) => f.severity === 'block');
    return verdict(blocks, 'PreToolUse');
  } catch (e) {
    return failClosed('PreToolUse', errText(e));
  }
}

/** Stop: re-scan the turn's net working tree for shell-mediated mutations the PreToolUse
 *  matcher can't see. Respects stop_hook_active to avoid an infinite loop. */
export function stopVerdict(input: ClaudeHookInput): HookResult {
  if (input.stop_hook_active) return { exitCode: 0, stdout: '' };
  const cwd = input.cwd ?? process.cwd();
  // "Nothing to compare" and "the comparison failed" must not share a code path: a blanket
  // catch→allow turned a broken policy or a git failure into a silent pass.
  if (!isGitRepo(cwd)) return { exitCode: 0, stdout: '' };
  let blocks: Finding[];
  try {
    blocks = evaluate(diffWorktree({ cwd }), loadPolicy(cwd)).filter((f) => f.severity === 'block');
  } catch (e) {
    return failClosed('Stop', errText(e));
  }
  return verdict(blocks, 'Stop');
}

function emit(r: HookResult): number {
  if (r.stdout) process.stdout.write(r.stdout);
  return r.exitCode;
}

export function runHookClaude(): number {
  try {
    return emit(preToolUseVerdict(parseInput(readStdin())));
  } catch (e) {
    return emit(failClosed('PreToolUse', errText(e)));
  }
}

export function runSweepClaude(): number {
  try {
    return emit(stopVerdict(parseInput(readStdin())));
  } catch (e) {
    return emit(failClosed('Stop', errText(e)));
  }
}
