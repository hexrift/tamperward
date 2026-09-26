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
import { repoContext, validateClaimAgainstRoot } from '../../repo-context';
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
  steeringUnavailableFinding,
} from '../contract';

/** A steering phase maps to exactly one DENY-CAPABLE Claude hook kind. `post-action` is
 *  observation-only — Claude's post-execution reconciliation is the end-of-turn Stop sweep,
 *  not a per-tool PostToolUse veto — so it must NEVER map to a deny-capable hook. This
 *  refuses it (throws) rather than silently falling through to PreToolUse; `decide` and
 *  `denyPayload` never call it for `post-action`. */
function hookKindFor(phase: SteeringPhase): 'PreToolUse' | 'Stop' {
  if (phase === 'end-of-turn') return 'Stop';
  if (phase === 'pre-action') return 'PreToolUse';
  throw new Error(`no deny-capable Claude hook for the observation-only phase "${phase}"`);
}

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

  readonly capabilities: RuntimeCapabilities = {
    preDeny: OPERATION_KINDS.filter((kind) => kind !== 'mcp' && kind !== 'other'),
    postObserve: [],
    endOfTurn: true,
    unsupported: [
      'MCP pre-deny is not declared because Claude MCP calls are not reconstructed into Change[] before evaluation',
      'catch-all other-tool pre-deny is not declared because unmodelled Claude tools are not reconstructed into Change[] before evaluation',
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
   * REVIEW POINT 5 — the runtime cwd is a CLAIM, not authority.
   *
   * The trusted repository root is derived from the RUNNER context (`defaultCwd`, else the
   * process cwd) — INDEPENDENTLY of the claim — via git (`repoContext` →
   * `git rev-parse --show-toplevel`, which resolves symlinks to a canonical path). The
   * claim is then validated against THAT root with the shared `validateClaimAgainstRoot`:
   * accepted only when it resolves to the same repository (its root, or a path inside it);
   * rejected for a malformed path, a non-repository, a different repository, or a symlink
   * that escapes into another repository. It never weakens what `preToolUseVerdict` does via
   * `repoRoot()` — it is the explicit boundary that `decide` enforces BEFORE evaluating.
   */
  validateIdentity(claim: UntrustedIdentity, defaultCwd?: string): IdentityValidation {
    const base = defaultCwd ?? process.cwd();
    // The runner's OWN trusted root — derived from the runner, not from `claim`.
    const runnerCtx = repoContext(base);
    if (!runnerCtx) {
      return { ok: false, rejected: `runner cwd (${base}) is not in a repository, so there is no trusted root to validate against` };
    }
    const v = validateClaimAgainstRoot(claim.claimedCwd, runnerCtx.root, base);
    return v.ok ? { ok: true, trustedRoot: v.trustedRoot } : { ok: false, rejected: v.rejected };
  }

  /** The exact deny wire bytes for `phase`, through the SAME `denyWire` the live
   *  `verdict()` uses (src/cli/hook.ts). Reuses `formatDenial`, so the reason text is
   *  identical to the live path. Byte-for-byte equal to what a live deny emits. */
  denyPayload(findings: Finding[], phase: SteeringPhase): string {
    return denyWire(formatDenial(findings), hookKindFor(phase));
  }

  /**
   * The authoritative synchronous path, enforced in order: parse → validate identity →
   * decide. Each step that fails does so CLOSED (deny), except `post-action`, which is
   * observation-only and returns `unsupported` (never a deny wire, never a PreToolUse
   * fallthrough — BLOCKER 2).
   *
   *  1. `post-action` → `unsupported` (Claude has no per-tool post-action veto).
   *  2. parse failure → `parse-failure`, byte-identical to the live fail-closed deny.
   *  3. identity claim rejected → a fail-closed DENY, BEFORE any content evaluation, so a
   *     runtime-supplied cwd pointing at another repository can never reach the detectors.
   *  4. otherwise → delegate to the canonical `preToolUseFromRaw` / `stopFromRaw`, PASSING
   *     the validated trusted root so the live path re-runs the same shared identity check.
   *     `wire` is byte-identical to the live CLI — every deny/allow decision, the fail-closed
   *     wrapping, repo-root resolution (#412), the turn baseline and the transport remain
   *     exactly as src/cli/hook.ts computes them.
   */
  decide(raw: string, phase: SteeringPhase, defaultCwd?: string): SteeringResult {
    if (phase === 'post-action') {
      return {
        outcome: 'unsupported',
        detail: 'Claude Code has no per-tool post-action veto; the end-of-turn Stop sweep is its post-turn reconciliation.',
      };
    }
    const parsed = this.parseEvent(raw, phase);
    if ('failure' in parsed) {
      // The live path fails CLOSED on an unparseable payload; take its byte-identical wire
      // and relabel the outcome as parse-failure.
      const live = phase === 'end-of-turn' ? stopFromRaw(raw, defaultCwd) : preToolUseFromRaw(raw, defaultCwd);
      const findings = live.findings ? [...live.findings] : [];
      return {
        outcome: 'parse-failure',
        detail: parsed.detail,
        wire: live.stdout,
        decision: { verdict: 'deny', findings, reason: live.stdout },
      };
    }
    const idv = this.validateIdentity(parsed.identity, defaultCwd);
    if (!idv.ok) {
      // The runtime's repository identity is a claim, and this one did not validate against
      // the runner's trusted root — deny before evaluating anything.
      const findings = [steeringUnavailableFinding(`repository identity claim rejected: ${idv.rejected}`)];
      const wire = this.denyPayload(findings, phase);
      return { outcome: 'ok', wire, detail: idv.rejected, decision: { verdict: 'deny', findings, reason: wire } };
    }
    const live = phase === 'end-of-turn' ? stopFromRaw(raw, defaultCwd, idv.trustedRoot) : preToolUseFromRaw(raw, defaultCwd, idv.trustedRoot);
    const wire = live.stdout;
    const denied = wire.length > 0;
    const findings = live.findings ? [...live.findings] : [];
    return {
      outcome: 'ok',
      wire,
      decision: { verdict: denied ? 'deny' : 'allow', findings, reason: denied ? wire : undefined },
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
