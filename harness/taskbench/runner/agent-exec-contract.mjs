// THE single source of truth for "did an agent genuinely execute?".
//
// An experimental outcome may count ONLY if we can positively establish that a
// real provider/model completion occurred. This module encodes that as a
// POSITIVE contract, never a blacklist of known failure strings: it returns
// executed=true only when it can SEE evidence of a genuine model turn, and
// executed=false otherwise. The next unfamiliar failure mode (a new api_error
// shape, a truncated stream, an empty transcript) therefore fails toward
// "did not execute" instead of silently becoming a valid trajectory.
//
// It is used by the credential PREFLIGHT (preflight-auth.sh): the positive
// control that, before any trajectory is dispatched, proves the provisioned
// credential can obtain a real completion. Holding "what counts as a genuine
// execution" in one small tested module keeps the preflight's decision explicit
// and reviewable rather than buried in a grep for error strings.
//
// The evidence of a genuine completion is an assistant message that carries:
//   - a REAL model id  (message.model present, non-empty, and not the CLI's
//     "<synthetic>" placeholder, which is exactly what Claude Code emits when it
//     could not reach the model — e.g. an invalid Authorization header), and
//   - REAL token usage  (input_tokens > 0 or output_tokens > 0): a real inference
//     always consumes the prompt, so zero/zero is a turn that never ran, and
//   - no api-error flag  (is_api_error_message !== true): a genuine turn is not
//     the provider reporting its own failure.
// Any ONE such message anywhere in the transcript is sufficient positive proof.
//
// Robustness: the transcript is stream-json (one JSON object per line) and may be
// TORN — a genuinely executing agent killed at the budget can leave a partial
// final line. Unparseable lines are skipped, never fatal, so a real-but-truncated
// run is still recognised as executed (and therefore burned/scored by the caller,
// never re-rolled) rather than mistaken for a non-run.

export const NOT_EXECUTED = 'AGENT_NOT_EXECUTED';
export const GENUINE_COMPLETION = 'GENUINE_COMPLETION';

// classifyExecution(transcriptText) -> { executed, reason, model?, input_tokens?,
//   output_tokens?, assistant_turns, lines_seen, lines_parsed }
export function classifyExecution(text) {
  const lines = String(text ?? '').split('\n');
  let seen = 0, parsed = 0, assistantTurns = 0;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    seen++;
    let m;
    try { m = JSON.parse(raw); } catch { continue; } // torn/non-JSON line: skip
    parsed++;
    if (!m || m.type !== 'assistant') continue;
    assistantTurns++;
    const model = m.message && m.message.model;
    if (typeof model !== 'string' || model === '' || model === '<synthetic>') continue;
    if (m.is_api_error_message === true) continue;
    const usage = (m.message && m.message.usage) || {};
    const inTok = Number(usage.input_tokens ?? 0) || 0;
    const outTok = Number(usage.output_tokens ?? 0) || 0;
    if (inTok > 0 || outTok > 0) {
      return {
        executed: true,
        reason: GENUINE_COMPLETION,
        model,
        input_tokens: inTok,
        output_tokens: outTok,
        assistant_turns: assistantTurns,
        lines_seen: seen,
        lines_parsed: parsed,
      };
    }
  }
  return {
    executed: false,
    reason: NOT_EXECUTED,
    assistant_turns: assistantTurns,
    lines_seen: seen,
    lines_parsed: parsed,
  };
}

// Convenience for callers that only need the boolean.
export function agentExecuted(text) { return classifyExecution(text).executed; }

// CLI:  node agent-exec-contract.mjs <transcript.jsonl>
//   prints  "EXECUTED <model> in=<n> out=<n>"  and exits 0 when a genuine
//   completion is proven; prints "NOT_EXECUTED <reason> turns=<n>" and exits 3
//   otherwise. Exit 3 matches the harness convention for a deterministic
//   "not scorable" rejection (distinct from 0 = ok).
const isMain = (() => {
  try { return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();

if (isMain) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('usage: agent-exec-contract.mjs <transcript.jsonl>\n');
    process.exit(2);
  }
  let text = '';
  try {
    const { readFileSync } = await import('node:fs');
    text = readFileSync(file, 'utf8');
  } catch (e) {
    // A transcript that cannot even be read is, by the positive contract, not
    // proof of execution.
    process.stdout.write(`NOT_EXECUTED ${NOT_EXECUTED} (transcript unreadable: ${e.code || e.message})\n`);
    process.exit(3);
  }
  const r = classifyExecution(text);
  if (r.executed) {
    process.stdout.write(`EXECUTED ${r.model} in=${r.input_tokens} out=${r.output_tokens} turns=${r.assistant_turns}\n`);
    process.exit(0);
  }
  process.stdout.write(`NOT_EXECUTED ${r.reason} turns=${r.assistant_turns} lines=${r.lines_parsed}/${r.lines_seen}\n`);
  process.exit(3);
}
