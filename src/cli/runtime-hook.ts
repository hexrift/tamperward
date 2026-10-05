// `tamperward hook codex|copilot` and `sweep codex|copilot`: the experimental runtimes' hook
// commands. Each runs the registered RuntimeAdapter over the raw bytes the runtime hands the
// hook, and writes the adapter's native wire at exit 0 — a deny is JSON on stdout, an allow is
// nothing. The adapter owns every failure state (an unparseable payload, a rejected identity
// claim, a reconstruction that cannot be modelled all fail CLOSED in its own envelope), so this
// module adds no verdict path; it is the stdin/stdout seam only. The Claude hook keeps its
// separate, byte-identical path in src/cli/hook.ts and the persistent service.

import { readFileSync } from 'node:fs';
import { adapterFor } from '../adapters/registry';
import { steeringUnavailableFinding } from '../adapters/contract';

export const RUNTIME_HOOK_AGENTS = Object.freeze(['codex', 'copilot'] as const);
export type RuntimeHookAgent = (typeof RUNTIME_HOOK_AGENTS)[number];

export interface RuntimeHookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function isRuntimeHookAgent(agent: string): agent is RuntimeHookAgent {
  return RUNTIME_HOOK_AGENTS.some((known) => known === agent);
}

/** The whole path from RAW BYTES, so a test needs no stdin. An unknown agent is exit 2 with
 *  nothing on stdout: the runtime reads no decision and applies its own default, which is the
 *  honest outcome for a command nothing shipped behind. */
export function runRuntimeHookFromRaw(kind: 'PreToolUse' | 'Stop', agent: string, raw: string, cwd: string = process.cwd()): RuntimeHookResult {
  if (!isRuntimeHookAgent(agent)) {
    return { exitCode: 2, stdout: '', stderr: `tamperward: unsupported ${kind === 'Stop' ? 'sweep' : 'hook'} agent "${agent}" (claude, ${RUNTIME_HOOK_AGENTS.join(', ')})\n` };
  }
  const adapter = adapterFor(agent);
  if (!adapter) {
    return { exitCode: 2, stdout: '', stderr: `tamperward: no adapter is registered for "${agent}"\n` };
  }
  const phase = kind === 'Stop' ? 'end-of-turn' : 'pre-action';
  try {
    const r = adapter.decide(raw, phase, cwd);
    return { exitCode: 0, stdout: r.wire ?? '', stderr: '' };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const wire = adapter.denyPayload([steeringUnavailableFinding(detail)], phase);
    return { exitCode: 0, stdout: wire, stderr: '' };
  }
}

export function runRuntimeHook(kind: 'PreToolUse' | 'Stop', agent: string): number {
  let raw: string;
  try {
    raw = readFileSync(0, 'utf8');
  } catch (e) {
    raw = '';
    const r = runRuntimeHookFromRaw(kind, agent, '', process.cwd());
    if (r.exitCode !== 0) {
      process.stderr.write(r.stderr);
      return r.exitCode;
    }
    const adapter = adapterFor(agent);
    const detail = `cannot read the hook payload on stdin: ${e instanceof Error ? e.message : String(e)}`;
    process.stdout.write(adapter ? adapter.denyPayload([steeringUnavailableFinding(detail)], kind === 'Stop' ? 'end-of-turn' : 'pre-action') : '');
    return 0;
  }
  const r = runRuntimeHookFromRaw(kind, agent, raw, process.cwd());
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.exitCode;
}
