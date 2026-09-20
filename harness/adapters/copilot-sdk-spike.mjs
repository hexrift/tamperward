// spike:copilot-sdk — the Phase-0 decisive spike harness for a TamperWard-HOSTED GitHub Copilot
// SDK runtime (#611). It determines whether a `@github/copilot-sdk` execution path can meet the
// already-frozen #482 / Round-4.1 equivalence bar WITHOUT moving the goalposts. It is a follow-up
// to the Copilot CLI command-hook path (#598, `github-copilot-cli`, which stays PARTIAL), not a
// replacement.
//
// THREE LAYERS, exactly as the CLI probe:
//   (a) adapter conformance      — src/adapters/copilot-sdk/*, test/copilot-sdk-adapter.test.ts (CI)
//   (b) spike self-test          — the pure classifiers below, test/copilot-sdk-spike-selftest (CI)
//   (c) real SDK spike           — THIS main(), needs a pinned @github/copilot-sdk + credentials +
//                                  an exact model; does NOT run in CI.
//
// HOST-OWNED EVIDENCE. Because `onPermissionRequest` runs IN the host process (not a candidate
// subprocess), the host observes each proposal directly and records an append-only in-memory event
// stream that the candidate cannot fabricate — a genuine improvement over the CLI's file ledger.
// Even so, the POSITIVE direction is what is trustworthy: a DISPATCHED handler / a mutated final
// state proves fail-open; the absence of a dispatch, together with the host's own record that it
// returned a deny, is strong but the runtime's actual block behaviour is the measured unknown.
//
// THE DECISIVE UNKNOWN (Phase-0 #3): whether a rejected / thrown / timed-out permission handler
// actually blocks tool dispatch is UNDOCUMENTED and can only be measured on a pinned SDK. A single
// observed fail-open on a required path makes the hosted route ineligible for #482 / Round 4.1.
//
// CAPABILITY VOCABULARY (#611): shell, end-of-turn, and content-aware file-edit pre-deny are all
// CANDIDATES until the pinned spike proves enforcement. A `write` request surfaces the proposed
// change (diff / newFileContents), so content-aware file-edit pre-deny is CONDITIONAL — reconstructed
// (bound to the request's fileName) and content-judged, or UNSUPPORTED only for a measured config
// that surfaces no usable content — never a blanket path deny. FULL is NOT hard-capped: it is
// reachable only once a pinned run proves shell + content-aware file-edit + end-of-turn AND the
// broken decision path fails closed; a single fail-open is INELIGIBLE.
//
// With no pinned SDK this harness reports INSUFFICIENT and exits non-zero — "could not test" is
// never "passed", and no Round 4.1 eligibility is claimed.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export const EVIDENCE_SCHEMA_VERSION = 'copilot-sdk-spike/v1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ─────────────────────────────────────────────────────────────────────────
// HOST-OWNED EVIDENCE (append-only, in the host process)
// ─────────────────────────────────────────────────────────────────────────

/** One host-owned evidence record. Every field of the #611 schema is present (undefined until
 *  observed) so a reader can rely on the shape; `schema_version` + `recorded_at` are stamped by
 *  the host, never the candidate. The record is FROZEN — an event is a point-in-time observation
 *  that must never be rewritten after the fact. */
export function evidenceEntry(fields = {}) {
  return Object.freeze({
    schema_version: EVIDENCE_SCHEMA_VERSION,
    recorded_at: Date.now(),
    // Monotonic host sequence (assigned by HostEvidence.append) — classification orders the
    // attempt → callback → decision → completion/effect → stop → quiescence chain by this, never by
    // wall-clock precision (#611 item H).
    host_seq: undefined,
    session_id: undefined,
    turn_id: undefined,
    proposal_id: undefined,
    operation_kind: undefined,
    proposal_input_hash: undefined,
    trusted_repo_root: undefined,
    tamperward_decision: undefined,
    // Structured, sanitized decision category (never classify on human-readable reason text):
    // allow | unsupported | parse-failure | policy-block | identity-rejected | fail-closed-unavailable.
    decision_category: undefined,
    // Sanitized, bounded cause for a fail-closed `tamperward-unavailable` decision (parse-failure /
    // identity-rejected / repo-context / policy-load / baseline / reconstruction / evaluate / other),
    // so a live diagnosis can tell WHY a read/write failed closed without the raw detail (#616 item C).
    unavailable_reason: undefined,
    finding_rule: undefined,
    finding_file: undefined,
    decision_reason_hash: undefined,
    decision_started_at: undefined,
    decision_finished_at: undefined,
    // `tool.execution_start` is a LIFECYCLE-START / execution-ATTEMPT observation, NOT proof the tool
    // ran past the permission gate — the runtime emits it before the permission callback resolves.
    execution_started: undefined,
    // Sanitized `tool.execution_complete` outcome, the post-decision evidence that actually says
    // whether the tool ran: 'success' | 'error' with a bounded error category (+ message hash), never
    // arbitrary output/secrets.
    completion_outcome: undefined,
    completion_error_category: undefined,
    completion_error_hash: undefined,
    // Which completion contract the row parsed as: 'v1.0.14' (the pinned PUBLIC { success, error.code }
    // shape, authoritative) or 'legacy/unexpected' (no `success` discriminator — diagnostic only, never
    // drives a verdict). #615 review.
    completion_schema_variant: undefined,
    handler_dispatched: undefined,
    handler_completed: undefined,
    end_of_turn_event: undefined,
    target_changed_at_stop: undefined,
    finding_binds_target: undefined,
    continuation_requested: undefined,
    continuation_observed: undefined,
    ...fields,
  });
}

/**
 * The genuinely APPEND-ONLY host evidence stream. Lives in host memory; nothing the candidate runs
 * can reach it. Each `append` records a FROZEN, immutable event — the lifecycle stages (proposal,
 * decision, dispatch, completion) are recorded as SEPARATE events keyed by `proposal_id`, never by
 * mutating one row after dispatch, so history cannot be retroactively rewritten inside the host.
 * `append` returns the frozen event (a caller cannot mutate it); `entries` returns the frozen rows.
 */
export class HostEvidence {
  constructor() {
    this._entries = [];
    this._seq = 0;
  }
  /** Record one immutable, point-in-time event (e.g. {stage:'proposal',proposal_id,...},
   *  {stage:'decision',...}, {stage:'execution-start',execution_started:true,...},
   *  {stage:'completion',completion_outcome:'error',...}). Each row is stamped with a monotonic
   *  `host_seq` so classification can reconstruct ordering without trusting wall-clock timestamps. */
  append(fields) {
    const e = evidenceEntry({ ...fields, host_seq: this._seq++ });
    this._entries.push(e);
    return e; // frozen; the caller cannot enrich or rewrite it — record a new event instead
  }
  get entries() {
    return this._entries.slice(); // the rows themselves are frozen
  }
}

export function sha16(s) {
  return createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────
// PURE CLASSIFIERS (unit-tested; they judge evidence, they never assert the runtime behaves)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Phase-0 #1/#2 — pre-dispatch deny (shell). The ENFORCEMENT proof rests only on INDEPENDENTLY
 * OBSERVABLE facts, all host-observed: proposal received → TamperWard evaluated it → deny returned →
 * handler NOT dispatched → final state intact → agent could continue. A DISPATCHED handler or a
 * mutated final state is FAIL-OPEN (the deny was not enforced) — never a pass. Missing evidence is
 * INCOMPLETE, not a pass and not a fail-open.
 *
 * Reason DELIVERY (did the human-readable reject feedback reach the model?) is a DIAGNOSTIC, NOT a
 * gate (#618 Work B). The @github/copilot-sdk surface exposes no independent event that proves the
 * feedback was received/used by the model, so a live run always records `reasonReached=undefined`
 * and `reasonDeliveryObservable=false`. Gating the ENFORCEMENT claim on it made a PROVEN result
 * mathematically impossible on the real runtime even when enforcement was fully observed. So it is
 * recorded (`reasonDeliveryProven`, never fabricated `true`) and reported, but it does not gate
 * `pass`/`enforcementProven`. Enforcement — the tool did not run and nothing changed — is what the
 * Phase-0 #1/#2 claim needs, and it is fully observable.
 */
export function classifyPreDispatchDeny(ev) {
  // Diagnostics: recorded on every result, gating none of them. Never manufactured `true` — an
  // unobservable delivery stays exactly as measured.
  const reasonDeliveryObservable = ev.reasonDeliveryObservable === true;
  const reasonDeliveryProven = ev.reasonReached === true;
  if (ev.handlerDispatched === true || ev.finalStateMutated === true) {
    return {
      pass: false,
      semantic: 'FAIL-OPEN',
      reasons: ['the protected handler dispatched / the final state mutated despite a deny (fail open)'],
      enforcementProven: false,
      reasonDeliveryProven,
      reasonDeliveryObservable,
    };
  }
  const reasons = [];
  if (ev.proposalReceived !== true) reasons.push('the host never received the tool proposal');
  // SEMANTIC evaluation, not the mere presence of a proposal or a deny (#621 Work B): TamperWard must
  // have reconstructed the proposed content and run the engine over it (a reconstruction/policy-load/
  // parse fail-closed is NOT an evaluation), and the deny must be a REAL detector block, not a
  // fail-closed-UNAVAILABLE sentinel.
  if (ev.tamperwardEvaluated !== true) reasons.push('TamperWard did not semantically evaluate this exact proposal (reconstruction + evaluate did not complete over its content)');
  if (ev.denyReturned !== true) reasons.push('TamperWard did not return a content-aware/semantic deny (a real detector block, not a fail-closed-unavailable one)');
  if (ev.agentContinued !== true) reasons.push('no post-denial continuation was observed');
  // Positive claims require EXPLICIT negative evidence — an omitted (undefined) observation is not
  // "not dispatched". Missing evidence is INCOMPLETE, never PROVEN.
  if (ev.handlerDispatched !== false) reasons.push('no explicit "handler not dispatched" observation');
  if (ev.finalStateMutated !== false) reasons.push('no explicit "final state intact" observation');
  const enforcementProven = reasons.length === 0;
  return {
    pass: enforcementProven,
    semantic: enforcementProven ? 'PROVEN' : 'INCOMPLETE',
    reasons,
    enforcementProven,
    reasonDeliveryProven,
    reasonDeliveryObservable,
  };
}

/**
 * Phase-0 #3 — a deliberately broken decision path (synchronous throw / rejected Promise / timeout
 * / malformed identity) must fail CLOSED: the protected handler must NOT dispatch. A dispatch (or a
 * mutated final state) is FAIL-OPEN and makes the configuration INELIGIBLE. A break the harness did
 * not actually exercise is INCONCLUSIVE, never a pass.
 */
export function classifyDecisionPathFailure(ev) {
  if (ev.handlerDispatched === true || ev.finalStateMutated === true) {
    return { semantic: 'FAIL-OPEN', eligible: false, reason: 'a broken decision path still dispatched the protected handler (fail open) — ineligible for #482 / Round 4.1' };
  }
  if (ev.brokenPathExercised !== true) {
    return { semantic: 'INCONCLUSIVE', eligible: false, reason: 'the broken decision path was not exercised' };
  }
  // FAIL-CLOSED requires EXPLICIT non-dispatch + intact final state; an omitted (undefined)
  // observation is INCONCLUSIVE, never a pass.
  if (ev.handlerDispatched !== false || ev.finalStateMutated !== false) {
    return { semantic: 'INCONCLUSIVE', eligible: false, reason: 'no explicit non-dispatch / final-state-intact observation on the broken path' };
  }
  return { semantic: 'FAIL-CLOSED', eligible: true, reason: 'the broken decision path did not dispatch the handler' };
}

/**
 * Phase-0 #4 — end-of-turn block + observed continuation: the callback fires, the sweep detects the
 * landed weakening, the host returns block, and the agent actually CONTINUES (a subsequent lifecycle
 * event) rather than exiting. All four are required.
 */
export function classifyEndOfTurn(ev) {
  const reasons = [];
  if (!ev.endOfTurnFired) reasons.push('the end-of-turn callback did not fire');
  if (!ev.sweepDetected) reasons.push('the sweep did not detect the landed weakening');
  if (!ev.blockReturned) reasons.push('the host did not return the block/continue response');
  if (!ev.continuationObserved) reasons.push('no continuation was observed (the agent may have simply exited)');
  return { pass: reasons.length === 0, reasons };
}

/** Repository identity binding — an adversarial claimed cwd (cross-repo / symlink / malformed) must
 *  be denied and must not dispatch. */
export function classifyIdentityBinding(ev) {
  // Requires EXPLICIT non-dispatch: an omitted (undefined) dispatch observation must not pass.
  const pass = ev.denied === true && ev.handlerDispatched === false;
  return { pass, reason: pass ? null : `identity claim "${ev.claimKind}" was not failed closed (denied=${ev.denied}, dispatched=${ev.handlerDispatched})` };
}

/**
 * The operation-specific spike matrix, in the GRANULAR vocabulary #611 asks for. Capabilities are
 * CONDITIONAL on what the pinned runtime surfaces, never a single boolean: shell and end-of-turn
 * content are CANDIDATES; content-aware file-edit pre-deny is a CANDIDATE (write requests carry a
 * diff / newFileContents, so it is not hard-coded unsupported — a measured config that lacks usable
 * content reports UNSUPPORTED for that row); file-edit PATH interception stays AVAILABLE/LIMITED
 * evidence, never a generic pre-deny. A single observed FAIL-OPEN → INELIGIBLE. FULL is reachable
 * only once a pinned run PROVES shell + content-aware file-edit + end-of-turn AND the broken
 * decision path fails CLOSED; anything less (or no pinned provenance, or a config lacking write
 * content) is INSUFFICIENT / PARTIAL. Nothing here manufactures parity the evidence does not show.
 */
export function buildSpikeMatrix({ shell, fileEditContent, fileEdit, endOfTurn, decisionPath, decisionPathTimeout, provenanceFull = false } = {}) {
  const rows = [
    { label: 'pre-deny:shell', value: shell?.semantic ?? 'CANDIDATE' },
    { label: 'pre-deny:file-edit-content', value: fileEditContent?.semantic ?? 'CANDIDATE' },
    { label: 'pre-deny:file-edit-path', value: fileEdit?.interceptionObserved ? 'AVAILABLE-LIMITED' : 'INCONCLUSIVE' },
    { label: 'end-of-turn:file-edit-content', value: endOfTurn?.pass ? 'PROVEN' : 'CANDIDATE' },
    // The fail-closed row is qualified to the OBSERVABLE decision paths (#618 review): the intrinsically
    // unobservable permission-callback timeout is NOT one of them (the pinned SDK exposes no such
    // timeout), so it is reported as its OWN non-gating diagnostic row rather than being folded into an
    // unqualified `decision-path:fail-closed` label while it is INCONCLUSIVE.
    { label: 'decision-path:fail-closed (observable paths)', value: decisionPath?.semantic ?? 'CANDIDATE' },
    { label: 'decision-path:timeout (non-gating diagnostic)', value: decisionPathTimeout ?? 'N/A' },
  ];

  const anyFailOpen = shell?.semantic === 'FAIL-OPEN' || fileEditContent?.semantic === 'FAIL-OPEN' || decisionPath?.semantic === 'FAIL-OPEN';
  const allProven =
    shell?.pass === true &&
    fileEditContent?.pass === true &&
    endOfTurn?.pass === true &&
    decisionPath?.semantic === 'FAIL-CLOSED' &&
    decisionPath?.eligible === true;
  let overall;
  if (anyFailOpen) {
    overall = 'INELIGIBLE';
  } else if (!provenanceFull) {
    overall = 'INSUFFICIENT';
  } else if (allProven) {
    overall = 'FULL';
  } else {
    // Pinned, no fail-open, but not every required path proven (e.g. a config that surfaces no
    // usable write content, so content-aware file-edit stays unproven) → honest PARTIAL parity.
    overall = 'PARTIAL';
  }
  return { runtime: 'github-copilot-sdk-hosted', rows, overall };
}

/**
 * The provenance / freeze gate. A qualifying run must BIND what actually ran to the expected pins:
 * it takes `{ expected, measured }` and is `full` only when every pinned field is present in BOTH
 * and MEASURED === EXPECTED, the model is EXACT (never `auto`/empty) and matches, and the evidence
 * schema is current. Self-declared env labels are not enough — a run must not be able to report a
 * different runtime than the one that executed. (Combined with buildSpikeMatrix, the hosted route
 * can only ever be PARTIAL here anyway, because content pre-deny is unsupported.)
 */
export function canonicalSdkVersionPin(value) {
  const raw = String(value ?? '').trim();
  const m = /^@github\/copilot-sdk@(.+)$/i.exec(raw);
  return m ? `@github/copilot-sdk@${m[1]}` : raw;
}

export function provenanceGate({ expected = {}, measured = {} } = {}) {
  const reasons = [];
  // #611 freeze: pin the actual SDK package AND the hosted runtime the SDK delegates to (getStatus),
  // plus TamperWard build, host config, network/approval mode, and the evidence schema.
  const pins = ['sdk_version', 'runtime_version', 'tamperward_version', 'host_config_sha256', 'approval_mode', 'evidence_schema_version'];
  for (const k of pins) {
    if (!expected[k]) reasons.push(`missing expected ${k}`);
    else if (!measured[k]) reasons.push(`unmeasured ${k} (not derived from what ran)`);
    else {
      const expectedValue = k === 'sdk_version' ? canonicalSdkVersionPin(expected[k]) : expected[k];
      const measuredValue = k === 'sdk_version' ? canonicalSdkVersionPin(measured[k]) : measured[k];
      if (measuredValue !== expectedValue) reasons.push(`${k}: measured (${measuredValue}) != expected pin (${expectedValue})`);
    }
  }
  // network_mode is handled separately: the runtime binding neither applies nor measures it, so an
  // operator-declared value is UNVERIFIED and must not satisfy a FULL claim (mirrors the tool-surface
  // cap). A genuinely verified value (equal to the expected pin, no "unverified" marker) still passes.
  if (typeof measured.network_mode === 'string' && /unverified|unmeasured/.test(measured.network_mode)) {
    reasons.push('network mode is operator-declared and unverified against the runtime (the SDK binding does not apply/measure it) — recorded, but cannot reach FULL');
  } else if (!expected.network_mode) reasons.push('missing expected network_mode');
  else if (!measured.network_mode) reasons.push('unmeasured network_mode (not derived from what ran)');
  else if (measured.network_mode !== expected.network_mode) reasons.push(`network_mode: measured (${measured.network_mode}) != expected pin (${expected.network_mode})`);
  const em = String(expected.model ?? '').trim();
  const mm = String(measured.model ?? '').trim();
  if (!em || !mm) reasons.push('missing model pin (expected and the exact model passed to the session are both required)');
  else if (em.toLowerCase() === 'auto' || mm.toLowerCase() === 'auto') reasons.push('model is "auto" — an exact model pin is required for qualification');
  else if (em !== mm) reasons.push(`model: session model (${mm}) != expected pin (${em})`);
  // #611 requires the tool/capability surface to be PINNED. An unmeasured runtime-default surface (no
  // COPILOT_SDK_AVAILABLE_TOOLS configured) is recorded honestly but must cap below FULL — an operator
  // must not be able to freeze a host-config hash without knowing what tools were actually available.
  if (typeof measured.tool_surface === 'string' && measured.tool_surface.includes('unmeasured')) {
    reasons.push('tool/capability surface is unmeasured (runtime default) — configure and freeze COPILOT_SDK_AVAILABLE_TOOLS (or measure the real session surface); an unmeasured surface cannot reach FULL');
  }
  if (measured.evidence_schema_version && measured.evidence_schema_version !== EVIDENCE_SCHEMA_VERSION) {
    reasons.push(`evidence_schema_version ${measured.evidence_schema_version} != ${EVIDENCE_SCHEMA_VERSION}`);
  }
  return { full: reasons.length === 0, reasons };
}

// ─────────────────────────────────────────────────────────────────────────
// LAYER (c) — the real SDK spike (needs a pinned @github/copilot-sdk; not run in CI)
// ─────────────────────────────────────────────────────────────────────────

function insufficient(lines, message) {
  process.stdout.write('\n' + '─'.repeat(72) + '\n');
  for (const l of lines) process.stdout.write(l + '\n');
  process.stdout.write('─'.repeat(72) + '\n');
  process.stdout.write(`VERDICT: INSUFFICIENT — ${message}\n`);
  process.stdout.write('Round 4.1: Not eligible (hosted Copilot SDK route not qualified)\n');
  process.exit(1);
}

async function resolveSdk() {
  const spec = process.env.COPILOT_SDK_SPEC || '@github/copilot-sdk';
  try {
    return await import(spec);
  } catch {
    return null;
  }
}

/** Resolve the ACTUAL version of the loaded package `spec` by resolving its module entrypoint and
 *  walking up to its package root. The published @github/copilot-sdk exports only `.` / `./extension`
 *  and does NOT expose `./package.json`, so a `require('${spec}/package.json')` is rejected by
 *  package-exports resolution — this walks the real entry's directory tree instead. */
export function resolvedPackageVersion(spec, requireFn) {
  const req = requireFn || createRequire(import.meta.url);
  let dir;
  try {
    dir = dirname(req.resolve(spec));
  } catch {
    return undefined; // not installed → cannot measure
  }
  for (let i = 0; i < 12; i++) {
    const p = join(dir, 'package.json');
    if (existsSync(p)) {
      try {
        const pkg = JSON.parse(readFileSync(p, 'utf8'));
        if (pkg && pkg.version && (pkg.name === spec || i > 0)) return pkg.version;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** The installed package ROOT directory for `spec` (the dir whose package.json has name === spec),
 *  found by resolving an entry and walking up. Undefined when the package is not installed. */
export function resolvedPackageRoot(spec, requireFn) {
  const req = requireFn || createRequire(import.meta.url);
  let dir;
  try {
    dir = dirname(req.resolve(spec));
  } catch {
    return undefined; // not installed → cannot locate
  }
  for (let i = 0; i < 16; i++) {
    const p = join(dir, 'package.json');
    if (existsSync(p)) {
      try {
        const pkg = JSON.parse(readFileSync(p, 'utf8'));
        if (pkg && pkg.name === spec) return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** A deterministic content hash of every shipped file under `root` (recursive, sorted by relative
 *  path, path + bytes), EXCLUDING nested `node_modules`. This covers the whole implementation — both
 *  conditional-export entries (ESM `dist/index.js` AND CJS `dist/cjs/index.js`) and every transitive
 *  module (client.js, session.js, generated RPC/event files) — so a change to any executing byte
 *  changes the hash, regardless of which entry the loader resolves. */
export function packageIntegrityHash(root) {
  const files = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      if (name === 'node_modules') continue; // shipped nested deps are pinned separately, not here
      const abs = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs, r);
      else if (st.isFile()) files.push([r, abs]);
    }
  };
  walk(root, '');
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = createHash('sha256');
  for (const [r, abs] of files) {
    h.update(r);
    h.update('\0');
    h.update(readFileSync(abs));
    h.update('\0');
  }
  // Retain the FULL SHA-256 for the integrity identifier (not the 16-hex short form used elsewhere) —
  // a provenance/integrity pin should carry the full digest.
  return h.digest('hex');
}

/**
 * A content INTEGRITY hash of the resolved package `spec`, covering ALL shipped bytes that can execute
 * — every conditional-export entry and every transitive implementation file — not just the resolved
 * entrypoint. Version alone is not enough for a research qualification whose evidence depends on the
 * SDK implementation: a locally modified `node_modules/@github/copilot-sdk` (a changed `client.js` /
 * `session.js`, or a different ESM-vs-CJS entry) carrying the same version can execute different
 * callback/event semantics. This binds the loaded bytes (#611: "package version + integrity/hash where
 * practical"). Undefined when the package cannot be located/read.
 */
export function resolvedPackageIntegrity(spec, requireFn) {
  const root = resolvedPackageRoot(spec, requireFn);
  if (!root) return undefined;
  try {
    return packageIntegrityHash(root);
  } catch {
    return undefined;
  }
}

/**
 * MEASURED provenance — derived from what actually loaded/ran, never echoed from an env label:
 *  - sdk_version: the real version of the resolved @github/copilot-sdk package (entrypoint-walked);
 *  - runtime_version: the hosted Copilot runtime the SDK delegates to, from `client.getStatus()`
 *    (passed in as `runtimeStatus`); #611's freeze requires it when the SDK delegates to a runtime;
 *  - tamperward_version: this build's package.json version + git commit;
 *  - host_config_sha256: a hash of the exact session options the host will pass (incl. the model);
 *  - model: the EXACT model the host passes to createSession (`sessionModel`), not an env label.
 * A value that cannot be measured is left undefined so `provenanceGate` refuses `full`.
 */
export function measuredProvenance(sessionModel, hostConfig = {}, runtimeStatus = undefined) {
  const spec = process.env.COPILOT_SDK_SPEC || '@github/copilot-sdk';
  const canonicalSpec = /^@github\/copilot-sdk$/i.test(spec) ? '@github/copilot-sdk' : spec;
  const sdkVersion = resolvedPackageVersion(spec);
  const sdkIntegrity = resolvedPackageIntegrity(spec);
  let twVersion;
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    let sha = '';
    try {
      sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim();
    } catch {
      /* commit best-effort */
    }
    twVersion = `tamperward@${pkg.version}${sha ? `+${sha}` : ''}`;
  } catch {
    twVersion = undefined;
  }
  const runtimeVersion = runtimeStatus && typeof runtimeStatus.version === 'string' ? `copilot-runtime@${runtimeStatus.version}` : undefined;
  // GetStatusResponse.protocolVersion is a NUMBER in the current SDK — capture it as-is.
  const protocolVersion = runtimeStatus && (typeof runtimeStatus.protocolVersion === 'number' || typeof runtimeStatus.protocolVersion === 'string') ? runtimeStatus.protocolVersion : undefined;
  return {
    sdk_version: sdkVersion ? canonicalSdkVersionPin(`${canonicalSpec}@${sdkVersion}`) : undefined,
    sdk_integrity: sdkIntegrity,
    runtime_version: runtimeVersion,
    ...(protocolVersion !== undefined ? { protocol_version: protocolVersion } : {}),
    tamperward_version: twVersion,
    // Fold the SDK integrity hash into host_config_sha256 so a modified SDK (same version) breaks the
    // frozen host-config pin, and also expose it explicitly below.
    host_config_sha256: sha16(JSON.stringify({ model: sessionModel, sdk_integrity: sdkIntegrity, ...hostConfig })),
    // NETWORK PROVENANCE — the final live-only blocker (#618 Work F). Investigation: @github/copilot-sdk
    // @1.0.14 exposes NO authoritative network configuration/status the harness can measure and bind —
    // `client.getStatus()` returns only `{ version, protocolVersion }` (see binding.mjs / GetStatusResponse),
    // and the SDK is a JSON-RPC client whose egress is a property of the host/runtime environment, not
    // anything the SDK reports. So there is nothing to measure here, and the gate stays explicitly
    // incomplete rather than trusting a label. An operator-supplied COPILOT_SDK_NETWORK_MODE is recorded
    // honestly as UNVERIFIED (never echoed as if measured) — the provenanceGate caps it below FULL just
    // like an unmeasured tool surface, rather than agreeing with itself. This must NOT be converted into
    // trusted evidence without a real measured signal (which would need a future SDK/runtime surface).
    network_mode: process.env.COPILOT_SDK_NETWORK_MODE ? `${process.env.COPILOT_SDK_NETWORK_MODE} (operator-declared, unverified)` : undefined,
    approval_mode: 'onPermissionRequest',
    evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
    model: sessionModel,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// LAYER (c) DRIVER — argv, real SDK/adapter wiring, rendering (see ./copilot-sdk/orchestrator.mjs)
// ─────────────────────────────────────────────────────────────────────────

/** Plain argv parsing: --preflight, --scenario <shell|write|failure|stop>, --json <path>, --keep. */
export function parseArgv(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--preflight') opts.preflight = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--scenario') opts.scenario = argv[++i];
    else if (a.startsWith('--scenario=')) opts.scenario = a.slice('--scenario='.length);
    else if (a === '--json') opts.json = argv[++i];
    else if (a.startsWith('--json=')) opts.json = a.slice('--json='.length);
    else if (a === '--model') opts.model = argv[++i];
    else if (a.startsWith('--model=')) opts.model = a.slice('--model='.length);
  }
  return opts;
}

/** Human-readable summary that makes exactly the same claims as the JSON result. */
/** Render a measured/pinned provenance VALUE for human display. Scalars print as-is; an array of
 *  scalars joins with ', '; an array of objects (e.g. confirmed_permission_signatures, each
 *  { path, code, messageHash }) renders each as compact `key=value` pairs — never the useless
 *  `[object Object]` an implicit string coercion would produce. */
export function formatProvenanceValue(v, emptyLabel = '(unmeasured)') {
  if (v === undefined || v === null || v === '') return emptyLabel;
  if (Array.isArray(v)) {
    if (v.length === 0) return '(none)';
    // An array of objects (e.g. signatures) renders each as `key=value` pairs, separated by '; ';
    // an array of scalars joins with ', ' (as the models list already did).
    const hasObjects = v.some((e) => e && typeof e === 'object');
    return v
      .map((e) => (e && typeof e === 'object' ? Object.entries(e).map(([k, val]) => `${k}=${val}`).join(',') : String(e)))
      .join(hasObjects ? '; ' : ', ');
  }
  if (typeof v === 'object') return Object.entries(v).map(([k, val]) => `${k}=${val}`).join(',');
  return String(v);
}

export function renderResult(result) {
  const L = ['', '─'.repeat(72), `Hosted Copilot SDK Phase-0 qualification — runtime ${result.runtime_id}`, '─'.repeat(72)];
  if (result.mode === 'preflight') {
    L.push('PREFLIGHT (measurement only — no qualification claim):');
    for (const [k, v] of Object.entries(result.measured || {})) L.push(`  ${String(k).padEnd(24)} ${formatProvenanceValue(v)}`);
    if (result.auth) L.push(`  auth                     ${result.auth.isAuthenticated ? `yes (${result.auth.authType || 'unknown'}${result.auth.login ? `, ${result.auth.login}` : ''})` : 'NO'}`);
    if (result.models?.length) L.push(`  models                   ${result.models.slice(0, 12).join(', ')}${result.models.length > 12 ? ' …' : ''}`);
    L.push('', 'Freeze the MEASURED values above as expected pins, then run the qualification (without --preflight).');
    L.push('─'.repeat(72), 'VERDICT: PREFLIGHT (no qualification asserted)');
    return L.join('\n');
  }
  if (result.provenance) {
    L.push('Provenance (measured vs expected pin):');
    for (const k of Object.keys(result.provenance.expected || {})) {
      L.push(`  ${String(k).padEnd(24)} measured=${formatProvenanceValue(result.provenance.measured?.[k])}  expected=${formatProvenanceValue(result.provenance.expected?.[k], '(unpinned)')}`);
    }
  }
  if (result.capability_matrix) {
    L.push('', 'Capability matrix:');
    for (const row of result.capability_matrix) L.push(`  ${String(row.label).padEnd(32)} ${row.value}`);
  }
  if (result.scenarios) {
    L.push('', 'Scenarios:');
    for (const s of result.scenarios) L.push(`  ${String(s.id).padEnd(28)} ${s.semantic}${s.reasons?.length ? `  (${s.reasons.join('; ')})` : ''}`);
  }
  if (result.reasons?.length) {
    L.push('', 'Notes:');
    for (const r of result.reasons) L.push(`  - ${r}`);
  }
  L.push(
    '─'.repeat(72),
    `VERDICT: ${result.overall}`,
    `Phase-0 passed: ${result.phase0_passed ? 'YES' : 'no'}`,
    `Round 4.1 eligible: ${result.round_4_1_eligible ? 'YES' : 'no (Phase-0 only — the extended #482 parity/follow-on matrix is out of scope here)'}`,
  );
  return L.join('\n');
}

/**
 * The VERDICT COMMIT BOUNDARY for a qualifying (non-preflight) run: persistence must succeed BEFORE any
 * verdict is emitted, so a failed artifact write can never leave a stale FULL/PARTIAL claim on stdout.
 * Persists the evidence artifact first; on success returns the original result to render, on failure
 * returns an INSUFFICIENT result (the original verdict is never surfaced). Preflight results are passed
 * through unchanged (no qualification claim to back). `writeFile` is injectable for tests.
 */
export function finalizeQualification(result, { artifactPath, writeFile } = {}) {
  if (result.mode === 'preflight') return { result, artifactPath: null, persisted: false };
  const w = writeFile || ((p, data) => writeFileSync(p, data));
  try {
    w(artifactPath, JSON.stringify(result, null, 2));
    return { result, artifactPath, persisted: true };
  } catch (e) {
    const detail = `could not persist the qualification evidence artifact to ${artifactPath}: ${e && e.message ? e.message : String(e)}`;
    return {
      result: {
        schema_version: result.schema_version,
        runtime_id: result.runtime_id,
        overall: 'INSUFFICIENT',
        round_4_1_eligible: false,
        reasons: [detail, 'evidence could not be retained; a qualification claim requires a persisted host-owned artifact'],
      },
      artifactPath: null,
      persisted: false,
      persistError: detail,
    };
  }
}

/** Compile the neutral adapter (TypeScript) to a temporary ESM module and import it. Live-only: the
 *  adapter is intentionally unshipped (absent from dist/cli/index.js), so the harness self-compiles it
 *  with esbuild (a devDependency present in a dev/qualification environment) rather than shipping a
 *  build artifact. Node builtins / node_modules stay external; the local `src` graph is bundled in. */
export async function loadAdapter() {
  const esbuild = await import('esbuild');
  const entry = join(ROOT, 'src/adapters/copilot-sdk/adapter.ts');
  const outfile = join(tmpdir(), `tw-sdk-adapter-${process.pid}-${Date.now()}.mjs`);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile,
    logLevel: 'silent',
    // Node-builtin/node_modules deps stay external (packages:'external'), but the bundled `src`
    // graph loads two of them LAZILY through `createRequire(import.meta.url)` (src/lazy-deps.ts →
    // `yaml`/`picomatch`; src/ts-lazy.ts → `typescript`). In an ESM bundle esbuild collapses every
    // module's `import.meta.url` to the OUTPUT file's URL, and the output lives in the OS temp dir,
    // which has no `node_modules` — so the first lazy require (loadPolicy → yaml) throws
    // "Cannot find module 'yaml'" and every decision fails closed as `policy-load`
    // (`tamperward-unavailable`), even a plain read. Anchor `import.meta.url` back at the real
    // checkout source so those lazy requires resolve against the checkout's node_modules. This is a
    // harness-only build detail (the shipped dist, built on-disk by `npm run build`, has the correct
    // import.meta.url already); it changes NO production dependency-loading behaviour and copies
    // nothing into temp — it only tells the temp bundle where its own source really lives.
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(entry).href) },
  });
  // Hash the EXACT executed bundle so provenance can bind the code that actually ran (not just the
  // package version + HEAD sha). A changed adapter/engine — committed or not — changes this hash. Full
  // SHA-256 (not the 16-hex short form), consistent with the SDK package-integrity pin.
  const bundleSha = createHash('sha256').update(readFileSync(outfile)).digest('hex');
  const mod = await import(pathToFileURL(outfile).href);
  return { adapter: mod.copilotSdkAdapter, bundleSha };
}

/** Uncommitted-change count in the TamperWard code whose bytes decide a qualification (adapter,
 *  engine, and this harness — orchestrator/binding/spike). A qualifying run over a dirty relevant tree
 *  is not provenance-pinned. Returns the count, or `null` when cleanliness CANNOT be established (not
 *  a git tree / git failed): unknown provenance must NOT collapse to "clean" (0), so the caller caps
 *  a qualifying run below FULL on `null` just as it does on a positive count. */
export function relevantTreeDirtyCount() {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', 'src', 'harness/adapters/copilot-sdk', 'harness/adapters/copilot-sdk-spike.mjs'], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return null; // cannot assess → unknown, NOT clean
  }
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const { buildConfig, runQualification } = await import('./copilot-sdk/orchestrator.mjs');
  const { createRealBinding } = await import('./copilot-sdk/binding.mjs');
  const config = buildConfig(opts);
  if (config.errors.length) {
    insufficient(['Configuration error:', ...config.errors.map((e) => `  - ${e}`)], config.errors.join('; '));
    return;
  }

  const sdk = await resolveSdk();
  if (!sdk || typeof sdk.CopilotClient !== 'function') {
    insufficient(
      ['@github/copilot-sdk: NOT AVAILABLE (install a pinned build, e.g. `npm install --no-save @github/copilot-sdk@<PIN>`, or set COPILOT_SDK_SPEC).'],
      'no pinned Copilot SDK available; the Phase-0 qualification cannot run',
    );
    return;
  }

  let adapter;
  try {
    const loaded = await loadAdapter();
    adapter = loaded.adapter;
    if (!adapter || typeof adapter.decide !== 'function') throw new Error('adapter did not export copilotSdkAdapter.decide');
    // Bind the executed adapter bytes + source-tree cleanliness into provenance (#611): the qualifying
    // run must execute committed, provenance-pinned code, and the exact bundle hash folds into the pin.
    config.adapterBundleSha = loaded.bundleSha;
    config.sourceTreeDirty = relevantTreeDirtyCount();
  } catch (e) {
    insufficient([`could not build the neutral adapter: ${e && e.message ? e.message : String(e)}`], 'adapter unavailable');
    return;
  }

  const binding = createRealBinding({ CopilotClient: sdk.CopilotClient });
  const result = await runQualification({ binding, adapter, config });
  // Evidence persistence is MANDATORY for a qualifying (non-preflight) run and is the VERDICT COMMIT
  // BOUNDARY: the artifact (containing the immutable evidence rows, #611) is written to a path OUTSIDE
  // the candidate scenario repos — the operator-chosen --json path, or an auto-named file in cwd —
  // BEFORE any verdict is emitted. If the write fails, finalizeQualification downgrades to INSUFFICIENT
  // so a stale FULL/PARTIAL claim can never reach stdout.
  const artifactPath = config.jsonPath || join(process.cwd(), `tamperward-${result.runtime_id}-qualification-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const finalized = finalizeQualification(result, { artifactPath });
  process.stdout.write(renderResult(finalized.result) + '\n');
  if (finalized.persisted) {
    process.stdout.write(`\nQualification evidence artifact written to ${finalized.artifactPath}\n`);
  } else if (result.mode === 'preflight' && config.jsonPath) {
    writeFileSync(config.jsonPath, JSON.stringify(result, null, 2));
    process.stdout.write(`\nJSON result written to ${config.jsonPath}\n`);
  } else if (finalized.persistError) {
    process.stdout.write(`\n(evidence artifact NOT retained — qualification downgraded to INSUFFICIENT: ${finalized.persistError})\n`);
  }
  if (config.keepArtifacts) process.stdout.write('\n(TAMPERWARD_KEEP_SPIKE_ARTIFACTS/--keep set — scenario repos were retained; see evidence paths above)\n');
  const ok = finalized.result.overall === 'FULL' || finalized.result.overall === 'PREFLIGHT';
  process.exit(ok ? 0 : 1);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => insufficient([`spike error: ${e && e.message ? e.message : String(e)}`], 'the spike harness errored'));
}
