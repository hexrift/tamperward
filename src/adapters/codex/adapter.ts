// Codex as an EXPERIMENTAL RuntimeAdapter (#482 / #563).
//
// This adapter is deliberately CONSERVATIVE and honest about what is not yet proven on a
// pinned Codex build. It does NOT flip Codex to in-loop steering (src/runtimes.ts is
// untouched) and it does NOT register a research round: adapter existence is milestone one,
// and 4.1-eligibility is a SECOND milestone gated by the real `probe:codex-runtime`
// qualification harness against a pinned Codex build.
//
// It opens no second verdict path: the pre-action content decision runs the SAME `evaluate`
// engine every other surface uses over a Change[] reconstructed by src/adapters/codex/
// changes.ts, and the end-of-turn sweep DELEGATES to the canonical git sweep (`stopFromRaw`
// in src/cli/hook.ts), re-wrapping only the wire envelope in Codex's shape. Identity is
// validated exactly as the Claude adapter validates it.

import { Finding } from '../../types';
import { evaluate } from '../../engine';
import { loadPolicy } from '../../policy-load';
import { stopFromRaw } from '../../cli/hook';
import { turnBaseline } from '../../session';
import { repoContext, repoRoot, validateClaimAgainstRoot } from '../../repo-context';
import {
  IdentityValidation,
  OperationKind,
  RuntimeAdapter,
  RuntimeCapabilities,
  SteeringEvent,
  SteeringPhase,
  SteeringResult,
  UntrustedIdentity,
  failClosedResult,
  steeringUnavailableFinding,
} from '../contract';
import { changesFromCodex } from './changes';
import { codexDenyWire } from './deny';
import { normalizeCodexEvent } from './schema';

// `unknown` is an adapter classification outcome, not a declarable capability kind;
// an unrecognized Copilot name is denied before it can reach this neutral set.
const POST_OBSERVE: readonly OperationKind[] = ['shell', 'file-edit', 'file-read', 'mcp', 'other'];

export class CodexRuntimeAdapter implements RuntimeAdapter {
  readonly name = 'codex';

  /**
   * CONSERVATIVE and honest. Pre-action deny ENFORCEMENT is not yet proven on a pinned
   * Codex build, so `preDeny` is empty — the adapter never claims a synchronous veto it
   * cannot demonstrate. Codex does surface post-execution tool outcomes and an end-of-turn
   * stop, so those are declared; every real gap is named in `unsupported`. The
   * `probe:codex-runtime` harness is what may later justify moving a kind into `preDeny`.
   */
  readonly capabilities: RuntimeCapabilities = {
    preDeny: [],
    postObserve: POST_OBSERVE,
    endOfTurn: true,
    unsupported: [
      'pre-action deny enforcement not yet proven on a pinned Codex build (see probe:codex-runtime)',
      'fail-closed hook transport not yet proven (openai/codex#41979)',
      'network-egress control',
      'identity / authentication',
    ],
  };

  parseEvent(raw: string, phase: SteeringPhase): SteeringEvent | { failure: 'parse-failure'; detail: string } {
    return normalizeCodexEvent(raw, phase);
  }

  /** Identity is a CLAIM validated against the runner's independently derived trusted root,
   *  reusing `repoContext` / `validateClaimAgainstRoot` exactly as the Claude adapter does.
   *  It never weakens the shared check. */
  validateIdentity(claim: UntrustedIdentity, defaultCwd?: string): IdentityValidation {
    const base = defaultCwd ?? process.cwd();
    const runnerCtx = repoContext(base);
    if (!runnerCtx) {
      return { ok: false, rejected: `runner cwd (${base}) is not in a repository, so there is no trusted root to validate against` };
    }
    const v = validateClaimAgainstRoot(claim.claimedCwd, runnerCtx.root, base);
    return v.ok ? { ok: true, trustedRoot: v.trustedRoot } : { ok: false, rejected: v.rejected };
  }

  denyPayload(findings: Finding[], phase: SteeringPhase): string {
    // The neutral contract includes observation-only post-action, but Codex has no
    // post-action veto envelope. Reject it at the adapter boundary rather than
    // allowing a fail-closed path to manufacture a PreToolUse denial.
    if (phase === 'post-action') {
      throw new Error('Codex post-action is observation-only and cannot produce a deny wire');
    }
    return codexDenyWire(findings, phase);
  }

  /**
   * parse → validate identity → decide, every failure CLOSED (deny), in order:
   *
   *  1. `post-action` → `unsupported` (observation-only; never a deny wire).
   *  2. parse failure → a fail-closed deny in Codex's wire.
   *  3. identity claim rejected → a fail-closed deny BEFORE any content evaluation.
   *  4. `end-of-turn` → delegate to the canonical git sweep, re-wrapped in Codex's wire.
   *  5. `pre-action` → reconstruct Change[] and run the SAME `evaluate` engine; a deny
   *     carries the shared denial reason. A reconstruction that cannot be modelled fails
   *     CLOSED to deny rather than allowing an unseen edit.
   */
  decide(raw: string, phase: SteeringPhase, defaultCwd?: string): SteeringResult {
    if (phase === 'post-action') {
      return {
        outcome: 'unsupported',
        detail: 'Codex post-action is observation-only; the end-of-turn Stop sweep is the post-turn reconciliation.',
      };
    }
    const parsed = this.parseEvent(raw, phase);
    if ('failure' in parsed) {
      const findings = [steeringUnavailableFinding(`unparseable Codex event: ${parsed.detail}`)];
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
      // The canonical git sweep's Stop wire is ALREADY Codex's `{decision:"block",reason}`
      // shape (stop.command.output.schema.json), so it passes through unchanged. The verdict
      // is entirely the canonical stopFromRaw's; the adapter reshapes nothing.
      const wire = stopFromRaw(raw, defaultCwd, idv.trustedRoot).stdout;
      return { outcome: 'ok', wire, decision: { verdict: wire ? 'deny' : 'allow', findings: [], reason: wire || undefined } };
    }

    try {
      const root = idv.trustedRoot ?? repoRoot(defaultCwd ?? process.cwd());
      const sessionCwd = parsed.identity.claimedCwd ?? defaultCwd ?? process.cwd();
      // Pin the Stop-sweep baseline at TURN START, on EVERY pre-action call regardless of
      // operation kind, exactly as the canonical preToolUseVerdict does (src/cli/hook.ts).
      // With preDeny empty the end-of-turn git sweep is Codex's only real enforcement, and
      // a baseline first set at Stop time would compare post-commit HEAD against a
      // post-commit baseline — a mutation the turn COMMITTED mid-turn would be invisible.
      // PR 2 adds the remaining canonical pre-action steps (effectDriftBlocks,
      // sanctionPredictedWrites) once Codex is wired live with the effect observer.
      turnBaseline(root, parsed.identity.sessionId);
      const policy = loadPolicy(root);
      const changes = changesFromCodex(parsed.operation, root, sessionCwd);
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
   *  seam, through the adapter's own `denyPayload` so the wire is Codex's native envelope. */
  failClosed(outcome: 'transport-failure' | 'not-invoked', detail: string, phase: SteeringPhase): SteeringResult {
    return failClosedResult(outcome, detail, phase, (f, p) => this.denyPayload(f, p));
  }
}

/** The singleton Codex adapter. */
export const codexAdapter = new CodexRuntimeAdapter();
