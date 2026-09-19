// The thin, replaceable seam between the real `@github/copilot-sdk` and the SDK-agnostic Phase-0
// orchestrator (#611, layer c). Everything the orchestrator needs from a Copilot runtime is expressed
// as this small binding contract, so the decisive scenario logic is written ONCE and driven either by
// the real SDK (live, credentialed) or by a deterministic fake (CI). This is the ONLY module that
// touches SDK-specific symbols, so reconciling with a new SDK version is a local change here.
//
// Binding contract (see createRealBinding for the real mapping):
//   binding.start()            -> Promise<void>            connect / spawn the hosted runtime
//   binding.getStatus()        -> Promise<{version, protocolVersion}>   MEASURED runtime provenance
//   binding.getAuthStatus()    -> Promise<{isAuthenticated, authType?, login?, ...}>  (no secrets)
//   binding.listModels?()      -> Promise<ModelInfo[]>     optional, for --preflight
//   binding.createSession(cfg) -> Promise<Session>
//   binding.stop()             -> Promise<void>
// where cfg = { workspace, model, onPermissionRequest(request, invocation), onAgentStop(input, invocation), onEvent(event) }
// and   Session = { sessionId, sendAndWait(prompt, timeoutMs) -> Promise<...>,
//                   disconnect() -> Promise<{ quiesced: boolean, error?: string }> }
// `disconnect()` quiesces the runtime (abort + disconnect) and REPORTS whether it succeeded, so the
// caller can refuse to treat post-turn state as authoritative when the runtime could not be stopped.
//
// `workspace` is the disposable scenario repository the session's tools operate in — each scenario
// runs in its own repo so one cannot perturb another. `onPermissionRequest` receives the SDK's raw
// PermissionRequest and returns an SDK-native PermissionRequestResult ({ kind: "reject", feedback } |
// { kind: "approve-once" } | ...). `onAgentStop` returns { decision: "block", reason } | void.
// `onEvent` receives raw session events; the orchestrator normalizes them itself.

/**
 * Map a live `@github/copilot-sdk` into the binding contract. `CopilotClient` is the SDK's client
 * class. `makeClientOptions(workspace)` builds the constructor options for a client, given the
 * scenario workspace — the harness uses this to root each scenario's runtime in its own repository;
 * pass a factory that sets the runtime's working directory for `workspace` (the one live-only
 * integration point to confirm against a pinned runtime — see docs/guide/runtime-adapters.md). A
 * fresh client is spawned per session so scenarios stay isolated; a shared client answers
 * status/auth/model queries for provenance and --preflight.
 */
export function createRealBinding({ CopilotClient, makeClientOptions } = {}) {
  if (typeof CopilotClient !== 'function') {
    throw new Error('createRealBinding requires the SDK CopilotClient class');
  }
  const optionsFor = typeof makeClientOptions === 'function' ? makeClientOptions : () => ({});
  // ONE client answers provenance (getStatus/getAuthStatus) AND runs every scenario session, so the
  // measured runtime/protocol is exactly the runtime that executes the scenarios (#611). Per-scenario
  // isolation comes from the SDK's per-session `workingDirectory`, not a fresh client per session.
  let client;
  const ensureClient = async () => {
    if (!client) {
      client = new CopilotClient(optionsFor(undefined));
      await client.start();
    }
    return client;
  };
  return {
    async start() {
      await ensureClient();
    },
    async getStatus() {
      return (await ensureClient()).getStatus();
    },
    async getAuthStatus() {
      return (await ensureClient()).getAuthStatus();
    },
    async listModels() {
      const c = await ensureClient();
      return typeof c.listModels === 'function' ? c.listModels() : [];
    },
    async createSession({ workspace, model, availableTools, onPermissionRequest, onAgentStop, onEvent } = {}) {
      const c = await ensureClient();
      // Root this scenario in its disposable repo via the SDK's per-session `workingDirectory` option,
      // so each scenario's tools operate only inside its own repo. This is the one live-only
      // integration point to confirm against a pinned runtime; a defect would surface as tools
      // executing outside the scenario repo, which the fixtures' before/after would catch.
      const session = await c.createSession({
        ...(workspace ? { workingDirectory: workspace } : {}),
        ...(availableTools && availableTools.length ? { availableTools } : {}),
        model,
        onPermissionRequest,
        hooks: onAgentStop ? { onAgentStop } : undefined,
      });
      const unsubscribe = typeof session.on === 'function' && onEvent ? session.on((event) => onEvent(event)) : () => {};
      return {
        sessionId: session.sessionId,
        async sendAndWait(prompt, timeoutMs) {
          return session.sendAndWait(prompt, timeoutMs);
        },
        async disconnect() {
          try {
            unsubscribe();
          } catch {
            /* best-effort — event unsubscription is not part of runtime quiescence */
          }
          // A `sendAndWait` timeout does NOT abort in-flight agent work (per the SDK docs), so
          // deterministically quiesce the session — abort any running turn, then release it — before
          // the caller reads final state. The shared client stays up for the remaining scenarios.
          //
          // Quiescence is part of the trusted OBSERVATION BOUNDARY: if abort/disconnect fails, the
          // runtime may still be active and could mutate the workspace AFTER we read "final" state, so
          // we must NOT swallow the failure. Return a structured quiescence result the orchestrator
          // records as host evidence and uses to cap the scenario (never PROVEN/FAIL-CLOSED on a
          // runtime we could not prove had stopped).
          try {
            if (typeof session.abort === 'function') await session.abort();
            await session.disconnect();
          } catch (e) {
            return { quiesced: false, error: e instanceof Error ? e.message : String(e) };
          }
          return { quiesced: true };
        },
      };
    },
    async stop() {
      if (client) await client.stop();
    },
  };
}
