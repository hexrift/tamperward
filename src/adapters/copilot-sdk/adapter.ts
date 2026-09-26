// GitHub Copilot SDK-HOSTED runtime as an EXPERIMENTAL RuntimeAdapter (#482 / #611).
//
// This is a SEPARATE runtime configuration from the Copilot CLI command-hook adapter
// (src/adapters/copilot, `github-copilot-cli`, which remains PARTIAL and is the evidence record
// for the command-hook path). Here TamperWard is the HOST: the `@github/copilot-sdk`
// `onPermissionRequest` callback runs in-process before each tool executes, and `onAgentStop`
// is the end-of-turn lever. The spike harness (harness/adapters/copilot-sdk-spike.mjs, #611
// Phase 0) is what may later justify any capability promotion; this adapter claims nothing it
// has not proven on a pinned SDK.
//
// It opens NO second verdict path: the pre-action shell decision runs the SAME `evaluate` engine
// over a Change[] reconstructed by the SHARED src/adapters/copilot/changes.ts (shell path), and
// the end-of-turn sweep DELEGATES to the canonical git sweep (`stopFromRaw`), whose
// `{decision:"block",reason}` wire is already the SDK `onAgentStop` shape. Identity is validated
// exactly as the Claude / Codex / Copilot-CLI adapters do.
//
// CONTENT-AWARE FILE-EDIT PRE-DENY IS CONDITIONAL (the crux of #611). A `write` permission request
// surfaces the proposed change — a unified `diff`, and optionally the full `newFileContents` — so
// TamperWard CAN judge it before execution: the adapter reconstructs a Change[] from that content
// and runs the SAME engine (a weakened assertion, an added skip, a policy change all block). This
// is CONDITIONAL on what the pinned runtime actually provides: a write that surfaces neither a
// usable diff nor newFileContents is `unsupported` for that measured configuration (allow-through;
// the end-of-turn git sweep is the authority) — never a blanket path deny, which would replace
// content-aware enforcement with stricter path blocking and break the #482 / Round 4.1 parity. What
// is UNPROVEN (and gates any capability claim) is whether the runtime enforces a rejected decision
// at all — the fail-open-vs-closed unknown the spike must measure.

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
  immutableRuntimeCapabilities,
  SteeringEvent,
  SteeringPhase,
  SteeringResult,
  UnavailableReason,
  UntrustedIdentity,
  failClosedResult,
  steeringUnavailableFinding,
} from '../contract';
import { changesFromCopilot } from '../copilot/changes';
import { sdkFileEditChanges } from './changes';
import { copilotSdkDenyWire } from './deny';
import { copilotSdkStopInput, normalizeCopilotSdkEvent } from './schema';

const FILE_EDIT_NO_CONTENT_DETAIL =
  'this Copilot SDK write surfaced no usable content (no diff, no newFileContents), so content-aware ' +
  'pre-denial cannot be established for this measured configuration; the end-of-turn git sweep is the ' +
  'authority for the landed write. This adapter does not blanket-deny writes.';

export class CopilotSdkHostedAdapter implements RuntimeAdapter {
  readonly name = 'github-copilot-sdk-hosted';

  /**
   * CONSERVATIVE and honest. `preDeny` is empty: even shell pre-deny is only a CANDIDATE until the
   * spike proves, on a pinned SDK, that a rejected/thrown/timed-out permission callback does NOT
   * dispatch the tool (the decisive unknown #611 must measure). `postObserve` is empty (the SDK has
   * no post-execution veto). `endOfTurn` is true via `onAgentStop`. Every real gap is named in
   * `unsupported`, at the granularity #611 asks for.
   */
  readonly capabilities: RuntimeCapabilities = immutableRuntimeCapabilities({
    preDeny: [],
    postObserve: [],
    endOfTurn: true,
    unsupported: [
      'shell pre-deny enforcement is only a CANDIDATE until the spike proves on a pinned @github/copilot-sdk that a rejected permission decision actually blocks tool dispatch (see spike:copilot-sdk)',
      'content-aware file-edit pre-deny is CONDITIONAL on the pinned runtime surfacing usable write content: the adapter reconstructs and content-judges a write carrying a diff / newFileContents, but a write that surfaces neither is unsupported for that measured configuration (allow-through; the end-of-turn sweep is authority) — never a blanket path deny',
      'the SDK permission-handler failure semantics (synchronous throw / rejected Promise / timeout) are UNMEASURED: whether a broken decision path fails open (dispatches the tool) or closed is exactly what the spike must establish; a single observed fail-open makes the path ineligible for #482 / Round 4.1',
      'onAgentStop is a lifecycle continuation control ({decision:"block"} forces another turn, guarded by stopHookActive), not a filesystem veto',
      'network-egress control',
      'identity / authentication',
    ],
  });

  parseEvent(raw: string, phase: SteeringPhase): SteeringEvent | { failure: 'parse-failure'; detail: string } {
    return normalizeCopilotSdkEvent(raw, phase);
  }

  /** Identity is a CLAIM validated against the runner's independently derived trusted root,
   *  reusing `repoContext` / `validateClaimAgainstRoot` exactly as the other adapters do. */
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
    if (phase === 'post-action') {
      throw new Error('Copilot SDK post-action is observation-only and cannot produce a deny wire');
    }
    return copilotSdkDenyWire(findings, phase);
  }

  /**
   * parse → validate identity → decide, every failure CLOSED (deny), in order:
   *  1. `post-action` → `unsupported` (the SDK has no post-execution veto).
   *  2. parse failure → a fail-closed deny in the SDK reject wire.
   *  3. identity claim rejected → a fail-closed deny BEFORE any content evaluation.
   *  4. `end-of-turn` → delegate to the canonical git sweep, whose wire is already the SDK
   *     `onAgentStop` `{decision:"block",reason}` shape.
   *  5. `pre-action` + shell → the SAME `evaluate` engine over the reconstructed command.
   *  6. `pre-action` + file-edit → `unsupported` (content not surfaced; sweep is authority).
   *  7. `pre-action` + read/mcp/other → no Change → allow.
   */
  decide(raw: string, phase: SteeringPhase, defaultCwd?: string): SteeringResult {
    if (phase === 'post-action') {
      return { outcome: 'unsupported', detail: 'Copilot SDK has no post-execution veto; the end-of-turn onAgentStop sweep is the post-turn reconciliation.' };
    }
    const parsed = this.parseEvent(raw, phase);
    if ('failure' in parsed) {
      const findings = [steeringUnavailableFinding(`unparseable Copilot SDK permission request: ${parsed.detail}`)];
      const wire = this.denyPayload(findings, phase);
      return { outcome: 'parse-failure', detail: parsed.detail, wire, unavailableReason: 'parse-failure', decision: { verdict: 'deny', findings, reason: wire } };
    }
    const idv = this.validateIdentity(parsed.identity, defaultCwd);
    if (!idv.ok) {
      const findings = [steeringUnavailableFinding(`repository identity claim rejected: ${idv.rejected}`)];
      const wire = this.denyPayload(findings, phase);
      return { outcome: 'ok', wire, detail: idv.rejected, unavailableReason: 'identity-rejected', decision: { verdict: 'deny', findings, reason: wire } };
    }

    if (phase === 'end-of-turn') {
      const stopInput = copilotSdkStopInput(raw);
      if (typeof stopInput !== 'string') {
        const findings = [steeringUnavailableFinding(`unparseable Copilot SDK permission request: ${stopInput.detail}`)];
        const wire = this.denyPayload(findings, 'end-of-turn');
        return { outcome: 'parse-failure', detail: stopInput.detail, wire, unavailableReason: 'parse-failure', decision: { verdict: 'deny', findings, reason: wire } };
      }
      // Surface the canonical sweep's STRUCTURED findings (rule/file/line), not only the rendered
      // wire, so the host can bind a block to the protected target structurally rather than by parsing
      // human denial text (#616 item D). `stdout`/`wire` is unchanged.
      const swept = stopFromRaw(stopInput, defaultCwd, idv.trustedRoot);
      const findings = swept.findings ? [...swept.findings] : [];
      return { outcome: 'ok', wire: swept.stdout, decision: { verdict: swept.stdout ? 'deny' : 'allow', findings, reason: swept.stdout || undefined } };
    }

    // Track WHICH pre-action step is running, so a throw fails closed with a SANITIZED bounded cause
    // category (#616 item C) rather than only an opaque `tamperward-unavailable`. The category is the
    // code SITE, never parsed from the (possibly path-bearing) error text.
    let stage: UnavailableReason = 'repo-context';
    try {
      const root = idv.trustedRoot ?? repoRoot(defaultCwd ?? process.cwd());
      // Pin the Stop-sweep baseline at TURN START on EVERY pre-action call, regardless of kind, so
      // the end-of-turn sweep (the only real enforcement while preDeny is empty) compares against a
      // turn-start baseline — including for a file-edit the pre-action path deliberately allows through.
      stage = 'baseline';
      turnBaseline(root, parsed.identity.sessionId);

      const sessionCwd = parsed.identity.claimedCwd ?? defaultCwd ?? process.cwd();
      stage = 'policy-load';
      const policy = loadPolicy(root);

      // file-edit: reconstruct the proposed change from the write's surfaced content (diff /
      // newFileContents) and content-judge it. A write with NO usable content is unsupported for
      // this measured configuration (allow-through; the sweep is authority) — not a blanket deny.
      // A diff that cannot be reconstructed throws → fail-closed deny below.
      if (parsed.operation.kind === 'file-edit') {
        stage = 'reconstruction';
        const changes = sdkFileEditChanges(parsed.operation.args, root, sessionCwd);
        if (changes === null) return { outcome: 'unsupported', detail: FILE_EDIT_NO_CONTENT_DETAIL };
        stage = 'evaluate';
        const findings = evaluate(changes, policy, undefined, 'tool-call', { cwd: root }).filter((f) => f.severity === 'block');
        const wire = this.denyPayload(findings, 'pre-action');
        return { outcome: 'ok', wire, decision: { verdict: findings.length ? 'deny' : 'allow', findings, reason: wire || undefined } };
      }

      stage = 'reconstruction';
      const changes = changesFromCopilot(parsed.operation, root, sessionCwd);
      stage = 'evaluate';
      const findings = evaluate(changes, policy, undefined, 'tool-call', { cwd: root }).filter((f) => f.severity === 'block');
      const wire = this.denyPayload(findings, 'pre-action');
      return { outcome: 'ok', wire, decision: { verdict: findings.length ? 'deny' : 'allow', findings, reason: wire || undefined } };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const findings = [steeringUnavailableFinding(detail)];
      const wire = this.denyPayload(findings, 'pre-action');
      return { outcome: 'ok', wire, detail, unavailableReason: stage, decision: { verdict: 'deny', findings, reason: wire } };
    }
  }

  /** A transport failure or a required callback that did not fire → a fail-closed deny at the
   *  seam, through the adapter's own `denyPayload` so the wire is the SDK's native envelope. */
  failClosed(outcome: 'transport-failure' | 'not-invoked', detail: string, phase: SteeringPhase): SteeringResult {
    return failClosedResult(outcome, detail, phase, (f, p) => this.denyPayload(f, p));
  }
}

/** The singleton hosted-SDK adapter. */
export const copilotSdkAdapter = new CopilotSdkHostedAdapter();
