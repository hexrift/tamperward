// GitHub Copilot CLI as an EXPERIMENTAL RuntimeAdapter (#482 / #598).
//
// This adapter is deliberately CONSERVATIVE and honest about what is not yet proven on a
// pinned Copilot CLI build. It does NOT flip Copilot to in-loop steering (src/runtimes.ts
// keeps Copilot `steering:'neutral'`) and it does NOT register a research round: adapter
// existence is milestone one, and Round 4.1-eligibility is a SECOND milestone gated by the
// real `probe:copilot-runtime` qualification harness against a pinned, authenticated
// Copilot CLI. Capability claims come from PROVEN invocation evidence, never from a hook
// name's mere existence.
//
// It opens no second verdict path: the pre-action content decision runs the SAME `evaluate`
// engine every other surface uses over a Change[] reconstructed by src/adapters/copilot/
// changes.ts, and the end-of-turn sweep DELEGATES to the canonical git sweep (`stopFromRaw`
// in src/cli/hook.ts), whose `{decision:"block",reason}` wire is Copilot's agentStop shape.
// The raw agentStop payload is normalized to the Claude Stop shape first (native camelCase
// `sessionId` → `session_id`) so the sweep anchors the same per-session baseline the
// pre-action path pinned. Identity is validated exactly as the Claude and Codex adapters do.
//
// Copilot control-point and transport facts carried in `unsupported` until the probe measures
// them on a pinned build (GitHub Copilot hooks reference):
//  - `preToolUse` is the only PRE-EXECUTION tool veto; `agentStop`'s `{decision:"block"}`
//    forces another turn (a lifecycle control, not a filesystem veto) and Copilot OVERRIDES
//    the hook after 8 consecutive blocks (the `stop_hook_active` lifecycle); `postToolUse` is
//    post-execution observation.
//  - a COMMAND `preToolUse` hook that crashes / exits non-zero / exits 2 fails CLOSED, but a
//    TIMEOUT fails OPEN (the tool call proceeds) — the specific qualification risk #598 names;
//    an HTTP `preToolUse` hook fails OPEN on network error / timeout / non-2xx, so TamperWard
//    qualifies only the local command/exec transport, recorded as such, not masked.

import { Finding } from '../../types';
import { evaluate } from '../../engine';
import { loadPolicy } from '../../policy-load';
import { stopFromRaw } from '../../cli/hook';
import { turnBaseline } from '../../session';
import { repoContext, repoRoot, validateClaimAgainstRoot } from '../../repo-context';
import {
  IdentityValidation,
  RuntimeAdapter,
  RuntimeCapabilities,
  SteeringEvent,
  SteeringPhase,
  SteeringResult,
  UntrustedIdentity,
  failClosedResult,
  steeringUnavailableFinding,
} from '../contract';
import { changesFromCopilot } from './changes';
import { copilotDenyWire } from './deny';
import { copilotStopInput, normalizeCopilotEvent } from './schema';

export class CopilotRuntimeAdapter implements RuntimeAdapter {
  readonly name = 'github-copilot-cli';

  /**
   * CONSERVATIVE and honest. Pre-action deny ENFORCEMENT is not yet proven on a pinned
   * Copilot CLI build, so `preDeny` is empty — the adapter never claims a synchronous veto
   * it has not demonstrated on the real runtime. `postObserve` is empty for milestone one:
   * Copilot does expose a `postToolUse` observation surface, but this adapter does not yet
   * consume it as a supported post-action path (`decide(..., 'post-action')` returns
   * `unsupported`), so it declares no post-observe capability rather than advertising kinds it
   * does not report. Every real gap is named in `unsupported`. The `probe:copilot-runtime`
   * harness is what may later justify moving a kind into `preDeny` or populating `postObserve`.
   */
  readonly capabilities: RuntimeCapabilities = {
    preDeny: [],
    postObserve: [],
    endOfTurn: true,
    unsupported: [
      'pre-action deny enforcement not yet proven on a pinned Copilot CLI build (see probe:copilot-runtime)',
      'COMMAND preToolUse hook timeout fails OPEN on Copilot CLI: a timed-out hook lets the tool call proceed (crash / non-zero exit / exit 2 fail closed); an HTTP preToolUse hook fails OPEN on network error / timeout / non-2xx, so only the local command/exec transport is a qualification candidate',
      'preToolUse is the only PRE-EXECUTION tool veto; agentStop can only block turn completion and force continuation (a lifecycle control, not a filesystem veto), and Copilot overrides the hook after 8 consecutive blocks (stop_hook_active lifecycle); postToolUse observation is not yet consumed by this adapter',
      'apply_patch / str_replace_editor exact hook payloads are modelled from the published contract but not yet confirmed against a pinned real-run fixture (str_replace_editor sub-ops other than str_replace/create fail closed); a PascalCase Edit carrying a patch-style payload fails closed unless a fixture proves the Edit-field rewrite',
      'shell-session write tools (write_bash / write_powershell) are classified as mutation-capable shell ops; their exact hook payload is not yet confirmed against a pinned fixture, so an event carrying no reconstructable command/input fails closed',
      'network-egress control',
      'identity / authentication',
    ],
  };

  parseEvent(raw: string, phase: SteeringPhase): SteeringEvent | { failure: 'parse-failure'; detail: string } {
    return normalizeCopilotEvent(raw, phase);
  }

  /** Identity is a CLAIM validated against the runner's independently derived trusted root,
   *  reusing `repoContext` / `validateClaimAgainstRoot` exactly as the Claude and Codex
   *  adapters do. It never weakens the shared check. */
  validateIdentity(claim: UntrustedIdentity, defaultCwd?: string): IdentityValidation {
    const base = defaultCwd ?? process.cwd();
    const runnerCtx = repoContext(base);
    if (!runnerCtx) {
      return {
        ok: false,
        rejected: `runner cwd (${base}) is not in a repository, so there is no trusted root to validate against`,
      };
    }
    const v = validateClaimAgainstRoot(claim.claimedCwd, runnerCtx.root, base);
    return v.ok ? { ok: true, trustedRoot: v.trustedRoot } : { ok: false, rejected: v.rejected };
  }

  denyPayload(findings: Finding[], phase: SteeringPhase): string {
    // The neutral contract includes observation-only post-action, but Copilot has no
    // post-action veto envelope (postToolUse is observational). Reject it at the adapter
    // boundary rather than allowing a fail-closed path to manufacture a preToolUse denial.
    if (phase === 'post-action') {
      throw new Error('Copilot post-action is observation-only and cannot produce a deny wire');
    }
    return copilotDenyWire(findings, phase);
  }

  /**
   * parse → validate identity → decide, every failure CLOSED (deny), in order:
   *
   *  1. `post-action` → `unsupported` (observation-only; never a deny wire).
   *  2. parse failure → a fail-closed deny in Copilot's wire.
   *  3. identity claim rejected → a fail-closed deny BEFORE any content evaluation.
   *  4. `end-of-turn` → delegate to the canonical git sweep, whose wire is already Copilot's
   *     agentStop `{decision:"block",reason}` shape and passes through unchanged.
   *  5. `pre-action` → reconstruct Change[] and run the SAME `evaluate` engine; a deny
   *     carries the shared denial reason. A reconstruction that cannot be modelled fails
   *     CLOSED to deny rather than allowing an unseen edit.
   */
  decide(raw: string, phase: SteeringPhase, defaultCwd?: string): SteeringResult {
    if (phase === 'post-action') {
      return {
        outcome: 'unsupported',
        detail: 'Copilot post-action is observation-only; the end-of-turn agentStop sweep is the post-turn reconciliation.',
      };
    }
    const parsed = this.parseEvent(raw, phase);
    if ('failure' in parsed) {
      const findings = [steeringUnavailableFinding(`unparseable Copilot event: ${parsed.detail}`)];
      const wire = this.denyPayload(findings, phase);
      return { outcome: 'parse-failure', detail: parsed.detail, wire, decision: { verdict: 'deny', findings, reason: wire } };
    }
    const idv = this.validateIdentity(parsed.identity, defaultCwd);
    if (!idv.ok) {
      const findings = [steeringUnavailableFinding(`repository identity claim rejected: ${idv.rejected}`)];
      const wire = this.denyPayload(findings, phase);
      return { outcome: 'ok', wire, detail: idv.rejected, decision: { verdict: 'deny', findings, reason: wire } };
    }

    if (phase === 'end-of-turn') {
      // Normalize either documented agentStop / Stop format to the Claude Stop shape the
      // canonical git sweep consumes (native `sessionId` → `session_id`), so the sweep anchors
      // the same per-session baseline the pre-action path pinned. The sweep's output wire is
      // ALREADY Copilot's agentStop `{decision:"block",reason}` shape, so it passes through
      // unchanged; the verdict is entirely the canonical stopFromRaw's.
      const stopInput = copilotStopInput(raw);
      if (typeof stopInput !== 'string') {
        const findings = [steeringUnavailableFinding(`unparseable Copilot event: ${stopInput.detail}`)];
        const wire = this.denyPayload(findings, 'end-of-turn');
        return { outcome: 'parse-failure', detail: stopInput.detail, wire, decision: { verdict: 'deny', findings, reason: wire } };
      }
      const wire = stopFromRaw(stopInput, defaultCwd, idv.trustedRoot).stdout;
      return { outcome: 'ok', wire, decision: { verdict: wire ? 'deny' : 'allow', findings: [], reason: wire || undefined } };
    }

    try {
      const root = idv.trustedRoot ?? repoRoot(defaultCwd ?? process.cwd());
      const sessionCwd = parsed.identity.claimedCwd ?? defaultCwd ?? process.cwd();
      // Pin the Stop-sweep baseline at TURN START, on EVERY pre-action call regardless of
      // operation kind, exactly as the canonical preToolUseVerdict does (src/cli/hook.ts).
      // With preDeny empty the end-of-turn git sweep is Copilot's only real enforcement, and
      // a baseline first set at Stop time would compare post-commit HEAD against a
      // post-commit baseline — a mutation the turn COMMITTED mid-turn would be invisible.
      turnBaseline(root, parsed.identity.sessionId);
      const policy = loadPolicy(root);
      const changes = changesFromCopilot(parsed.operation, root, sessionCwd);
      const findings = evaluate(changes, policy, undefined, 'tool-call', { cwd: root }).filter((f) => f.severity === 'block');
      const wire = this.denyPayload(findings, 'pre-action');
      return { outcome: 'ok', wire, decision: { verdict: findings.length ? 'deny' : 'allow', findings, reason: wire || undefined } };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const findings = [steeringUnavailableFinding(detail)];
      const wire = this.denyPayload(findings, 'pre-action');
      return { outcome: 'ok', wire, detail, decision: { verdict: 'deny', findings, reason: wire } };
    }
  }

  /** A transport failure or a required hook that did not fire → a fail-closed deny at the
   *  seam, through the adapter's own `denyPayload` so the wire is Copilot's native envelope. */
  failClosed(outcome: 'transport-failure' | 'not-invoked', detail: string, phase: SteeringPhase): SteeringResult {
    return failClosedResult(outcome, detail, phase, (f, p) => this.denyPayload(f, p));
  }
}

/** The singleton Copilot adapter. */
export const copilotAdapter = new CopilotRuntimeAdapter();
