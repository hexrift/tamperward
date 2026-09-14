// Claude Code as the first implementation of the neutral RuntimeAdapter (#482, Phase 1).
//
// ZERO behaviour change. This adapter is a CONFORMANCE WRAPPER, not a second verdict
// path: the authoritative implementation stays in src/cli/hook.ts, and `decide()`
// DELEGATES to `preToolUseFromRaw` / `stopFromRaw` so its stdout is byte-identical to
// the live CLI (`tamperward hook claude` / `tamperward sweep claude`), which is still
// wired directly to `runHookClaude` / `runSweepClaude` in src/cli/main.ts — untouched.
// The existing hook test suite (claude-hook, stop-sweep-edges-417, signoff,
// canonical-wiring, hook-service, …) is the guardrail: it exercises the same functions.
//
// What the adapter adds is the neutral SEAM: it classifies the outcome (ok / parse-failure
// / …), declares Claude's per-operation capabilities, and exposes `denyPayload` through the
// same `denyWire` the live `verdict()` uses. It does NOT change any deny/allow path, the
// fail-closed behaviour, repo-root resolution (#412), or the deny wire format.

import { Finding } from '../../types';
import { ClaudeHookInput } from './changes';
import { formatDenial } from './deny';
import { parseInput, denyWire, preToolUseFromRaw, stopFromRaw, HookInputError } from '../../cli/hook';
import { repoContext } from '../../repo-context';
import { isAbsolute, resolve } from 'node:path';
import {
  IdentityValidation,
  OPERATION_KINDS,
  OperationKind,
  ProposedOperation,
  RuntimeAdapter,
  RuntimeCapabilities,
  SteeringEvent,
  SteeringPhase,
  SteeringResult,
  UntrustedIdentity,
  failClosedResult,
} from '../contract';

/** A steering phase maps to exactly one Claude hook kind. `post-action` has no live
 *  Claude wiring (Claude's post-execution reconciliation is the end-of-turn Stop sweep,
 *  not a per-tool PostToolUse veto), so it never reaches the deny/decide path. */
function hookKindFor(phase: SteeringPhase): 'PreToolUse' | 'Stop' {
  return phase === 'end-of-turn' ? 'Stop' : 'PreToolUse';
}

/** Claude's tool name → neutral operation kind. Read-only tools and unknown tools are
 *  classified but produce no Change downstream (src/adapters/claude/changes.ts), which is
 *  why Claude can DECLARE pre-deny for every kind: PreToolUse fires for all of them and
 *  can deny any — it simply finds nothing to block on a pure read. */
function operationKind(toolName: string | undefined): OperationKind {
  if (!toolName) return 'other';
  if (toolName === 'Bash' || toolName === 'BashOutput' || toolName === 'KillShell') return 'shell';
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') return 'file-edit';
  if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep' || toolName === 'NotebookRead') return 'file-read';
  if (toolName.startsWith('mcp__')) return 'mcp';
  return 'other';
}

function eventFrom(input: ClaudeHookInput, phase: SteeringPhase): SteeringEvent {
  const operation: ProposedOperation =
    phase === 'end-of-turn'
      ? { kind: 'other', name: 'stop', args: {} }
      : { kind: operationKind(input.tool_name), name: input.tool_name ?? '', args: input.tool_input ?? {} };
  return {
    phase,
    operation,
    identity: { claimedCwd: input.cwd, sessionId: input.session_id },
  };
}

export class ClaudeRuntimeAdapter implements RuntimeAdapter {
  readonly name = 'claude-code';

  /**
   * Claude Code's live PreToolUse fires for EVERY tool and can synchronously deny it —
   * shell, file edit, file read, MCP, and anything else — even under
   * `--dangerously-skip-permissions`. The end-of-turn Stop sweep is live too. There is no
   * live per-tool PostToolUse veto (Stop is the post-turn reconciliation), so `postObserve`
   * is empty and `unsupported` names that gap explicitly rather than implying it.
   */
  readonly capabilities: RuntimeCapabilities = {
    preDeny: OPERATION_KINDS,
    postObserve: [],
    endOfTurn: true,
    unsupported: [
      'per-operation post-action veto (end-of-turn Stop sweep is the post-turn reconciliation)',
      'network-egress control',
      'identity / authentication',
    ],
  };

  parseEvent(raw: string, phase: SteeringPhase): SteeringEvent | { failure: 'parse-failure'; detail: string } {
    try {
      // Same parser the live path uses: empty stdin is a well-formed ABSENCE (allow), a
      // malformed/wrong-shape payload throws HookInputError (fail closed).
      return eventFrom(parseInput(raw), phase);
    } catch (e) {
      if (e instanceof HookInputError) return { failure: 'parse-failure', detail: e.message };
      throw e;
    }
  }

  /**
   * REVIEW POINT 5 — the runtime cwd is a CLAIM, not authority. Derive the repository
   * root INDEPENDENTLY via git (repoContext → `git rev-parse --show-toplevel`, which
   * resolves symlinks to a canonical path), reject a malformed claim, and surface the
   * trusted root. This mirrors — and never weakens — what `preToolUseVerdict` already does
   * via `repoRoot()`; the live decide path re-derives the root itself, so this method is the
   * EXPLICIT boundary, not a new authority. A claim that resolves outside the repository the
   * runner is enforcing (no git root, or a git root other than the runner's) is rejected.
   */
  validateIdentity(claim: UntrustedIdentity, defaultCwd?: string): IdentityValidation {
    const claimed = claim.claimedCwd;
    if (claimed !== undefined && (typeof claimed !== 'string' || claimed.trim() === '')) {
      return { ok: false, rejected: 'malformed cwd claim' };
    }
    // The path a relative claim resolves against is the runner's own cwd, never the claim.
    const base = defaultCwd ?? process.cwd();
    const sessionCwd = claimed == null ? base : isAbsolute(claimed) ? claimed : resolve(base, claimed);
    const ctx = repoContext(sessionCwd);
    if (!ctx) {
      // No repository independently derivable from the claim: the runner cannot bind the
      // operation to a trusted root, so the identity is not accepted as authority.
      return { ok: false, rejected: `no repository root derivable from cwd claim (${sessionCwd})` };
    }
    return { ok: true, trustedRoot: ctx.root };
  }

  /** The exact deny wire bytes for `phase`, through the SAME `denyWire` the live
   *  `verdict()` uses (src/cli/hook.ts). Reuses `formatDenial`, so the reason text is
   *  identical to the live path. Byte-for-byte equal to what a live deny emits. */
  denyPayload(findings: Finding[], phase: SteeringPhase): string {
    return denyWire(formatDenial(findings), hookKindFor(phase));
  }

  /**
   * The authoritative synchronous path. Delegates entirely to the canonical
   * `preToolUseFromRaw` / `stopFromRaw`, so `wire` is byte-identical to the live CLI —
   * every deny/allow decision, the fail-closed wrapping, repo-root resolution, the turn
   * baseline and the transport all remain exactly as src/cli/hook.ts computes them.
   *
   * The adapter only CLASSIFIES the outcome on top of that unchanged verdict: a payload
   * the parser rejects is reported as `parse-failure` (the live path has already failed
   * CLOSED — `wire` is a deny), everything else as `ok` with the live allow/deny.
   */
  decide(raw: string, phase: SteeringPhase, defaultCwd?: string): SteeringResult {
    const kind = hookKindFor(phase);
    const live = kind === 'Stop' ? stopFromRaw(raw, defaultCwd) : preToolUseFromRaw(raw, defaultCwd);
    const wire = live.stdout;
    const denied = wire.length > 0;
    const parsed = this.parseEvent(raw, phase);
    if ('failure' in parsed) {
      // The live path already denied (fail closed on the unparseable payload); we relabel
      // the OUTCOME as parse-failure without touching the byte-identical `wire`.
      return {
        outcome: 'parse-failure',
        detail: parsed.detail,
        wire,
        decision: { verdict: 'deny', findings: [], reason: wire },
      };
    }
    return {
      outcome: 'ok',
      wire,
      decision: { verdict: denied ? 'deny' : 'allow', findings: [], reason: denied ? wire : undefined },
    };
  }

  /**
   * Map a transport failure (or a required hook that did not fire) onto a fail-closed
   * DENY at the neutral seam. Claude's LIVE client additionally degrades a hook-service
   * transport failure to the in-process verdict (src/cli/index.ts / hook-client.ts) rather
   * than surfacing it here, so this method documents the contract guarantee for the seam;
   * a partial adapter with no in-process fallback denies through exactly this path.
   */
  failClosed(outcome: 'transport-failure' | 'not-invoked', detail: string, phase: SteeringPhase): SteeringResult {
    return failClosedResult(outcome, detail, phase, (f, p) => this.denyPayload(f, p));
  }
}

/** The singleton Claude adapter. */
export const claudeAdapter = new ClaudeRuntimeAdapter();
