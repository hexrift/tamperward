// The TamperWard GitHub Copilot CLI hook driver used by the qualification probe (#598). It
// reads a Copilot hook payload on stdin, runs copilotAdapter.decide, writes the deny wire
// (empty = allow) to stdout, and APPENDS one line to the parent-owned ledger (TW_PROBE_LEDGER)
// recording what it saw and decided. The ledger is the probe's evidence: specIntact alone is
// never proof. Mirror of harness/adapters/probe-driver.mjs (the Codex driver).
//
// This is a REAL repo source file (not emitted at runtime) so esbuild resolves the adapter
// import deterministically when the probe bundles it.

import { readFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { copilotAdapter } from '../../src/adapters/copilot/adapter';

const phase = process.env.TW_COPILOT_PHASE === 'stop' ? 'end-of-turn' : 'pre-action';
const root = process.env.TW_COPILOT_ROOT || process.cwd();

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  raw = '';
}

let result;
let threw = '';
try {
  result = copilotAdapter.decide(raw, phase, root);
} catch (e) {
  threw = e && e.message ? e.message : String(e);
  // A throw must FAIL CLOSED at the wire, not just in the ledger: an empty stdout is an ALLOW
  // to the real Copilot runtime, so emit the adapter's native deny envelope so the recorded
  // deny is the deny the runtime actually saw.
  try {
    result = copilotAdapter.failClosed('transport-failure', `driver caught: ${threw}`, phase);
  } catch {
    result = { outcome: 'transport-failure', wire: '', decision: { verdict: 'deny' } };
  }
}
if (result.wire) process.stdout.write(result.wire);

const ledger = process.env.TW_PROBE_LEDGER;
if (ledger) {
  const sha = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
  let payload = {};
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    payload = {};
  }
  // Copilot has two documented wire formats: PascalCase (tool_name / tool_input / session_id)
  // and native camelCase (toolName / toolArgs-as-JSON-string / sessionId). Extract the evidence
  // fields from either so the ledger records the real tool/command whichever mode fired.
  const str = (v) => (typeof v === 'string' ? v : '');
  const toolName = str(payload.tool_name) || str(payload.toolName);
  const sessionId = str(payload.session_id) || str(payload.sessionId);
  let args = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : null;
  if (!args && typeof payload.toolArgs === 'string') {
    try {
      const decoded = JSON.parse(payload.toolArgs);
      if (decoded && typeof decoded === 'object') args = decoded;
    } catch {
      args = null;
    }
  } else if (!args && payload.toolArgs && typeof payload.toolArgs === 'object') {
    args = payload.toolArgs;
  }
  const command = args ? str(args.command) || str(args.input) : '';
  const entry = {
    caseId: process.env.TW_PROBE_CASE || '',
    event: phase === 'end-of-turn' ? 'Stop' : 'PreToolUse',
    tool: toolName,
    decision: threw ? 'error' : result.decision ? result.decision.verdict : result.wire ? 'deny' : 'allow',
    outcome: result.outcome ?? '',
    reasonHash: result.wire ? sha(result.wire) : '',
    sessionId,
    turnId: str(payload.turn_id) || str(payload.turnId),
    toolUseId: str(payload.tool_use_id) || str(payload.toolUseId),
    command,
    stopHookActive: payload.stop_hook_active === true,
    payloadHash: sha(raw),
    threw,
    ts: Date.now(),
  };
  try {
    appendFileSync(ledger, JSON.stringify(entry) + '\n');
  } catch {
    /* best effort — a lost ledger line surfaces as missing evidence, which fails the case */
  }
}

process.exit(0);
