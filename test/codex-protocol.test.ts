// Layer (a): PROTOCOL CONFORMANCE. Deterministic tests that the Codex adapter parses the
// REAL Codex hook INPUT shape and emits deny wire that validates against the REAL Codex
// OUTPUT schemas, copied verbatim from openai/codex codex-rs/hooks/schema/generated into
// test/fixtures/codex-schemas. If Codex changes the wire, these fixtures must be refreshed
// and the adapter updated — never the reverse.

import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexAdapter } from '../src/adapters/codex/adapter';
import { codexDenyWire } from '../src/adapters/codex/deny';
import { normalizeCodexEvent } from '../src/adapters/codex/schema';
import { Finding } from '../src/types';

const DIR = join(__dirname, 'fixtures', 'codex-schemas');
const schema = (name: string) => JSON.parse(readFileSync(join(DIR, name), 'utf8'));
const ajv = new Ajv({ strict: false });
const validatePreIn = ajv.compile(schema('pre-tool-use.command.input.schema.json'));
const validatePreOut = ajv.compile(schema('pre-tool-use.command.output.schema.json'));
const validateStopIn = ajv.compile(schema('stop.command.input.schema.json'));
const validateStopOut = ajv.compile(schema('stop.command.output.schema.json'));

const findings: Finding[] = [
  {
    rule: 'test-deletion',
    severity: 'block',
    file: 'src/a.spec.ts',
    message: 'A protected test file was removed.',
    evidence: 'rm src/a.spec.ts',
    remediation: 'Fix the failing test, do not delete it.',
    signoff: { required: true, command: 'tamperward allow test-deletion --reason "..."' },
  },
];

// A schema-VALID PreToolUse input carrying the real apply_patch payload shape.
function preToolUseInput(): Record<string, unknown> {
  return {
    cwd: '/repo',
    hook_event_name: 'PreToolUse',
    model: 'gpt-5-codex',
    permission_mode: 'bypassPermissions',
    session_id: 'sess-1',
    tool_input: { command: '*** Begin Patch\n*** Update File: src/a.spec.ts\n*** End Patch' },
    tool_name: 'apply_patch',
    tool_use_id: 'call-1',
    transcript_path: null,
    turn_id: 'turn-1',
  };
}

function stopInput(): Record<string, unknown> {
  return {
    cwd: '/repo',
    hook_event_name: 'Stop',
    last_assistant_message: null,
    model: 'gpt-5-codex',
    permission_mode: 'bypassPermissions',
    session_id: 'sess-1',
    stop_hook_active: false,
    transcript_path: null,
    turn_id: 'turn-1',
  };
}

describe('Codex protocol conformance — inputs match the real Codex input schema', () => {
  it('the PreToolUse fixture validates against pre-tool-use.command.input.schema.json', () => {
    expect(validatePreIn(preToolUseInput())).toBe(true);
  });

  it('the Stop fixture validates against stop.command.input.schema.json', () => {
    expect(validateStopIn(stopInput())).toBe(true);
  });

  it('the adapter reads identity and tool from a real PreToolUse input', () => {
    const ev = normalizeCodexEvent(JSON.stringify(preToolUseInput()), 'pre-action');
    expect('failure' in ev).toBe(false);
    if ('failure' in ev) return;
    expect(ev.operation.kind).toBe('file-edit');
    expect(ev.operation.name).toBe('apply_patch');
    expect(ev.identity).toEqual({ claimedCwd: '/repo', sessionId: 'sess-1' });
  });
});

describe('Codex protocol conformance — deny wire validates against the real output schemas', () => {
  it('pre-action deny wire validates against pre-tool-use.command.output.schema.json', () => {
    const wire = JSON.parse(codexDenyWire(findings, 'pre-action'));
    const ok = validatePreOut(wire);
    if (!ok) console.error(validatePreOut.errors);
    expect(ok).toBe(true);
    expect(wire.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(wire.decision).toBe('block');
  });

  it('end-of-turn deny wire validates against stop.command.output.schema.json (no hookSpecificOutput)', () => {
    const wire = JSON.parse(codexDenyWire(findings, 'end-of-turn'));
    const ok = validateStopOut(wire);
    if (!ok) console.error(validateStopOut.errors);
    expect(ok).toBe(true);
    expect(wire.decision).toBe('block');
    expect(wire.hookSpecificOutput).toBeUndefined();
  });

  it('a pre-action deny wire produced by decide() also validates against the output schema', () => {
    // Cross-repo identity rejection yields a real pre-action deny wire without needing a repo.
    const raw = JSON.stringify({ ...preToolUseInput(), tool_name: 'Bash', tool_input: { command: 'rm x' }, cwd: '/definitely/not/a/repo/xyz' });
    const r = codexAdapter.decide(raw, 'pre-action', process.cwd());
    expect(r.decision?.verdict).toBe('deny');
    // Bound the wire before the schema walk: a pre-action deny wire is a small,
    // fixed-shape object, so this asserts that and keeps CodeQL from reading
    // JSON.parse → Ajv as an unbounded deep-object traversal.
    const wire = r.wire as string;
    expect(wire.length).toBeLessThan(10_000);
    expect(validatePreOut(JSON.parse(wire))).toBe(true);
  });
});
