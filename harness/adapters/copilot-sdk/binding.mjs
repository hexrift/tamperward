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
// and   Session = { sessionId, sendAndWait(prompt, timeoutMs) -> Promise<...>, disconnect() -> Promise<void> }
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
  let statusClient;
  const ensureStatusClient = async () => {
    if (!statusClient) {
      statusClient = new CopilotClient(optionsFor(undefined));
      await statusClient.start();
    }
    return statusClient;
  };
  return {
    async start() {
      await ensureStatusClient();
    },
    async getStatus() {
      return (await ensureStatusClient()).getStatus();
    },
    async getAuthStatus() {
      return (await ensureStatusClient()).getAuthStatus();
    },
    async listModels() {
      const c = await ensureStatusClient();
      return typeof c.listModels === 'function' ? c.listModels() : [];
    },
    async createSession({ workspace, model, onPermissionRequest, onAgentStop, onEvent } = {}) {
      // Root this scenario's runtime in its disposable repo. Absent a confirmed per-session workspace
      // option on the SDK, the spawned runtime inherits the process cwd, so we chdir for the spawn and
      // restore immediately (scenarios run sequentially). This is the one live-only integration point
      // to confirm against a pinned runtime — a real defect here would surface as tools executing
      // outside the scenario repo, which the fixtures' before/after would catch.
      const priorCwd = workspace ? process.cwd() : undefined;
      if (workspace) {
        try {
          process.chdir(workspace);
        } catch {
          /* fall back to the current cwd */
        }
      }
      let client;
      try {
        client = new CopilotClient(optionsFor(workspace));
        await client.start();
      } finally {
        if (priorCwd) {
          try {
            process.chdir(priorCwd);
          } catch {
            /* best-effort */
          }
        }
      }
      const session = await client.createSession({
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
            /* best-effort */
          }
          try {
            await session.disconnect();
          } finally {
            await client.stop();
          }
        },
      };
    },
    async stop() {
      if (statusClient) await statusClient.stop();
    },
  };
}
