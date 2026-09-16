// The TamperWard Codex hook driver used by the qualification probe. It reads a Codex hook
// payload on stdin, runs codexAdapter.decide, writes the deny wire (empty = allow) to
// stdout, and APPENDS one line to the parent-owned ledger (TW_PROBE_LEDGER) recording what
// it saw and decided. The ledger is the probe's evidence: specIntact alone is never proof.
//
// This is a REAL repo source file (not emitted at runtime) so esbuild resolves the adapter
// import deterministically when the probe bundles it.

import { readFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { codexAdapter } from '../../src/adapters/codex/adapter';

const phase = process.env.TW_CODEX_PHASE === 'stop' ? 'end-of-turn' : 'pre-action';
const root = process.env.TW_CODEX_ROOT || process.cwd();

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  raw = '';
}

let result;
let threw = '';
try {
  result = codexAdapter.decide(raw, phase, root);
} catch (e) {
  threw = e && e.message ? e.message : String(e);
  result = { outcome: 'transport-failure', wire: '', decision: { verdict: 'deny' } };
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
  const entry = {
    caseId: process.env.TW_PROBE_CASE || '',
    event: phase === 'end-of-turn' ? 'Stop' : 'PreToolUse',
    tool: typeof payload.tool_name === 'string' ? payload.tool_name : '',
    decision: threw ? 'error' : result.decision ? result.decision.verdict : result.wire ? 'deny' : 'allow',
    outcome: result.outcome ?? '',
    reasonHash: result.wire ? sha(result.wire) : '',
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : '',
    turnId: typeof payload.turn_id === 'string' ? payload.turn_id : '',
    toolUseId: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : '',
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
