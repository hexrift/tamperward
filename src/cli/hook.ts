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
import { diffWorktree } from '../git/build';
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
  const cwd = input.cwd ?? process.cwd();
  const changes = changesFromClaudeHook(input, cwd);
  const blocks = evaluate(changes, loadPolicy(cwd)).filter((f) => f.severity === 'block');
  return verdict(blocks, 'PreToolUse');
}

/** Stop: re-scan the turn's net working tree for shell-mediated mutations the PreToolUse
 *  matcher can't see. Respects stop_hook_active to avoid an infinite loop. */
export function stopVerdict(input: ClaudeHookInput): HookResult {
  if (input.stop_hook_active) return { exitCode: 0, stdout: '' };
  const cwd = input.cwd ?? process.cwd();
  let blocks: Finding[];
  try {
    blocks = evaluate(diffWorktree({ cwd }), loadPolicy(cwd)).filter((f) => f.severity === 'block');
  } catch {
    return { exitCode: 0, stdout: '' }; // not a git repo / nothing to compare
  }
  return verdict(blocks, 'Stop');
}

export function runHookClaude(): number {
  const r = preToolUseVerdict(parseInput(readStdin()));
  if (r.stdout) process.stdout.write(r.stdout);
  return r.exitCode;
}

export function runSweepClaude(): number {
  const r = stopVerdict(parseInput(readStdin()));
  if (r.stdout) process.stdout.write(r.stdout);
  return r.exitCode;
}
