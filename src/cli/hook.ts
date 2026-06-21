// `holdfast hook claude` (PreToolUse) and `holdfast sweep claude` (Stop).
//
// Output contract (verified against current Claude Code docs): exit 2 with the reason
// on stderr blocks the tool/stop and feeds the reason back to the model. A deny holds
// even under bypassPermissions / --dangerously-skip-permissions, so the agent cannot
// escape the gate by changing permission mode. Exit 0 allows.

import { readFileSync, appendFileSync } from 'node:fs';
import { changesFromClaudeHook, ClaudeHookInput } from '../adapters/claude/changes';
import { formatDenial } from '../adapters/claude/deny';
import { evaluate } from '../engine';
import { loadPolicy } from '../policy-load';
import { diffWorktree } from '../git/build';
import { Finding } from '../types';

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

function denyIfBlocking(findings: Finding[]): number {
  const blocks = findings.filter((f) => f.severity === 'block');
  if (blocks.length === 0) return 0;
  // Optional deny audit trail (used by the harness to count interceptions).
  const log = process.env.HOLDFAST_DENYLOG;
  if (log) {
    try {
      appendFileSync(log, blocks.map((b) => b.rule).join(',') + '\n');
    } catch {
      /* best effort */
    }
  }
  process.stderr.write(formatDenial(blocks));
  return 2;
}

/** PreToolUse: deny the shortcut before the tool runs. */
export function runHookClaude(): number {
  const input = parseInput(readStdin());
  const cwd = input.cwd ?? process.cwd();
  const changes = changesFromClaudeHook(input, cwd);
  return denyIfBlocking(evaluate(changes, loadPolicy(cwd)));
}

/** Stop: re-scan the turn's net working tree to catch shell-mediated mutations the
 *  PreToolUse matcher can't see. Respects stop_hook_active to avoid an infinite loop. */
export function runSweepClaude(): number {
  const input = parseInput(readStdin());
  if (input.stop_hook_active) return 0;
  const cwd = input.cwd ?? process.cwd();
  let changes;
  try {
    changes = diffWorktree({ cwd });
  } catch {
    return 0; // not a git repo / nothing to compare — nothing to sweep
  }
  return denyIfBlocking(evaluate(changes, loadPolicy(cwd)));
}
