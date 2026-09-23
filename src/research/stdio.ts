// Language-neutral JSONL lifecycle messages for research adapters.

import { ResearchError, type AdapterLayer } from './adapter';

export const STDIO_PROTOCOL = 'research-stdio-jsonl-v1' as const;

export interface StdioCapabilities {
  layers: readonly AdapterLayer[];
  intervention: 'enforced' | 'advisory' | 'not-connected';
}

export type StdioMessage =
  | { type: 'hello'; protocol: typeof STDIO_PROTOCOL; runtime: string; capabilities: StdioCapabilities }
  | { type: 'start'; task: string; arm: 'ungated' | 'gated'; cwd: string; base: string; prompt?: string }
  | { type: 'run'; run_id: string; status: 'started' | 'finished' }
  | { type: 'event'; event: 'tool' | 'edit' | 'turn'; request_id?: string; name?: string; detail?: string }
  | { type: 'intervention'; action: 'deny' | 'allow'; request_id: string; reason: string }
  | { type: 'complete'; status: 'completed' | 'failed' | 'cancelled'; exit_code?: number }
  | { type: 'error'; message: string };

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ResearchError('stdio message must be a JSON object');
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, name: string, required = true): string | undefined {
  const result = value[name];
  if (result === undefined && !required) return undefined;
  if (typeof result !== 'string' || result.length === 0) throw new ResearchError(`stdio message ${name} must be a non-empty string`);
  return result;
}

function oneOf<T extends string>(value: Record<string, unknown>, name: string, values: readonly T[]): T {
  const result = stringField(value, name);
  if (!values.includes(result as T)) throw new ResearchError(`stdio message ${name} must be one of ${values.join('|')}`);
  return result as T;
}

export function encodeStdioMessage(message: StdioMessage): string {
  return JSON.stringify(message) + '\n';
}

export function parseStdioMessage(line: string): StdioMessage {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { throw new ResearchError('stdio message is not valid JSON'); }
  const value = object(raw);
  const type = oneOf(value, 'type', ['hello', 'start', 'run', 'event', 'intervention', 'complete', 'error'] as const);
  if (type === 'hello') {
    const protocol = stringField(value, 'protocol');
    if (protocol !== STDIO_PROTOCOL) throw new ResearchError(`stdio protocol must be ${STDIO_PROTOCOL}`);
    const runtime = stringField(value, 'runtime') as string;
    const caps = object(value.capabilities);
    const layers = caps.layers;
    if (!Array.isArray(layers) || !layers.every((x) => typeof x === 'string' && ['envelope', 'pre-tool-use', 'stop-sweep'].includes(x))) {
      throw new ResearchError('stdio hello capabilities.layers is invalid');
    }
    const intervention = oneOf(caps, 'intervention', ['enforced', 'advisory', 'not-connected'] as const);
    return { type, protocol: STDIO_PROTOCOL, runtime, capabilities: { layers: layers as AdapterLayer[], intervention } };
  }
  if (type === 'start') {
    return { type, task: stringField(value, 'task') as string, arm: oneOf(value, 'arm', ['ungated', 'gated'] as const), cwd: stringField(value, 'cwd') as string, base: stringField(value, 'base') as string, ...(value.prompt === undefined ? {} : { prompt: stringField(value, 'prompt') }) };
  }
  if (type === 'run') {
    return { type, run_id: stringField(value, 'run_id') as string, status: oneOf(value, 'status', ['started', 'finished'] as const) };
  }
  if (type === 'event') {
    return { type, event: oneOf(value, 'event', ['tool', 'edit', 'turn'] as const), ...(value.request_id === undefined ? {} : { request_id: stringField(value, 'request_id') }), ...(value.name === undefined ? {} : { name: stringField(value, 'name') }), ...(value.detail === undefined ? {} : { detail: stringField(value, 'detail') }) };
  }
  if (type === 'intervention') {
    return { type, action: oneOf(value, 'action', ['deny', 'allow'] as const), request_id: stringField(value, 'request_id') as string, reason: stringField(value, 'reason') as string };
  }
  if (type === 'complete') {
    const exitCode = value.exit_code;
    if (exitCode !== undefined && (!Number.isInteger(exitCode) || (exitCode as number) < 0)) throw new ResearchError('stdio complete exit_code must be a non-negative integer');
    return { type, status: oneOf(value, 'status', ['completed', 'failed', 'cancelled'] as const), ...(exitCode === undefined ? {} : { exit_code: exitCode as number }) };
  }
  return { type, message: stringField(value, 'message') as string };
}

export function stdioCapabilityDeclaration(layers: readonly AdapterLayer[] = ['envelope']): StdioCapabilities {
  return { layers: [...layers], intervention: layers.includes('pre-tool-use') ? 'advisory' : 'not-connected' };
}
